import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { Finding } from "../findings";
import { generateWorkloadLog } from "../../parser/__tests__/helpers";
import { parseLog } from "../../parser/parseLog";
import { computeFindings } from "../findings";

describe("computeFindings across the pathology fixtures", () => {
  let fixtureDir: string;
  let megamorphic: Finding[];
  let deoptLoop: Finding[];
  let mapChurn: Finding[];

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "deopt-mcp-findings-"));
    megamorphic = computeFindings(
      await parseLog(generateWorkloadLog("megamorphic", fixtureDir))
    );
    deoptLoop = computeFindings(
      await parseLog(generateWorkloadLog("deopt-loop", fixtureDir))
    );
    mapChurn = computeFindings(
      await parseLog(generateWorkloadLog("map-churn", fixtureDir))
    );
  }, 120_000);

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  // The agent workflow starts at findings[0]; if the deliberately-hot megamorphic site
  // is not the top finding, the ranking failed at its core promise.
  it("ranks the hot megamorphic IC as the top finding of its session", () => {
    const [top] = megamorphic;
    expect(top?.kind).toBe("megamorphic-ic");
    expect(top?.file.endsWith("megamorphic.js")).toBe(true);
    expect(top?.line).toBe(7);
    expect(top?.evidence["key"]).toBe("x");
    expect(top?.suggestedFix).toContain("same order");
  });

  it("emits severities in 1-100 sorted non-increasing, findings only for user code", () => {
    for (const findings of [megamorphic, deoptLoop, mapChurn]) {
      for (const [index, found] of findings.entries()) {
        expect(found.severity).toBeGreaterThanOrEqual(1);
        expect(found.severity).toBeLessThanOrEqual(100);
        expect(found.file.startsWith("node:")).toBe(false);
        if (index > 0) {
          expect(found.severity).toBeLessThanOrEqual(
            findings[index - 1]?.severity ?? 0
          );
        }
      }
    }
  });

  // Six warm-up/poison cycles produce repeated eager deopts at add's `a + b`; that must
  // be classified as a deopt loop, which outranks any single deopt or soft deopt.
  it("detects the deopt loop and ranks it above one-off deopts", () => {
    const loop = deoptLoop.find(
      (found) =>
        found.kind === "deopt-loop" && found.file.endsWith("deopt-loop.js")
    );
    expect(loop).toBeDefined();
    expect(Number(loop?.evidence["count"])).toBeGreaterThanOrEqual(2);
    for (const other of deoptLoop) {
      if (other.kind === "eager-deopt" || other.kind === "soft-deopt") {
        expect(loop?.severity ?? 0).toBeGreaterThanOrEqual(other.severity);
      }
    }
  });

  // makeRecord's conditional properties must show up both as churn at the creation site
  // and as a polluted IC where the records are later read — the two views of one bug.
  it("connects map churn at creation to IC pollution at the read site", () => {
    const churn = mapChurn.find(
      (found) =>
        found.kind === "map-churn" && found.file.endsWith("map-churn.js")
    );
    expect(churn).toBeDefined();
    expect(churn?.evidence["propertyNames"]).toEqual(
      expect.arrayContaining(["even", "third"])
    );
    const pollutedRead = mapChurn.find(
      (found) =>
        (found.kind === "megamorphic-ic" || found.kind === "polymorphic-ic") &&
        found.evidence["key"] === "id"
    );
    expect(pollutedRead).toBeDefined();
  });
});
