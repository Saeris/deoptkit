import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { runWorkload } from "../../collect/runner";
import type { LogModel } from "../../model/logModel";
import { parseLog } from "../../parser/parseLog";
import { SessionStore } from "../../sessions";
import { getFindings } from "../../tools/getFindings";
import { SourceMapResolver } from "../resolver";

// The interface block is erased by transpilation, so generated line numbers differ
// from these — exactly what the resolver must undo.
const TS_SOURCE = `interface Shape {
  x: number;
  a?: number;
  b?: number;
  c?: number;
  d?: number;
  e?: number;
  f?: number;
  g?: number;
}

function getX(obj: Shape): number {
  return obj.x;
}

const shapes: Shape[] = [
  { x: 1 },
  { a: 1, x: 2 },
  { a: 1, b: 2, x: 3 },
  { a: 1, b: 2, c: 3, x: 4 },
  { a: 1, b: 2, c: 3, d: 4, x: 5 },
  { a: 1, b: 2, c: 3, d: 4, e: 5, x: 6 },
  { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, x: 7 },
  { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, x: 8 }
];

let sum = 0;
for (let i = 0; i < 1e6; i++) {
  sum += getX(shapes[i % shapes.length]!);
}
if (sum < 0) throw new Error("unreachable");
`;

const TS_LINE_OF_RETURN =
  TS_SOURCE.split("\n").findIndex((line) => line.includes("return obj.x")) + 1;

describe("sourceMapResolver on a transpiled TypeScript workload", () => {
  let fixtureDir: string;
  let model: LogModel;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "deoptkit-sourcemap-"));
    const { outputText } = ts.transpileModule(TS_SOURCE, {
      fileName: "app.ts",
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        inlineSourceMap: true
      }
    });
    const appJs = join(fixtureDir, "app.js");
    await writeFile(appJs, outputText);
    const run = await runWorkload({
      command: ["node", appJs],
      timeoutMs: 60_000
    });
    try {
      if (run.exitCode !== 0)
        throw new Error(`workload failed: ${run.stderrTail}`);
      model = await parseLog(run.logfile);
    } finally {
      await rm(run.dir, { recursive: true, force: true });
    }
  }, 60_000);

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  // TypeScript users edit .ts files; a finding located in compiled .js is a finding
  // the agent cannot act on. The resolver must recover the original position.
  it("maps the megamorphic IC from compiled js back to the ts source", () => {
    const site = model.ics.find(
      (candidate) =>
        candidate.file?.endsWith("app.js") === true && candidate.key === "x"
    );
    expect(site).toBeDefined();
    // Transpilation erased the 10-line interface, so generated and original differ.
    expect(site?.line).not.toBe(TS_LINE_OF_RETURN);

    const resolver = new SourceMapResolver(model);
    const original = resolver.resolve(
      site?.file,
      site?.line ?? 0,
      site?.column ?? 0
    );
    expect(original?.file.endsWith("app.ts")).toBe(true);
    expect(original?.line).toBe(TS_LINE_OF_RETURN);
  });

  it("attaches original positions to findings at the tool boundary", async () => {
    const sessions = new SessionStore();
    const session = sessions.add("ts-app", model);
    const result = await getFindings.invoke(
      { sessionId: session.id },
      { sessions }
    );
    const [first] = result.content as [{ type: "text"; text: string }];
    const { items } = JSON.parse(first.text) as {
      items: { kind: string; original?: { file: string; line: number } }[];
    };
    const megamorphic = items.find((found) => found.kind === "megamorphic-ic");
    expect(megamorphic?.original?.file.endsWith("app.ts")).toBe(true);
    expect(megamorphic?.original?.line).toBe(TS_LINE_OF_RETURN);
  });
});
