import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { Finding } from "../findings";
import type { LogModel } from "../../model/logModel";
import { generateWorkloadLog } from "../../parser/__tests__/helpers";
import { parseLog } from "../../parser/parseLog";
import { findingIdentity } from "../compare";
import { computeFindings } from "../findings";

describe("computeFindings scoring calibration", () => {
  // Calibrated on the Valimock dogfood: keyed (obj[key]) megamorphism usually means
  // genuinely dynamic keys — inherent to generic dispatch — so it must rank below a
  // named-property megamorphic site with identical evidence.
  it("ranks named megamorphic ICs above keyed ones with equal evidence", () => {
    const icSite = (type: string, key: string): LogModel["ics"][number] => ({
      type,
      file: "file:///app/src/hot.js",
      functionName: "dispatch",
      line: 10,
      column: 5,
      key,
      keys: [key],
      distinctKeys: 1,
      worstState: "megamorphic",
      transitions: Array.from({ length: 6 }, (_, index) => ({
        time: index,
        oldState: "polymorphic" as const,
        newState: "megamorphic" as const,
        mapAddress: "0x1"
      }))
    });
    const model: LogModel = {
      v8Version: "14.0.0",
      ics: [icSite("KeyedLoadIC", "dynamic"), icSite("LoadIC", "name")],
      deopts: [],
      maps: {
        createdCount: 0,
        entries: new Map(),
        eventCounts: {},
        transitionSites: []
      },
      profile: { tickCount: 0, vmStates: {}, functions: [], samples: [] },
      scripts: new Map(),
      functionIndex: [],
      markers: [],
      codeEntryCount: 0,
      codeSourceInfoCount: 0,
      warnings: { unknownCommands: {}, badLines: 0 }
    };
    const findings = computeFindings(model);
    const named = findings.find(
      (found) => found.evidence["icType"] === "LoadIC"
    );
    const keyed = findings.find(
      (found) => found.evidence["icType"] === "KeyedLoadIC"
    );
    expect(named?.severity ?? 0).toBeGreaterThan(keyed?.severity ?? 0);
    expect(keyed?.evidence["keyedAccess"]).toBe(true);
    expect(keyed?.summary).toContain("inherent");
  });
});

const modelWith = (parts: Pick<LogModel, "ics" | "deopts">): LogModel => ({
  v8Version: "14.0.0",
  ...parts,
  maps: {
    createdCount: 0,
    entries: new Map(),
    eventCounts: {},
    transitionSites: []
  },
  profile: { tickCount: 0, vmStates: {}, functions: [], samples: [] },
  scripts: new Map(),
  functionIndex: [],
  markers: [],
  codeEntryCount: 0,
  codeSourceInfoCount: 0,
  warnings: { unknownCommands: {}, badLines: 0 }
});

describe("computeFindings for keyed IC sites", () => {
  // The identity must not depend on which key crossed the threshold, or CI baselines
  // flicker between runs of the same code.
  it("reports one megamorphic finding per keyed site with an identity free of any key", () => {
    const findings = computeFindings(
      modelWith({
        deopts: [],
        ics: [
          {
            type: "KeyedLoadIC",
            file: "file:///app/src/hot.js",
            functionName: "tick",
            line: 10,
            column: 5,
            key: "js",
            keys: ["js", "gc", "other"],
            distinctKeys: 3,
            worstState: "megamorphic",
            transitions: Array.from({ length: 6 }, (_, index) => ({
              time: index,
              oldState: "polymorphic" as const,
              newState: "megamorphic" as const,
              mapAddress: "0x1"
            }))
          }
        ]
      })
    );
    const megamorphic = findings.filter(
      (found) => found.kind === "megamorphic-ic"
    );
    expect(megamorphic).toHaveLength(1);
    const [found] = megamorphic;
    expect(found?.evidence["keys"]).toEqual(["js", "gc", "other"]);
    expect(found?.evidence["distinctKeys"]).toBe(3);
    expect(found?.evidence).not.toHaveProperty("key");
    expect(found?.summary).toContain("dynamic-key");
    expect(found?.summary).toContain("3 distinct keys");
    expect(found ? findingIdentity(found) : "").toMatch(/\|KeyedLoadIC$/u);
  });
});

