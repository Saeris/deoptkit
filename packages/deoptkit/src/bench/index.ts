import type { Bench, BenchFn, BenchFnOptions, BenchRegistration } from "vitest";
import { mark } from "../harness/index";

type Hook = NonNullable<BenchFnOptions["beforeAll"]>;
type HookThis = ThisParameterType<Hook>;
type HookMode = Parameters<Hook>[0];

/**
 * Register a benchmark through the `bench` test-context fixture with deoptkit
 * harness markers bracketing the case, so analysis tools can window to exactly
 * this case via `fromMark: "<name>_start", toMark: "<name>_end"`. tinybench runs
 * `beforeAll`/`afterAll` once per phase (warmup and run) and windows resolve
 * first-start to last-end, so the case's full activity is covered.
 *
 * ```ts
 * test("parse record", async ({ bench }) => {
 *   await benchObserved(bench, "parse record", () => parseRecord(next())).run();
 * });
 * ```
 */
export const benchObserved = <Name extends string>(
  bench: Bench,
  name: Name,
  fn: BenchFn,
  options: BenchFnOptions = {}
): BenchRegistration<Name> =>
  bench(
    name,
    {
      ...options,
      beforeAll: async function (
        this: HookThis,
        mode: HookMode
      ): Promise<void> {
        mark(`${name}_start`);
        await options.beforeAll?.call(this, mode);
      },
      afterAll: async function (this: HookThis, mode: HookMode): Promise<void> {
        await options.afterAll?.call(this, mode);
        mark(`${name}_end`);
      }
    },
    fn
  );
