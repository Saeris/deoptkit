import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { LogModel } from "../../model/logModel";
import { parseLog } from "../parseLog";

const WORKLOAD = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "fixtures",
  "workloads",
  "megamorphic.js"
);

// Mirrors fixtures/generate.mjs — the category flags dexnode passes for modern V8.
const v8Flags = (logfile: string): string[] => [
  `--logfile=${logfile}`,
  "--no-logfile-per-isolate",
  "--log-deopt",
  "--log-ic",
  "--log-maps",
  "--log-maps-details",
  "--log-code",
  "--log-source-code",
  "--prof",
  "--log-internal-timer-events",
  "--detailed-line-info"
];

describe("parseLog on a real generated V8 log", () => {
  let fixtureDir: string;
  let model: LogModel;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "deopt-mcp-parse-"));
    const logfile = join(fixtureDir, "megamorphic.log");
    const result = spawnSync(
      process.execPath,
      [...v8Flags(logfile), WORKLOAD],
      { encoding: "utf8" }
    );
    if (result.status !== 0) {
      throw new Error(
        `workload failed (exit ${result.status}): ${result.stderr}`
      );
    }
    model = await parseLog(logfile);
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

  // Events we deliberately do not handle yet must surface in warnings rather than
  // vanish — agents need to know when a log contains data the parser skipped.
  it("counts unhandled commands instead of dropping them silently", () => {
    expect(model.warnings.badLines).toBe(0);
    expect(Object.keys(model.warnings.unknownCommands)).toEqual(
      expect.arrayContaining(["map-create", "tick"])
    );
  });
});