describe("computeFindings for insufficient-type-feedback deopts", () => {
  const deoptSite = (reasons: string[]): LogModel["deopts"][number] => ({
    file: "file:///app/src/hot.js",
    line: 4,
    column: 12,
    functionName: "add",
    kind: "eager",
    reasons: [...new Set(reasons)],
    count: reasons.length,
    inlinedCount: 0,
    firstTime: 0,
    lastTime: reasons.length,
    events: reasons.map((reason, index) => ({ time: index, reason }))
  });
  const kindsFor = (...reasons: string[]): string[] =>
    computeFindings(modelWith({ ics: [], deopts: [deoptSite(reasons)] })).map(
      ({ kind }) => kind
    );

  // V8 removed the soft deopt kind and logs feedback bailouts as eager; they are
  // warm-up, not instability, and must not gate CI.
  it("classifies repeated feedback bailouts as a soft deopt, never a deopt loop", () => {
    expect(
      kindsFor(
        "Insufficient type feedback for binary operation",
        "Insufficient type feedback for binary operation"
      )
    ).toEqual(["soft-deopt"]);
  });

  it("still reports repeated real deopts at a site as a deopt loop", () => {
    expect(kindsFor("wrong map", "wrong map")).toEqual(["deopt-loop"]);
  });

  it("splits a site's real and feedback deopts into separate findings", () => {
    expect(
      kindsFor("wrong map", "Insufficient type feedback for call").sort()
    ).toEqual(["eager-deopt", "soft-deopt"]);
  });
});

describe("computeFindings user-code filter", () => {
  // On Windows V8 logs CommonJS scripts with OS paths (C:\...\node_modules\ajv\dist\ajv.js)
  // and ESM with file URLs, so a forward-slash-only test let dependency code through as
  // user code and baselines filled with findings about code the user does not own.
  it("excludes dependency code logged with Windows backslash paths", () => {
    const icSite = (file: string): LogModel["ics"][number] => ({
      type: "LoadIC",
      file,
      functionName: "dispatch",
      line: 10,
      column: 5,
      key: "name",
      keys: ["name"],
      distinctKeys: 1,
      worstState: "megamorphic",
      transitions: Array.from({ length: 6 }, (_, index) => ({
        time: index,
        oldState: "polymorphic" as const,
        newState: "megamorphic" as const,
        mapAddress: "0x1"
      }))
    });
    const model: LogModel = {
      v8Version: "14.0.0",
      ics: [
        icSite("C:\\proj\\node_modules\\dep\\index.js"),
        icSite("C:\\proj\\src\\app.js")
      ],
      deopts: [],
      maps: {
        createdCount: 0,
        entries: new Map(),
        eventCounts: {},
        transitionSites: []
      },
      profile: { tickCount: 0, vmStates: {}, functions: [], samples: [] },
      scripts: new Map(),
      functionIndex: [],
      markers: [],
      codeEntryCount: 0,
      codeSourceInfoCount: 0,
      warnings: { unknownCommands: {}, badLines: 0 }
    };
    expect(computeFindings(model).map(({ file }) => file)).toEqual([
      "C:\\proj\\src\\app.js"
    ]);
  });
});

describe("computeFindings across the pathology fixtures", () => {
  let fixtureDir: string;
  let megamorphic: Finding[];
  let deoptLoop: Finding[];
  let mapChurn: Finding[];

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "deoptkit-findings-"));
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
    // Inlined deopts must be attributed to getX's own `obj.x`, not to the caller's
    // position inside a mangled file URL that the LSP and CI annotations cannot open.
    expect(loop?.functionName).toBe("getX");
    expect(loop?.file.includes("inlined at")).toBe(false);
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
