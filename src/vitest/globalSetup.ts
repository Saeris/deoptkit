import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

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

/** After the bench run, list the V8 logs the workers produced for `load_manifest`. */
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
};
