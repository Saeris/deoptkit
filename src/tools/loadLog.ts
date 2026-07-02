import { open } from "node:fs/promises";
import * as v from "valibot";
import { defineTool, jsonResult } from "./defineTool";

/** Bytes to sniff from the head of the file when checking it looks like a V8 log. */
const SNIFF_LENGTH = 4096;

/** Every V8 log opens with a `v8-version,<major>,<minor>,...` row (or `code-creation` on ancient builds). */
const V8_LOG_MARKERS = ["v8-version,", "code-creation,", "shared-library,"];

export const loadLog = defineTool({
  name: "load_log",
  description:
    "Parse a V8 log file (v8.log, produced by `node --prof --log-deopt --log-ic --log-maps ...`) " +
    "into a session for analysis. Returns the new session id and summary counts.",
  schema: v.object({
    path: v.pipe(
      v.string(),
      v.description("Absolute path to the v8.log file to load")
    )
  }),
  handler: async ({ path }) => {
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
      return jsonResult(
        {
          error: `Cannot read log file: ${error instanceof Error ? error.message : String(error)}`
        },
        { isError: true }
      );
    }
    if (!V8_LOG_MARKERS.some((marker) => head.includes(marker))) {
      return jsonResult(
        {
          error:
            `File does not look like a V8 log (no ${V8_LOG_MARKERS.join("/")} rows in the first ` +
            `${SNIFF_LENGTH} bytes). Generate one with the V8 logging flags described in this tool's description.`
        },
        { isError: true }
      );
    }
    return jsonResult(
      {
        error:
          "V8 log parsing is not implemented yet (Phase 1 of docs/SPEC.md). " +
          "The file exists and looks like a V8 log, but no session was created."
      },
      { isError: true }
    );
  }
});
