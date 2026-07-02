import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export const LOG_CATEGORIES = [
  "ics",
  "deopts",
  "maps",
  "profile",
  "sources"
] as const;
export type LogCategory = (typeof LOG_CATEGORIES)[number];

/** V8 flags per category — the modern-V8 flag set dexnode uses. */
const CATEGORY_FLAGS: Record<LogCategory, string[]> = {
  ics: ["--log-ic"],
  deopts: ["--log-deopt"],
  maps: ["--log-maps", "--log-maps-details"],
  profile: ["--prof", "--log-internal-timer-events", "--detailed-line-info"],
  sources: ["--log-code", "--log-source-code"]
};

export interface RunOptions {
  /** Executable and arguments; V8 flags are inserted after the executable. */
  command: string[];
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  timeoutMs?: number | undefined;
  categories?: LogCategory[] | undefined;
}

export interface RunResult {
  /** Path of the V8 log the process wrote (may not exist if spawn failed early). */
  logfile: string;
  /** Temp directory owning the logfile; callers remove it after parsing. */
  dir: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const TAIL_LENGTH = 4096;

/** `node` resolves to this process's executable — reliable across PATH/shim differences. */
const resolveExecutable = (executable: string): string => {
  const name = basename(executable).toLowerCase();
  return name === "node" || name === "node.exe" ? process.execPath : executable;
};

/** Run a command under V8 logging flags, writing v8.log into a fresh temp dir. */
export const runWorkload = async (options: RunOptions): Promise<RunResult> => {
  const [executable, ...args] = options.command;
  const dir = await mkdtemp(join(tmpdir(), "deopt-mcp-run-"));
  const logfile = join(dir, "v8.log");
  const categories = options.categories ?? [...LOG_CATEGORIES];
  const flags = [
    `--logfile=${logfile}`,
    "--no-logfile-per-isolate",
    ...categories.flatMap((category) => CATEGORY_FLAGS[category])
  ];

  const started = Date.now();
  try {
    return await new Promise<RunResult>((resolve, reject) => {
      const child = spawn(resolveExecutable(executable), [...flags, ...args], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
        shell: false
      });

      let stdoutTail = "";
      let stderrTail = "";
      let timedOut = false;
      const append = (current: string, chunk: unknown): string =>
        (current + String(chunk)).slice(-TAIL_LENGTH);
      child.stdout.on(
        "data",
        (chunk) => (stdoutTail = append(stdoutTail, chunk))
      );
      child.stderr.on(
        "data",
        (chunk) => (stderrTail = append(stderrTail, chunk))
      );

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      // Note: on Windows a missing executable often surfaces as close(-4058), not error.
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.once("close", (exitCode, signal) => {
        clearTimeout(timer);
        resolve({
          logfile,
          dir,
          exitCode,
          signal,
          timedOut,
          durationMs: Date.now() - started,
          stdoutTail,
          stderrTail
        });
      });
    });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
};
