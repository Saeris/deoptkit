import { readdir, writeFile } from "node:fs/promises";
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

/** The findings interchange `deoptkit lsp` reads; `deoptkit ci` writes the same shape. */
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
 * runs — coverage instrumentation changes the optimization behavior being measured.
 */
export const setup = (project?: unknown): void => {
  requireOutDir();
  if (coverageEnabled(project)) {
    throw new Error(
      "deoptkit: disable coverage for observation runs — coverage instrumentation changes the optimization behavior being measured."
    );
  }
};

/**
 * After the bench run, list the V8 logs the workers produced for `load_manifest` and
 * write their findings (with source-mapped original positions) for `deoptkit lsp`.
 */
export const teardown = async (): Promise<void> => {
  const outDir = requireOutDir();
  const entries = await readdir(outDir);
  const manifest: DeoptKitManifest = {
    createdAt: new Date().toISOString(),
    outDir,
    logfiles: entries
      .filter((name) => /^v8-.*\.log$/u.test(name))
      .map((name) => join(outDir, name))
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
