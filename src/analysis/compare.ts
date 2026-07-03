import type { LogModel } from "../model/logModel";
import type { Finding } from "./findings";
import { computeFindings } from "./findings";

export interface PersistingFinding {
  kind: Finding["kind"];
  file: string;
  functionName: string | undefined;
  summary: string;
  baseSeverity: number;
  headSeverity: number;
}

export interface FunctionDelta {
  functionName: string;
  file: string;
  baseSelfTicks: number;
  headSelfTicks: number;
  delta: number;
}

export interface SessionComparison {
  /** Findings present in base but gone in head — what the change fixed. */
  resolved: Finding[];
  /** Findings present in head but not base — regressions the change introduced. */
  introduced: Finding[];
  /** Findings in both, with severity movement. */
  persisting: PersistingFinding[];
  /** Per-function self-tick movement for user code, largest absolute change first. */
  functionDeltas: FunctionDelta[];
  counts: {
    megamorphicIcSites: { base: number; head: number };
    deoptEvents: { base: number; head: number };
    mapsCreated: { base: number; head: number };
    profileTicks: { base: number; head: number };
  };
}

/**
 * Identity for matching a finding across two profiles of edited code. Line numbers
 * shift when code changes, so identity is kind + file + function + the IC key or
 * churned property names; deopts fall back to their reason set.
 */
const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asJoinedStrings = (value: unknown): string | undefined =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").join(",")
    : undefined;

/**
 * Stable identity for a finding across runs of edited code: kind + file + function +
 * the IC key / churned properties / deopt reasons — deliberately not line numbers,
 * which shift with every edit. Shared by compare_sessions and `deoptkit ci` baselines.
 */
export const findingIdentity = (found: Finding): string => {
  const detail =
    asString(found.evidence["key"]) ??
    asJoinedStrings(found.evidence["propertyNames"]) ??
    asJoinedStrings(found.evidence["reasons"]) ??
    "";
  return `${found.kind}|${found.file}|${found.functionName ?? ""}|${detail}`;
};

const matchKey = findingIdentity;

const isUserFile = (file: string | undefined): file is string =>
  file !== undefined &&
  !file.startsWith("node:") &&
  !file.includes("/node_modules/");

const MAX_FUNCTION_DELTAS = 20;

export const compareSessions = (
  base: LogModel,
  head: LogModel
): SessionComparison => {
  const baseFindings = new Map(
    computeFindings(base).map((found) => [matchKey(found), found])
  );
  const headFindings = new Map(
    computeFindings(head).map((found) => [matchKey(found), found])
  );

  const resolved: Finding[] = [];
  const persisting: PersistingFinding[] = [];
  for (const [key, found] of baseFindings) {
    const still = headFindings.get(key);
    if (!still) {
      resolved.push(found);
    } else {
      persisting.push({
        kind: found.kind,
        file: found.file,
        functionName: found.functionName,
        summary: still.summary,
        baseSeverity: found.severity,
        headSeverity: still.severity
      });
    }
  }
  const introduced = [...headFindings.entries()]
    .filter(([key]) => !baseFindings.has(key))
    .map(([, found]) => found);

  const ticksByFunction = (
    model: LogModel
  ): Map<string, { functionName: string; file: string; selfTicks: number }> => {
    const rows = new Map<
      string,
      { functionName: string; file: string; selfTicks: number }
    >();
    for (const row of model.profile.functions) {
      if (!isUserFile(row.file)) continue;
      const key = `${row.functionName}|${row.file}`;
      const existing = rows.get(key);
      if (existing) existing.selfTicks += row.selfTicks;
      else
        rows.set(key, {
          functionName: row.functionName,
          file: row.file,
          selfTicks: row.selfTicks
        });
    }
    return rows;
  };
  const baseTicks = ticksByFunction(base);
  const headTicks = ticksByFunction(head);
  const functionDeltas: FunctionDelta[] = [
    ...new Set([...baseTicks.keys(), ...headTicks.keys()])
  ]
    .map((key) => {
      const before = baseTicks.get(key);
      const after = headTicks.get(key);
      const row = before ?? after;
      return {
        functionName: row?.functionName ?? "",
        file: row?.file ?? "",
        baseSelfTicks: before?.selfTicks ?? 0,
        headSelfTicks: after?.selfTicks ?? 0,
        delta: (after?.selfTicks ?? 0) - (before?.selfTicks ?? 0)
      };
    })
    .filter((row) => row.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, MAX_FUNCTION_DELTAS);

  const megamorphicCount = (model: LogModel): number =>
    model.ics.filter(
      (site) =>
        isUserFile(site.file) &&
        (site.worstState === "megamorphic" || site.worstState === "generic")
    ).length;
  const deoptEvents = (model: LogModel): number =>
    model.deopts.reduce((sum, site) => sum + site.count, 0);

  return {
    resolved,
    introduced,
    persisting,
    functionDeltas,
    counts: {
      megamorphicIcSites: {
        base: megamorphicCount(base),
        head: megamorphicCount(head)
      },
      deoptEvents: { base: deoptEvents(base), head: deoptEvents(head) },
      mapsCreated: {
        base: base.maps.createdCount,
        head: head.maps.createdCount
      },
      profileTicks: {
        base: base.profile.tickCount,
        head: head.profile.tickCount
      }
    }
  };
};
