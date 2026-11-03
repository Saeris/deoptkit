import type { SourceInfo } from "../parser/sourceInfo";

/** IC states in escalation order. V8 logs these as single characters (see `parseIcState`). */
export const IC_STATES = [
  "no_feedback",
  "uninitialized",
  "premonomorphic",
  "monomorphic",
  "recompute_handler",
  "polymorphic",
  "megamorphic",
  "generic"
] as const;

export type IcState = (typeof IC_STATES)[number];

/** Single-character state codes emitted by V8's IC tracing (ic-inl.h TransitionMarkFromState). */
const IC_STATE_CODES: Record<string, IcState> = {
  X: "no_feedback",
  "0": "uninitialized",
  ".": "premonomorphic",
  "1": "monomorphic",
  "^": "recompute_handler",
  P: "polymorphic",
  N: "megamorphic",
  G: "generic"
};

export const parseIcState = (code: string): IcState | undefined =>
  IC_STATE_CODES[code];

/** Escalation rank for comparing states; higher is worse for performance. */
export const icStateRank = (state: IcState): number => IC_STATES.indexOf(state);

export interface IcTransition {
  time: number;
  oldState: IcState;
  newState: IcState;
  mapAddress: string;
}

/** All IC activity observed at one source position for one property key. */
export interface IcSite {
  /** IC kind as logged: LoadIC, StoreIC, KeyedLoadIC, KeyedStoreIC, LoadGlobalIC, StoreGlobalIC, StoreInArrayLiteralIC. */
  type: string;
  /** Script URL of the code containing the IC, resolved through the code map. */
  file: string | undefined;
  /** Name of the enclosing function, resolved through the code map. */
  functionName: string | undefined;
  /** 1-based position within `file`. */
  line: number;
  column: number;
  /** Property key being accessed; for keyed ICs the first key observed at the site. */
  key: string;
  /** Distinct keys observed at a keyed site (obj[key]), in first-seen order, at most MAX_SITE_KEYS; one entry (the property) for named ICs. */
  keys: string[];
  /** Number of distinct keys observed, uncapped. */
  distinctKeys: number;
  worstState: IcState;
  transitions: IcTransition[];
}

export type DeoptKind = "eager" | "lazy" | "soft" | "unknown";

export interface SourcePosition {
  file: string;
  line: number;
  column: number;
}

export interface DeoptEvent {
  time: number;
  reason: string;
  /** Callers this deopt was inlined into, innermost first; absent when not inlined. */
  inlinedAt?: SourcePosition[];
}

/** All deoptimizations observed at one source position. */
export interface DeoptSite {
  file: string;
  line: number;
  column: number;
  /** Name of the function containing this position, resolved from the code map when available. */
  functionName: string | undefined;
  kind: DeoptKind;
  /** Distinct V8 bailout reasons seen here, e.g. "Insufficient type feedback for generic named access". */
  reasons: string[];
  count: number;
  /** Events whose code was inlined into a caller when they deopted. */
  inlinedCount: number;
  firstTime: number;
  lastTime: number;
  /** Individual deopt occurrences, for time-window filtering. */
  events: DeoptEvent[];
}

/** A code object from a `code-creation` event; ranges let ICs and ticks resolve to source. */
export interface CodeEntry {
  start: bigint;
  size: number;
  kind: string;
  functionName: string;
  /** Script position parsed from the entry name's trailing `url:line:column`, when present. */
  file: string | undefined;
  line: number | undefined;
  column: number | undefined;
  /** SharedFunctionInfo address from a JS `code-creation`; identical across a function's tiers. */
  sfi?: string | undefined;
  /**
   * V8's tier marker from code-creation: `~` interpreted, `^` baseline, `+` Maglev, `*`
   * TurboFan, with an `o` prefix for OSR code and a trailing `'` for context-specialized code.
   */
  marker?: string | undefined;
  /** Decoded `code-source-info` tables, when the log has them for this code object. */
  source?: SourceInfo | undefined;
}

