import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { Finding } from "../findings";
import type { LogModel, Tier } from "../../model/logModel";
import { generateWorkloadLog } from "../../parser/__tests__/helpers";
import { parseMapDetails } from "../../parser/mapDetails";
import { parseLog } from "../../parser/parseLog";
import { findingIdentity } from "../compare";
import { computeFindings } from "../findings";

describe("finding heat", () => {
  it("reports the heat each severity was scored with, zero when the profiler never sampled the code", () => {
    // Editors and agents need to tell a finding that cost time from one that
    // merely recorded many transitions in code the profiler never saw; the
    // score blends both, so the heat it used travels with the finding.
    const site: LogModel["ics"][number] = {
      type: "LoadIC",
      file: "file:///app/src/hot.js",
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
    };
    const model: LogModel = {
      v8Version: "14.0.0",
      ics: [site],
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
    const [cold] = computeFindings(model);
    expect(cold?.heat).toBe(0);

    model.profile = {
      tickCount: 10,
      vmStates: {},
      functions: [
        {
          functionName: "dispatch",
          file: "file:///app/src/hot.js",
          line: 10,
          column: 5,
          selfTicks: 10,
          totalTicks: 10
        }
      ],
      samples: []
    };
    const [hot] = computeFindings(model);
    expect(hot?.heat).toBe(1);
    expect(hot?.severity ?? 0).toBeGreaterThan(cold?.severity ?? 0);
  });
});

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
  const deoptSite = (
    events: { reason: string; tier?: Tier }[]
  ): LogModel["deopts"][number] => ({
    file: "file:///app/src/hot.js",
    line: 4,
    column: 12,
    functionName: "add",
    kind: "eager",
    reasons: [...new Set(events.map(({ reason }) => reason))],
    count: events.length,
    inlinedCount: 0,
    firstTime: 0,
    lastTime: events.length,
    events: events.map((event, index) => ({ time: index, ...event }))
  });
  const findingsFor = (events: { reason: string; tier?: Tier }[]): Finding[] =>
    computeFindings(modelWith({ ics: [], deopts: [deoptSite(events)] }));
  const kindsFor = (...reasons: string[]): string[] =>
    findingsFor(reasons.map((reason) => ({ reason }))).map(({ kind }) => kind);

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

  // One bailout per tier while a function climbs Ignition -> Maglev -> TurboFan is V8
  // learning, not instability. Counting it as a loop made the same code flip between
  // eager-deopt and deopt-loop depending on whether a run happened to reach TurboFan,
  // so a CI baseline could never hold still.
  it("reports one bailout per tier as an eager deopt with per-tier counts, not a loop", () => {
    const found = findingsFor([
      { reason: "wrong map", tier: "maglev" },
      { reason: "wrong map", tier: "turbofan" }
    ]);
    expect(found.map(({ kind }) => kind)).toEqual(["eager-deopt"]);
    expect(found[0]?.evidence["count"]).toBe(2);
    expect(found[0]?.evidence["tiers"]).toEqual({ maglev: 1, turbofan: 1 });
  });

  // The loop signal is V8 re-optimizing with fresh feedback and still bailing out in
  // the same tier; that has to survive the per-tier rule.
  it("reports the same tier bailing out twice as a deopt loop", () => {
    const found = findingsFor([
      { reason: "wrong map", tier: "turbofan" },
      { reason: "wrong map", tier: "turbofan" }
    ]);
    expect(found.map(({ kind }) => kind)).toEqual(["deopt-loop"]);
    expect(found[0]?.evidence["tiers"]).toEqual({ turbofan: 2 });
  });

  it("splits a site's real and feedback deopts into separate findings", () => {
    expect(
      kindsFor("wrong map", "Insufficient type feedback for call").sort()
    ).toEqual(["eager-deopt", "soft-deopt"]);
  });
});

