import type { SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeFindings } from "../../analysis/findings";
import { runCi } from "../../cli/ci";
import type { Finding } from "../../analysis/findings";
import { toDiagnostics } from "../../lsp/server";
import type { LogModel } from "../../model/logModel";
import { parseLog } from "../../parser/parseLog";
import { SourceMapResolver } from "../../sourcemaps/resolver";
import type { DeoptKitFindingsFile, DeoptKitManifest } from "../globalSetup";
import { createE2eProject } from "./e2eProject";
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
    // V8 inlines getX into the bench function; before the inlining tables were decoded
    // the inlined copy was a second, higher-ranked finding in the bench file.
    expect(
      models
        .flatMap(computeFindings)
        .filter(
          (found) =>
            found.kind === "megamorphic-ic" &&
            found.evidence["key"] === "x" &&
            !found.file.endsWith("lib.ts")
        )
    ).toEqual([]);
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
    // This has failed on Windows runners only, while the test above found the same
    // finding in the same logs. Say what the teardown saw: it reports a log it could not
    // analyze on the child's stderr, which is otherwise discarded.
    if (site?.original === undefined) {
      const logs = new Set(payload.findings.map(({ script }) => script));
      throw new Error(
        `findings.json has no source-mapped megamorphic "x" finding (${site === undefined ? "none at all" : `one at ${site.file}:${String(site.line)}, unmapped`}). ` +
          `It holds ${String(payload.findings.length)} finding(s) from ${String(logs.size)} log(s); the manifest lists ${String(readManifest().logfiles.length)}.\n` +
          `vitest stderr:\n${run.stderr.slice(-3000)}`
      );
    }
    expect(site.original.file.endsWith("lib.ts")).toBe(true);
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

/** tinybench calls a function once when it is added, to see whether it returns a promise. */
const DETECTION_CALL = 1;
const PROVIDER = 'provider: "deoptkit/vitest/provider"';

describe("deoptKit vitest preset with an iteration limit, end to end", () => {
  let project: E2eProject;
  let run: SpawnSyncReturns<string>;

  beforeAll(async () => {
    project = await createE2eProject({
      name: "limit",
      presetOptions: "iterations: 40",
      benchmarkOptions: PROVIDER
    });
    run = project.run();
  }, 120_000);

  afterAll(async () => {
    await project.cleanup();
    delete process.env["DEOPTKIT_OUT_DIR"];
    delete process.env["DEOPTKIT_ITERATIONS"];
  });

  // Under logging, a time budget makes a log as large as the machine is fast; the
  // limit is what bounds it. Only a real run proves that Vitest loads the provider
  // from the built package and that the global setup accepts the path Vitest resolves.
  it("runs the case exactly the limit's count", () => {
    if (run.status !== 0) {
      throw new Error(
        `vitest bench exited ${String(run.status)}:\n${run.stdout}\n${run.stderr}`
      );
    }
    expect(project.calls()).toBe(40 + DETECTION_CALL);
  });

  // A fixed count is what lets `deoptkit ci --manifest` gate a bench run like a
  // script: run it again and the structural findings are the same.
  it("gives deoptkit ci the same findings on a second run", async () => {
    const gateDir = join(project.dir, ".gate");
    const gate = async (): Promise<number> =>
      runCi([
        "--out-dir",
        gateDir,
        "--manifest",
        join(project.outDir, "manifest.json")
      ]);
    await expect(gate()).resolves.toBe(0);
    const [baselineFile] = await readdir(join(gateDir, "baselines"));
    const baseline = JSON.parse(
      readFileSync(join(gateDir, "baselines", baselineFile ?? ""), "utf8")
    ) as { findings: { kind: string; functionName?: string }[] };
    expect(baseline.findings).toContainEqual(
      expect.objectContaining({ kind: "megamorphic-ic", functionName: "getX" })
    );

    const again = project.run();
    if (again.status !== 0) {
      throw new Error(
        `vitest bench exited ${String(again.status)}:\n${again.stdout}\n${again.stderr}`
      );
    }
    await expect(gate()).resolves.toBe(0);
  }, 120_000);
});

describe("deoptKit vitest preset in nativeEsm mode, end to end", () => {
  let project: E2eProject;
  let run: SpawnSyncReturns<string>;
  let findings: Finding[];

  const output = (): string => `${run.stdout}\n${run.stderr}`;

  beforeAll(async () => {
    // With the limit too: Vitest imports the provider through Node's own loader in
    // this mode, a different path from the module runner's.
    project = await createE2eProject({
      name: "native",
      presetOptions: "nativeEsm: true, iterations: 40",
      benchmarkOptions: PROVIDER
    });
    run = project.run();
    // Parse leniently: the first test asserts the run, so a broken run fails there
    // with Vitest's own output instead of an unrelated parse error here.
    const manifestPath = `${project.outDir}/manifest.json`;
    const logfiles = existsSync(manifestPath)
      ? (JSON.parse(readFileSync(manifestPath, "utf8")) as DeoptKitManifest)
          .logfiles
      : [];
    const models = await Promise.all(
      logfiles.map(async (logfile) => parseLog(logfile))
    );
    findings = models.flatMap((model) => computeFindings(model));
  }, 120_000);

  afterAll(async () => {
    await project.cleanup();
    delete process.env["DEOPTKIT_OUT_DIR"];
    delete process.env["DEOPTKIT_ITERATIONS"];
  });

  it("applies the iteration limit under Node's own loader too", () => {
    if (run.status !== 0) {
      throw new Error(
        `vitest bench exited ${String(run.status)}:\n${output()}`
      );
    }
    expect(project.calls()).toBe(40 + DETECTION_CALL);
  });

  // Without the module runner V8 sees the shipped file, so the finding must land on the
  // true position with no source-map resolution; that is the whole reason to opt in.
  it("reports the megamorphic site at its exact position without source maps", () => {
    if (run.status !== 0) {
      throw new Error(
        `vitest bench exited ${String(run.status)}:\n${output()}`
      );
    }
    const site = findings.find(
      (finding) =>
        finding.kind === "megamorphic-ic" &&
        finding.evidence["key"] === "x" &&
        finding.file.endsWith("lib.ts")
    );
    expect(site).toBeDefined();
    expect(site?.file).not.toContain("?");
    expect(site?.line).toBe(2);
    expect(site?.functionName).toBe("getX");
    // V8 inlines getX into the bench function; before the inlining tables were decoded
    // the inlined copy was a second, higher-ranked finding in the bench file.
    expect(
      findings.filter(
        (finding) =>
          finding.kind === "megamorphic-ic" &&
          finding.evidence["key"] === "x" &&
          !finding.file.endsWith("lib.ts")
      )
    ).toEqual([]);
  });

  // Native imports make Vitest append ?vitest=<timestamp> to script URLs; if that leaks
  // into a finding the identity changes on every run and baselines never match.
  it("leaves no loader query string in any finding location", () => {
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.filter(({ file }) => file.includes("?vitest="))).toEqual(
      []
    );
  });
});
