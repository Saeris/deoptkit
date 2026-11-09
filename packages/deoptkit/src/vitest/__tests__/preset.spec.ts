import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { generateWorkloadLog } from "../../parser/__tests__/helpers";
import { setup, teardown } from "../globalSetup";
import type { DeoptKitFindingsFile } from "../globalSetup";
import { deoptKit } from "../index";

describe("deoptKit vitest preset", () => {
  let outDir: string;

  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), "deoptkit-preset-"));
  });

  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true });
    delete process.env["DEOPTKIT_OUT_DIR"];
    delete process.env["DEOPTKIT_ITERATIONS"];
  });

  it("configures the forks pool with the V8 flag set and per-pid logfiles", () => {
    const config = deoptKit({ outDir });
    expect(config.pool).toBe("forks");
    const { execArgv } = config;
    expect(execArgv).toEqual(
      expect.arrayContaining(["--log-ic", "--log-deopt", "--prof"])
    );
    const logfileFlag = execArgv.find((flag) => flag.startsWith("--logfile="));
    // %p expands to the worker pid, giving each forked process its own log.
    expect(logfileFlag).toContain("v8-%p.log");
    expect(logfileFlag).toContain(outDir);
    expect(config.globalSetup).toEqual(["deoptkit/vitest/global-setup"]);
    expect(process.env["DEOPTKIT_OUT_DIR"]).toBe(outDir);
  });

  // The module runner rewrites imports into property reads that V8 then reports as IC
  // sites; native mode is what makes "the code V8 sees is the code you ship" true. It
  // must stay opt-in, so the default config may not carry the Vitest experimental keys.
  it("only switches Vitest to native ESM when nativeEsm is set", () => {
    expect(deoptKit({ outDir })).not.toHaveProperty("experimental");
    expect(deoptKit({ outDir, nativeEsm: true }).experimental).toEqual({
      viteModuleRunner: false,
      nodeLoader: false
    });
  });

  // The provider runs in forked workers and reads the limit from the environment they
  // inherit. A limit left over from an earlier call would quietly cap a config that
  // never asked for one, so leaving the option out must clear it.
  it("hands an iteration limit to the workers and clears it when unset", () => {
    deoptKit({ outDir, iterations: 500 });
    expect(process.env["DEOPTKIT_ITERATIONS"]).toBe("500");
    deoptKit({ outDir });
    expect(process.env["DEOPTKIT_ITERATIONS"]).toBeUndefined();
  });

  it("rejects an iteration limit that is not a positive integer", () => {
    for (const iterations of [0, -5, 1.5, Number.NaN]) {
      expect(() => deoptKit({ outDir, iterations })).toThrow(
        /positive integer/u
      );
    }
  });

  // Only deoptkit's provider applies the limit. Without it each case still runs for
  // Vitest's time budget, so the run would write the very logs the limit was set to
  // prevent while looking configured.
  it("refuses an iteration limit that no provider will apply", () => {
    deoptKit({ outDir, iterations: 100 });
    const withProvider = (provider?: string): unknown => ({
      config: { coverage: { enabled: false }, benchmark: { provider } }
    });
    expect(() => setup(withProvider())).toThrow(/deoptkit\/vitest\/provider/u);
    expect(() => setup(withProvider("/repo/my-provider.mjs"))).toThrow(
      /deoptkit\/vitest\/provider/u
    );
    // Vitest resolves the setting to the module's file, through links or not.
    expect(() =>
      setup(
        withProvider("/repo/node_modules/deoptkit/dist/vitest-provider.mjs")
      )
    ).not.toThrow();
    expect(() =>
      setup(
        withProvider("C:\\repo\\packages\\deoptkit\\dist\\vitest-provider.mjs")
      )
    ).not.toThrow();
    // Without a limit, the provider is optional.
    deoptKit({ outDir });
    expect(() => setup(withProvider())).not.toThrow();
  });

  // The whole observation is invalid under coverage instrumentation; failing loudly
  // beats silently reporting optimization behavior of instrumented code.
  it("refuses to run with coverage enabled", () => {
    deoptKit({ outDir });
    expect(() => setup({ config: { coverage: { enabled: true } } })).toThrow(
      /coverage/u
    );
  });

  // The findings interchange is what the LSP reads; a teardown that writes the
  // manifest but no findings leaves editors blind to everything the bench observed.
  it("writes a manifest and the findings interchange for produced logs on teardown", async () => {
    deoptKit({ outDir });
    setup({ config: { coverage: { enabled: false } } });
    const logfile = join(outDir, "v8-workload.log");
    await rename(generateWorkloadLog("map-churn", outDir), logfile);
    await writeFile(join(outDir, "unrelated.txt"), "ignore me\n");
    await teardown();
    const manifest = JSON.parse(
      await readFile(join(outDir, "manifest.json"), "utf8")
    ) as {
      outDir: string;
      logfiles: string[];
    };
    expect(manifest.outDir).toBe(outDir);
    expect(manifest.logfiles).toEqual([logfile]);
    const payload = JSON.parse(
      await readFile(join(outDir, "findings.json"), "utf8")
    ) as DeoptKitFindingsFile;
    expect(payload.findings.length).toBeGreaterThan(0);
    for (const finding of payload.findings)
      expect(finding.script).toBe(logfile);
    expect(payload.findings.some(({ kind }) => kind === "megamorphic-ic")).toBe(
      true
    );
  }, 60_000);

  // `deoptkit ci --manifest` gates the logs a manifest lists. The output directory
  // keeps every earlier run's logs, so listing them all would gate old code. A worker
  // that reuses an old pid rewrites that file, and its log belongs to this run.
  it("lists only the logs this run wrote", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deoptkit-runs-"));
    try {
      deoptKit({ outDir: dir });
      // Names without a pid: the teardown waits for a log's writer to exit, and on
      // Linux pids 1 and 2 always belong to running processes.
      const stale = join(dir, "v8-stale.log");
      const reused = join(dir, "v8-reused.log");
      const past = new Date(Date.now() - 60_000);
      for (const logfile of [stale, reused]) {
        await writeFile(logfile, "");
        await utimes(logfile, past, past);
      }
      setup({ config: { coverage: { enabled: false } } });
      await writeFile(reused, "");
      const fresh = join(dir, "v8-fresh.log");
      await writeFile(fresh, "");
      await teardown();
      const manifest = JSON.parse(
        await readFile(join(dir, "manifest.json"), "utf8")
      ) as { logfiles: string[] };
      expect(manifest.logfiles.toSorted()).toEqual([fresh, reused].toSorted());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Vitest runs this teardown before it waits for its workers to exit, and V8 writes
  // the end of a log as the process exits. A teardown that read a log while its worker
  // was still exiting dropped findings from findings.json on Windows runners.
  it("waits for each log's worker to exit before reading the log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deoptkit-exit-"));
    try {
      deoptKit({ outDir: dir });
      setup({ config: { coverage: { enabled: false } } });
      // A stand-in worker: it names its log the way the preset's `%p` does, and writes
      // the last line half a second later, just before it exits.
      const worker = spawn(process.execPath, [
        "-e",
        `const { appendFileSync, writeFileSync } = require("node:fs");
         const log = require("node:path").join(${JSON.stringify(dir)}, "v8-" + process.pid + ".log");
         writeFileSync(log, "");
         setTimeout(() => appendFileSync(log, "the end\\n"), 500);`
      ]);
      const log = join(dir, `v8-${String(worker.pid)}.log`);
      while (!existsSync(log)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await teardown();
      expect(readFileSync(log, "utf8")).toBe("the end\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // With `isolate: false` Vitest stops its workers only after this teardown, so waiting
  // for them would add the whole timeout to every run and still read unfinished logs.
  it("does not wait for shared workers, and says their logs may be unfinished", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deoptkit-shared-"));
    const worker = spawn(process.execPath, [
      "-e",
      `require("node:fs").writeFileSync(require("node:path").join(${JSON.stringify(dir)}, "v8-" + process.pid + ".log"), "");
       setTimeout(() => {}, 5000);`
    ]);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      deoptKit({ outDir: dir });
      setup({ config: { coverage: { enabled: false }, isolate: false } });
      while (!existsSync(join(dir, `v8-${String(worker.pid)}.log`))) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const started = performance.now();
      await teardown();
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("isolate"));
    } finally {
      stderr.mockRestore();
      worker.kill();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The preset's per-process logs depend on V8 actually expanding %p to the pid;
  // if a V8 upgrade drops the placeholder, this catches it before users do.
  it("v8 expands %p in --logfile to the process pid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deoptkit-pid-"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          `--logfile=${join(dir, "v8-%p.log")}`,
          "--no-logfile-per-isolate",
          "--log-code",
          "-e",
          "0"
        ],
        { encoding: "utf8" }
      );
      expect(result.status).toBe(0);
      const produced = (await readdir(dir)).filter((name) =>
        /^v8-\d+\.log$/u.test(name)
      );
      expect(produced).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
