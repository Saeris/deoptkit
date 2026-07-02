import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { setup, teardown } from "../globalSetup";
import { deoptKit } from "../index";

describe("deoptKit vitest preset", () => {
  let outDir: string;

  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), "deoptkit-preset-"));
  });

  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true });
    delete process.env["DEOPTKIT_OUT_DIR"];
  });

  it("configures the forks pool with the V8 flag set and per-pid logfiles", () => {
    const config = deoptKit({ outDir });
    expect(config.pool).toBe("forks");
    const { execArgv } = config.poolOptions.forks;
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

  // The whole observation is invalid under coverage instrumentation; failing loudly
  // beats silently reporting optimization behavior of instrumented code.
  it("refuses to run with coverage enabled", () => {
    deoptKit({ outDir });
    expect(() => setup({ config: { coverage: { enabled: true } } })).toThrow(
      /coverage/u
    );
  });

  it("writes a manifest of produced logs on teardown", async () => {
    deoptKit({ outDir });
    await writeFile(join(outDir, "v8-12345.log"), "v8-version,14,6,0,0\n");
    await writeFile(join(outDir, "unrelated.txt"), "ignore me\n");
    setup({ config: { coverage: { enabled: false } } });
    await teardown();
    const manifest = JSON.parse(
      await readFile(join(outDir, "manifest.json"), "utf8")
    ) as {
      outDir: string;
      logfiles: string[];
    };
    expect(manifest.outDir).toBe(outDir);
    expect(manifest.logfiles).toEqual([join(outDir, "v8-12345.log")]);
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
