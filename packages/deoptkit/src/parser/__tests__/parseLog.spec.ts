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

  it("captures map-details text for later property inspection", () => {
    const withDetails = [...model.maps.entries.values()].filter(
      ({ details }) => details?.includes("[Map]") === true
    );
    expect(withDetails.length).toBeGreaterThan(100);
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
});
