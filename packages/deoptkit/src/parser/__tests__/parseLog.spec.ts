import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { LogModel } from "../../model/logModel";
import { normalizeScriptUrl, parseDeoptLocation, parseLog } from "../parseLog";
import { generateWorkloadLog } from "./helpers";

describe("parseLog on a real generated V8 log", () => {
  let fixtureDir: string;
  let model: LogModel;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "deoptkit-parse-"));
    model = await parseLog(generateWorkloadLog("megamorphic", fixtureDir));
  }, 60_000);

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it("reads the v8-version header", () => {
    expect(model.v8Version).toMatch(/^\d+\.\d+\./u);
  });

  // The workload's whole purpose: getX's property load sees 8 shapes, so its IC must
  // escalate to megamorphic. If this fails, either V8's log format drifted or the
  // parser lost the ability to detect the exact pathology this tool exists to find.
  it("detects the deliberately megamorphic LoadIC at its source position", () => {
    const site = model.ics.find(
      (candidate) =>
        candidate.file?.endsWith("megamorphic.js") === true &&
        candidate.key === "x"
    );
    expect(site).toBeDefined();
    expect(site?.type).toBe("LoadIC");
    expect(site?.worstState).toBe("megamorphic");
    expect(site?.functionName).toContain("getX");
    expect(site?.line).toBe(7);
    expect(site?.column).toBeGreaterThan(0);
    // uninitialized -> mono -> poly escalation takes several recorded transitions.
    expect(site?.transitions.length).toBeGreaterThanOrEqual(4);
  });

  it("attributes deopts in the workload to file/line with kind and reason", () => {
    const sites = model.deopts.filter((site) =>
      site.file.endsWith("megamorphic.js")
    );
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      expect(site.kind).not.toBe("unknown");
      expect(site.line).toBeGreaterThan(0);
      expect(site.count).toBeGreaterThan(0);
      expect(site.reasons.length).toBeGreaterThan(0);
    }
  });

  it("indexes code entries so IC pcs resolve through the code map", () => {
    expect(model.codeEntryCount).toBeGreaterThan(100);
  });

  // get_function serves annotated snippets straight from the log's embedded sources,
  // so agents never need a separate file read (or the original file at all).
  it("captures script sources and a function index", () => {
    const url = [...model.scripts.keys()].find((candidate) =>
      candidate.endsWith("megamorphic.js")
    );
    expect(url).toBeDefined();
    expect(model.scripts.get(url ?? "")).toContain("return obj.x;");
    const fn = model.functionIndex.find(
      (info) => info.functionName === "getX" && info.file === url
    );
    expect(fn?.line).toBe(6);
    // The hot loop drives getX through multiple optimization tiers.
    expect(fn?.tiers.length).toBeGreaterThanOrEqual(2);
  });

  // Each shape literal in the workload adds `x` at a different offset, so V8 records
  // a map Transition per shape, all attributed to the literal site. Losing this means
  // losing the map-churn signal that explains WHY a site went megamorphic.
  it("attributes the shape literals' map transitions to their source position", () => {
    expect(model.maps.createdCount).toBeGreaterThan(100);
    const site = model.maps.transitionSites.find(
      (candidate) =>
        candidate.file?.endsWith("megamorphic.js") === true &&
        candidate.propertyNames.includes("x")
    );
    expect(site).toBeDefined();
    expect(site?.count).toBeGreaterThanOrEqual(8);
  });

  // The megamorphic IC's observed maps must resolve to parsed map entries — this
  // linkage is how get_map will explain which shapes polluted a call site.
  it("links IC transitions to map entries seen in map events", () => {
    const site = model.ics.find(
      (candidate) =>
        candidate.file?.endsWith("megamorphic.js") === true &&
        candidate.key === "x"
    );
    const known = site?.transitions.filter(({ mapAddress }) =>
      model.maps.entries.has(mapAddress)
    );
    expect(known?.length ?? 0).toBeGreaterThan(0);
  });

  // get_map answers "which properties, in what order" from these parsed shapes; a
  // shape literal whose `x` lost its representation would leave nothing to compare.
  it("parses map-details into structured shapes", () => {
    const entries = [...model.maps.entries.values()];
    expect(
      entries.filter(({ details }) => details?.type === "JS_OBJECT_TYPE").length
    ).toBeGreaterThan(100);
    const literal = entries.find(
      ({ details }) =>
        details?.constructorName === "Object" &&
        details.properties.some(({ name }) => name === "x")
    );
    const x = literal?.details?.properties.find(({ name }) => name === "x");
    expect(x?.representation).toBeDefined();
    expect(literal?.details?.unparsedLines).toBe(0);
    // A non-zero count means V8 changed the block format and the shape data is
    // silently incomplete.
    expect(
      entries.reduce(
        (sum, { details }) => sum + (details?.unparsedLines ?? 0),
        0
      )
    ).toBe(0);
    // Transition events carry the map they produced, so findings can name it.
    expect(model.maps.transitionSites[0]?.events[0]?.mapAddress).toMatch(
      /^0x/u
    );
  });

  // The workload spends ~1s inside its hot loop, so the profiler must attribute
  // meaningful self time to code in megamorphic.js — the signal severity ranking
  // uses to weight megamorphic ICs by how hot their surroundings actually are.
  it("attributes profiler self ticks to the hot workload code", () => {
    // Windows caps --prof sampling at ~15ms/sample, so thresholds stay loose.
    expect(model.profile.tickCount).toBeGreaterThan(5);
    const total = Object.values(model.profile.vmStates).reduce(
      (a, b) => a + b,
      0
    );
    expect(total).toBe(model.profile.tickCount);
    const hot = model.profile.functions.find(
      (row) =>
        row.file?.endsWith("megamorphic.js") === true && row.selfTicks > 0
    );
    expect(hot).toBeDefined();
    expect(hot?.totalTicks).toBeGreaterThanOrEqual(hot?.selfTicks ?? 0);
  });

  // The real flag set must keep producing the tables, or every attribution silently
  // degrades to the caller: inlined ICs, ticks, and map transitions land on the function
  // V8 inlined them into. Node 26 writes 49 tables for this workload.
  it("decodes the code-source-info tables the real flag set produces", () => {
    expect(model.codeSourceInfoCount).toBeGreaterThan(40);
    expect(Object.keys(model.warnings.unknownCommands)).not.toContain(
      "code-source-info"
    );
  });

  // Events we deliberately do not handle yet must surface in warnings rather than
  // vanish — agents need to know when a log contains data the parser skipped.
  it("counts unhandled commands instead of dropping them silently", () => {
    expect(model.warnings.badLines).toBe(0);
    const unknown = Object.keys(model.warnings.unknownCommands);
    // v8-platform appears in every log; tick counts are sampling-dependent and can be
    // zero on a fast run, so they are not asserted.
    expect(unknown).toEqual(expect.arrayContaining(["v8-platform"]));
    expect(unknown).not.toEqual(
      expect.arrayContaining([
        "map-create",
        "map",
        "map-details",
        "script-source"
      ])
    );
  });
});

