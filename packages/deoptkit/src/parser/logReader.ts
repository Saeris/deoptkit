import { open as fsOpen } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createInterface } from "node:readline";
import { parseLine } from "./csv";

const isBusy = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "EBUSY";

export interface OpenLogOptions {
  /** How to open the file; tests stand in a lock here. */
  open?: (path: string, flags: "r") => Promise<FileHandle>;
  /** How long to wait out a lock before failing (default 10 s). */
  waitMs?: number;
}

/**
 * Open a log for reading, waiting out a brief lock. On Windows another process can hold
 * a file for a moment after its writer closes it (an antivirus scan is the usual one),
 * and opening it then fails with EBUSY. Logs are read right after their writer exits
 * (the bench teardown, `profile_run`, `deoptkit ci`), and on a GitHub Windows runner the
 * bench teardown failed this way. Any other error fails at once.
 */
export const openLog = async (
  path: string,
  { open = fsOpen, waitMs = 10_000 }: OpenLogOptions = {}
): Promise<FileHandle> => {
  const deadline = Date.now() + waitMs;
  for (let delay = 25; ; delay = Math.min(delay * 2, 1_000)) {
    try {
      return await open(path, "r");
    } catch (error) {
      if (!isBusy(error) || Date.now() + delay > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

/**
 * Receives the fields following the command name on a matching log line. Elements are
 * typed as possibly-undefined because real logs contain truncated lines; handlers must
 * guard rather than trust arity.
 */
export type LineHandler = (args: Array<string | undefined>) => void;

export interface ReadWarnings {
  /** Occurrences of commands with no registered handler, by command name. */
  unknownCommands: Map<string, number>;
  /** Lines whose handler threw; the parser skips them rather than aborting. */
  badLines: number;
}

/**
 * Streams a V8 log file line by line, dispatching each line's fields to the handler
 * registered for its leading command field. Unknown commands and handler failures are
 * counted, never fatal — logs from unfamiliar V8 versions degrade instead of erroring.
 */
export const readLog = async (
  path: string,
  handlers: Record<string, LineHandler | undefined>
): Promise<ReadWarnings> => {
  const warnings: ReadWarnings = { unknownCommands: new Map(), badLines: 0 };
  // The stream closes the handle when it ends or fails.
  const lines = createInterface({
    input: (await openLog(path)).createReadStream(),
    crlfDelay: Infinity
  });
  for await (const line of lines) {
    if (line.length === 0) continue;
    const fields = parseLine(line);
    const command = fields[0] ?? "";
    const handler = handlers[command];
    if (!handler) {
      warnings.unknownCommands.set(
        command,
        (warnings.unknownCommands.get(command) ?? 0) + 1
      );
      continue;
    }
    try {
      handler(fields.slice(1));
    } catch {
      warnings.badLines += 1;
    }
  }
  return warnings;
};
