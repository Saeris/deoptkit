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
  /** Call each case's function exactly this many times (or fewer, when a bench asks for fewer), with no time budget and no warm-up, so logs stay bounded and findings repeat. Needs `benchmark: { provider: "deoptkit/vitest/provider" }`. Default: Vitest's time-based runs. */
  iterations?: number;
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
 *
 * Vitest runs each case for a time budget, so under logging a fast case makes a huge log. Pass `iterations` to run each case a fixed number of times instead. deoptkit's benchmark provider applies the count, and the project selects it in its own `benchmark` config (a spread would replace that key, and with it the project's `include`); the global setup refuses to run if `iterations` is set without it.
 */
export const deoptKit = (
  options: DeoptKitPresetOptions = {}
): DeoptKitTestConfig => {
  const outDir = resolve(options.outDir ?? ".deopt");
  mkdirSync(outDir, { recursive: true });
  // The global setup module runs in a separate context; hand it the outDir via env.
  process.env["DEOPTKIT_OUT_DIR"] = outDir;
  // Forked workers inherit this process's environment, so this reaches the provider.
  // Cleared when unset, so a second call in one process does not inherit a limit.
  if (options.iterations === undefined) {
    delete process.env["DEOPTKIT_ITERATIONS"];
  } else {
    if (!Number.isSafeInteger(options.iterations) || options.iterations < 1) {
      throw new Error(
        `deoptkit: iterations must be a positive integer, received ${String(options.iterations)}.`
      );
    }
    process.env["DEOPTKIT_ITERATIONS"] = String(options.iterations);
  }
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
