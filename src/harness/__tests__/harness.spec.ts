import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { Finding } from "../../analysis/findings";
import { computeFindings } from "../../analysis/findings";
import { applyWindow, resolveWindow } from "../../analysis/window";
import { runWorkload } from "../../collect/runner";
import type { LogModel } from "../../model/logModel";
import { parseLog } from "../../parser/parseLog";
import { SessionStore } from "../../sessions";
import { getFindings } from "../../tools/getFindings";

// Two observed cases: hot_mega drives a LoadIC megamorphic with 8 shapes; clean reads
// one shape monomorphically. Windowing must attribute the pathology to hot_mega only.
const WORKLOAD = `
import { observed } from "./harness.mjs";

function getX(obj) {
  return obj.x;
}
function getY(obj) {
  return obj.y;
}

const shapes = [
  { x: 1 },
  { a: 1, x: 2 },
  { a: 1, b: 2, x: 3 },
  { a: 1, b: 2, c: 3, x: 4 },
  { a: 1, b: 2, c: 3, d: 4, x: 5 },
  { a: 1, b: 2, c: 3, d: 4, e: 5, x: 6 },
  { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, x: 7 },
  { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, x: 8 }
];
const single = { y: 1 };

observed("hot mega", (i) => getX(shapes[i % shapes.length]), { iterations: 50000 });
observed("clean", () => getY(single), { iterations: 50000 });
`;

const isMegaX = (found: Finding): boolean =>
  found.kind === "megamorphic-ic" && found.evidence["key"] === "x";

describe("harness markers and windowed analysis", () => {
  let fixtureDir: string;
  let model: LogModel;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "deoptkit-harness-"));
    // The workload consumes the real shipped harness, transpiled the same way vp pack
    // would emit it — if mark()'s eval trick breaks on a V8 upgrade, this fails.
    const harnessSource = await readFile(
      join(import.meta.dirname, "..", "index.ts"),
      "utf8"
    );
    const { outputText } = ts.transpileModule(harnessSource, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext
      }
    });
    await writeFile(join(fixtureDir, "harness.mjs"), outputText);
    await writeFile(join(fixtureDir, "workload.mjs"), WORKLOAD);
    const run = await runWorkload({
      command: ["node", join(fixtureDir, "workload.mjs")],
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

  it("captures sanitized markers in log order with usable timestamps", () => {
    const labels = model.markers.map(({ label }) => label);
    // "hot mega" sanitizes to hot_mega; observed() brackets with _start/_end.
    expect(labels).toEqual([
      "hot_mega_start",
      "hot_mega_end",
      "clean_start",
      "clean_end"
    ]);
    const times = model.markers.map(({ time }) => time);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    // Markers must never leak into the function index as observable functions.
    expect(
      model.functionIndex.some(({ functionName }) =>
        functionName.includes("__DEOPT_MARK__")
      )
    ).toBe(false);
  });

  it("attributes the megamorphic IC to the hot window and clears the clean window", () => {
    expect(computeFindings(model).some(isMegaX)).toBe(true);

    const hot = resolveWindow(model, {
      fromMark: "hot_mega_start",
      toMark: "hot_mega_end"
    });
    if ("error" in hot) throw new Error(hot.error);
    expect(computeFindings(applyWindow(model, hot)).some(isMegaX)).toBe(true);

    const clean = resolveWindow(model, {
      fromMark: "clean_start",
      toMark: "clean_end"
    });
    if ("error" in clean) throw new Error(clean.error);
    const cleanFindings = computeFindings(applyWindow(model, clean));
    expect(cleanFindings.some(isMegaX)).toBe(false);
  });

  it("exposes windowing through get_findings and rejects unknown marks helpfully", async () => {
    const sessions = new SessionStore();
    const session = sessions.add("windowed", model);
    const windowed = await getFindings.invoke(
      { sessionId: session.id, fromMark: "clean_start", toMark: "clean_end" },
      { sessions }
    );
    const [first] = windowed.content as [{ type: "text"; text: string }];
    const { items } = JSON.parse(first.text) as { items: Finding[] };
    expect(items.some(isMegaX)).toBe(false);

    const bad = await getFindings.invoke(
      { sessionId: session.id, fromMark: "nope" },
      { sessions }
    );
    expect(bad.isError).toBe(true);
    const [badFirst] = bad.content as [{ type: "text"; text: string }];
    expect(badFirst.text).toContain("hot_mega_start");
  });
});
