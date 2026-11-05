import type { LogModel } from "../model/logModel";
import { isUserCode } from "./findings";

export interface QualityWarning {
  code: "no-ticks" | "sparse-ticks" | "cold" | "no-user-code";
  message: string;
}

/** How trustworthy a session's findings are, from signals already in the model. */
export interface SessionQuality {
  totalTicks: number;
  /** Mean time between profiler samples, from the first to the last; undefined below two samples. */
  tickIntervalMs: number | undefined;
  /** Samples whose innermost frame is user code. */
  userCodeTicks: number;
  userFunctions: number;
  /** User functions that reached Maglev or TurboFan. */
  userFunctionsOptimized: number;
  userIcSites: number;
  warnings: QualityWarning[];
}

/**
 * V8 samples about every 1 ms on Linux and macOS and every 15 ms on Windows, but
 * IC and map logging contend with the sampler: a remark workload that would take
 * about 66 s unprofiled ran 158 s under full logging and produced 294 ticks, one
 * per 537 ms, while a lighter run of the same code sampled every 17 ms. Heat and
 * severity rest on a handful of ticks from such a run, so the session says so.
 */
const SPARSE_TICK_INTERVAL_MS = 100;

const tickIntervalMs = (model: LogModel): number | undefined => {
  const { samples } = model.profile;
  if (samples.length < 2) return undefined;
  const first = samples[0];
  const last = samples[samples.length - 1];
  // Log timestamps are microseconds.
  return (
    Math.round(((last.time - first.time) / 1000 / (samples.length - 1)) * 10) /
    10
  );
};

export const sessionQuality = (model: LogModel): SessionQuality => {
  const userFunctions = model.functionIndex.filter(({ file }) =>
    isUserCode(file)
  );
  const userFunctionsOptimized = userFunctions.filter(({ tiers }) =>
    tiers.some((tier) => tier === "maglev" || tier === "turbofan")
  ).length;
  const userIcSites = model.ics.filter(({ file }) => isUserCode(file)).length;
  const userCodeTicks = model.profile.functions
    .filter(({ file }) => isUserCode(file))
    .reduce((sum, { selfTicks }) => sum + selfTicks, 0);

  const warnings: QualityWarning[] = [];
  const noUserCode = userFunctions.length === 0 && userIcSites === 0;
  if (noUserCode) {
    warnings.push({
      code: "no-user-code",
      message:
        "No user code was observed: only node: internals and dependencies ran. Check the command, its cwd, and that the workload actually executes your code."
    });
  } else if (userFunctionsOptimized === 0) {
    warnings.push({
      code: "cold",
      message:
        "No user function reached an optimizing tier (Maglev or TurboFan): V8 never optimized this workload, so inline-cache states reflect warm-up, not steady state. Run the hot code thousands of times (observed() from deoptkit/harness) before trusting findings."
    });
  }
  const interval = tickIntervalMs(model);
  if (model.profile.tickCount === 0) {
    warnings.push({
      code: "no-ticks",
      message:
        "No profiler ticks were recorded: the run was shorter than one sampling interval (about 1 ms on Linux and macOS, about 15 ms on Windows), so findings cannot be ranked by heat."
    });
  } else if (interval !== undefined && interval > SPARSE_TICK_INTERVAL_MS) {
    warnings.push({
      code: "sparse-ticks",
      message: `Profiler samples are ${interval} ms apart on average (about 1 ms on Linux and macOS and 15 ms on Windows when the sampler keeps up): V8's IC and map logging starved the sampler, so heat, severity ranks and get_profile rest on ${model.profile.tickCount} ticks. For a trustworthy call tree, profile again with categories: ["profile"] and read get_profile from that session.`
    });
  }

  return {
    totalTicks: model.profile.tickCount,
    tickIntervalMs: interval,
    userCodeTicks,
    userFunctions: userFunctions.length,
    userFunctionsOptimized,
    userIcSites,
    warnings
  };
};
