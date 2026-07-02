import { readFile } from "node:fs/promises";
import * as v from "valibot";
import { defineTool, jsonResult } from "./defineTool";
import { loadLogFile } from "./loadLog";

const manifestSchema = v.object({
  logfiles: v.array(v.string())
});

export const loadManifest = defineTool({
  name: "load_manifest",
  description:
    "Load every V8 log listed in a deoptkit manifest (written by the deoptkit/vitest bench " +
    "preset to <outDir>/manifest.json) as sessions. Bench cases wrapped with benchObserved " +
    "expose <name>_start/<name>_end markers for the fromMark/toMark window filters.",
  schema: v.object({
    path: v.pipe(
      v.string(),
      v.description("Path to manifest.json, e.g. .deopt/manifest.json")
    )
  }),
  handler: async ({ path }, ctx) => {
    let manifest: v.InferOutput<typeof manifestSchema>;
    try {
      const raw: unknown = JSON.parse(await readFile(path, "utf8"));
      const parsed = v.safeParse(manifestSchema, raw);
      if (!parsed.success) {
        return jsonResult(
          {
            error: `Not a deoptkit manifest (expected { logfiles: string[] }): ${path}`
          },
          { isError: true }
        );
      }
      manifest = parsed.output;
    } catch (error) {
      return jsonResult(
        {
          error: `Cannot read manifest: ${error instanceof Error ? error.message : String(error)}`
        },
        { isError: true }
      );
    }
    if (manifest.logfiles.length === 0) {
      return jsonResult(
        {
          error:
            "Manifest lists no logfiles — did the bench run produce any V8 logs?"
        },
        { isError: true }
      );
    }
    const outcomes = await Promise.all(
      manifest.logfiles.map(async (logfile) => ({
        logfile,
        ...(await loadLogFile(logfile, ctx))
      }))
    );
    const loaded = outcomes.filter((outcome) => !("error" in outcome));
    return jsonResult(
      { loadedCount: loaded.length, sessions: outcomes },
      loaded.length === 0 ? { isError: true } : undefined
    );
  }
});
