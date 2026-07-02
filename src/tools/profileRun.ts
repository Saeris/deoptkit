import { access, rm } from "node:fs/promises";
import * as v from "valibot";
import { LOG_CATEGORIES, runWorkload } from "../collect/runner";
import { parseLog } from "../parser/parseLog";
import { defineTool, jsonResult } from "./defineTool";

export const profileRun = defineTool({
  name: "profile_run",
  description:
    "Run a command under V8 optimization logging and load the result as a session — no flag " +
    "knowledge needed. The executable must be a V8 host that accepts V8 flags (node, or a path " +
    "to one); run npm-script workloads as `node path/to/script.js`. Then call get_findings.",
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
    )
  }),
  handler: async ({ command, cwd, env, timeoutMs, categories }, ctx) => {
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
        model
      );
      return jsonResult({
        sessionId: session.id,
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
        warnings: model.warnings
      });
    } finally {
      await rm(run.dir, { recursive: true, force: true });
    }
  }
});
