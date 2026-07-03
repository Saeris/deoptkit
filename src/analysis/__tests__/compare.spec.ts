import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { runWorkload } from "../../collect/runner";
import type { LogModel } from "../../model/logModel";
import { parseLog } from "../../parser/parseLog";
import type { SessionComparison } from "../compare";
import { compareSessions } from "../compare";

const WORKLOAD_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "fixtures",
  "workloads"
);

/** Profile a fixture from a fixed path, simulating an agent editing app.js in place. */
const profileAs = async (fixture: string, dir: string): Promise<LogModel> => {
  const app = join(dir, "app.js");
  await copyFile(join(WORKLOAD_DIR, fixture), app);
  const run = await runWorkload({ command: ["node", app], timeoutMs: 60_000 });
  try {
    if (run.exitCode !== 0)
      throw new Error(`workload failed: ${run.stderrTail}`);
    return await parseLog(run.logfile);
  } finally {
    await rm(run.dir, { recursive: true, force: true });
  }
};

describe("compareSessions on the map-churn fix-verify pair", () => {
  let fixtureDir: string;
  let comparison: SessionComparison;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "deoptkit-compare-"));
    const base = await profileAs("map-churn.js", fixtureDir);
    const head = await profileAs("map-churn-fixed.js", fixtureDir);
    comparison = compareSessions(base, head);
  }, 120_000);

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  // The fix-verify contract: after normalizing the record shape, the megamorphic read
  // of `id` must be reported as resolved — this is how an agent knows the fix worked.
  it("reports the megamorphic id read as resolved by the shape fix", () => {
    const resolvedIds = comparison.resolved.filter(
      (found) =>
        found.kind === "megamorphic-ic" && found.evidence["key"] === "id"
    );
    expect(resolvedIds.length).toBeGreaterThan(0);
    const reintroduced = comparison.introduced.filter(
      (found) =>
        found.kind === "megamorphic-ic" && found.evidence["key"] === "id"
    );
    expect(reintroduced).toEqual([]);
  });

  it("shows fewer megamorphic user-code IC sites after the fix", () => {
    expect(comparison.counts.megamorphicIcSites.head).toBeLessThan(
      comparison.counts.megamorphicIcSites.base
    );
  });

  // The fixed constructor initializes every property in one literal — a one-time
  // linear transition chain. That must NOT read as map churn (Valimock's fully
  // initialized context object false-positived on a count-based threshold), while
  // the conditional base version's churn must be reported as resolved.
  it("does not flag a fully-initialized constructor as churn", () => {
    const churnInHead = [
      ...comparison.introduced.filter(
        (found) => found.kind === "map-churn" && found.file.endsWith("app.js")
      ),
      ...comparison.persisting.filter(
        (found) => found.kind === "map-churn" && found.file.endsWith("app.js")
      )
    ];
    expect(churnInHead).toEqual([]);
    expect(
      comparison.resolved.some(
        (found) => found.kind === "map-churn" && found.file.endsWith("app.js")
      )
    ).toBe(true);
  });

  it("keeps finding matching stable across the edit (no self-noise in persisting)", () => {
    // Whatever persists must at least be attributed to real user files, not internals.
    for (const found of comparison.persisting) {
      expect(found.file.startsWith("node:")).toBe(false);
    }
  });
});
