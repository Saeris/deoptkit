import type { IcSite, LogModel } from "../model/logModel";

export type FindingKind =
  | "megamorphic-ic"
  | "polymorphic-ic"
  | "deopt-loop"
  | "eager-deopt"
  | "soft-deopt"
  | "map-churn"
  | "dictionary-mode";

export interface Finding {
  kind: FindingKind;
  /** 1-100; computed from signal weight x occurrence count x enclosing-function heat. */
  severity: number;
  /**
   * The share (0-1) of all profile self ticks that the enclosing function or its
   * file took: the heat the severity was scored with. 0 means the profiler never
   * sampled this code, so the finding cost no time in this run, however many
   * transitions it recorded.
   */
  heat: number;
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

/**
 * Findings only cover the user's own code; engine internals are queryable via list tools.
 * On Windows V8 logs CommonJS scripts with OS paths (`C:\...\node_modules\ajv\dist\ajv.js`)
 * and ESM with file URLs, so a forward-slash-only test let dependency code through as
 * user code.
 */
export const isUserCode = (file: string | undefined): file is string => {
  if (file === undefined) return false;
  const normalized = file.replaceAll("\\", "/");
  return (
    !normalized.startsWith("node:") && !normalized.includes("/node_modules/")
  );
};

export const FINDING_EXPLANATIONS: Record<
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
      "The same optimized tier (Maglev or TurboFan) discarded its code for this position more than once: V8 re-optimized with the new type feedback and still bailed out. Each cycle wastes compilation work and runs deoptimized code until V8 re-optimizes; repeated offenders can be permanently disabled from optimization.",
    suggestedFix:
      "Stabilize the types flowing through this expression after warm-up: avoid mixing numbers and strings in the same operation, and avoid changing object shapes late in an object's life."
  },
  "eager-deopt": {
    explanation:
      "Optimized code hit a state its type feedback did not predict and bailed out mid-execution. One bailout per tier while a function climbs Ignition → Maglev → TurboFan is normal warm-up.",
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
  },
  "dictionary-mode": {
    explanation:
      "Objects built or extended here left fast-properties mode: V8 moved them to a dictionary (hash table) backing store, so every property access on them is a hash lookup and the inline caches that see them cannot specialize. The usual trigger (`TooManyFastProperties`) is adding properties one at a time with keyed stores (`obj[key] = value`) past V8's soft limit of about 12 out-of-object fields; `delete` of a property that is not the last one added (`DeletingProperty`) normalizes an object too.",
    suggestedFix:
      "Define the properties in one step instead of storing them one by one: an object literal, spread, `Object.assign`, or `Object.fromEntries(pairs)` keep up to 128 fast properties. Avoid `delete` (set the field to undefined instead). If the object really is a dynamic string-keyed table, use a Map."
  }
};

const BASE_WEIGHT: Record<FindingKind, number> = {
  "megamorphic-ic": 18,
  "deopt-loop": 16,
  "dictionary-mode": 14,
  "map-churn": 10,
  "eager-deopt": 8,
  "polymorphic-ic": 6,
  "soft-deopt": 3
};

/**
 * V8 normalizes prototypes and module namespaces on purpose (prototype maps are
 * dictionary-mode by design, so that adding methods does not invalidate every
 * instance's shape), and accessor-pair normalizations are host plumbing far more
 * often than user code: Node defines `import.meta`'s accessors at the user's first
 * `import.meta` access, which the dogfood gate reported as three slow objects in
 * the bench. Only the remaining reasons (`TooManyFastProperties`, `DeletingProperty`)
 * mean a hot object went slow.
 */
const DELIBERATE_NORMALIZE_RE =
  /Prototype|ProtoMap|ModuleNamespace|TransitionToAccessorPair|TransitionToDifferentAccessor/u;

/**
 * What kind of value reached an IC site, from the map-details of the maps its
 * transitions recorded. Strings go polymorphic over V8's own representations
 * (one-byte, two-byte, cons, sliced, thin, internalized or not) and arrays over
 * their elements kinds (packed or holey; smi, double or tagged), which no change
 * to property order can fix, so those sites get their own clause and rank below
 * object-shape problems. Undefined when none of the maps was printed (the maps
 * category was off).
 */
type Receiver = "object" | "string" | "array" | "mixed";

interface ReceiverSummary {
  receiver: Receiver;
  types: string[];
  elementsKinds: string[];
}

