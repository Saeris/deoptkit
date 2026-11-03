import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { FrameParser, frame } from "../jsonrpc";
import type { Diagnostic } from "../server";
import { runLsp, toDiagnostics } from "../server";

describe("jsonrpc framing", () => {
  it("round-trips messages split across arbitrary chunk boundaries", () => {
    const parser = new FrameParser();
    const bytes = Buffer.concat([
      frame({ id: 1, method: "initialize", params: { a: 1 } }),
      frame({ method: "initialized", params: {} })
    ]);
    const collected: unknown[] = [];
    // Feed one byte at a time — the cruelest chunking a stream can produce.
    for (const byte of bytes) {
      collected.push(...parser.push(Buffer.from([byte])));
    }
    expect(collected).toHaveLength(2);
    expect(collected[0]).toMatchObject({ id: 1, method: "initialize" });
    expect(collected[1]).toMatchObject({ method: "initialized" });
  });
});

describe("toDiagnostics", () => {
  const payload = {
    createdAt: "2026-07-02T00:00:00.000Z",
    findings: [
      {
        kind: "megamorphic-ic",
        severity: 80,
        file: "file:///C:/app/dist/x.js",
        line: 3,
        column: 9,
        summary: "hot one",
        explanation: "why",
        suggestedFix: "fix it",
        original: { file: "file:///C:/app/src/x.ts", line: 12, column: 9 }
      },
      {
        kind: "soft-deopt",
        severity: 4,
        file: "file:///C:/app/dist/y.js",
        line: 1,
        column: 1,
        summary: "meh"
      }
    ]
  };

  it("maps severity bands, prefers original positions, converts to 0-based", () => {
    const byUri = toDiagnostics(payload, () => false);
    const hot = byUri.get("file:///C:/app/src/x.ts")?.[0];
    expect(hot?.severity).toBe(1); // >= 60 => Error
    expect(hot?.range.start).toEqual({ line: 11, character: 8 });
    expect(hot?.code).toBe("megamorphic-ic");
    expect(hot?.message).toContain("Fix: fix it");
    const meh = byUri.get("file:///C:/app/dist/y.js")?.[0];
    expect(meh?.severity).toBe(3); // < 25 => Information
  });

  it("downgrades stale findings to Information with a re-run hint", () => {
    const byUri = toDiagnostics(payload, () => true);
    const hot = byUri.get("file:///C:/app/src/x.ts")?.[0];
    expect(hot?.severity).toBe(3);
    expect(hot?.message).toContain("re-run the bench");
  });
});

describe("runLsp end-to-end over in-process streams", () => {
  let dir: string;
  let findingsPath: string;
  let annotated: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "deoptkit-lsp-"));
    findingsPath = join(dir, "findings.json");
    annotated = join(dir, "hot.js");
    await writeFile(annotated, "function f(o){ return o.x; }\n");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const writeFindings = async (summary: string): Promise<void> => {
    // createdAt in the future keeps the annotated file "fresh" for staleness checks.
    await writeFile(
      findingsPath,
      JSON.stringify({
        createdAt: new Date(Date.now() + 60_000).toISOString(),
        findings: [
          {
            kind: "megamorphic-ic",
            severity: 70,
            file: pathToFileURL(annotated).href,
            line: 1,
            column: 24,
            summary
          }
        ]
      })
    );
  };

  it("publishes on initialize, republishes on change, clears on removal, exits on shutdown", async () => {
    await writeFindings("first");

    const input = new PassThrough();
    const output = new PassThrough();
    const parser = new FrameParser();
    const notifications: { uri: string; diagnostics: Diagnostic[] }[] = [];
    const responses: unknown[] = [];
    output.on("data", (chunk: Buffer) => {
      for (const message of parser.push(chunk)) {
        const asRecord = message as unknown as Record<string, unknown>;
        if (asRecord["method"] === "textDocument/publishDiagnostics") {
          notifications.push(
            asRecord["params"] as { uri: string; diagnostics: Diagnostic[] }
          );
        } else if ("id" in asRecord) {
          responses.push(message);
        }
      }
    });

    const done = runLsp(["--findings", findingsPath], { input, output });
    const waitFor = async (predicate: () => boolean): Promise<void> => {
      for (let tries = 0; tries < 100 && !predicate(); tries++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(predicate()).toBe(true);
    };

    input.write(frame({ id: 1, method: "initialize", params: {} }));
    input.write(frame({ method: "initialized", params: {} }));
    await waitFor(() => notifications.length >= 1);
    expect(responses).toHaveLength(1);
    expect(notifications[0]?.uri).toBe(pathToFileURL(annotated).href);
    expect(notifications[0]?.diagnostics[0]?.severity).toBe(1);
    expect(notifications[0]?.diagnostics[0]?.message).toContain("first");

    // Live loop: the writer replaces findings.json; the watcher republishes.
    await writeFindings("second");
    await waitFor(() =>
      notifications.some(({ diagnostics }) =>
        diagnostics.some(({ message }) => message.includes("second"))
      )
    );

    // Removal clears previously published URIs.
    await rm(findingsPath);
    await waitFor(() =>
      notifications.some(
        ({ uri, diagnostics }) =>
          uri === pathToFileURL(annotated).href && diagnostics.length === 0
      )
    );

    input.write(frame({ id: 2, method: "shutdown" }));
    input.write(frame({ method: "exit" }));
    await expect(done).resolves.toBe(0);
  }, 30_000);

  it("marks findings stale when the annotated file is newer than the observation", async () => {
    await writeFindings("stale-check");
    // Backdate the observation and touch the source file after it.
    const past = new Date(Date.now() - 120_000);
    const raw = JSON.parse(
      await (await import("node:fs/promises")).readFile(findingsPath, "utf8")
    ) as {
      createdAt: string;
    };
    raw.createdAt = past.toISOString();
    await writeFile(findingsPath, JSON.stringify(raw));
    await utimes(annotated, new Date(), new Date());

    const input = new PassThrough();
    const output = new PassThrough();
    const parser = new FrameParser();
    const stale: Diagnostic[] = [];
    output.on("data", (chunk: Buffer) => {
      for (const message of parser.push(chunk)) {
        const asRecord = message as unknown as Record<string, unknown>;
        if (asRecord["method"] === "textDocument/publishDiagnostics") {
          stale.push(
            ...(asRecord["params"] as { diagnostics: Diagnostic[] }).diagnostics
          );
        }
      }
    });
    const done = runLsp(["--findings", findingsPath], { input, output });
    input.write(frame({ id: 1, method: "initialize", params: {} }));
    input.write(frame({ method: "initialized", params: {} }));
    for (let tries = 0; tries < 100 && stale.length === 0; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(stale[0]?.severity).toBe(3);
    expect(stale[0]?.message).toContain("re-run the bench");
    input.write(frame({ id: 2, method: "shutdown" }));
    input.write(frame({ method: "exit" }));
    await expect(done).resolves.toBe(0);
  }, 30_000);
});