/** One V8 object map (hidden class) observed in the log. */
export interface MapEntry {
  address: string;
  createdAt: number;
  /** Raw `map-details` text block, when logged. Parsed lazily by the map tools. */
  details: string | undefined;
  /** Address of the map this one transitioned from, when known. */
  parent: string | undefined;
  /** Transition subtype that produced this map (Transition, Normalize, ReplaceDescriptors, ...). */
  subtype: string | undefined;
  /** Property name added, for `Transition` events. */
  propertyName: string | undefined;
}

export interface MapTransitionEvent {
  time: number;
  propertyName: string | undefined;
}

/** Aggregated map transitions attributed to one source position — the map-churn signal. */
export interface MapTransitionSite {
  file: string | undefined;
  functionName: string | undefined;
  line: number;
  column: number;
  /** Distinct property names added at this site. */
  propertyNames: string[];
  /** Total transition events observed here. */
  count: number;
  /** Individual transition occurrences, for time-window filtering. */
  events: MapTransitionEvent[];
}

export interface MapsModel {
  createdCount: number;
  /** Map address -> latest entry at that address (V8 reuses addresses after GC). */
  entries: Map<string, MapEntry>;
  /** `map` event subtype -> occurrence count. */
  eventCounts: Record<string, number>;
  /** Transition sites sorted by descending count. */
  transitionSites: MapTransitionSite[];
}

/** CPU samples aggregated per function (all optimization tiers merged by source position). */
export interface FunctionTicks {
  functionName: string;
  file: string | undefined;
  line: number | undefined;
  column: number | undefined;
  /** Samples where this function was at the top of the stack. */
  selfTicks: number;
  /** Samples where this function was anywhere on the stack. */
  totalTicks: number;
}

/**
 * One CPU sample, retained so ticks can be windowed. Function keys have the form
 * `${functionName}|${file}|${line}|${column}`, matching the identity `FunctionTicks`
 * rows are merged by.
 */
export interface TickSample {
  time: number;
  vmState: string;
  /** Function key of the frame at the top of the stack, when resolved. */
  self: string | undefined;
  /** Distinct function keys anywhere on the stack (including `self`), innermost first. */
  onStack: string[];
}

export interface ProfileModel {
  tickCount: number;
  /** Sample counts by VM state (js, gc, compiler, idle, ...). */
  vmStates: Record<string, number>;
  /** Sorted by descending selfTicks. */
  functions: FunctionTicks[];
  /** Every sample in log order, for time-window filtering. */
  samples: TickSample[];
}

/** An optimization tier, named from V8's stable code-creation marker. */
export type Tier = "interpreted" | "baseline" | "maglev" | "turbofan";

/** A function observed via `code-creation`, indexed by source identity. */
export interface FunctionInfo {
  functionName: string;
  file: string;
  line: number;
  column: number;
  /** Optimization tiers observed for this function, from the code-creation markers, in first-seen order. */
  tiers: Tier[];
  /** True when any tier was entered through on-stack replacement (an o marker prefix). */
  osr: boolean;
  codeCreations: number;
}

export interface ParserWarnings {
  unknownCommands: Record<string, number>;
  badLines: number;
}

/** An in-band timestamp marker planted by `deoptkit/harness`'s `mark()`. */
export interface Marker {
  label: string;
  time: number;
}

/** The parsed form of one v8.log — everything the analysis tools query. */
export interface LogModel {
  v8Version: string;
  ics: IcSite[];
  deopts: DeoptSite[];
  maps: MapsModel;
  profile: ProfileModel;
  /** Script URL -> full source text, from `--log-source-code`. */
  scripts: Map<string, string>;
  /** Functions seen in code-creation events, for lookup by name/position. */
  functionIndex: FunctionInfo[];
  /** Harness markers in log order, for fromMark/toMark window filtering. */
  markers: Marker[];
  codeEntryCount: number;
  /** code-source-info lines decoded; 0 means the log lacks --log-source-code tables and attribution falls back to the caller. */
  codeSourceInfoCount: number;
  warnings: ParserWarnings;
}
