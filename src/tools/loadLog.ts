import { open } from "node:fs/promises";
import * as v from "valibot";
import { parseLog } from "../parser/parseLog";
import type { ToolContext } from "./defineTool";
import { defineTool, jsonResult } from "./defineTool";

/** Bytes to sniff from the head of the file when checking it looks like a V8 log. */
const SNIFF_LENGTH = 4096;

/** Every V8 log opens with a `v8-version,<major>,<minor>,...` row (or `code-creation` on ancient builds). */
const V8_LOG_MARKERS = ["v8-version,", "code-creation,", "shared-library,"];

export type LoadOutcome =
  | { error: string }
  | {
      sessionId: string;
      source: string;
      v8Version: string;
      counts: {
        icSites: number;
        deoptSites: number;
        mapsCreated: number;
        mapTransitionSites: number;
        profileTicks: number;
        codeEntries: number;
      };
      markers: string[];
      warnings: { unknownCommands: Record<string, number>; badLines: number };
    };

/** Sniff, parse, and register one v8.log as a session; shared by load_log and load_manifest. */
export const loadLogFile = async (
  path: string,
  ctx: ToolContext
): Promise<LoadOutcome> => {
  let head: string;
  try {
    const file = await open(path, "r");
    try {
      const buffer = Buffer.alloc(SNIFF_LENGTH);
      const { bytesRead } = await file.read(buffer, 0, SNIFF_LENGTH, 0);
      head = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await file.close();
    }
  } catch (error) {
    return {
      error: `Cannot read log file: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  if (!V8_LOG_MARKERS.some((marker) => head.includes(marker))) {
    return {
      error:
        `File does not look like a V8 log (no ${V8_LOG_MARKERS.join("/")} rows in the first ` +
        `${SNIFF_LENGTH} bytes). Generate one with the V8 logging flags this server uses in profile_run.`
    };
  }
  const model = await parseLog(path);
  const session = ctx.sessions.add(path, model);
  return {
    sessionId: session.id,
    source: path,
    v8Version: model.v8Version,
    counts: {
      icSites: model.ics.length,
      deoptSites: model.deopts.length,
      mapsCreated: model.maps.createdCount,
      mapTransitionSites: model.maps.transitionSites.length,
      profileTicks: model.profile.tickCount,
      codeEntries: model.codeEntryCount
    },
    markers: [...new Set(model.markers.map(({ label }) => label))],
    warnings: model.warnings
  };
};

export const loadLog = defineTool({
  name: "load_log",
  description:
    "Parse a V8 log file (v8.log, produced by `node --prof --log-deopt --log-ic --log-maps ...`) " +
    "into a session for analysis. Returns the new session id, summary counts, and parser warnings.",
  schema: v.object({
    path: v.pipe(
      v.string(),
      v.description("Absolute path to the v8.log file to load")
    )
  }),
  handler: async ({ path }, ctx) => {
    const outcome = await loadLogFile(path, ctx);
    return "error" in outcome
      ? jsonResult(outcome, { isError: true })
      : jsonResult(outcome);
  }
});
