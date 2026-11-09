import { readdirSync, statSync } from "node:fs";
import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { computeFindings } from "../analysis/findings";
import type { Finding } from "../analysis/findings";
import { parseLog } from "../parser/parseLog";
import { SourceMapResolver } from "../sourcemaps/resolver";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Walk `project.config.coverage.enabled` without trusting the host's shape. */
const coverageEnabled = (project: unknown): boolean => {
  if (!isRecord(project)) return false;
  const config = project["config"];
  if (!isRecord(config)) return false;
  const coverage = config["coverage"];
  return isRecord(coverage) && coverage["enabled"] === true;
};

/** Walk `project.config.benchmark.provider`, which Vitest resolves to the module's absolute path. */
const benchmarkProvider = (project: unknown): string | undefined => {
  if (!isRecord(project)) return undefined;
  const config = project["config"];
  if (!isRecord(config)) return undefined;
  const benchmark = config["benchmark"];
  if (!isRecord(benchmark)) return undefined;
  const provider = benchmark["provider"];
  return typeof provider === "string" ? provider : undefined;
};

/** The file `deoptkit/vitest/provider` resolves to, however the package is linked. */
const PROVIDER_FILE = /(?:^|[\\/])vitest-provider\.mjs$/u;

const LOG_FILE = /^v8-.*\.log$/u;

/**
 * The logs already in the output directory when the run started, with their
 * modification times. The directory keeps every earlier run's logs, and a manifest
 * that listed them would hand `deoptkit ci --manifest` findings from old code.
 */
let logsBefore = new Map<string, number>();

const existingLogs = (outDir: string): Map<string, number> =>
  new Map(
    readdirSync(outDir)
      .filter((name) => LOG_FILE.test(name))
      .map((name) => [name, statSync(join(outDir, name)).mtimeMs])
  );

/** The worker writing `v8-<pid>.log`: the preset names each log with V8's `%p`. */
const writerOf = (logfile: string): number | undefined => {
  const pid = /v8-(\d+)\.log$/u.exec(logfile)?.[1];
  return pid === undefined ? undefined : Number(pid);
};

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return isRecord(error) && error["code"] === "EPERM";
  }
};

/**
 * How long the teardown waits for the workers to finish their logs. Vitest starts
 * stopping a worker when its file ends, but waits for the exit only when it closes the
 * pool, after this teardown. V8 writes the end of a log as the process exits (about 7%
 * of one measured log), so a log read before then is missing it: on Windows runners
 * that dropped findings from `findings.json`. Vitest kills a worker 500 ms after asking
 * it to stop, so an isolated worker is gone well within this.
 */
const WRITER_EXIT_WAIT_MS = 10_000;

/** Wait until no log's writer is running, or the time is up. Returns the writers still running. */
const waitForWriters = async (logfiles: string[]): Promise<number[]> => {
  const deadline = Date.now() + WRITER_EXIT_WAIT_MS;
  let running = logfiles
    .map(writerOf)
    .filter((pid): pid is number => pid !== undefined && pid !== process.pid);
  for (;;) {
    running = running.filter(isRunning);
    if (running.length === 0 || Date.now() >= deadline) return running;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const requireOutDir = (): string => {
  const outDir = process.env["DEOPTKIT_OUT_DIR"];
  if (outDir === undefined) {
    throw new Error(
      "deoptkit: DEOPTKIT_OUT_DIR is not set — register this global setup via the deoptKit() preset from deoptkit/vitest."
    );
  }
  return outDir;
};

export interface DeoptKitManifest {
  createdAt: string;
  outDir: string;
  logfiles: string[];
}

/**
 * The findings interchange `deoptkit lsp` reads; `deoptkit ci` writes the same shape
 * plus a `baselined` flag per finding, which this writer has no baseline to set.
 */
export interface DeoptKitFindingsFile {
  createdAt: string;
  outDir: string;
  findings: Array<
    Finding & {
      original?: { file: string; line: number; column: number };
      script: string;
    }
  >;
}

/**
 * Vitest global setup registered by the `deoptkit/vitest` preset. Refuses coverage
 * runs — coverage instrumentation changes the optimization behavior being measured —
 * and an iteration limit that nothing would apply.
 */
export const setup = (project?: unknown): void => {
  const outDir = requireOutDir();
  if (coverageEnabled(project)) {
    throw new Error(
      "deoptkit: disable coverage for observation runs — coverage instrumentation changes the optimization behavior being measured."
    );
  }
  // Only deoptkit's provider reads the limit. Without it every case still runs for
  // Vitest's time budget, and the logs grow as if `iterations` had never been set.
  if (
    process.env["DEOPTKIT_ITERATIONS"] !== undefined &&
    !PROVIDER_FILE.test(benchmarkProvider(project) ?? "")
  ) {
    throw new Error(
      "deoptkit: `iterations` needs deoptkit's benchmark provider. Add `provider: \"deoptkit/vitest/provider\"` to this project's `benchmark` config."
    );
  }
  logsBefore = existingLogs(outDir);
};

/**
 * After the bench run, list the V8 logs the workers produced for `load_manifest` and
 * write their findings (with source-mapped original positions) for `deoptkit lsp`.
 */
export const teardown = async (): Promise<void> => {
  const outDir = requireOutDir();
  const logfiles: string[] = [];
  for (const name of await readdir(outDir)) {
    if (!LOG_FILE.test(name)) continue;
    const logfile = join(outDir, name);
    // An earlier run's log is unchanged. A worker that reuses an old pid rewrites
    // that file, so a name seen before still counts once its time has moved.
    if (logsBefore.get(name) === (await stat(logfile)).mtimeMs) continue;
    logfiles.push(logfile);
  }
  for (const pid of await waitForWriters(logfiles)) {
    process.stderr.write(
      `deoptkit: worker ${String(pid)} was still running ${String(WRITER_EXIT_WAIT_MS / 1000)} s after the tests ended, so its log may be incomplete. With \`isolate: false\`, Vitest keeps workers alive until after this teardown.\n`
    );
  }
  const manifest: DeoptKitManifest = {
    createdAt: new Date().toISOString(),
    outDir,
    logfiles
  };
  await writeFile(
    join(outDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  // One log at a time: a parsed model is tens of MB. A log that cannot be analyzed
  // must not fail the bench run, so report it and keep the rest.
  const findings: DeoptKitFindingsFile["findings"] = [];
  for (const logfile of manifest.logfiles) {
    try {
      const model = await parseLog(logfile);
      const resolver = new SourceMapResolver(model);
      for (const found of computeFindings(model)) {
        const original = resolver.resolve(found.file, found.line, found.column);
        findings.push(
          original
            ? { ...found, original, script: logfile }
            : { ...found, script: logfile }
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `deoptkit: could not analyze ${logfile}: ${message}\n`
      );
    }
  }
  await writeFile(
    join(outDir, "findings.json"),
    `${JSON.stringify({ createdAt: new Date().toISOString(), outDir, findings } satisfies DeoptKitFindingsFile, null, 2)}\n`
  );
};