describe("parseDeoptLocation", () => {
  const url =
    "file:///C:/GitHub/@saeris/deopt-mcp/fixtures/workloads/deopt-loop.js";

  it("parses a plain location as one position with no inlining chain", () => {
    expect(parseDeoptLocation(`<${url}:10:14>`)).toEqual({
      site: { file: url, line: 10, column: 14 },
      inlinedAt: []
    });
  });

  // V8 appends ` inlined at <...>` for code inlined into a caller. Greedy-matching the
  // whole string used to swallow `...:10:14> inlined at <file...` as the file name and
  // report the caller's position, which made one deopt loop look like two sites with a
  // bogus URL that downstream consumers (LSP, CI annotations) could not resolve.
  it("splits an inlined location into the deopting expression and its caller chain", () => {
    const parsed = parseDeoptLocation(
      `<${url}:10:14> inlined at <${url}:16:12>`
    );
    expect(parsed?.site).toEqual({ file: url, line: 10, column: 14 });
    expect(parsed?.inlinedAt).toEqual([{ file: url, line: 16, column: 12 }]);
    expect(parsed?.site.file).not.toMatch(/[<>]/u);
  });

  it("keeps every level of a nested inlining chain, innermost first", () => {
    const parsed = parseDeoptLocation(
      `<${url}:10:14> inlined at <${url}:16:12> inlined at <${url}:30:3>`
    );
    expect(parsed?.inlinedAt).toEqual([
      { file: url, line: 16, column: 12 },
      { file: url, line: 30, column: 3 }
    ]);
  });

  it("rejects text that is not a location so the reader counts a bad line", () => {
    expect(parseDeoptLocation("not a location")).toBeUndefined();
    expect(
      parseDeoptLocation(`<${url}:10:14> inlined at oops`)
    ).toBeUndefined();
  });

  // Deopt sites feed the same finding identity as code entries, so a loader query on
  // either the site or an inlining caller must be dropped or baselines never match.
  it("drops loader queries from the site and every inlining caller", () => {
    const parsed = parseDeoptLocation(
      "<file:///C:/app/lib.ts?vitest=123:10:14> inlined at <file:///C:/app/lib.ts?vitest=123:16:12>"
    );
    expect(parsed?.site.file).toBe("file:///C:/app/lib.ts");
    expect(parsed?.inlinedAt[0]?.file).toBe("file:///C:/app/lib.ts");
  });
});

