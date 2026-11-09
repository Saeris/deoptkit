import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { runWorkload } from "../../collect/runner";
import { gitHubAnnotation, parseCiArgs, runCi } from "../ci";

const WORKLOAD_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "fixtures",
  "workloads"
);

describe("deoptkit ci", () => {
  let dir: string;
  let app: string;
  let outDir: string;
  let previousCwd: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "deoptkit-ci-"));
    app = join(dir, "app.js");
    outDir = join(dir, ".deopt");
    // Baseline paths are relative to the working directory, so run from the workspace
    // the script lives in. (The forks pool keeps this chdir inside this spec's process.)
    previousCwd = process.cwd();
    process.chdir(dir);
  });

  afterAll(async () => {
    process.chdir(previousCwd);
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects bad usage with exit 2", async () => {
    await expect(runCi([])).resolves.toBe(2);
    await expect(runCi(["--nope", "x.mjs"])).resolves.toBe(2);
    expect(parseCiArgs(["--out-dir"])).toEqual({
      error: "--out-dir requires a value"
    });
  });

  it("parses --accumulate and refuses it together with --update", async () => {
    expect(parseCiArgs(["--accumulate", "x.mjs"])).toMatchObject({
      accumulate: true,
      update: false
    });
    // Both write the baseline but with opposite intent (replace vs. union): combining
    // them is ambiguous, so it is a usage error rather than a silent precedence rule.
    expect(parseCiArgs(["--update", "--accumulate", "x.mjs"])).toHaveProperty(
      "error"
    );
    await expect(runCi(["--update", "--accumulate", "x.mjs"])).resolves.toBe(2);
  });

  // The snapshot lifecycle: first run writes a baseline and passes; an unchanged run
  // stays clean; a regression (the shape-churning variant replacing the fixed one)
  // fails with exit 1; --update accepts it; the accepted state then passes.
  it("gates structural regressions against a checked-in baseline", async () => {
    await copyFile(join(WORKLOAD_DIR, "map-churn-fixed.js"), app);
    await expect(runCi(["--out-dir", outDir, app])).resolves.toBe(0);
    const { readdir } = await import("node:fs/promises");
    const baselines = await readdir(join(outDir, "baselines"));
    expect(baselines).toHaveLength(1);
    const baseline = JSON.parse(
      await readFile(join(outDir, "baselines", baselines[0] ?? ""), "utf8")
    ) as { script: string; findings: unknown[] };
    expect(baseline.script).toBe(app);

    // Same code, same baseline: clean.
    await expect(runCi(["--out-dir", outDir, app])).resolves.toBe(0);

    // Regression: conditional-shape constructor replaces the fixed one.
    await copyFile(join(WORKLOAD_DIR, "map-churn.js"), app);
    await expect(runCi(["--out-dir", outDir, app])).resolves.toBe(1);

    // The interchange tells editors which findings the gate accepts, so that
    // accepted findings can be demoted while new ones stay problems. A failing
    // run therefore marks its new structural findings as not baselined.
    const GATED = [
      "megamorphic-ic",
      "map-churn",
      "dictionary-mode",
      "deopt-loop"
    ];
    const readInterchange = async (): Promise<
      { kind: string; baselined: boolean; heat: number }[]
    > =>
      (
        JSON.parse(await readFile(join(outDir, "findings.json"), "utf8")) as {
          findings: { kind: string; baselined: boolean; heat: number }[];
        }
      ).findings;
    const regressed = await readInterchange();
    expect(
      regressed.some((found) => found.kind === "map-churn" && !found.baselined)
    ).toBe(true);

    // Accept the new state, then it passes.
    await expect(runCi(["--out-dir", outDir, "--update", app])).resolves.toBe(
      0
    );
    await expect(runCi(["--out-dir", outDir, app])).resolves.toBe(0);

    // Once accepted, every gated finding is marked baselined; kinds the gate does
    // not track are never baselined, and every finding carries the heat it was
    // scored with.
    const acceptedRun = await readInterchange();
    const gated = acceptedRun.filter((found) => GATED.includes(found.kind));
    expect(gated.length).toBeGreaterThan(0);
    expect(gated.every((found) => found.baselined)).toBe(true);
    expect(
      acceptedRun
        .filter((found) => !GATED.includes(found.kind))
        .every((found) => !found.baselined)
    ).toBe(true);
    expect(acceptedRun.every((found) => typeof found.heat === "number")).toBe(
      true
    );

    // A baseline is committed and must match on any machine; an absolute path in the
    // identity makes every CI run fail with "NEW" findings. (The fixed variant's first
    // baseline is empty, so the accepted regression is where entries exist to check.)
    const accepted = JSON.parse(
      await readFile(join(outDir, "baselines", baselines[0] ?? ""), "utf8")
    ) as { findings: { identity: string; file: string }[] };
    expect(accepted.findings.length).toBeGreaterThan(0);
    for (const entry of accepted.findings) {
      expect(entry.file.startsWith("file:")).toBe(false);
      expect(isAbsolute(entry.file)).toBe(false);
      expect(entry.identity).toContain(entry.file);
      expect(entry.file).toBe("app.js");
    }

    // Fixing it again is not a failure — resolved findings only prompt an update notice.
    await copyFile(join(WORKLOAD_DIR, "map-churn-fixed.js"), app);
    await expect(runCi(["--out-dir", outDir, app])).resolves.toBe(0);

    // Findings at a threshold (a keyed IC with 4-5 transitions, a deopt site with exactly
    // 2 eager deopts) flicker between runs; accumulating over several runs lets the gate
    // fail only on genuinely new sites, which is the invariant it exists for. With the
    // fixed variant back in place the churn entries no longer occur, yet --accumulate
    // must keep them (--update would have emptied the baseline).
    await expect(
      runCi(["--out-dir", outDir, "--accumulate", app])
    ).resolves.toBe(0);
    const accumulated = JSON.parse(
      await readFile(join(outDir, "baselines", baselines[0] ?? ""), "utf8")
    ) as { findings: { identity: string }[] };
    expect(accumulated.findings.length).toBeGreaterThanOrEqual(
      accepted.findings.length
    );
    expect(accumulated.findings.map(({ identity }) => identity)).toEqual(
      expect.arrayContaining(accepted.findings.map(({ identity }) => identity))
    );

    // Every run rewrites the findings interchange the LSP and agents consume.
    const interchange = JSON.parse(
      await readFile(join(outDir, "findings.json"), "utf8")
    ) as {
      createdAt: string;
      findings: { kind: string; script: string }[];
    };
    expect(interchange.createdAt).toMatch(/^\d{4}-/u);
    for (const found of interchange.findings) {
      expect(found.script).toBe(app);
      expect(found.kind.length).toBeGreaterThan(0);
    }
  }, 300_000);

  // A vitest bench run has no script to rerun, so the gate reads the logs its manifest
  // lists: every one of them, since a worker per test file means a regression can sit
  // in any log. And it must fail loud when it cannot see the whole run, because a gate
  // over part of one passes for the wrong reason.
  it("gates the logs a vitest bench manifest lists", async () => {
    const logs = join(dir, "logs");
    await mkdir(logs, { recursive: true });
    const manifest = join(dir, "manifest.json");
    const gateDir = join(dir, ".deopt-vitest");
    const record = async (workload: string, name: string): Promise<string> => {
      await copyFile(join(WORKLOAD_DIR, `${workload}.js`), app);
      const run = await runWorkload({
        command: [process.execPath, app],
        timeoutMs: 60_000
      });
      try {
        const logfile = join(logs, name);
        await copyFile(run.logfile, logfile);
        return logfile;
      } finally {
        await rm(run.dir, { recursive: true, force: true });
      }
    };
    const listing = async (logfiles: string[]): Promise<void> => {
      await writeFile(manifest, JSON.stringify({ outDir: logs, logfiles }));
    };
    const gate = async (...flags: string[]): Promise<number> =>
      runCi(["--out-dir", gateDir, ...flags, "--manifest", manifest]);

    const first = await record("map-churn-fixed", "v8-1.log");
    await listing([first, await record("map-churn-fixed", "v8-2.log")]);
    await expect(gate()).resolves.toBe(0);
    await expect(readdir(join(gateDir, "baselines"))).resolves.toHaveLength(1);
    await expect(gate()).resolves.toBe(0);

    // The regression is in the second worker's log only.
    await listing([first, await record("map-churn", "v8-2.log")]);
    await expect(gate()).resolves.toBe(1);
    await expect(gate("--update")).resolves.toBe(0);
    await expect(gate()).resolves.toBe(0);

    await listing([]);
    await expect(gate()).resolves.toBe(2);
    await listing([first, join(logs, "v8-missing.log")]);
    await expect(gate()).resolves.toBe(2);
    await writeFile(manifest, "{}");
    await expect(gate()).resolves.toBe(2);
    await rm(manifest);
    await expect(gate()).resolves.toBe(2);
  }, 300_000);

  it("parses --manifest as an input of its own", () => {
    expect(parseCiArgs(["--manifest", "m.json"])).toMatchObject({
      manifests: ["m.json"],
      scripts: []
    });
    expect(parseCiArgs(["--manifest"])).toEqual({
      error: "--manifest requires a value"
    });
  });

  it("formats GitHub annotations at the original source position", () => {
    const annotation = gitHubAnnotation({
      kind: "megamorphic-ic",
      severity: 50,
      heat: 0.2,
      file: "file:///C:/repo/dist/app.js",
      line: 3,
      column: 9,
      functionName: "readId",
      summary:
        'LoadIC for property "id" went megamorphic (16 recorded transitions)',
      explanation: "",
      suggestedFix: "",
      evidence: {},
      original: { file: "file:///C:/repo/src/app.ts", line: 12, column: 9 }
    });
    expect(annotation).toContain("::warning file=");
    expect(annotation).toContain("line=12");
    expect(annotation).toContain("app.ts");
    expect(annotation).toContain("deoptkit megamorphic-ic");
  });
});
