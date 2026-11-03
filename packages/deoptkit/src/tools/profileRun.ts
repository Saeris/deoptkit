import { access, rm } from "node:fs/promises";
import * as v from "valibot";
import { LOG_CATEGORIES, runWorkload } from "../collect/runner";
import { parseLog } from "../parser/parseLog";
import { comparisonPayload } from "./compareSessions";
import { defineTool, jsonResult } from "./defineTool";
import { sessionIdSchema, unknownSessionError } from "./shared";

export const profileRun = defineTool({
  name: "profile_run",
  title: "Profile a command",
  description:
    "Run a command under V8 optimization logging and load the result as a session — no flag " +
    "knowledge needed. The executable must be a V8 host that accepts V8 flags (node, or a path " +
    "to one); run npm-script workloads as `node path/to/script.js`. Then call get_findings; pass " +
    "compareTo after a fix to get the before/after comparison in the same call.",
  // It spawns the user's command, so it must never be auto-approved as read-only.
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false
  },
  schema: v.object({
    command: v.pipe(
      v.array(v.string()),
      v.minLength(1),
      v.description(
        'Executable and arguments, e.g. ["node", "bench/index.js", "--iterations", "100"]'
      )
    ),
    cwd: v.optional(
      v.pipe(v.string(), v.description("Working directory for the command"))
    ),
    env: v.optional(
      v.pipe(
        v.record(v.string(), v.string()),
        v.description(
          "Extra environment variables (merged over the server's environment)"
        )
      )
    ),
    timeoutMs: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1000),
        v.maxValue(600_000),
        v.description("Kill the process after this long (default 60000)")
      )
    ),
    categories: v.optional(
      v.pipe(
        v.array(v.picklist(LOG_CATEGORIES)),
        v.description(
          "Log categories to record (default: all of ics, deopts, maps, profile, sources)"
        )
      )
    ),
    compareTo: v.optional(
      v.pipe(
        sessionIdSchema,
        v.description(
          "A base session to compare the new session against; the response then includes `comparison`, the same payload compare_sessions returns"
        )
      )
    )
  }),
  handler: async (
    { command, cwd, env, timeoutMs, categories, compareTo },
    ctx
  ) => {
    // Never spawn a workload for a request that cannot be fulfilled.
    const base =
      compareTo === undefined ? undefined : ctx.sessions.get(compareTo);
    if (compareTo !== undefined && !base) return unknownSessionError(compareTo);
    let run;
    try {
      run = await runWorkload({ command, cwd, env, timeoutMs, categories });
    } catch (error) {
      return jsonResult(
        {
          error: `Failed to start command: ${error instanceof Error ? error.message : String(error)}`
        },
        { isError: true }
      );
    }
    const exit = {
      exitCode: run.exitCode,
      signal: run.signal,
      timedOut: run.timedOut,
      durationMs: run.durationMs,
      stdoutTail: run.stdoutTail,
      stderrTail: run.stderrTail
    };
    try {
      await access(run.logfile);
    } catch {
      await rm(run.dir, { recursive: true, force: true });
      return jsonResult(
        {
          error:
            "The command produced no V8 log. It likely is not a V8 host or rejected the flags — " +
            "see stderrTail.",
          exit
        },
        { isError: true }
      );
    }
    try {
      const model = await parseLog(run.logfile);
      const session = ctx.sessions.add(
        `profile_run: ${command.join(" ")}`,
        model,
        cwd ?? process.cwd()
      );
      return jsonResult({
        sessionId: session.id,
        workspaceRoot: session.workspaceRoot,
        v8Version: model.v8Version,
        exit,
        counts: {
          icSites: model.ics.length,
          deoptSites: model.deopts.length,
          mapsCreated: model.maps.createdCount,
          mapTransitionSites: model.maps.transitionSites.length,
          profileTicks: model.profile.tickCount,
          codeEntries: model.codeEntryCount
        },
        markers: [...new Set(model.markers.map(({ label }) => label))],
        warnings: model.warnings,
        ...(base ? { comparison: comparisonPayload(base, session) } : {})
      });
    } finally {
      await rm(run.dir, { recursive: true, force: true });
    }
  }
});