describe("normalizeScriptUrl", () => {
  it("strips a loader cache-busting query from a file URL", () => {
    expect(normalizeScriptUrl("file:///C:/app/lib.ts?vitest=123")).toBe(
      "file:///C:/app/lib.ts"
    );
  });

  it("strips a query and fragment together", () => {
    expect(normalizeScriptUrl("file:///app/x.js?t=1#frag")).toBe(
      "file:///app/x.js"
    );
  });

  it("leaves non-file URLs untouched", () => {
    expect(normalizeScriptUrl("node:internal/x")).toBe("node:internal/x");
  });

  it("leaves a file URL without a query untouched", () => {
    expect(normalizeScriptUrl("file:///C:/app/lib.ts")).toBe(
      "file:///C:/app/lib.ts"
    );
  });
});

describe("parseLog with loader query strings in script URLs", () => {
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "deoptkit-parse-query-"));
  });

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  // Vitest's native loader appends `?vitest=<timestamp>` to every bench file it
  // imports; without normalization each run produces a different finding identity, so
  // CI baselines never match and the source file cannot be found on disk.
  it("reports the code map, IC sites, and script sources under the bare URL", async () => {
    const path = join(fixtureDir, "query.v8.log");
    await writeFile(
      path,
      [
        "v8-version,14,6,0,0,-node.1,0",
        "code-creation,JS,10,50,0x1000,64,getX file:///C:/app/lib.ts?vitest=123:2:49,0x2fcf,+'",
        "script-source,84,file:///C:/app/lib.ts?vitest=123,export const getX = (o) => o.x;",
        "LoadIC,0x1010,100,2,49,1,N,0x2,x",
        ""
      ].join("\n")
    );
    const model = await parseLog(path);
    const bare = "file:///C:/app/lib.ts";
    expect(model.ics[0]?.file).toBe(bare);
    expect(model.scripts.has(bare)).toBe(true);
    expect(model.functionIndex[0]?.file).toBe(bare);
    expect([...model.scripts.keys()].some((key) => key.includes("?"))).toBe(
      false
    );
  });
});

