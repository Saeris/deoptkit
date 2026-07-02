import { spawnSync } from "node:child_process";
import { join } from "node:path";

const WORKLOAD_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "fixtures",
  "workloads"
);

// Mirrors fixtures/generate.mjs — the category flags dexnode passes for modern V8.
const v8Flags = (logfile: string): string[] => [
  `--logfile=${logfile}`,
  "--no-logfile-per-isolate",
  "--log-deopt",
  "--log-ic",
  "--log-maps",
  "--log-maps-details",
  "--log-code",
  "--log-source-code",
  "--prof",
  "--log-internal-timer-events",
  "--detailed-line-info"
];

/** Run a fixture workload under V8 logging flags, writing `<workload>.log` into `dir`. */
export const generateWorkloadLog = (workload: string, dir: string): string => {
  const logfile = join(dir, `${workload}.log`);
  const result = spawnSync(
    process.execPath,
    [...v8Flags(logfile), join(WORKLOAD_DIR, `${workload}.js`)],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(
      `workload ${workload} failed (exit ${result.status}): ${result.stderr}`
    );
  }
  return logfile;
};
