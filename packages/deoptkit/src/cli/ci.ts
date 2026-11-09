import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";
import { findingIdentity } from "../analysis/compare";
import type { Finding } from "../analysis/findings";
import { computeFindings } from "../analysis/findings";
import { toWorkspacePath } from "../analysis/paths";
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
  /** Manifests a `vitest bench` run under the `deoptkit/vitest` preset wrote. */
  manifests: string[];
  update: boolean;
  accumulate: boolean;
  outDir: string;
}

/** Exit codes: 0 = clean, 1 = new findings vs baseline, 2 = usage or run failure. */
export const parseCiArgs = (args: string[]): CiOptions | { error: string } => {
  const options: CiOptions = {
    scripts: [],
    manifests: [],
    update: false,
    accumulate: false,
    outDir: ".deopt"
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--update") options.update = true;
    else if (arg === "--accumulate") options.accumulate = true;
    else if (arg === "--out-dir") {
      const value = args.at(++index);
      if (value === undefined) return { error: "--out-dir requires a value" };
      options.outDir = value;
    } else if (arg === "--manifest") {
      const value = args.at(++index);
      if (value === undefined) return { error: "--manifest requires a value" };
      options.manifests.push(value);
    } else if (arg.startsWith("-")) return { error: `Unknown flag: ${arg}` };
    else options.scripts.push(arg);
  }
  if (options.update && options.accumulate) {
    return { error: "--update and --accumulate cannot be combined" };
  }
  if (options.scripts.length === 0 && options.manifests.length === 0) {
    return {
      error:
        "Usage: deoptkit ci [--update|--accumulate] [--out-dir <dir>] [--manifest <manifest.json>] [<script.mjs> ...]"
    };
  }
  return options;
};

/**
 * Only run-stable finding kinds participate in gating: IC states, map churn and
 * normalization are deterministic given the same inputs, and deopt loops survive OSR filtering. One-off
 * eager/soft deopts depend on tier-up timing and would flake the gate — they still
 * appear in findings.json for humans and agents.
 */
const GATED_KINDS = new Set<string>([
  "megamorphic-ic",
  "map-churn",
  "dictionary-mode",
  "deopt-loop"
]);

/**
 * Baselines are committed and compared on other machines, so identities must not
 * contain the checkout path: the file is rewritten relative to the working directory.
 * Bundlers hash chunk names (`dist/parseLog-Ckn1Egq2.mjs`), which change on every
 * build, while the source-mapped original path does not; a baseline must survive a
 * rebuild, so the original file is preferred when the source maps resolve one.
 */
const portable = (found: LocatedFinding): Finding => ({
  ...found,
  file: toWorkspacePath(found.original?.file ?? found.file, process.cwd())
});

const toEntries = (findings: LocatedFinding[]): BaselineEntry[] =>
  findings
    .filter(({ kind }) => GATED_KINDS.has(kind))
    .map((found) => {
      const entry = portable(found);
      return {
        identity: findingIdentity(entry),
        kind: entry.kind,
        file: entry.file,
        functionName: entry.functionName,
        summary: entry.summary
      };
    });

/**
 * Findings at a threshold (a keyed IC with 4-5 transitions, a deopt site with exactly
 * 2 eager deopts) flicker between runs. Accumulating over several runs lets the gate
 * fail only on genuinely new sites, which is the invariant it exists for. Existing
 * entries come first and win on identity.
 */
const mergeEntries = (
  existing: BaselineEntry[],
  current: BaselineEntry[]
): BaselineEntry[] => {
  const merged = new Map(existing.map((entry) => [entry.identity, entry]));
  for (const entry of current) {
    if (!merged.has(entry.identity)) merged.set(entry.identity, entry);
  }
  return [...merged.values()];
};

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

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const analyzeLog = async (logfile: string): Promise<LocatedFinding[]> => {
  const model: LogModel = await parseLog(logfile);
  const resolver = new SourceMapResolver(model);
  return computeFindings(model).map((found) => {
    const original = resolver.resolve(found.file, found.line, found.column);
    return original ? { ...found, original } : found;
  });
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
    return await analyzeLog(run.logfile);
  } finally {
    await rm(run.dir, { recursive: true, force: true });
  }
};

const manifestSchema = v.object({ logfiles: v.array(v.string()) });

/**
 * Gate a `vitest bench` run instead of a script: the logs its manifest lists, as one
 * set of findings against one baseline. The run should use `deoptKit({ iterations })`,
 * because a time-budgeted case runs as many times as the machine allows, and findings
 * at a threshold then come and go between machines.
 *
 * Every log must analyze. The bench teardown skips a log it cannot read, but a gate
 * that did the same would pass on part of the run.
 */
