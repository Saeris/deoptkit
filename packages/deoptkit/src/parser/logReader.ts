import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { parseLine } from "./csv";

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
  const lines = createInterface({
    input: createReadStream(path),
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
