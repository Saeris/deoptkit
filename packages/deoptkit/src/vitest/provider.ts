import { Bench } from "tinybench";
import type { BenchmarkProvider, BenchResult } from "vitest";

/**
 * The preset's iteration limit, or `undefined` when it set none. `deoptKit({ iterations })`
 * sets it in the config process, and forked workers inherit it.
 */
const iterationLimit = (): number | undefined => {
  const raw = process.env["DEOPTKIT_ITERATIONS"];
  if (raw === undefined) return undefined;
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error(
      `deoptkit: DEOPTKIT_ITERATIONS must be a positive integer, received "${raw}".`
    );
  }
  return limit;
};

/**
 * A Vitest benchmark provider that runs each case a fixed number of times while V8
 * logging is on. Select it with `benchmark: { provider: "deoptkit/vitest/provider" }`
 * and set the count with `deoptKit({ iterations })`.
 *
 * Vitest's built-in provider runs a case until a time budget (1 s by default) and a
 * minimum count are both met. Under V8 logging that makes a log's size depend on how
 * fast the case is: a fast case fills its second with hundreds of thousands of calls,
 * and with every category on, one profile run wrote several gigabytes. A fixed count
 * bounds the log, and it makes the findings repeatable from one machine to the next,
 * which `deoptkit ci --manifest` needs to gate on them.
 *
 * With a limit, each case calls its function exactly `iterations` times, or fewer
 * when the bench asks for fewer (`.run({ iterations: 5 })` stays 5). There is no time
 * budget and no warm-up phase: V8 observes every call the same way, so a warm-up
 * would only be more calls. Without a limit, this behaves like the built-in provider.
 */
const provider: BenchmarkProvider = {
  run: async ({ test, config, options, registrations }) => {
    const limit = iterationLimit();
    const bench = new Bench({
      signal: test.context.signal,
      name: test.fullTestName,
      retainSamples: config.retainSamples,
      ...options,
      ...(limit === undefined
        ? {}
        : {
            iterations: Math.min(options?.iterations ?? limit, limit),
            time: 0,
            warmup: false
          })
    });
    for (const { name, fn, fnOpts } of registrations) {
      bench.add(name, fn, fnOpts);
    }
    await bench.run();
    const errors = bench.tasks.flatMap((task) =>
      task.result.state === "errored" ? [task.result.error] : []
    );
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Some benchmarks failed");
    }
    return bench.tasks.map((task): BenchResult => {
      const { result } = task;
      if (result.state !== "completed") {
        throw new Error(
          `task "${task.name}" did not complete: received "${result.state}"`
        );
      }
      return { ...result, name: task.name };
    });
  }
};

// Vitest loads a provider module and reads only its default export.
// oxlint-disable-next-line import/no-default-export
export default provider;
