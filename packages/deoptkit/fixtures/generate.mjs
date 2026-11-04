// Regenerates fixtures/logs/<node-major>/<workload>.log for every workload.
// Usage: node fixtures/generate.mjs
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workloadDir = join(here, "workloads");
const nodeMajor = process.versions.node.split(".")[0];
const logDir = join(here, "logs", `node-${nodeMajor}`);
mkdirSync(logDir, { recursive: true });

// The same category flags dexnode passes for modern V8 (>= 9).
const v8Flags = (logfile) => [
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

for (const file of readdirSync(workloadDir)) {
  const logfile = join(logDir, `${parse(file).name}.log`);
  const { status, stderr } = spawnSync(
    process.execPath,
    [...v8Flags(logfile), join(workloadDir, file)],
    { encoding: "utf8" }
  );
  if (status === 0) {
    if (stderr.trim()) console.error(`stderr from ${file}: ${stderr.trim()}`);
    console.log(`wrote ${logfile}`);
  } else {
    console.error(`FAIL ${file} (exit ${status})\n${stderr}`);
    process.exitCode = 1;
  }
}
