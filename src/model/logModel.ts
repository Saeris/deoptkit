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
  /** Property key being accessed. */
  key: string;
  worstState: IcState;
  transitions: IcTransition[];
}

export type DeoptKind = "eager" | "lazy" | "soft" | "unknown";

/** All deoptimizations observed at one source position. */
export interface DeoptSite {
  file: string;
  line: number;
  column: number;
  kind: DeoptKind;
  /** Distinct V8 bailout reasons seen here, e.g. "Insufficient type feedback for generic named access". */
  reasons: string[];
  count: number;
  firstTime: number;
  lastTime: number;
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

export interface ProfileModel {
  tickCount: number;
  /** Sample counts by VM state (js, gc, compiler, idle, ...). */
  vmStates: Record<string, number>;
  /** Sorted by descending selfTicks. */
  functions: FunctionTicks[];
}

export interface ParserWarnings {
  unknownCommands: Record<string, number>;
  badLines: number;
}

/** The parsed form of one v8.log — everything the analysis tools query. */
export interface LogModel {
  v8Version: string;
  ics: IcSite[];
  deopts: DeoptSite[];
  maps: MapsModel;
  profile: ProfileModel;
  codeEntryCount: number;
  warnings: ParserWarnings;
}
