import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FunctionInfo, LogModel, Tier } from "../../model/logModel";
import { generateWorkloadLog } from "../../parser/__tests__/helpers";
import { parseLog } from "../../parser/parseLog";
import { sessionQuality } from "../quality";

const userFile = "file:///app/src/hot.js";

const fn = (
  functionName: string,
  tiers: Tier[],
  file = userFile
): FunctionInfo => ({
  functionName,
  file,
  line: 1,
  column: 1,
  tiers,
  osr: false,
  codeCreations: tiers.length
});

const model = (parts: Partial<LogModel> = {}): LogModel => ({
  v8Version: "0.0.0",
  ics: [],
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
  warnings: { unknownCommands: {}, badLines: 0 },
  ...parts
});

const icSite = (file = userFile): LogModel["ics"][number] => ({
  type: "LoadIC",
  file,
  functionName: "hot",
  line: 3,
  column: 5,
  key: "x",
  keys: ["x"],
  distinctKeys: 1,
  worstState: "monomorphic",
  transitions: []
});

const tickRow = (
  functionName: string,
  selfTicks: number,
  file = userFile
): LogModel["profile"]["functions"][number] => ({
  functionName,
  file,
  line: 1,
  column: 1,
  selfTicks,
  totalTicks: selfTicks
});

const codes = (quality: ReturnType<typeof sessionQuality>): string[] =>
  quality.warnings.map(({ code }) => code);

describe("sessionQuality", () => {
  // An agent reading findings from a cold run optimizes warm-up artifacts, so a
  // healthy session must come back clean or the warning stops meaning anything:
  // this is the guard against a warning that fires on every run.
  it("reports a warmed-up, sampled session with user code as healthy", () => {
    const quality = sessionQuality(
      model({
        functionIndex: [fn("hot", ["interpreted", "turbofan"])],
        ics: [icSite()],
        profile: {
          tickCount: 40,
          vmStates: { js: 40 },
          functions: [tickRow("hot", 38)],
          samples: []
        }
      })
    );
    expect(quality.warnings).toEqual([]);
    expect(quality).toMatchObject({
      totalTicks: 40,
      userCodeTicks: 38,
      userFunctions: 1,
      userFunctionsOptimized: 1,
      userIcSites: 1
    });
  });

  // A wrong cwd or command yields a log of node: internals; without this warning
  // the empty findings list reads as "nothing wrong" instead of "nothing ran".
  it("warns no-user-code when only node: internals and dependencies ran", () => {
    const quality = sessionQuality(
      model({
        functionIndex: [
          fn("internal", ["turbofan"], "node:internal/modules/cjs/loader"),
          fn("dep", ["turbofan"], "file:///app/node_modules/lib/index.js")
        ],
        ics: [icSite("node:internal/util")],
        profile: {
          tickCount: 10,
          vmStates: { js: 10 },
          functions: [tickRow("internal", 10, "node:internal/util")],
          samples: []
        }
      })
    );
    expect(codes(quality)).toEqual(["no-user-code"]);
    expect(quality.userCodeTicks).toBe(0);
  });

  // Cold only means something when user code exists; with no user code at all the
  // sharper no-user-code warning already says why nothing was optimized.
  it("warns cold, not no-user-code, when user code never reached an optimizing tier", () => {
    const quality = sessionQuality(
      model({
        functionIndex: [fn("hot", ["interpreted", "baseline"])],
        ics: [icSite()],
        profile: {
          tickCount: 5,
          vmStates: { js: 5 },
          functions: [tickRow("hot", 5)],
          samples: []
        }
      })
    );
    expect(codes(quality)).toEqual(["cold"]);
    expect(quality.userFunctionsOptimized).toBe(0);
  });

  // A run shorter than one sampling interval has no heat data at all; findings
  // would be unranked guesses.
  it("warns no-ticks when the profiler recorded no samples", () => {
    const quality = sessionQuality(
      model({
        functionIndex: [fn("hot", ["maglev"])],
        ics: [icSite()]
      })
    );
    expect(codes(quality)).toEqual(["no-ticks"]);
  });

  const samplesEvery = (
    intervalMs: number,
    count: number
  ): LogModel["profile"]["samples"] =>
    Array.from({ length: count }, (_, index) => ({
      time: index * intervalMs * 1000,
      vmState: "js",
      self: undefined,
      onStack: [],
      frames: []
    }));

  // A remark workload took 158 s under full logging and produced 294 ticks; the
  // call tree built from them pointed at the wrong plugin until a profile-only run
  // sampled every 17 ms. The session has to say its ticks are too few to rank by.
  it("warns sparse-ticks when the sampler fell far behind, naming the profile-only pass", () => {
    const quality = sessionQuality(
      model({
        functionIndex: [fn("hot", ["turbofan"])],
        ics: [icSite()],
        profile: {
          tickCount: 4,
          vmStates: { js: 4 },
          functions: [tickRow("hot", 4)],
          samples: samplesEvery(500, 4)
        }
      })
    );
    expect(codes(quality)).toEqual(["sparse-ticks"]);
    expect(quality.tickIntervalMs).toBe(500);
    expect(quality.warnings[0]?.message).toContain('categories: ["profile"]');
    expect(quality.warnings[0]?.message).toContain("4 ticks");
  });

  // Windows samples every 15 ms or so when the sampler keeps up; that must read as
  // healthy or the warning fires on every Windows run.
  it("accepts the platform's normal sampling interval", () => {
    const quality = sessionQuality(
      model({
        functionIndex: [fn("hot", ["turbofan"])],
        ics: [icSite()],
        profile: {
          tickCount: 40,
          vmStates: { js: 40 },
          functions: [tickRow("hot", 40)],
          samples: samplesEvery(15, 40)
        }
      })
    );
    expect(quality.warnings).toEqual([]);
    expect(quality.tickIntervalMs).toBe(15);
  });

  it("orders warnings no-user-code, cold, no-ticks when several apply", () => {
    expect(codes(sessionQuality(model()))).toEqual([
      "no-user-code",
      "no-ticks"
    ]);
    expect(
      codes(
        sessionQuality(
          model({ functionIndex: [fn("hot", ["interpreted"])], ics: [] })
        )
      )
    ).toEqual(["cold", "no-ticks"]);
  });

  // Windows V8 logs CommonJS scripts with OS paths; a forward-slash-only test would
  // count dependency code as the user's and silence the no-user-code warning.
  it("treats backslash node_modules paths as dependency code", () => {
    const quality = sessionQuality(
      model({
        functionIndex: [
          fn("dep", ["turbofan"], "C:\\app\\node_modules\\ajv\\dist\\ajv.js")
        ]
      })
    );
    expect(quality.userFunctions).toBe(0);
    expect(codes(quality)).toContain("no-user-code");
  });
});

describe("sessionQuality on the deopt-loop workload", () => {
  let fixtureDir: string;
  let quality: ReturnType<typeof sessionQuality>;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "deoptkit-quality-"));
    quality = sessionQuality(
      await parseLog(generateWorkloadLog("deopt-loop", fixtureDir))
    );
  }, 60_000);

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  // The fixture's `hot` deopts, and a deopt needs optimized code to bail out of, so
  // it is optimized by construction. If this warns cold, the tier derivation (not
  // the workload) is broken and every real run would carry a false warning.
  it("is neither cold nor missing user code", () => {
    expect(codes(quality)).not.toContain("cold");
    expect(codes(quality)).not.toContain("no-user-code");
    expect(quality.userFunctionsOptimized).toBeGreaterThanOrEqual(1);
  });
});
