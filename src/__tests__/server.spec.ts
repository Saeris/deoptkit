import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../server";

const connect = async (): Promise<Client> => {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    createServer().connect(serverTransport),
    client.connect(clientTransport)
  ]);
  return client;
};

const textPayload = (
  result: Awaited<ReturnType<Client["callTool"]>>
): Record<string, unknown> => {
  const [first] = result.content as [{ type: "text"; text: string }];
  return JSON.parse(first.text) as Record<string, unknown>;
};

describe("deoptkit server", () => {
  let client: Client;
  let fixtureDir: string;

  beforeAll(async () => {
    client = await connect();
    fixtureDir = await mkdtemp(join(tmpdir(), "deoptkit-test-"));
  });

  afterAll(async () => {
    await client.close();
    await rm(fixtureDir, { recursive: true, force: true });
  });

  describe("tools/list", () => {
    // Agents discover and call tools purely from this listing; a missing tool or a
    // non-object schema silently breaks every client, so the contract is pinned here.
    it("advertises the session tools with object input schemas", async () => {
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      expect([...byName.keys()].toSorted()).toEqual([
        "compare_sessions",
        "get_findings",
        "get_function",
        "get_map",
        "list_deopts",
        "list_functions",
        "list_ics",
        "list_sessions",
        "load_log",
        "load_manifest",
        "profile_run"
      ]);
      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.description?.length ?? 0).toBeGreaterThan(0);
      }
      expect(byName.get("load_log")?.inputSchema.required).toContain("path");
    });
  });

  describe("prompts", () => {
    it("serves the analyze-performance prompt with the command inlined", async () => {
      const { prompts } = await client.listPrompts();
      expect(prompts.map(({ name }) => name)).toEqual(["analyze-performance"]);
      const prompt = await client.getPrompt({
        name: "analyze-performance",
        arguments: { command: "node bench.js" }
      });
      const [message] = prompt.messages;
      const text = message?.content.type === "text" ? message.content.text : "";
      expect(text).toContain("node bench.js");
      expect(text).toContain("compare_sessions");
    });
  });

  describe("list_sessions", () => {
    it("returns an empty session list on a fresh server", async () => {
      const result = await client.callTool({
        name: "list_sessions",
        arguments: {}
      });
      expect(result.isError ?? false).toBe(false);
      expect(textPayload(result)).toEqual({ sessions: [] });
    });
  });

  describe("load_log", () => {
    it("rejects arguments that do not match the schema", async () => {
      const result = await client.callTool({
        name: "load_log",
        arguments: { path: 42 }
      });
      expect(result.isError).toBe(true);
      expect(textPayload(result).error).toBe("Invalid arguments");
    });

    it("reports unreadable paths as errors instead of crashing the server", async () => {
      const result = await client.callTool({
        name: "load_log",
        arguments: { path: join(fixtureDir, "does-not-exist.log") }
      });
      expect(result.isError).toBe(true);
      expect(textPayload(result).error).toMatch(/Cannot read log file/u);
    });

    it("rejects files that are not V8 logs so agents get actionable feedback", async () => {
      const path = join(fixtureDir, "not-a-log.txt");
      await writeFile(path, "hello world\n");
      const result = await client.callTool({
        name: "load_log",
        arguments: { path }
      });
      expect(result.isError).toBe(true);
      expect(textPayload(result).error).toMatch(/does not look like a V8 log/u);
    });

    // The end-to-end promise: run a workload with zero flag knowledge, get ranked
    // findings that name its deliberate pathology.
    it("profile_run profiles a workload and get_findings names its pathology", async () => {
      const workload = join(
        import.meta.dirname,
        "..",
        "..",
        "fixtures",
        "workloads",
        "map-churn.js"
      );
      const result = await client.callTool({
        name: "profile_run",
        arguments: { command: ["node", workload], timeoutMs: 60_000 }
      });
      expect(result.isError ?? false).toBe(false);
      const payload = textPayload(result);
      expect((payload.counts as { icSites: number }).icSites).toBeGreaterThan(
        0
      );

      const findings = await client.callTool({
        name: "get_findings",
        arguments: { sessionId: String(payload.sessionId) }
      });
      const { items } = textPayload(findings) as unknown as {
        items: { kind: string; file: string }[];
      };
      expect(
        items.some(
          (found) =>
            found.kind === "megamorphic-ic" &&
            found.file.endsWith("map-churn.js")
        )
      ).toBe(true);

      // Drill-down: the annotated snippet marks the polluted read without any file I/O.
      const fn = await client.callTool({
        name: "get_function",
        arguments: {
          sessionId: String(payload.sessionId),
          file: "map-churn.js",
          functionName: "readId"
        }
      });
      expect(fn.isError ?? false).toBe(false);
      const detail = textPayload(fn) as unknown as {
        snippet: { text: string };
        annotations: { note: string }[];
      };
      expect(detail.snippet.text).toContain("return record.id;");
      expect(
        detail.annotations.some((annotation) =>
          annotation.note.includes("megamorphic")
        )
      ).toBe(true);
    }, 90_000);

    it("reports unknown sessions as errors on analysis tools", async () => {
      const result = await client.callTool({
        name: "get_findings",
        arguments: { sessionId: "nope" }
      });
      expect(result.isError).toBe(true);
      expect(textPayload(result).error).toMatch(/Unknown session/u);
    });

    it("parses a minimal V8 log into a session and reports it in list_sessions", async () => {
      const path = join(fixtureDir, "real.v8.log");
      await writeFile(
        path,
        "v8-version,13,6,233,10,-node.18,0\nshared-library,foo,0x1,0x2,0\n"
      );
      const result = await client.callTool({
        name: "load_log",
        arguments: { path }
      });
      expect(result.isError ?? false).toBe(false);
      const payload = textPayload(result);
      expect(payload.sessionId).toMatch(/^s\d+$/u);
      expect(payload.v8Version).toBe("13.6.233.10.-node.18.0");
      expect(payload.counts).toEqual({
        icSites: 0,
        deoptSites: 0,
        mapsCreated: 0,
        mapTransitionSites: 0,
        profileTicks: 0,
        codeEntries: 0
      });

      const sessions = await client.callTool({
        name: "list_sessions",
        arguments: {}
      });
      const listed = textPayload(sessions).sessions as { id: string }[];
      expect(listed.map(({ id }) => id)).toContain(payload.sessionId);
    });
  });
});