describe("parseLog on the deopt-loop workload", () => {
  let fixtureDir: string;
  let model: LogModel;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "deoptkit-parse-deopt-"));
    model = await parseLog(generateWorkloadLog("deopt-loop", fixtureDir));
  }, 60_000);

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  // The deopt-loop fixture is this tool's definition of the pathology: one expression
  // (`obj.x` in getX) deopts once per new shape. V8 logs some of those deopts as inlined
  // into `hot` and some not, so a parser that keys sites by the caller's position would
  // split the loop and under-count it, hiding the repeated-deopt signal.
  it("merges inlined and non-inlined deopts of one expression into a single named site", () => {
    const sites = model.deopts.filter(
      (site) =>
        site.file.endsWith("deopt-loop.js") &&
        site.kind === "eager" &&
        site.line === 10 &&
        site.column === 14
    );
    expect(sites).toHaveLength(1);
    const [site] = sites;
    expect(site?.functionName).toBe("getX");
    expect(site?.count).toBeGreaterThanOrEqual(5);
    expect(site?.inlinedCount).toBeGreaterThanOrEqual(1);
    expect(site?.events.some((event) => event.inlinedAt !== undefined)).toBe(
      true
    );
    expect(
      model.deopts.some((entry) => entry.file.includes("inlined at"))
    ).toBe(false);
  });

  // V8's code-creation kind numbers shift between versions; the marker alphabet does
  // not, and agents read these names. A deopt needs optimized code to bail out of, so
  // `hot` must name TurboFan and the inlined `getX` an optimizing tier.
  it("names the optimization tiers a function reached from the code-creation markers", () => {
    const tiersOf = (name: string): string[] =>
      model.functionIndex.find(
        (info) =>
          info.functionName === name && info.file.endsWith("deopt-loop.js")
      )?.tiers ?? [];
    expect(tiersOf("hot")).toContain("turbofan");
    expect(
      tiersOf("getX").some((tier) => tier === "maglev" || tier === "turbofan")
    ).toBe(true);
  });
});

