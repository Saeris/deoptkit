import { statSync, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as v from "valibot";
import manifest from "../../package.json" with { type: "json" };
import { Connection } from "./jsonrpc";

const positionSchema = v.object({
  file: v.string(),
  line: v.number(),
  column: v.number()
});

const findingSchema = v.object({
  kind: v.string(),
  severity: v.number(),
  file: v.string(),
  line: v.number(),
  column: v.number(),
  summary: v.string(),
  explanation: v.optional(v.string()),
  suggestedFix: v.optional(v.string()),
  original: v.optional(positionSchema)
});

const findingsFileSchema = v.object({
  createdAt: v.string(),
  findings: v.array(findingSchema)
});

type FindingsFile = v.InferOutput<typeof findingsFileSchema>;
type FileFinding = v.InferOutput<typeof findingSchema>;

/** LSP DiagnosticSeverity: 1 Error, 2 Warning, 3 Information, 4 Hint. */
type LspSeverity = 1 | 2 | 3 | 4;

export interface Diagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity: LspSeverity;
  source: "deoptkit";
  code: string;
  message: string;
}

/** Severity thresholds per BENCHMARKING §8 — calibrate against real findings over time. */
const severityOf = (score: number): LspSeverity =>
  score >= 60 ? 1 : score >= 25 ? 2 : 3;

const toUri = (file: string): string =>
  file.startsWith("file:") ? file : pathToFileURL(resolvePath(file)).href;

const messageOf = (finding: FileFinding, stale: boolean): string => {
  const lines = [`[${finding.severity}] ${finding.summary}`];
  if (finding.explanation) lines.push("", `Why: ${finding.explanation}`);
  if (finding.suggestedFix) lines.push(`Fix: ${finding.suggestedFix}`);
  if (stale) {
    lines.push(
      "",
      "(stale — the source changed after this observation; re-run the bench)"
    );
  }
  return lines.join("\n");
};

/**
 * Map the findings interchange to per-URI LSP diagnostics. Positions prefer the
 * source-mapped original; LSP is 0-based where findings are 1-based. `staleFor`
 * reports whether the annotated file changed after the observation, downgrading
 * the diagnostic to Information rather than letting it lie about edited code.
 */
export const toDiagnostics = (
  payload: FindingsFile,
  staleFor: (file: string) => boolean
): Map<string, Diagnostic[]> => {
  const byUri = new Map<string, Diagnostic[]>();
  for (const finding of payload.findings) {
    const at = finding.original ?? finding;
    const uri = toUri(at.file);
    const stale = staleFor(at.file);
    const line = Math.max(0, at.line - 1);
    const character = Math.max(0, at.column - 1);
    const diagnostic: Diagnostic = {
      range: {
        start: { line, character },
        end: { line, character: character + 1 }
      },
      severity: stale ? 3 : severityOf(finding.severity),
      source: "deoptkit",
      code: finding.kind,
      message: messageOf(finding, stale)
    };
    const list = byUri.get(uri);
    if (list) list.push(diagnostic);
    else byUri.set(uri, [diagnostic]);
  }
  return byUri;
};

export const parseLspArgs = (
  args: string[]
): { findingsPath: string } | { error: string } => {
  let findingsPath = join(".deopt", "findings.json");
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--findings") {
      const value = args.at(++index);
      if (value === undefined) return { error: "--findings requires a value" };
      findingsPath = value;
    } else {
      return { error: `Unknown flag: ${arg}` };
    }
  }
  return { findingsPath };
};

export interface LspStreams {
  input: Readable;
  output: Writable;
}

const DEBOUNCE_MS = 100;

/**
 * Diagnostics-only LSP server: watches the findings interchange written by
 * `deoptkit ci` (and future writers) and pushes publishDiagnostics whenever it
 * changes. Never requests document sync — clients surface diagnostics in the
 * Problems panel and as squiggles when the file opens. Streams are injectable so
 * tests can drive the protocol in-process; production uses stdio.
 */
export const runLsp = async (
  args: string[],
  streams?: LspStreams
): Promise<number> => {
  const options = parseLspArgs(args);
  if ("error" in options) {
    process.stderr.write(`${options.error}\n`);
    return 2;
  }
  const findingsPath = resolvePath(options.findingsPath);
  const connection = new Connection(
    streams?.input ?? process.stdin,
    streams?.output ?? process.stdout
  );
  const published = new Set<string>();

  const publish = async (): Promise<void> => {
    let payload: FindingsFile | undefined;
    let observedAt = 0;
    try {
      const raw: unknown = JSON.parse(await readFile(findingsPath, "utf8"));
      const parsed = v.safeParse(findingsFileSchema, raw);
      if (parsed.success) {
        payload = parsed.output;
        observedAt = Date.parse(parsed.output.createdAt) || 0;
      }
    } catch {
      // Missing or unreadable interchange: everything clears below.
    }
    const staleFor = (file: string): boolean => {
      try {
        const path = file.startsWith("file:") ? fileURLToPath(file) : file;
        return statSync(path).mtimeMs > observedAt;
      } catch {
        return false;
      }
    };
    const next = payload
      ? toDiagnostics(payload, staleFor)
      : new Map<string, Diagnostic[]>();
    for (const uri of published) {
      if (!next.has(uri)) {
        connection.sendNotification("textDocument/publishDiagnostics", {
          uri,
          diagnostics: []
        });
        published.delete(uri);
      }
    }
    for (const [uri, diagnostics] of next) {
      connection.sendNotification("textDocument/publishDiagnostics", {
        uri,
        diagnostics
      });
      published.add(uri);
    }
  };

  let shutdownRequested = false;
  const exited = new Promise<number>((resolve) => {
    connection.onRequest("initialize", () => ({
      capabilities: { textDocumentSync: 0 },
      serverInfo: { name: "deoptkit", version: manifest.version }
    }));
    connection.onNotification("initialized", async () => {
      await publish();
    });
    connection.onRequest("shutdown", () => {
      shutdownRequested = true;
      return null;
    });
    connection.onNotification("exit", () => {
      resolve(shutdownRequested ? 0 : 1);
    });
  });

  // Watch the directory: the file may not exist yet, and writers replace it atomically.
  let timer: NodeJS.Timeout | undefined;
  const scheduleRepublish = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => void publish(), DEBOUNCE_MS);
  };
  const watcher = watch(dirname(findingsPath), (_event, filename) => {
    if (
      filename === null ||
      resolvePath(dirname(findingsPath), filename) === findingsPath
    ) {
      scheduleRepublish();
    }
  });

  connection.listen();
  process.stderr.write(`deoptkit lsp: watching ${findingsPath}\n`);
  try {
    return await exited;
  } finally {
    clearTimeout(timer);
    watcher.close();
  }
};