describe("computeFindings for map churn groups", () => {
  // One call per anonymous function, all in one file, each adding the same three
  // properties once.
  const transitionSite = (
    functionLine: number
  ): LogModel["maps"]["transitionSites"][number] => ({
    file: "file:///app/src/build.js",
    functionName: "",
    functionLine,
    functionColumn: 1,
    line: functionLine + 1,
    column: 5,
    propertyNames: ["a", "b", "c"],
    count: 3,
    events: ["a", "b", "c"].map((propertyName, index) => ({
      time: index,
      subtype: "Transition",
      reason: undefined,
      propertyName,
      mapAddress: `0x${functionLine}${index}`
    }))
  });
  const churnFor = (
    ...sites: LogModel["maps"]["transitionSites"]
  ): Finding[] => {
    const model = modelWith({ ics: [], deopts: [] });
    return computeFindings({
      ...model,
      maps: { ...model.maps, transitionSites: sites }
    }).filter(({ kind }) => kind === "map-churn");
  };

  // Anonymous functions (V8 names them "") and module top-level code share the empty
  // name, so grouping by name alone pooled the object literals of unrelated functions
  // into one branching "churn" finding that no edit could ever fix. Each of the three
  // sites below builds its own linear shape; pooled, their identical property names
  // look like one property added from three parent shapes.
  it("does not pool the transitions of different anonymous functions", () => {
    expect(
      churnFor(transitionSite(10), transitionSite(20), transitionSite(30))
    ).toEqual([]);
  });

  // The split must not hide real churn: the same function adding the same property
  // from three parent shapes is the branching this finding exists to report.
  it("still reports one finding when a single function branches", () => {
    const sites = [10, 10, 10].map((line, index) => ({
      ...transitionSite(line),
      line: line + index + 1
    }));
    const found = churnFor(...sites);
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence["maxTransitionsPerProperty"]).toBe(3);
  });
});

describe("computeFindings for normalization events", () => {
  const normalizeSite = (
    events: LogModel["maps"]["transitionSites"][number]["events"]
  ): LogModel["maps"]["transitionSites"][number] => ({
    file: "file:///app/src/build.js",
    functionName: "build",
    functionLine: 1,
    functionColumn: 1,
    line: 3,
    column: 9,
    propertyNames: [],
    count: events.length,
    events
  });
  const normalization = (
    subtype: string,
    reason: string,
    index: number
  ): LogModel["maps"]["transitionSites"][number]["events"][number] => ({
    time: index,
    subtype,
    reason,
    propertyName: undefined,
    mapAddress: "0x9"
  });
  const findingsFor = (
    ...sites: LogModel["maps"]["transitionSites"]
  ): Finding[] => {
    const model = modelWith({ ics: [], deopts: [] });
    return computeFindings({
      ...model,
      maps: { ...model.maps, transitionSites: sites }
    });
  };

  // The Valimock builder stored each mocked key with `result[key] = value`; past 12
  // fields V8 normalized every wide mock, and the NormalizedMapCache logged one
  // `NormalizeCached` event per object at the store. Counted as churn, that read as
  // "200 map transitions" from conditional property order, advice that could not
  // fix it; the mechanism had to be confirmed by hand with %HasFastProperties.
  it("reports objects normalized past the fast-property limit as dictionary-mode, not map churn", () => {
    const found = findingsFor(
      normalizeSite(
        Array.from({ length: 150 }, (_, index) =>
          normalization("NormalizeCached", "TooManyFastProperties", index)
        )
      )
    );
    expect(found.map(({ kind }) => kind)).toEqual(["dictionary-mode"]);
    expect(found[0]?.line).toBe(3);
    expect(found[0]?.evidence).toMatchObject({
      count: 150,
      reasons: ["TooManyFastProperties"]
    });
    expect(found[0]?.suggestedFix).toContain("Object.fromEntries");
  });

  // V8 normalizes prototype objects by design (every class body and Object.create
  // does it), and Node defines `import.meta`'s accessors at the user's first
  // `import.meta` access, so reporting those would send an agent to "fix" each
  // class and every ESM bench that reads import.meta.url.
  it("ignores the normalizations V8 and the host perform on purpose", () => {
    const deliberate = [
      "NormalizeAsPrototype",
      "NormalizeAndCopyAsPrototype",
      "Normalize_AttributesMismatchProtoMap",
      "TransitionToAccessorPair",
      "JSModuleNamespace"
    ];
    expect(
      findingsFor(
        normalizeSite(
          Array.from({ length: 150 }, (_, index) =>
            normalization(
              "Normalize",
              deliberate[index % deliberate.length] ?? "",
              index
            )
          )
        )
      )
    ).toEqual([]);
  });

  it("reports a delete-driven normalization alongside the keyed-store one", () => {
    const found = findingsFor(
      normalizeSite([
        normalization("NormalizeCached", "DeletingProperty", 0),
        normalization("NormalizeCached", "TooManyFastProperties", 1)
      ])
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence["reasons"]).toEqual([
      "DeletingProperty",
      "TooManyFastProperties"
    ]);
  });
});

