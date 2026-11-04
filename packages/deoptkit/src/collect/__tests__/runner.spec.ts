import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runWorkload } from "../runner";

const WORKLOAD_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "fixtures",
  "workloads"
);

describe("runWorkload", () => {
  const cleanups: string[] = [];
  afterEach(async () => {
    await Promise.all(
      cleanups.map(async (dir) => rm(dir, { recursive: true, force: true }))
    );
    cleanups.length = 0;
  });

  it("runs a node workload and produces a V8 log", async () => {
    const result = await runWorkload({
      command: ["node", join(WORKLOAD_DIR, "map-churn.js")],
      timeoutMs: 30_000
    });
    cleanups.push(result.dir);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    await expect(access(result.logfile)).resolves.toBeUndefined();
  }, 60_000);

  // Agents profile failing scripts all the time; the exit code must pass through
  // rather than masking the log that was still produced.
  it("reports non-zero exits while keeping the log", async () => {
    const result = await runWorkload({
      command: ["node", "-e", "console.error('boom'); process.exit(3)"],
      timeoutMs: 30_000
    });
    cleanups.push(result.dir);
    expect(result.exitCode).toBe(3);
    expect(result.stderrTail).toContain("boom");
    await expect(access(result.logfile)).resolves.toBeUndefined();
  }, 60_000);

  it("kills runaway processes at the timeout", async () => {
    const result = await runWorkload({
      command: ["node", "-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 2000
    });
    cleanups.push(result.dir);
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(15_000);
  }, 60_000);

  // POSIX rejects with ENOENT via the child's error event; Windows often reports a
  // close with libuv's negative errno instead. Either way: no zero exit, no log.
  it("surfaces a missing executable as an error or failed exit without a log", async () => {
    const result = await runWorkload({
      command: ["definitely-not-a-real-binary-3f9a"],
      timeoutMs: 5000
    }).catch((error: unknown) => error);
    if (result instanceof Error) return;
    const run = result as Awaited<ReturnType<typeof runWorkload>>;
    cleanups.push(run.dir);
    expect(run.exitCode).not.toBe(0);
    await expect(access(run.logfile)).rejects.toThrow();
  }, 30_000);
});
