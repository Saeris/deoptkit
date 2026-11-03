import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
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

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "deoptkit-ci-"));
    app = join(dir, "app.js");
    outDir = join(dir, ".deopt");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects bad usage with exit 2", async () => {
    await expect(runCi([])).resolves.toBe(2);
    await expect(runCi(["--nope", "x.mjs"])).resolves.toBe(2);
    expect(parseCiArgs(["--out-dir"])).toEqual({
      error: "--out-dir requires a value"
    });
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

    // Accept the new state, then it passes.
    await expect(runCi(["--out-dir", outDir, "--update", app])).resolves.toBe(
      0
    );
    await expect(runCi(["--out-dir", outDir, app])).resolves.toBe(0);

    // Fixing it again is not a failure — resolved findings only prompt an update notice.
    await copyFile(join(WORKLOAD_DIR, "map-churn-fixed.js"), app);
    await expect(runCi(["--out-dir", outDir, app])).resolves.toBe(0);

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

  it("formats GitHub annotations at the original source position", () => {
    const annotation = gitHubAnnotation({
      kind: "megamorphic-ic",
      severity: 50,
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
