import { afterEach, describe, expect, it, vi } from "vitest";
import type { BenchmarkGroup, BenchRunOptions } from "vitest";
import provider from "../provider";

/** The parts of a group the provider reads; Vitest builds the real one per test. */
const groupFor = (fn: () => void, options?: BenchRunOptions): BenchmarkGroup =>
  ({
    test: {
      fullTestName: "provider spec",
      context: { signal: new AbortController().signal }
    },
    config: { retainSamples: false },
    registrations: [{ name: "case", fn }],
    ...(options === undefined ? {} : { options })
  }) as unknown as BenchmarkGroup;

/**
 * tinybench calls a function once when it is added, to see whether it returns a
 * promise. That call is not a sample, but V8 logs it like any other.
 */
const DETECTION_CALL = 1;

const callsFor = async (options?: BenchRunOptions): Promise<number> => {
  let calls = 0;
  await provider.run(
    groupFor(() => {
      calls++;
    }, options)
  );
  return calls;
};

describe("deoptkit's benchmark provider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // The limit exists to bound a V8 log: under logging, a time budget turns a fast
  // case into hundreds of thousands of calls and gigabytes of log. If the budget or
  // the warm-up phase survives, the count is no longer the one the user set.
  it("calls each case exactly the preset's count, with no time budget or warm-up", async () => {
    vi.stubEnv("DEOPTKIT_ITERATIONS", "25");
    await expect(callsFor()).resolves.toBe(25 + DETECTION_CALL);
    await expect(callsFor({ time: 2_000, warmupIterations: 50 })).resolves.toBe(
      25 + DETECTION_CALL
    );
  });

  // Some cases take seconds per call and ask for a handful of samples; raising them
  // to the preset's count would turn a profile run into hours. A bench's own count is
  // a minimum meant for throughput runs, though, so it may not lift the bound either.
  it("keeps a smaller count that the bench asks for, and caps a larger one", async () => {
    vi.stubEnv("DEOPTKIT_ITERATIONS", "25");
    await expect(callsFor({ iterations: 3 })).resolves.toBe(3 + DETECTION_CALL);
    await expect(callsFor({ iterations: 1_000 })).resolves.toBe(
      25 + DETECTION_CALL
    );
  });

  // Selecting the provider must not change a run that sets no limit: those runs
  // still measure throughput, which needs Vitest's time-based sampling.
  it("without a limit, runs like Vitest's built-in provider", async () => {
    await expect(
      callsFor({ time: 0, iterations: 7, warmup: false })
    ).resolves.toBe(7 + DETECTION_CALL);
    await expect(
      callsFor({ time: 30, iterations: 1, warmup: false })
    ).resolves.toBeGreaterThan(100);
  });

  // Vitest matches results to registrations by name and treats a missing one as a
  // provider bug; a failing case must fail its test, not vanish from the report.
  it("returns a result per case and rethrows a failing case", async () => {
    vi.stubEnv("DEOPTKIT_ITERATIONS", "5");
    const results = await provider.run(groupFor(() => undefined));
    expect(results.map(({ name }) => name)).toEqual(["case"]);
    expect(results[0]?.latency.samplesCount).toBe(5);

    const failure = new Error("the case broke");
    await expect(
      provider.run(
        groupFor(() => {
          throw failure;
        })
      )
    ).rejects.toBe(failure);
  });

  it("rejects a limit that is not a positive integer", async () => {
    vi.stubEnv("DEOPTKIT_ITERATIONS", "1.5");
    await expect(callsFor()).rejects.toThrow(/positive integer/u);
  });
});
