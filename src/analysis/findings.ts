import type { LogModel } from "../model/logModel";

export type FindingKind =
  | "megamorphic-ic"
  | "polymorphic-ic"
  | "deopt-loop"
  | "eager-deopt"
  | "soft-deopt"
  | "map-churn";

export interface Finding {
  kind: FindingKind;
  /** 1-100; computed from signal weight x occurrence count x enclosing-function heat. */
  severity: number;
  file: string;
  line: number;
  column: number;
  functionName: string | undefined;
  /** One-line statement of the problem at this site. */
  summary: string;
  /** Why this matters in V8 terms. */
  explanation: string;
  /** Actionable fix category. */
  suggestedFix: string;
  /** Kind-specific numbers backing the severity (counts, states, property names, ...). */
  evidence: Record<string, unknown>;
}

/** Findings only cover the user's own code; engine internals are queryable via list tools. */
const isUserCode = (file: string | undefined): file is string =>
  file !== undefined &&
  !file.startsWith("node:") &&
  !file.includes("/node_modules/");

const EXPLANATIONS: Record<
  FindingKind,
  { explanation: string; suggestedFix: string }
> = {
  "megamorphic-ic": {
    explanation:
      "This access site has seen 5+ distinct object shapes, so V8 gave up on shape-specialized fast paths and performs a generic (hash-lookup) access every time.",
    suggestedFix:
      "Normalize the object shapes reaching this site: initialize the same properties in the same order everywhere those objects are created, or split the call site so each variant is handled by its own monomorphic code path."
  },
  "polymorphic-ic": {
    explanation:
      "This access site sees 2-4 object shapes; V8 checks each cached shape on every access. Cheap in cold code, but measurable inside hot functions.",
    suggestedFix:
      "If the shapes are conceptually one type, align their property initialization order; if they are genuinely different types, consider handling each in separate code."
  },
  "deopt-loop": {
    explanation:
      "TurboFan-optimized code for this position was discarded multiple times (eager deopts). Each cycle wastes compilation work and runs deoptimized code until V8 re-optimizes; repeated offenders can be permanently disabled from optimization.",
    suggestedFix:
      "Stabilize the types flowing through this expression after warm-up: avoid mixing numbers and strings in the same operation, and avoid changing object shapes late in an object's life."
  },
  "eager-deopt": {
    explanation:
      "Optimized code hit a state its type feedback did not predict and bailed out mid-execution.",
    suggestedFix:
      "Check what unusual value or shape reaches this position (the reason string names V8's failed assumption) and make its type consistent."
  },
  "soft-deopt": {
    explanation:
      "V8 intentionally deoptimized to gather better type feedback (often for rarely-executed or not-yet-warm code). Usually harmless unless frequent in hot paths.",
    suggestedFix:
      "Generally no action needed; investigate only if this site also shows eager deopts or sits in a hot function."
  },
  "map-churn": {
    explanation:
      "Object creation here produces many distinct hidden classes (maps) for conceptually similar objects, usually via conditional or variably-ordered property assignment. Downstream property accesses then go polymorphic or megamorphic.",
    suggestedFix:
      "Initialize every property unconditionally and in a fixed order at construction (assign undefined for optional fields), or use a class constructor that always defines the full shape."
  }
};

const BASE_WEIGHT: Record<FindingKind, number> = {
  "megamorphic-ic": 18,
  "deopt-loop": 16,
  "map-churn": 10,
  "eager-deopt": 8,
  "polymorphic-ic": 6,
  "soft-deopt": 3
};

/**
 * Keyed ICs (`obj[key]`) going megamorphic usually means genuinely dynamic keys —
 * inherent to generic dispatchers, not shape pollution the user can fix. Calibrated
 * on the Valimock dogfood, where 8 keyed sites produced a wall of mid-40s severities
 * in a codebase with zero real named-IC problems.
 */
const KEYED_IC_DISCOUNT = 0.45;

