import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LogCategory } from "../collect/runner";
import { v8FlagsFor } from "../collect/runner";

export interface DeoptKitPresetOptions {
  /** Where per-process V8 logs and the manifest land (default ".deopt"). */
  outDir?: string;
  /** Log categories to record (default: all). */
  categories?: LogCategory[];
}

export interface DeoptKitTestConfig {
  pool: "forks";
  poolOptions: { forks: { execArgv: string[] } };
  globalSetup: string[];
}

/**
 * Vitest bench-mode preset: spread into the `test` config to run benchmark workers
 * under V8 optimization logging.
 *
 * ```ts
 * import { deoptKit } from "deoptkit/vitest";
 * export default defineConfig({
 *   test: { ...deoptKit({ outDir: ".deopt" }) }
 * });
 * ```
 *
 * Forces the forks pool (worker threads would interleave isolate logs in one file)
 * and writes one log per worker process via V8's `%p` pid placeholder. After the
 * run, the global setup's teardown writes `<outDir>/manifest.json` listing the logs
 * for `load_manifest`. Wrap bench bodies with `benchObserved` from `deoptkit/bench`
 * so each case gets fromMark/toMark window markers.
 */
export const deoptKit = (
  options: DeoptKitPresetOptions = {}
): DeoptKitTestConfig => {
  const outDir = resolve(options.outDir ?? ".deopt");
  mkdirSync(outDir, { recursive: true });
  // The global setup module runs in a separate context; hand it the outDir via env.
  process.env["DEOPTKIT_OUT_DIR"] = outDir;
  return {
    pool: "forks",
    poolOptions: {
      forks: {
        execArgv: v8FlagsFor(join(outDir, "v8-%p.log"), options.categories)
      }
    },
    globalSetup: ["deoptkit/vitest/global-setup"]
  };
};
