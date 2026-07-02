import type { BenchOptions } from "vitest";
import { bench } from "vitest";
import { mark } from "../harness/index";

type BenchFn = Parameters<typeof bench>[1];
type SetupHook = NonNullable<BenchOptions["setup"]>;
type TeardownHook = NonNullable<BenchOptions["teardown"]>;

/**
 * Drop-in replacement for vitest's `bench()` that brackets the whole case with
 * deoptkit harness markers, so analysis tools can window to exactly this case via
 * `fromMark: "<name>_start", toMark: "<name>_end"`. Warmup and run phases both mark;
 * windows resolve first-start to last-end, so the case's full activity is covered.
 */
export const benchObserved = (
  name: string,
  fn: BenchFn,
  options?: BenchOptions
): void => {
  bench(name, fn, {
    ...options,
    setup: (...args: Parameters<SetupHook>): ReturnType<SetupHook> => {
      mark(`${name}_start`);
      return options?.setup?.(...args);
    },
    teardown: async (...args: Parameters<TeardownHook>): Promise<void> => {
      await options?.teardown?.(...args);
      mark(`${name}_end`);
    }
  });
};