const analyzeManifest = async (
  manifest: string
): Promise<LocatedFinding[] | { error: string }> => {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifest, "utf8"));
  } catch (error) {
    return { error: `cannot read ${manifest}: ${messageOf(error)}` };
  }
  const parsed = v.safeParse(manifestSchema, raw);
  if (!parsed.success) {
    return { error: `${manifest} is not a deoptkit manifest` };
  }
  if (parsed.output.logfiles.length === 0) {
    return {
      error: `${manifest} lists no logs: run vitest bench with the deoptkit/vitest preset first`
    };
  }
  const findings: LocatedFinding[] = [];
  for (const logfile of parsed.output.logfiles) {
    try {
      findings.push(...(await analyzeLog(logfile)));
    } catch (error) {
      return { error: `cannot analyze ${logfile}: ${messageOf(error)}` };
    }
  }
  return findings;
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
  const allFindings: Array<
    LocatedFinding & { script: string; baselined: boolean }
  > = [];

  // A manifest gates like a script: its path names its baseline and its findings.
  const sources: Array<{
    script: string;
    analyze: () => Promise<LocatedFinding[] | { error: string }>;
  }> = [
    ...options.scripts.map((script) => ({
      script,
      analyze: async () => analyzeScript(script)
    })),
    ...options.manifests.map((manifest) => ({
      script: manifest,
      analyze: async () => analyzeManifest(manifest)
    }))
  ];
  for (const { script, analyze } of sources) {
    const findings = await analyze();
    if ("error" in findings) {
      log(`deoptkit ci: ${findings.error}`);
      return 2;
    }
    const entries = toEntries(findings);
    const baselinePath = baselinePathFor(options.outDir, script);
    const baseline = await readBaseline(baselinePath);

    const writeCurrent = async (
      written: BaselineEntry[] = entries
    ): Promise<void> => {
      await mkdir(join(options.outDir, "baselines"), { recursive: true });
      await writeFile(
        baselinePath,
        `${JSON.stringify(
          {
            createdAt: new Date().toISOString(),
            script,
            findings: written
          } satisfies Baseline,
          null,
          2
        )}\n`
      );
    };

    // The identities the baseline accepts once this run is over. The interchange
    // marks those findings so editors can demote what the gate will never fail on.
    let accepted: Set<string>;
    if (baseline === undefined) {
      await writeCurrent();
      log(
        `${basename(script)}: no baseline — wrote ${entries.length} finding(s) to ${baselinePath}`
      );
      accepted = new Set(entries.map(({ identity }) => identity));
    } else {
      const known = new Set(baseline.findings.map(({ identity }) => identity));
      const current = new Set(entries.map(({ identity }) => identity));
      const introduced = findings.filter(
        (found) =>
          GATED_KINDS.has(found.kind) &&
          !known.has(findingIdentity(portable(found)))
      );
      const resolved = baseline.findings.filter(
        ({ identity }) => !current.has(identity)
      );

      if (options.update) {
        await writeCurrent();
        log(
          `${basename(script)}: baseline updated (${entries.length} finding(s); +${introduced.length} new, -${resolved.length} resolved)`
        );
        accepted = current;
      } else if (options.accumulate) {
        const merged = mergeEntries(baseline.findings, entries);
        await writeCurrent(merged);
        const added = merged.filter(({ identity }) => !known.has(identity));
        log(
          `${basename(script)}: baseline accumulated (${merged.length} finding(s); +${added.length} new)`
        );
        accepted = new Set(merged.map(({ identity }) => identity));
      } else {
        accepted = known;
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
          for (const entry of resolved)
            log(`  ${entry.kind} — ${entry.summary}`);
        }
        if (introduced.length === 0 && resolved.length === 0) {
          log(
            `${basename(script)}: clean — matches baseline (${entries.length} finding(s))`
          );
        }
      }
    }
    for (const found of findings) {
      allFindings.push({
        ...found,
        script,
        baselined: accepted.has(findingIdentity(portable(found)))
      });
    }
  }

  // The findings interchange consumed by editor surfaces (deoptkit lsp) and agents:
  // always the latest run's full picture, regardless of baseline verdicts, with
  // `baselined` telling consumers which findings the gate already accepts.
  await mkdir(options.outDir, { recursive: true });
  await writeFile(
    join(options.outDir, "findings.json"),
    `${JSON.stringify({ createdAt: new Date().toISOString(), findings: allFindings }, null, 2)}\n`
  );

  return failed ? 1 : 0;
};
