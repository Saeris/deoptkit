/**
 * Runtime helpers imported by benchmark workloads under observation. Zero dependencies
 * and inert when the process is not running under V8 logging flags — safe to leave in
 * committed bench files.
 */

/** Marker labels must be valid identifier fragments; collapse anything else to `_`. */
const sanitizeLabel = (label: string): string =>
  label.replace(/[^A-Za-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");

/**
 * Plant an in-band timestamp marker in the V8 log. Evaluating a uniquely named
 * function and invoking it once forces its compilation, which writes a
 * `code-creation` event named `__DEOPT_MARK__<label>__` with a microsecond
 * timestamp into the log — no V8 API, no side files, no clock correlation.
 * Returns the sanitized label used, which is what window filters match against.
 */
export const mark = (label: string): string => {
  const safe = sanitizeLabel(label);
  // The eval IS the mechanism: only a freshly compiled, uniquely named function
  // produces the log event that carries the marker.
  // oxlint-disable-next-line no-eval
  (0, eval)(`(function __DEOPT_MARK__${safe}__(){})`)();
  return safe;
};

export interface ObservedOptions {
  /** Warm-up iterations; V8 needs thousands of calls before optimization behavior shows. */
  iterations?: number;
}

export interface ObservedResult<T> {
  label: string;
  /** Marker labels bracketing the run — pass to a tool's fromMark/toMark window. */
  startMark: string;
  endMark: string;
  iterations: number;
  /** Wall-clock milliseconds the loop took, warm-up included; under logging flags this is inflated. */
  durationMs: number;
  /** The final iteration's return value (also acts as the dead-code-elimination sink). */
  lastResult: T;
}

/** Module-level sink so V8 cannot prove iteration results are unused. */
let sink: unknown;
export const lastSinkValue = (): unknown => sink;

/**
 * Run `fn` in a marked, warmed observation window. The default iteration count is
 * enough for inline caches to escalate and optimizing tiers to engage on hot code.
 */
export const observed = <T>(
  label: string,
  fn: (iteration: number) => T,
  options?: ObservedOptions
): ObservedResult<T> => {
  const iterations = options?.iterations ?? 10_000;
  const safe = sanitizeLabel(label);
  const startMark = mark(`${safe}_start`);
  const started = performance.now();
  let lastResult!: T;
  for (let iteration = 0; iteration < iterations; iteration++) {
    lastResult = fn(iteration);
    sink = lastResult;
  }
  const durationMs = performance.now() - started;
  const endMark = mark(`${safe}_end`);
  return {
    label: safe,
    startMark,
    endMark,
    iterations,
    durationMs,
    lastResult
  };
};

export interface InterleavedOptions {
  /** Measured rounds per variant (default 7); one unmeasured warm-up round runs first. */
  rounds?: number;
  /** Calls of each variant per round (default 10 000). */
  iterations?: number;
}

export interface VariantTiming {
  /** Median of the rounds: the number to compare variants by. */
  medianMs: number;
  minMs: number;
  roundsMs: number[];
}

export interface InterleavedResult {
  label: string;
  /** Marker labels bracketing the whole comparison — pass to a tool's fromMark/toMark window. */
  startMark: string;
  endMark: string;
  rounds: number;
  iterations: number;
  variants: Record<string, VariantTiming>;
}

const median = (values: number[]): number => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  const lower = sorted[middle - 1] ?? upper;
  return sorted.length % 2 === 0 ? (lower + upper) / 2 : upper;
};

/**
 * Time variants of the same work against each other. Back-to-back runs of "before"
 * then "after" drift by 30% or more on a busy machine (turbo clocks, GC debt, the
 * profiler itself), so each round runs every variant once in rotating order and
 * the medians over rounds are what to compare. Timing only: structural findings
 * come from `observed()` and the tools.
 */
export const interleaved = (
  label: string,
  variants: Record<string, (iteration: number) => unknown>,
  options?: InterleavedOptions
): InterleavedResult => {
  const rounds = options?.rounds ?? 7;
  const iterations = options?.iterations ?? 10_000;
  const names = Object.keys(variants);
  const safe = sanitizeLabel(label);
  const startMark = mark(`${safe}_start`);
  const timings = new Map<string, number[]>(names.map((name) => [name, []]));
  // Round -1 warms every variant unmeasured; later rounds rotate the order so no
  // variant always runs first or always right after the same neighbour.
  for (let round = -1; round < rounds; round++) {
    for (let slot = 0; slot < names.length; slot++) {
      const name = names[(slot + Math.max(round, 0)) % names.length];
      const fn = variants[name];
      const started = performance.now();
      for (let iteration = 0; iteration < iterations; iteration++)
        sink = fn(iteration);
      const elapsed = performance.now() - started;
      if (round >= 0) timings.get(name)?.push(elapsed);
    }
  }
  const endMark = mark(`${safe}_end`);
  const results: Record<string, VariantTiming> = {};
  for (const [name, roundsMs] of timings)
    results[name] = {
      medianMs: median(roundsMs),
      minMs: Math.min(...roundsMs),
      roundsMs
    };
  return {
    label: safe,
    startMark,
    endMark,
    rounds,
    iterations,
    variants: results
  };
};
