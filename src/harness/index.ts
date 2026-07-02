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
  // eslint-disable-next-line no-eval -- the eval IS the mechanism: only a freshly
  // compiled, uniquely named function produces the log event that carries the marker.
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
  let lastResult!: T;
  for (let iteration = 0; iteration < iterations; iteration++) {
    lastResult = fn(iteration);
    sink = lastResult;
  }
  const endMark = mark(`${safe}_end`);
  return { label: safe, startMark, endMark, iterations, lastResult };
};
