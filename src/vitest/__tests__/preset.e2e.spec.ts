import type { SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeFindings } from "../../analysis/findings";
import { toDiagnostics } from "../../lsp/server";
import type { LogModel } from "../../model/logModel";
import { parseLog } from "../../parser/parseLog";
import { SourceMapResolver } from "../../sourcemaps/resolver";
import type { DeoptKitFindingsFile, DeoptKitManifest } from "../globalSetup";
import { createE2eProject, ensureDist } from "./e2eProject";
import type { E2eProject } from "./e2eProject";

describe("deoptKit vitest preset, end to end", () => {
  let project: E2eProject;
  let run: SpawnSyncReturns<string>;
  let models: LogModel[];

  const output = (): string => `${run.stdout}\n${run.stderr}`;
  const readManifest = (): DeoptKitManifest =>
    JSON.parse(
      readFileSync(`${project.outDir}/manifest.json`, "utf8")
    ) as DeoptKitManifest;

  beforeAll(async () => {
    ensureDist();
    project = await createE2eProject({ name: "runner" });
    run = project.run();
    // Parse leniently: the first test asserts the run and manifest, so a broken run
    // fails there with Vitest's own output instead of an unrelated parse error here.
    const logfiles = existsSync(`${project.outDir}/manifest.json`)
      ? readManifest().logfiles
      : [];
    models = await Promise.all(
      logfiles.map(async (logfile) => parseLog(logfile))
    );
  }, 120_000);

  afterAll(async () => {
    await project.cleanup();
    // The preset sets this in whichever process evaluates the config; that was the
    // spawned Vitest, not this one, but leave no trace either way.
    delete process.env["DEOPTKIT_OUT_DIR"];
  });

  // The 0.1.0 preset emitted a config key Vitest ignores and produced no log at all,
  // while its shape-only test passed. Only a real spawn can prove the V8 flags
  // actually reach the benchmark workers.
  it("forked bench workers run under V8 logging and the teardown writes the manifest", () => {
    // The lint config allows no message argument on expect, so surface the child's
    // output explicitly: a bench failure is undiagnosable without it.
    if (run.status !== 0) {
      throw new Error(
        `vitest bench exited ${String(run.status)}:\n${output()}`
      );
    }
    expect(run.stdout).toContain("Test Files  1 passed");
    const manifest = readManifest();
    expect(manifest.logfiles.length).toBeGreaterThanOrEqual(1);
    for (const logfile of manifest.logfiles) {
      expect(logfile).toMatch(/v8-\d+\.log$/u);
      expect(existsSync(logfile)).toBe(true);
    }
  });

  // The window from the case's first marker to its last is what fromMark/toMark
  // filters resolve; if the hooks stop firing, per-case analysis can no longer be
  // scoped to one benchmark.
  it("benchObserved brackets the case with markers", () => {
    const bracketed = models.find((model) =>
      model.markers.some(({ label }) => label === "get_x_start")
    );
    expect(bracketed).toBeDefined();
    const times = (label: string): number[] =>
      (bracketed?.markers ?? [])
        .filter((marker) => marker.label === label)
        .map(({ time }) => time);
    const starts = times("get_x_start");
    const ends = times("get_x_end");
    expect(ends.length).toBeGreaterThan(0);
    expect(Math.min(...starts)).toBeLessThan(Math.max(...ends));
  });

  // Vite's module runner serves transformed code, so generated lines differ from the
  // source; the inline source map is what makes the finding point at editable code.
  it("findings in a bench worker locate user code and resolve to original positions", () => {
    const sites = models.flatMap((model) =>
      computeFindings(model)
        .filter(
          (finding) =>
            finding.kind === "megamorphic-ic" &&
            finding.evidence["key"] === "x" &&
            finding.file.endsWith("lib.ts")
        )
        .map((finding) => ({ finding, model }))
    );
    expect(sites.length).toBeGreaterThan(0);
    const [first] = sites;
    if (first === undefined) throw new Error("unreachable");
    const { finding, model } = first;
    const original = new SourceMapResolver(model).resolve(
      finding.file,
      finding.line,
      finding.column
    );
    expect(original?.file.endsWith("lib.ts")).toBe(true);
    // getX is declared on line 2 of lib.ts.
    expect(original?.line).toBe(2);
  });

  // The README promises that `vitest bench --watch` alone keeps the editor squiggles
  // fresh. That only holds if the teardown writes the interchange the LSP reads,
  // already source-mapped; a manifest alone leaves the editor blind.
  it("the teardown writes findings.json that the LSP can publish", () => {
    const payload = JSON.parse(
      readFileSync(`${project.outDir}/findings.json`, "utf8")
    ) as DeoptKitFindingsFile;
    const site = payload.findings.find(
      (finding) =>
        finding.kind === "megamorphic-ic" && finding.evidence["key"] === "x"
    );
    expect(site?.original?.file.endsWith("lib.ts")).toBe(true);
    expect(site?.original?.line).toBe(2);

    const diagnostics = toDiagnostics(payload, () => false);
    const uri = [...diagnostics.keys()].find((key) => key.endsWith("lib.ts"));
    const [first] = diagnostics.get(uri ?? "") ?? [];
    expect(uri).toBeDefined();
    // LSP lines are 0-based; getX is on line 2 of lib.ts.
    expect(first?.range.start.line).toBe(1);
    expect(first?.code).toBe("megamorphic-ic");
  });
});
