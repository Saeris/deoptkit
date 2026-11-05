import { statSync, unwatchFile, watchFile } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
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
  /** Share of profile self ticks the finding was scored with; 0 means never sampled. */
  heat: v.optional(v.number()),
  /** Set by `deoptkit ci` on findings its baseline already accepts. */
  baselined: v.optional(v.boolean()),
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

/** Why a finding is published below the severity its score calls for. */
interface Demotions {
  /** The annotated file changed after the observation. */
  stale: boolean;
  /** The committed baseline already accepts it; `deoptkit ci` will not fail on it. */
  baselined: boolean;
  /** The profiler never sampled the function or file, so it cost no time. */
  cold: boolean;
}

const messageOf = (finding: FileFinding, demoted: Demotions): string => {
  const lines = [`[${finding.severity}] ${finding.summary}`];
  if (finding.explanation) lines.push("", `Why: ${finding.explanation}`);
  if (finding.suggestedFix) lines.push(`Fix: ${finding.suggestedFix}`);
  if (demoted.baselined) {
    lines.push(
      "",
      "(baselined — already accepted in the committed baseline; deoptkit ci fails only on new findings)"
    );
  }
  if (demoted.cold) {
    lines.push(
      "",
      "(cold — the profiler never sampled this function or its file, so it cost no time in this run)"
    );
  }
  if (demoted.stale) {
    lines.push(
      "",
      "(stale — the source changed after this observation; re-run the bench)"
    );
  }
  return lines.join("\n");
};

/**
 * Baselined and cold findings are published as Hint, the one LSP severity editors
 * keep out of the Problems panel: the finding stays discoverable in the hover
 * without competing with the findings that are new or actually ran. Stale findings
 * downgrade to Information rather than lie about edited code.
 */
const severityFor = (finding: FileFinding, demoted: Demotions): LspSeverity =>
  demoted.baselined || demoted.cold
    ? 4
    : demoted.stale
      ? 3
      : severityOf(finding.severity);

/**
 * Map the findings interchange to per-URI LSP diagnostics. Positions prefer the
 * source-mapped original; LSP is 0-based where findings are 1-based. `staleFor`
 * reports whether the annotated file changed after the observation. Findings
 * without `heat` or `baselined` come from older writers and are never demoted.
 */
export const toDiagnostics = (
  payload: FindingsFile,
  staleFor: (file: string) => boolean
): Map<string, Diagnostic[]> => {
  const byUri = new Map<string, Diagnostic[]>();
  for (const finding of payload.findings) {
    const at = finding.original ?? finding;
    const uri = toUri(at.file);
    const demoted: Demotions = {
      stale: staleFor(at.file),
      baselined: finding.baselined === true,
      cold: finding.heat === 0
    };
    const line = Math.max(0, at.line - 1);
    const character = Math.max(0, at.column - 1);
    const diagnostic: Diagnostic = {
      range: {
        start: { line, character },
        end: { line, character: character + 1 }
      },
      severity: severityFor(finding, demoted),
      source: "deoptkit",
      code: finding.kind,
      message: messageOf(finding, demoted)
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
    } else if (arg === "--stdio" || arg.startsWith("--clientProcessId=")) {
      // vscode-languageclient appends --stdio and --clientProcessId=<pid> when it starts a module server over stdio; stdio is the only transport this server has, and the pid is not used yet.
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

  // Poll the file rather than fs.watch it: fs.watch on Windows aborts the process via
  // a libuv assertion (src\win\fs-event.c) when the watched directory is mutated under
  // 8.3 short-name paths. watchFile uses stat polling — no native directory backend, no
  // crash — and findings.json changes once per bench run, so 250ms latency is fine.
  const POLL_INTERVAL_MS = 250;
  watchFile(findingsPath, { interval: POLL_INTERVAL_MS }, () => {
    void publish();
  });

  connection.listen();
  process.stderr.write(`deoptkit lsp: watching ${findingsPath}\n`);
  try {
    return await exited;
  } finally {
    unwatchFile(findingsPath);
  }
};