describe("parseLog resolves inlined positions through code-source-info", () => {
  const LIB = "file:///app/lib.js";
  const MAIN = "file:///app/main.js";
  let fixtureDir: string;
  let model: LogModel;

  // getX (lib.js) is inlined into hot (main.js). V8 logs every event from the inlined
  // copy with hot's code address, and resolves the logged line/column against
  // main.js; only hot's code-source-info tables say the pc is really inside getX.
  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "deoptkit-parse-inlining-"));
    const path = join(fixtureDir, "inlining.v8.log");
    await writeFile(
      path,
      [
        "v8-version,14,0,0,0,-node.0,0",
        // Each `\\n` writes a backslash and an n, which the CSV reader decodes as a newline.
        `script-source,7,${LIB},export const getX = (o) => o.x;\\n`,
        `script-source,8,${MAIN},// caller\\nimport { getX } from "./lib.js";\\nfunction hot(o) { return getX(o); }\\n`,
        `code-creation,JS,10,1000,0x1000,64,getX ${LIB}:1:21,0x7001,~`,
        "code-source-info,0x1000,7,20,31,C0O21C8O27C16O29,,",
        `code-creation,JS,13,2000,0x2000,256,hot ${MAIN}:3:13,0x7002,*`,
        "code-source-info,0x2000,8,43,78,C0O59C16O72C32O29I0C48O75,F0O72,S0x7001",
        "LoadIC,0x1012,2500,1,30,0,1,0x9000,x,,",
        "LoadIC,0x2028,3000,2,20,P,N,0x9001,x,,",
        "LoadIC,0x2030,3050,2,20,P,N,0x9002,x,,",
        "tick,0x2028,3100,0,0x0,0,0x2010",
        "tick,0x2030,3150,0,0x0,0,0x2030",
        "map,Transition,3300,0x8001,0x8002,0x2028,2,20,,x",
        `code-deopt,3200,256,0x2000,0,29,deopt-eager,<${LIB}:1:30> inlined at <${MAIN}:3:30>,wrong map`,
        ""
      ].join("\n")
    );
    model = await parseLog(path);
  });

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it("decodes every table that follows a known code object", () => {
    expect(model.warnings.unknownCommands["code-source-info"]).toBeUndefined();
    expect(model.codeSourceInfoCount).toBe(2);
  });

  // Without the tables the second event becomes a second site in main.js at 2:20 — the
  // ghost finding the e2e suite guards against.
  it("merges the inlined IC event into the callee's own site", () => {
    const sites = model.ics.filter((site) => site.key === "x");
    expect(sites).toHaveLength(1);
    const [site] = sites;
    expect(site?.file).toBe(LIB);
    expect(site?.line).toBe(1);
    expect(site?.column).toBe(30);
    expect(site?.functionName).toBe("getX");
    // The third event's pc (offset 48 in hot's TurboFan code) is the return address
    // after the call into the IC runtime, and V8's Code::SourcePosition subtracts one
    // before the lookup, so the entry at the exact offset names the call site while the
    // real position is one byte back, inside inlined getX.
    expect(site?.transitions).toHaveLength(3);
    expect(site?.worstState).toBe("megamorphic");
  });

  // Charging inlined ticks to the caller left getX with zero self time, so its
  // findings ranked by its file's heat instead of its own.
  it("gives the self tick to the inlined function and keeps the caller on the stack", () => {
    expect(model.profile.samples[0]?.self).toBe(`getX|${LIB}|1|21`);
    expect(model.profile.samples[0]?.onStack).toEqual([
      `getX|${LIB}|1|21`,
      `hot|${MAIN}|3|13`
    ]);
    // A sampled pc is exact: offset 48 is hot's own call site, not inlined code.
    expect(model.profile.samples[1]?.self).toBe(`hot|${MAIN}|3|13`);
    // A stack frame is a return address: one byte back, offset 47 is inlined getX.
    expect(model.profile.samples[1]?.onStack).toEqual(
      expect.arrayContaining([`hot|${MAIN}|3|13`, `getX|${LIB}|1|21`])
    );
    const row = (name: string): unknown =>
      model.profile.functions.find((fn) => fn.functionName === name);
    expect(row("getX")).toMatchObject({ selfTicks: 1, totalTicks: 2 });
    expect(row("hot")).toMatchObject({ selfTicks: 1, totalTicks: 2 });
  });

  // Map transitions are logged with the same caller-relative pc and position as ICs,
  // so an inlined constructor's churn would otherwise land at a bogus caller position.
  it("attributes a map transition from inlined code to the callee's position", () => {
    expect(model.maps.transitionSites[0]).toMatchObject({
      file: LIB,
      functionName: "getX",
      line: 1,
      column: 30
    });
  });

  // The deopting code object is hot's; its inlining id must name getX through the
  // table rather than fall back to the code object's own name.
  it("names an inlined deopt's function through the inlining table", () => {
    expect(model.deopts[0]?.functionName).toBe("getX");
    expect(model.deopts[0]?.inlinedCount).toBe(1);
  });

  // The two fixture creations carry the `~` and `*` markers; the tier names must come
  // from those, since the kind numbers (10, 13) mean different things per V8 version.
  it("derives each function's tier from its code-creation marker", () => {
    const info = (name: string): unknown =>
      model.functionIndex.find((fn) => fn.functionName === name);
    expect(info("hot")).toMatchObject({ tiers: ["turbofan"], osr: false });
    expect(info("getX")).toMatchObject({ tiers: ["interpreted"], osr: false });
  });
});

describe("parseLog tier names from code-creation markers", () => {
  let fixtureDir: string;
  let model: LogModel;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "deoptkit-parse-tiers-"));
    const path = join(fixtureDir, "tiers.v8.log");
    const create = (name: string, address: string, marker: string): string =>
      `code-creation,JS,10,50,${address},64,${name} file:///app/tiers.js:1:1,0x7001,${marker}`;
    await writeFile(
      path,
      [
        "v8-version,14,0,0,0,-node.0,0",
        create("osrTurbofan", "0x1000", "o*"),
        create("maglevSpecialized", "0x2000", "+'"),
        create("baseline", "0x3000", "^"),
        // V8 writes nothing for interpreted code whose optimization is disabled.
        create("unmarked", "0x4000", ""),
        ""
      ].join("\n")
    );
    model = await parseLog(path);
  });

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  // The osr flag must survive the tier collapse: an OSR-compiled tier is entered
  // mid-loop, which tells an agent the function's hot loop ran once, not that it was
  // called often.
  it("maps the marker alphabet to tier names and flags on-stack replacement", () => {
    const info = (name: string): unknown =>
      model.functionIndex.find((fn) => fn.functionName === name);
    expect(info("osrTurbofan")).toMatchObject({
      tiers: ["turbofan"],
      osr: true
    });
    expect(info("maglevSpecialized")).toMatchObject({
      tiers: ["maglev"],
      osr: false
    });
    expect(info("baseline")).toMatchObject({ tiers: ["baseline"], osr: false });
    expect(info("unmarked")).toMatchObject({
      tiers: ["interpreted"],
      osr: false
    });
  });
});

