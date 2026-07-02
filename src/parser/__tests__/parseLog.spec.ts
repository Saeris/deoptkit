import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { LogModel } from "../../model/logModel";
import { parseLog } from "../parseLog";
import { generateWorkloadLog } from "./helpers";

describe("parseLog on a real generated V8 log", () => {
  let fixtureDir: string;
  let model: LogModel;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "deopt-mcp-parse-"));
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
