import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";
import { findingIdentity } from "../analysis/compare";
import type { Finding } from "../analysis/findings";
import { computeFindings } from "../analysis/findings";
import { runWorkload } from "../collect/runner";
import type { LogModel } from "../model/logModel";
import { parseLog } from "../parser/parseLog";
import { SourceMapResolver } from "../sourcemaps/resolver";

/** One baselined finding: identity for matching plus display fields for humans. */
const baselineEntrySchema = v.object({
  identity: v.string(),
  kind: v.string(),
  file: v.string(),
  functionName: v.optional(v.string()),
  summary: v.string()
});

const baselineSchema = v.object({
  createdAt: v.string(),
  script: v.string(),
  findings: v.array(baselineEntrySchema)
});

type BaselineEntry = v.InferOutput<typeof baselineEntrySchema>;
type Baseline = v.InferOutput<typeof baselineSchema>;

export interface CiOptions {
  scripts: string[];
  update: boolean;
  outDir: string;
}

/** Exit codes: 0 = clean, 1 = new findings vs baseline, 2 = usage or run failure. */
export const parseCiArgs = (args: string[]): CiOptions | { error: string } => {
  const options: CiOptions = { scripts: [], update: false, outDir: ".deopt" };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--update") options.update = true;
    else if (arg === "--out-dir") {
      const value = args.at(++index);
      if (value === undefined) return { error: "--out-dir requires a value" };
      options.outDir = value;
    } else if (arg.startsWith("-")) return { error: `Unknown flag: ${arg}` };
    else options.scripts.push(arg);
  }
  if (options.scripts.length === 0) {
    return {
      error:
        "Usage: deoptkit ci [--update] [--out-dir <dir>] <script.mjs> [...]"
    };
  }
  return options;
};

const toEntries = (findings: Finding[]): BaselineEntry[] =>
  findings.map((found) => ({
    identity: findingIdentity(found),
    kind: found.kind,
    file: found.file,
    functionName: found.functionName,
    summary: found.summary
  }));

const baselinePathFor = (outDir: string, script: string): string => {
  const slug = relative(process.cwd(), resolve(script)).replace(
    /[^A-Za-z0-9.-]+/gu,
    "__"
  );
  return join(outDir, "baselines", `${slug}.json`);
};

const readBaseline = async (path: string): Promise<Baseline | undefined> => {
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    const parsed = v.safeParse(baselineSchema, raw);
    return parsed.success ? parsed.output : undefined;
  } catch {
    return undefined;
  }
};

export type LocatedFinding = Finding & {
  original?: { file: string; line: number; column: number };
};

/** GitHub Actions workflow-command annotation for a finding, at its original position. */
export const gitHubAnnotation = (found: LocatedFinding): string => {
  const at = found.original ?? found;
  const file = at.file.startsWith("file:") ? fileURLToPath(at.file) : at.file;
  const rel = relative(process.cwd(), file).replaceAll("\\", "/");
  return `::warning file=${rel},line=${at.line},col=${at.column},title=deoptkit ${found.kind}::${found.summary}`;
};

const analyzeScript = async (
  script: string
): Promise<LocatedFinding[] | { error: string }> => {
  const run = await runWorkload({
    command: [process.execPath, resolve(script)],
    timeoutMs: 300_000
  });
  try {
    if (run.exitCode !== 0) {
      return {
        error: `${script} exited ${run.exitCode}${run.timedOut ? " (timed out)" : ""}: ${run.stderrTail.slice(-500)}`
      };
    }
    const model: LogModel = await parseLog(run.logfile);
    const resolver = new SourceMapResolver(model);
    return computeFindings(model).map((found) => {
      const original = resolver.resolve(found.file, found.line, found.column);
      return original ? { ...found, original } : found;
    });
  } finally {
    await rm(run.dir, { recursive: true, force: true });
  }
};

const log = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

/**
 * Snapshot-style regression gate over structural findings. First run writes the
 * baseline and passes; later runs fail (exit 1) only when findings appear that the
 * baseline does not contain, matched by line-number-free identity. Resolved findings
 * prompt an --update notice. Timing never participates.
 */
export const runCi = async (args: string[]): Promise<number> => {
  const options = parseCiArgs(args);
  if ("error" in options) {
    log(options.error);
    return 2;
  }
  let failed = false;
  const inGitHubActions = process.env["GITHUB_ACTIONS"] === "true";

  for (const script of options.scripts) {
    const findings = await analyzeScript(script);
    if ("error" in findings) {
      log(`deoptkit ci: ${findings.error}`);
      return 2;
    }
    const entries = toEntries(findings);
    const baselinePath = baselinePathFor(options.outDir, script);
    const baseline = await readBaseline(baselinePath);

    const writeCurrent = async (): Promise<void> => {
      await mkdir(join(options.outDir, "baselines"), { recursive: true });
      await writeFile(
        baselinePath,
        `${JSON.stringify(
          {
            createdAt: new Date().toISOString(),
            script,
            findings: entries
          } satisfies Baseline,
          null,
          2
        )}\n`
      );
    };

    if (baseline === undefined) {
      await writeCurrent();
      log(
        `${basename(script)}: no baseline — wrote ${entries.length} finding(s) to ${baselinePath}`
      );
      continue;
    }

    const known = new Set(baseline.findings.map(({ identity }) => identity));
    const current = new Set(entries.map(({ identity }) => identity));
    const introduced = findings.filter(
      (found) => !known.has(findingIdentity(found))
    );
    const resolved = baseline.findings.filter(
      ({ identity }) => !current.has(identity)
    );

    if (options.update) {
      await writeCurrent();
      log(
        `${basename(script)}: baseline updated (${entries.length} finding(s); +${introduced.length} new, -${resolved.length} resolved)`
      );
      continue;
    }

    if (introduced.length > 0) {
      failed = true;
      log(
        `${basename(script)}: ${introduced.length} NEW finding(s) vs baseline:`
      );
      for (const found of introduced) {
        const at = found.original ?? found;
        log(
          `  [${found.severity}] ${found.kind} @ ${at.file}:${at.line}:${at.column} — ${found.summary}`
        );
        if (inGitHubActions) log(gitHubAnnotation(found));
      }
    }
    if (resolved.length > 0) {
      log(
        `${basename(script)}: ${resolved.length} baselined finding(s) no longer occur — run with --update to accept:`
      );
      for (const entry of resolved) log(`  ${entry.kind} — ${entry.summary}`);
    }
    if (introduced.length === 0 && resolved.length === 0) {
      log(
        `${basename(script)}: clean — matches baseline (${entries.length} finding(s))`
      );
    }
  }
  return failed ? 1 : 0;
};