const summarizeReceivers = (
  model: LogModel,
  site: IcSite
): ReceiverSummary | undefined => {
  const types = new Set<string>();
  const elementsKinds = new Set<string>();
  for (const { mapAddress } of site.transitions) {
    const details = model.maps.entries.get(mapAddress)?.details;
    if (details === undefined || details.type === "") continue;
    types.add(details.type);
    if (details.type === "JS_ARRAY_TYPE" && details.elementsKind !== undefined)
      elementsKinds.add(details.elementsKind);
  }
  if (types.size === 0) return undefined;
  const classes = new Set(
    [...types].map((type) =>
      type.endsWith("_STRING_TYPE")
        ? "string"
        : // Arrays that differ only by elements kind are an elements problem; arrays
          // polymorphic for any other reason (extra named properties) are shapes.
          type === "JS_ARRAY_TYPE" && elementsKinds.size > 1
          ? "array"
          : "object"
    )
  );
  const [only] = classes;
  return {
    receiver: classes.size === 1 ? only : "mixed",
    types: [...types],
    elementsKinds: [...elementsKinds]
  };
};

/**
 * String representation polymorphism is V8's doing and the user cannot normalize
 * it, so it ranks like noise. Mixed elements kinds are fixable (keep each array's
 * element type uniform) but with different advice from shape alignment, so they
 * rank below it.
 */
const RECEIVER_DISCOUNT: Record<Receiver, number> = {
  object: 1,
  mixed: 1,
  string: 0.3,
  array: 0.6
};

const listOf = (items: string[], limit = 4): string =>
  items.slice(0, limit).join(", ") +
  (items.length > limit ? `, … +${items.length - limit} more` : "");

/** The clause appended to an IC finding's summary when its receivers are not plain objects. */
const receiverClause = ({
  receiver,
  types,
  elementsKinds
}: ReceiverSummary): string => {
  switch (receiver) {
    case "string":
      return ` over ${types.length} string representations (${listOf(types)}): V8-internal string kinds, not object shapes`;
    case "array":
      return ` over arrays of ${elementsKinds.length} elements kinds (${listOf(elementsKinds)}): keep each array's element type uniform`;
    case "mixed":
      return ` over mixed receiver types (${listOf(types)})`;
    case "object":
      return "";
  }
};

/**
 * Keyed ICs (`obj[key]`) going megamorphic usually means genuinely dynamic keys —
 * inherent to generic dispatchers, not shape pollution the user can fix. Calibrated
 * on the Valimock dogfood, where 8 keyed sites produced a wall of mid-40s severities
 * in a codebase with zero real named-IC problems.
 */
const KEYED_IC_DISCOUNT = 0.45;

/**
 * Keep the first `limit` distinct map addresses as evidence: the addresses let an agent
 * call get_map without a list_ics round trip. V8 logs a store IC's first transition
 * against the null map, which get_map cannot resolve.
 */
