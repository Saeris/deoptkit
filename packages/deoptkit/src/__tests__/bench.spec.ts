import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureDist } from "../vitest/__tests__/e2eProject";

/** The package directory, where the bench resolves `../dist` and `../fixtures`. */
const PACKAGE = join(import.meta.dirname, "..", "..");

describe("bench/parse.bench.mjs", () => {
  beforeAll(() => {
    ensureDist();
  }, 60_000);

  // The deoptkit ci gate runs this bench on one CI matrix lane (see .github/workflows/ci.yml);
  // this test proves on every lane that the subject still runs against the shipped entry
  // points, so a renamed export or a broken harness import fails here, not only in the gate.
  it("runs against the built package", () => {
    const run = spawnSync(process.execPath, ["bench/parse.bench.mjs"], {
      cwd: PACKAGE,
      encoding: "utf8"
    });
    if (run.status !== 0) {
      throw new Error(
        `bench exited ${String(run.status)}:\n${run.stdout}\n${run.stderr}`
      );
    }
    expect(run.status).toBe(0);
  }, 60_000);
});