/**
 * severity = base x (1 + log10(1 + occurrences)) x (1 + 4 x heat), clamped to 1-100,
 * where heat is the enclosing function's share of all self ticks. A megamorphic site
 * with even modest hits in a hot function outranks anything cold — matching how much
 * wall-clock each finding can actually cost.
 */
const score = (
  kind: FindingKind,
  occurrences: number,
  heat: number,
  discount = 1
): number => {
  const raw =
    BASE_WEIGHT[kind] *
    discount *
    (1 + Math.log10(1 + occurrences)) *
    (1 + 4 * heat);
  return Math.max(1, Math.min(100, Math.round(raw)));
};

const finding = (
  kind: FindingKind,
  site: {
    file: string;
    line: number;
    column: number;
    functionName?: string | undefined;
  },
  summary: string,
  severity: number,
  evidence: Record<string, unknown>
): Finding => ({
  kind,
  severity,
  file: site.file,
  line: site.line,
  column: site.column,
  functionName: site.functionName,
  summary,
  ...EXPLANATIONS[kind],
  evidence
});

/** Rank everything wrong in a session, worst first. */
export const computeFindings = (model: LogModel): Finding[] => {
  const totalSelfTicks = Math.max(
    1,
    model.profile.functions.reduce((sum, row) => sum + row.selfTicks, 0)
  );
  const heatByFunction = new Map<string, number>();
  const heatByFile = new Map<string, number>();
  for (const row of model.profile.functions) {
    const share = row.selfTicks / totalSelfTicks;
    const key = `${row.functionName}|${row.file}`;
    heatByFunction.set(key, (heatByFunction.get(key) ?? 0) + share);
    if (row.file !== undefined) {
      heatByFile.set(row.file, (heatByFile.get(row.file) ?? 0) + share);
    }
  }
  // Inlining attributes ticks to the caller, so a site's own function often shows no
  // heat even when it dominates the profile; the file-level share is the fallback.
  const heatOf = (functionName: string | undefined, file: string): number =>
    Math.max(
      heatByFunction.get(`${functionName}|${file}`) ?? 0,
      heatByFile.get(file) ?? 0
    );

  const findings: Finding[] = [];

  for (const site of model.ics) {
    if (!isUserCode(site.file)) continue;
    const at = {
      file: site.file,
      line: site.line,
      column: site.column,
      functionName: site.functionName
    };
    const heat = heatOf(site.functionName, site.file);
    const hits = site.transitions.length;
    const keyed = site.type.startsWith("Keyed");
    if (site.worstState === "megamorphic" || site.worstState === "generic") {
      findings.push(
        finding(
          "megamorphic-ic",
          at,
          `${site.type} for property "${site.key}" went megamorphic (${hits} recorded transitions)${
            keyed
              ? " — keyed/dynamic access, often inherent to generic dispatch"
              : ""
          }`,
          score("megamorphic-ic", hits, heat, keyed ? KEYED_IC_DISCOUNT : 1),
          {
            icType: site.type,
            key: site.key,
            worstState: site.worstState,
            transitions: hits,
            keyedAccess: keyed
          }
        )
      );
    } else if (site.worstState === "polymorphic" && heat > 0) {
      findings.push(
        finding(
          "polymorphic-ic",
          at,
          `${site.type} for property "${site.key}" is polymorphic inside a hot function`,
          score("polymorphic-ic", hits, heat),
          {
            icType: site.type,
            key: site.key,
            worstState: site.worstState,
            transitions: hits
          }
        )
      );
    }
  }

  for (const site of model.deopts) {
    if (!isUserCode(site.file)) continue;
    const heat = heatOf(undefined, site.file);
    if (site.kind === "eager" && site.count >= 2) {
      findings.push(
        finding(
          "deopt-loop",
          site,
          `${site.count} eager deopts at the same position (${site.reasons.join("; ")})`,
          score("deopt-loop", site.count, heat),
          { kind: site.kind, count: site.count, reasons: site.reasons }
        )
      );
    } else if (site.kind === "eager") {
      findings.push(
        finding(
          "eager-deopt",
          site,
          `Eager deopt: ${site.reasons.join("; ")}`,
          score("eager-deopt", site.count, heat),
          { kind: site.kind, count: site.count, reasons: site.reasons }
        )
      );
    } else if (site.kind === "soft") {
      findings.push(
        finding(
          "soft-deopt",
          site,
          `Soft deopt: ${site.reasons.join("; ")}`,
          score("soft-deopt", site.count, heat),
          { kind: site.kind, count: site.count, reasons: site.reasons }
        )
      );
    }
  }

  // Conditional properties transition at different lines, so churn from one constructor
  // fragments across per-line sites; the meaningful unit is the enclosing function.
  interface ChurnGroup {
    file: string;
    functionName: string | undefined;
    anchor: { line: number; column: number; count: number };
    count: number;
    propertyNames: string[];
    transitionsPerName: Map<string, number>;
  }
  const churnGroups = new Map<string, ChurnGroup>();
  for (const site of model.maps.transitionSites) {
    if (!isUserCode(site.file)) continue;
    const key = `${site.functionName}|${site.file}`;
    let group = churnGroups.get(key);
    if (!group) {
      group = {
        file: site.file,
        functionName: site.functionName,
        anchor: { line: site.line, column: site.column, count: site.count },
        count: 0,
        propertyNames: [],
        transitionsPerName: new Map()
      };
      churnGroups.set(key, group);
    }
    group.count += site.count;
    if (site.count > group.anchor.count) {
      group.anchor = {
        line: site.line,
        column: site.column,
        count: site.count
      };
    }
    for (const { propertyName } of site.events) {
      if (propertyName === undefined) continue;
      group.transitionsPerName.set(
        propertyName,
        (group.transitionsPerName.get(propertyName) ?? 0) + 1
      );
    }
    for (const name of site.propertyNames) {
      if (!group.propertyNames.includes(name)) group.propertyNames.push(name);
    }
  }

  /** Unbounded random-keyed creation shows as volume even without per-name repeats. */
  const CHURN_VOLUME_THRESHOLD = 100;
  /** A property added from 3+ parent shapes means the shape tree branches — real churn. */
  const CHURN_BRANCH_THRESHOLD = 3;

  for (const group of churnGroups.values()) {
    // A healthy constructor builds one shape family: each property transitions exactly
    // once, in one linear chain, on first execution. A 20-property object literal is
    // NOT churn (learned dogfooding on Valimock, whose fully-initialized context object
    // tripped a count-based threshold). Churn is branching — the same property added
    // from several parent shapes — or unbounded volume from random-keyed objects.
    const maxPerName = Math.max(0, ...group.transitionsPerName.values());
    if (
      maxPerName < CHURN_BRANCH_THRESHOLD &&
      group.count < CHURN_VOLUME_THRESHOLD
    )
      continue;
    findings.push(
      finding(
        "map-churn",
        {
          file: group.file,
          line: group.anchor.line,
          column: group.anchor.column,
          functionName: group.functionName
        },
        `${group.count} map transitions created in one function (properties: ${group.propertyNames
          .slice(0, 8)
          .join(
            ", "
          )}${group.propertyNames.length > 8 ? `, … +${group.propertyNames.length - 8} more` : ""})`,
        score("map-churn", group.count, heatOf(group.functionName, group.file)),
        {
          transitionCount: group.count,
          propertyNames: group.propertyNames,
          maxTransitionsPerProperty: maxPerName
        }
      )
    );
  }

  return findings.sort(
    (a, b) =>
      b.severity - a.severity ||
      // Equal clamped severities order by intrinsic signal weight, worst kind first.
      BASE_WEIGHT[b.kind] - BASE_WEIGHT[a.kind] ||
      a.file.localeCompare(b.file) ||
      a.line - b.line
  );
};