const addExampleMap = (
  maps: string[],
  address: string,
  limit: number
): void => {
  if (
    maps.length < limit &&
    address !== "" &&
    address !== "0x000000000000" &&
    !maps.includes(address)
  )
    maps.push(address);
};

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
  heat: number,
  evidence: Record<string, unknown>
): Finding => ({
  kind,
  severity,
  heat: Math.round(heat * 10_000) / 10_000,
  file: site.file,
  line: site.line,
  column: site.column,
  functionName: site.functionName,
  summary,
  ...FINDING_EXPLANATIONS[kind],
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
  // Inlining tables attribute a function's own ticks correctly, but the cost of a
  // megamorphic site is spent inside V8 builtins such as LoadIC_Megamorphic, and the
  // sampler cannot walk from those frames back to the JS caller: on the megamorphic
  // fixture 44 of 64 ticks sit in LoadIC_Megamorphic with no JS frame on the sampled
  // stack while getX itself holds 3. A function's self ticks therefore understate its
  // IC cost, so the file-level share stays as the heat proxy until builtin time can be
  // charged to the sites that incur it.
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
    const exampleKeys = site.keys
      .slice(0, 3)
      .map((exampleKey) => `"${exampleKey}"`)
      .join(", ");
    const exampleMaps: string[] = [];
    for (const { mapAddress } of site.transitions)
      addExampleMap(exampleMaps, mapAddress, 3);
    const receivers = summarizeReceivers(model, site);
    const clause = receivers === undefined ? "" : receiverClause(receivers);
    const receiverDiscount =
      receivers === undefined ? 1 : RECEIVER_DISCOUNT[receivers.receiver];
    const receiverEvidence =
      receivers === undefined
        ? {}
        : {
            receiver: receivers.receiver,
            receiverTypes: receivers.types.slice(0, 8),
            ...(receivers.elementsKinds.length > 1
              ? { elementsKinds: receivers.elementsKinds }
              : {})
          };
    if (site.worstState === "megamorphic" || site.worstState === "generic") {
      findings.push(
        finding(
          "megamorphic-ic",
          at,
          keyed
            ? `${site.type} at a dynamic-key site went megamorphic (${hits} recorded transitions over ${site.distinctKeys} distinct keys, e.g. ${exampleKeys})${clause} — often inherent to generic dispatch`
            : `${site.type} for property "${site.key}" went megamorphic (${hits} recorded transitions)${clause}`,
          score(
            "megamorphic-ic",
            hits,
            heat,
            (keyed ? KEYED_IC_DISCOUNT : 1) * receiverDiscount
          ),
          heat,
          keyed
            ? {
                icType: site.type,
                keys: site.keys.slice(0, 8),
                distinctKeys: site.distinctKeys,
                worstState: site.worstState,
                transitions: hits,
                keyedAccess: true,
                exampleMaps,
                ...receiverEvidence
              }
            : {
                icType: site.type,
                key: site.key,
                worstState: site.worstState,
                transitions: hits,
                keyedAccess: false,
                exampleMaps,
                ...receiverEvidence
              }
        )
      );
    } else if (site.worstState === "polymorphic" && heat > 0) {
      findings.push(
        finding(
          "polymorphic-ic",
          at,
          keyed
            ? `${site.type} at a dynamic-key site (${site.distinctKeys} distinct keys, e.g. ${exampleKeys}) is polymorphic inside a hot function${clause}`
            : `${site.type} for property "${site.key}" is polymorphic inside a hot function${clause}`,
          score("polymorphic-ic", hits, heat, receiverDiscount),
          heat,
          keyed
            ? {
                icType: site.type,
                keys: site.keys.slice(0, 8),
                distinctKeys: site.distinctKeys,
                worstState: site.worstState,
                transitions: hits,
                exampleMaps,
                ...receiverEvidence
              }
            : {
                icType: site.type,
                key: site.key,
                worstState: site.worstState,
                transitions: hits,
                exampleMaps,
                ...receiverEvidence
              }
        )
      );
    }
  }

  // On-stack-replacement bailouts are tier-up mechanics, not pathologies: every loop
  // that gets hot "deopts" to enter its optimized version. Reporting them as findings
  // buries real signals and makes runs non-reproducible (OSR timing varies per run).
  const isOsrNoise = (reason: string): boolean =>
    reason.includes("on stack replacement") || reason.includes("OSR");

  for (const site of model.deopts) {
    if (!isUserCode(site.file)) continue;
    const events = site.events.filter(({ reason }) => !isOsrNoise(reason));
    if (events.length === 0) continue;
    const heat = heatOf(site.functionName, site.file);
    const distinctReasons = (
      list: ReadonlyArray<{ reason: string }>
    ): string[] =>
      [
        ...new Set(
          list.map(({ reason }) => reason).filter((reason) => reason !== "")
        )
      ].sort();
    // Modern V8 logs insufficient-type-feedback bailouts as eager deopts, but they mean
    // optimized code reached an expression it had never executed in that tier, the
    // original soft-deopt meaning: warm-up, not instability.
    const feedback = events.filter(({ reason }) =>
      reason.startsWith("Insufficient type feedback")
    );
    const hard = events.filter(
      ({ reason }) => !reason.startsWith("Insufficient type feedback")
    );
    // Climbing Ignition -> Maglev -> TurboFan costs a function one "wrong map" bailout
    // per tier while V8 learns; only the same tier discarding the same position twice
    // is a loop. Events with no known code object share one bucket.
    const tierCounts = new Map<string, number>();
    for (const { tier } of hard) {
      const name = tier ?? "unknown";
      tierCounts.set(name, (tierCounts.get(name) ?? 0) + 1);
    }
    const tiers = Object.fromEntries(tierCounts);
    const repeats = Math.max(0, ...tierCounts.values());
    if (repeats >= 2 && site.kind === "eager") {
      const reasons = distinctReasons(hard);
      findings.push(
        finding(
          "deopt-loop",
          site,
          `${hard.length} eager deopts at the same position (${reasons.join("; ")})`,
          score("deopt-loop", hard.length, heat),
          heat,
          {
            kind: site.kind,
            count: hard.length,
            reasons,
            inlinedCount: site.inlinedCount,
            tiers
          }
        )
      );
    } else if (hard.length >= 1 && site.kind === "eager") {
      const reasons = distinctReasons(hard);
      findings.push(
        finding(
          "eager-deopt",
          site,
          hard.length === 1
            ? `Eager deopt: ${reasons.join("; ")}`
            : `${hard.length} eager deopts, one per tier (${reasons.join("; ")})`,
          score("eager-deopt", hard.length, heat),
          heat,
          {
            kind: site.kind,
            count: hard.length,
            reasons,
            inlinedCount: site.inlinedCount,
            tiers
          }
        )
      );
    }
    if (feedback.length > 0) {
      const reasons = distinctReasons(feedback);
      findings.push(
        finding(
          "soft-deopt",
          site,
          `Soft deopt (insufficient type feedback): ${reasons.join("; ")}`,
          score("soft-deopt", feedback.length, heat),
          heat,
          {
            kind: site.kind,
            count: feedback.length,
            reasons,
            inlinedCount: site.inlinedCount
          }
        )
      );
    }
    // Feedback bailouts on a soft-kind site are already reported above; only the rest
    // belong here, or one site would yield two findings with the same identity.
    if (site.kind === "soft" && hard.length > 0) {
      const count = hard.length;
      const reasons = distinctReasons(hard);
      findings.push(
        finding(
          "soft-deopt",
          site,
          `Soft deopt: ${reasons.join("; ")}`,
          score("soft-deopt", count, heat),
          heat,
          { kind: site.kind, count, reasons, inlinedCount: site.inlinedCount }
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
    exampleMaps: string[];
  }
  const churnGroups = new Map<string, ChurnGroup>();
  // Normalization is not shape churn: a normalized object leaves the transition tree,
  // and the NormalizedMapCache hands repeat offenders the same dictionary map. Counted
  // as churn it produced a wall of "transitions" at a keyed-store site (the Valimock
  // builder) that no property-order edit could fix. Grouped per function like churn,
  // since one store loop logs under several pcs as it tiers up.
  interface NormalizeGroup {
    file: string;
    functionName: string | undefined;
    anchor: { line: number; column: number; count: number };
    count: number;
    reasons: string[];
    exampleMaps: string[];
  }
  const normalizeGroups = new Map<string, NormalizeGroup>();
  for (const site of model.maps.transitionSites) {
    if (!isUserCode(site.file)) continue;
    // Anonymous functions (V8 names them "") and module top-level code share one name,
    // so the position of the function itself is what tells them apart.
    const key = `${site.functionName}|${site.file}|${site.functionLine}|${site.functionColumn}`;
    const transitions = site.events.filter(
      ({ subtype }) => !subtype.startsWith("Normalize")
    );
    const slowed = site.events.filter(
      ({ subtype, reason }) =>
        subtype.startsWith("Normalize") &&
        !DELIBERATE_NORMALIZE_RE.test(reason ?? "")
    );
    if (slowed.length > 0) {
      let group = normalizeGroups.get(key);
      if (!group) {
        group = {
          file: site.file,
          functionName: site.functionName,
          anchor: { line: site.line, column: site.column, count: 0 },
          count: 0,
          reasons: [],
          exampleMaps: []
        };
        normalizeGroups.set(key, group);
      }
      group.count += slowed.length;
      if (slowed.length > group.anchor.count)
        group.anchor = {
          line: site.line,
          column: site.column,
          count: slowed.length
        };
      for (const { reason, mapAddress } of slowed) {
        addExampleMap(group.exampleMaps, mapAddress, 3);
        const name = reason ?? "unknown";
        if (!group.reasons.includes(name)) group.reasons.push(name);
      }
    }
    if (transitions.length === 0) continue;
    let group = churnGroups.get(key);
    if (!group) {
      group = {
        file: site.file,
        functionName: site.functionName,
        anchor: {
          line: site.line,
          column: site.column,
          count: transitions.length
        },
        count: 0,
        propertyNames: [],
        transitionsPerName: new Map(),
        exampleMaps: []
      };
      churnGroups.set(key, group);
    }
    group.count += transitions.length;
    if (transitions.length > group.anchor.count) {
      group.anchor = {
        line: site.line,
        column: site.column,
        count: transitions.length
      };
    }
    for (const { propertyName, mapAddress } of transitions) {
      addExampleMap(group.exampleMaps, mapAddress, 5);
      if (propertyName === undefined) continue;
      group.transitionsPerName.set(
        propertyName,
        (group.transitionsPerName.get(propertyName) ?? 0) + 1
      );
      if (!group.propertyNames.includes(propertyName))
        group.propertyNames.push(propertyName);
    }
  }

  for (const group of normalizeGroups.values()) {
    const reasons = group.reasons.toSorted();
    const heat = heatOf(group.functionName, group.file);
    findings.push(
      finding(
        "dictionary-mode",
        {
          file: group.file,
          line: group.anchor.line,
          column: group.anchor.column,
          functionName: group.functionName
        },
        `${group.count} objects left fast-properties mode here (${reasons.join("; ")})`,
        score("dictionary-mode", group.count, heat),
        heat,
        { count: group.count, reasons, exampleMaps: group.exampleMaps }
      )
    );
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
    const heat = heatOf(group.functionName, group.file);
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
        score("map-churn", group.count, heat),
        heat,
        {
          transitionCount: group.count,
          propertyNames: group.propertyNames,
          maxTransitionsPerProperty: maxPerName,
          exampleMaps: group.exampleMaps
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
