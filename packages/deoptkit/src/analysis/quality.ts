import type { LogModel } from "../model/logModel";
import { isUserCode } from "./findings";

export interface QualityWarning {
  code: "no-ticks" | "cold" | "no-user-code";
  message: string;
}

/** How trustworthy a session's findings are, from signals already in the model. */
export interface SessionQuality {
  totalTicks: number;
  /** Samples whose innermost frame is user code. */
  userCodeTicks: number;
  userFunctions: number;
  /** User functions that reached Maglev or TurboFan. */
  userFunctionsOptimized: number;
  userIcSites: number;
  warnings: QualityWarning[];
}

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
  if (model.profile.tickCount === 0) {
    warnings.push({
      code: "no-ticks",
      message:
        "No profiler ticks were recorded: the run was shorter than one sampling interval (about 1 ms on Linux and macOS, about 15 ms on Windows), so findings cannot be ranked by heat."
    });
  }

  return {
    totalTicks: model.profile.tickCount,
    userCodeTicks,
    userFunctions: userFunctions.length,
    userFunctionsOptimized,
    userIcSites,
    warnings
  };
};