describe("computeFindings classifies IC receivers by map type", () => {
  const site = (addresses: string[]): LogModel["ics"][number] => ({
    type: "LoadIC",
    file: "file:///app/src/hot.js",
    functionName: "hot",
    line: 4,
    column: 12,
    key: "length",
    keys: ["length"],
    distinctKeys: 1,
    worstState: "megamorphic",
    transitions: addresses.map((mapAddress, index) => ({
      time: index,
      oldState: "polymorphic" as const,
      newState: "megamorphic" as const,
      mapAddress
    }))
  });
  const entry = (
    address: string,
    type: string,
    elementsKind?: string
  ): [
    string,
    LogModel["maps"]["entries"] extends Map<string, infer T> ? T : never
  ] => [
    address,
    {
      address,
      createdAt: 0,
      details: { ...parseMapDetails(""), type, elementsKind },
      parent: undefined,
      subtype: undefined,
      propertyName: undefined
    }
  ];
  const findingFor = (
    addresses: string[],
    entries: ReturnType<typeof entry>[]
  ): Finding | undefined => {
    const model = modelWith({ ics: [site(addresses)], deopts: [] });
    return computeFindings({
      ...model,
      maps: { ...model.maps, entries: new Map(entries) }
    })[0];
  };
  const addresses = ["0x1", "0x2", "0x3", "0x4", "0x5"];
  const objects = findingFor(
    addresses,
    addresses.map((address) => entry(address, "JS_OBJECT_TYPE"))
  );

  // The jisho pass ranked `endsWith` on strings as the session's top finding, with
  // advice to align property initialization order. Strings have no properties to
  // align: V8 picks a map per representation (one-byte, two-byte, cons, sliced),
  // and the agent wasted its first fix on it.
  it("names string representation polymorphism and ranks it below object shapes", () => {
    const strings = findingFor(addresses, [
      entry("0x1", "SEQ_ONE_BYTE_STRING_TYPE"),
      entry("0x2", "SEQ_TWO_BYTE_STRING_TYPE"),
      entry("0x3", "CONS_ONE_BYTE_STRING_TYPE"),
      entry("0x4", "SLICED_ONE_BYTE_STRING_TYPE"),
      entry("0x5", "INTERNALIZED_ONE_BYTE_STRING_TYPE")
    ]);
    expect(strings?.evidence["receiver"]).toBe("string");
    expect(strings?.summary).toContain("string representations");
    expect(strings?.summary).toContain("not object shapes");
    expect(strings?.severity ?? 0).toBeLessThan(objects?.severity ?? 0);
    expect(objects?.evidence["receiver"]).toBe("object");
    expect(objects?.summary).not.toContain("over");
  });

  // Arrays that differ only by elements kind are fixable, but by keeping each
  // array's element type uniform, not by property order: the finding must say which.
  it("names arrays polymorphic over elements kinds and lists the kinds", () => {
    const arrays = findingFor(addresses, [
      entry("0x1", "JS_ARRAY_TYPE", "PACKED_SMI_ELEMENTS"),
      entry("0x2", "JS_ARRAY_TYPE", "PACKED_DOUBLE_ELEMENTS"),
      entry("0x3", "JS_ARRAY_TYPE", "PACKED_ELEMENTS"),
      entry("0x4", "JS_ARRAY_TYPE", "HOLEY_SMI_ELEMENTS"),
      entry("0x5", "JS_ARRAY_TYPE", "HOLEY_ELEMENTS")
    ]);
    expect(arrays?.evidence["receiver"]).toBe("array");
    expect(arrays?.evidence["elementsKinds"]).toEqual([
      "PACKED_SMI_ELEMENTS",
      "PACKED_DOUBLE_ELEMENTS",
      "PACKED_ELEMENTS",
      "HOLEY_SMI_ELEMENTS",
      "HOLEY_ELEMENTS"
    ]);
    expect(arrays?.summary).toContain("elements kinds");
    expect(arrays?.severity ?? 0).toBeLessThan(objects?.severity ?? 0);
    expect(arrays?.severity ?? 0).toBeGreaterThan(
      findingFor(addresses, [
        entry("0x1", "SEQ_ONE_BYTE_STRING_TYPE"),
        entry("0x2", "SEQ_TWO_BYTE_STRING_TYPE")
      ])?.severity ?? 0
    );
  });

  // Arrays polymorphic for any other reason (extra named properties) are shapes,
  // and a site whose maps were never printed must not be guessed at.
  it("treats same-kind arrays as object shapes and leaves unprinted maps unclassified", () => {
    const sameKind = findingFor(addresses, [
      entry("0x1", "JS_ARRAY_TYPE", "PACKED_ELEMENTS"),
      entry("0x2", "JS_ARRAY_TYPE", "PACKED_ELEMENTS")
    ]);
    expect(sameKind?.evidence["receiver"]).toBe("object");
    expect(sameKind?.evidence["elementsKinds"]).toBeUndefined();
    const unprinted = findingFor(addresses, []);
    expect(unprinted?.evidence["receiver"]).toBeUndefined();
    expect(unprinted?.severity).toBe(objects?.severity);
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
  let dictionaryMode: Finding[];

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
    dictionaryMode = computeFindings(
      await parseLog(generateWorkloadLog("dictionary-mode", fixtureDir))
    );
  }, 180_000);

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  // The real log is the contract: V8 logs the keyed builder's normalizations as
  // `NormalizeCached` with reason `TooManyFastProperties` at the store, one finding
  // for the function however many pcs the loop ran under, and never as churn.
  it("reports the keyed builder of the dictionary-mode fixture once, at its store line", () => {
    const inBuilder = dictionaryMode.filter(
      ({ functionName }) => functionName === "buildRecord"
    );
    expect(inBuilder.some(({ kind }) => kind === "map-churn")).toBe(false);
    const normalized = inBuilder.filter(
      ({ kind }) => kind === "dictionary-mode"
    );
    expect(normalized).toHaveLength(1);
    const [found] = normalized;
    expect(found?.line).toBe(20);
    expect(found?.evidence["reasons"]).toEqual(["TooManyFastProperties"]);
    expect(found?.evidence["count"]).toBeGreaterThanOrEqual(1000);
  });

  it("classifies the fixture's string and array megamorphism from the printed maps", () => {
    const endsWith = dictionaryMode.find(
      ({ evidence }) => evidence["key"] === "endsWith"
    );
    expect(endsWith?.kind).toBe("megamorphic-ic");
    expect(endsWith?.evidence["receiver"]).toBe("string");
    const types = endsWith?.evidence["receiverTypes"];
    expect(
      Array.isArray(types) &&
        types.every((type) => String(type).endsWith("_STRING_TYPE"))
    ).toBe(true);
    const push = dictionaryMode.find(
      ({ evidence }) => evidence["key"] === "push"
    );
    expect(push?.kind).toBe("megamorphic-ic");
    expect(push?.evidence["receiver"]).toBe("array");
    const kinds = push?.evidence["elementsKinds"];
    expect(Array.isArray(kinds) ? kinds.length : 0).toBeGreaterThanOrEqual(2);
    // Neither outranks the dictionary-mode finding, the real problem here. Severity
    // clamps at 100, and on a lane where every sampled tick lands in this file both
    // reach the clamp, so the strict ordering is pinned by the unit tests above.
    const dictionary = dictionaryMode.find(
      ({ kind }) => kind === "dictionary-mode"
    );
    expect(endsWith?.severity ?? 0).toBeLessThanOrEqual(
      dictionary?.severity ?? 0
    );
    expect(push?.severity ?? 0).toBeLessThanOrEqual(dictionary?.severity ?? 0);
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