describe("parseLog models keyed IC sites by position", () => {
  let fixtureDir: string;
  let model: LogModel;

  // V8's feedback is one slot per syntactic site; before this change the keyed events
  // became three sites and the megamorphic one named whichever key was being accessed
  // at the time.
  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "deoptkit-parse-keyed-"));
    const path = join(fixtureDir, "keyed.v8.log");
    await writeFile(
      path,
      [
        "v8-version,14,0,0,0,-node.0,0",
        "script-source,7,file:///app/k.js,const f = (o, k) => o[k];\\n",
        "code-creation,JS,10,1000,0x1000,64,f file:///app/k.js:1:11,0x7001,~",
        "KeyedLoadIC,0x1010,2000,1,22,0,1,0x9001,a,,",
        "KeyedLoadIC,0x1010,2100,1,22,1,P,0x9002,b,,",
        "KeyedLoadIC,0x1010,2200,1,22,P,N,0x9003,c,,",
        "KeyedLoadIC,0x1010,2300,1,22,N,N,0x9004,a,,",
        "LoadIC,0x1020,2400,1,22,0,1,0x9005,x,,",
        "LoadIC,0x1020,2500,1,22,1,P,0x9006,y,,",
        ""
      ].join("\n")
    );
    model = await parseLog(path);
  });

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it("folds every key of a keyed access into one site that records the distinct keys", () => {
    const keyed = model.ics.filter((site) => site.type === "KeyedLoadIC");
    expect(keyed).toHaveLength(1);
    const [site] = keyed;
    expect(site?.transitions).toHaveLength(4);
    expect(site?.worstState).toBe("megamorphic");
    expect(site?.keys).toEqual(["a", "b", "c"]);
    expect(site?.distinctKeys).toBe(3);
    expect(site?.key).toBe("a");
  });

  // The count is what tells an agent a site is truly dynamic; an over-count past the cap
  // would make a 33-key site look like it keeps growing.
  it("keeps distinctKeys exact past the cap on retained keys", async () => {
    const path = join(fixtureDir, "keyed-cap.v8.log");
    const keys = Array.from({ length: 40 }, (_, index) => `k${index}`);
    const states = ["0,1", "1,P", "P,N"];
    await writeFile(
      path,
      [
        "v8-version,14,0,0,0,-node.0,0",
        "script-source,7,file:///app/k.js,const f = (o, k) => o[k];\\n",
        "code-creation,JS,10,1000,0x1000,64,f file:///app/k.js:1:11,0x7001,~",
        // The last key is repeated: it sits past the cap, so it is not retained, and
        // checking membership against the capped list would count it as new again.
        ...[...keys, "k39"].map(
          (key, index) =>
            `KeyedLoadIC,0x1010,${2000 + index},1,22,${states[index] ?? "N,N"},0x9001,${key},,`
        ),
        ""
      ].join("\n")
    );
    const [site, ...rest] = (await parseLog(path)).ics;
    expect(rest).toHaveLength(0);
    expect(site?.keys).toHaveLength(32);
    expect(site?.distinctKeys).toBe(40);
    expect(site?.transitions).toHaveLength(41);
  });

  // Only keyed ICs fold by position: a named IC's key is the property written in the
  // source, so named sites must stay separate per key rather than collapse with them.
  it("keeps one site per property for named ICs", () => {
    const named = model.ics.filter((site) => site.type === "LoadIC");
    expect(named.map((site) => site.key).sort()).toEqual(["x", "y"]);
    for (const site of named) expect(site.transitions).toHaveLength(1);
  });
});
