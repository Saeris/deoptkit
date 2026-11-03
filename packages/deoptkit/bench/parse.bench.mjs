// deoptkit observing its own parser. Generates a fresh V8 log of the megamorphic
// fixture workload, then parses and analyzes it repeatedly inside a marked window.
// Imports the built package: profile what users run (docs/BENCHMARKING.md §2.3).
// Run under the gate with `node dist/main.mjs ci bench/parse.bench.mjs` from the
// package directory (dist/ must be built first).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mark } from "../dist/harness.mjs";
import { computeFindings, parseLog, v8FlagsFor } from "../dist/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workload = join(here, "..", "fixtures", "workloads", "megamorphic.js");
const dir = mkdtempSync(join(tmpdir(), "deoptkit-bench-"));
const logfile = join(dir, "megamorphic.log");

// The child gets its own --logfile, so its log never mixes with the one deoptkit ci
// records for this process.
const run = spawnSync(process.execPath, [...v8FlagsFor(logfile), workload], {
  encoding: "utf8"
});
if (run.status !== 0) throw new Error(`workload failed: ${run.stderr}`);

// Enough repetitions for the parser's hot loops to tier up; each parse is ~100 ms.
const ITERATIONS = 20;
let sink = 0;
mark("parse_log_start");
for (let iteration = 0; iteration < ITERATIONS; iteration++) {
  // Sequential on purpose: one parse per iteration, so the window measures the parser
  // and not the scheduler.
  // oxlint-disable-next-line no-await-in-loop
  const model = await parseLog(logfile);
  sink += computeFindings(model).length + model.ics.length;
}
mark("parse_log_end");
rmSync(dir, { recursive: true, force: true });
// Observable result so nothing above is dead code (never throws).
if (sink < 0) throw new Error(`unreachable: ${sink}`);
