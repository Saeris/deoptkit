import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LogCategory } from "../collect/runner";
import { v8FlagsFor } from "../collect/runner";

export interface DeoptKitPresetOptions {
  /** Where per-process V8 logs and the manifest land (default ".deopt"). */
  outDir?: string;
  /** Log categories to record (default: all). */
  categories?: LogCategory[];
  /** Run bench files on Node's native ESM loader instead of Vite's module runner (exact positions, no transform artifacts; requires Node >= 22.18 for .ts files and plain ESM imports). Default false. */
  nativeEsm?: boolean;
}

export interface DeoptKitTestConfig {
  pool: "forks";
  execArgv: string[];
  globalSetup: string[];
  experimental?: { viteModuleRunner: false; nodeLoader: false };
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
 *
 * By default Vitest runs bench files through Vite's module runner, which rewrites imports into property reads and shifts line numbers (recovered later through source maps). Pass `nativeEsm: true` to let Node import the files directly: V8 then observes exactly the shipped code at exact source positions, at the cost of Vite's transforms (aliases, plugins, `vi.mock`, `import.meta.vitest`), so bench files must be plain ESM that Node can resolve.
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
    execArgv: v8FlagsFor(join(outDir, "v8-%p.log"), options.categories),
    globalSetup: ["deoptkit/vitest/global-setup"],
    ...(options.nativeEsm === true
      ? {
          experimental: {
            viteModuleRunner: false as const,
            nodeLoader: false as const
          }
        }
      : {})
  };
};
