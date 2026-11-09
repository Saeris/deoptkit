import { spawn } from "node:child_process";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openLog, readLog } from "../logReader";

const busy = (): Error =>
  Object.assign(new Error("EBUSY: resource busy or locked"), {
    code: "EBUSY"
  });

describe("opening a log", () => {
  let dir: string;
  let log: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "deoptkit-open-"));
    log = join(dir, "v8.log");
    await writeFile(log, "v8-version,13,0,0,0,0,0\n");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // On Windows another process can hold a file for a moment after its writer closes it,
  // and the bench teardown, `profile_run` and `deoptkit ci` read a log right then. Failing
  // on that lock dropped every finding in the log from findings.json on a CI runner.
  it("waits out a brief lock", async () => {
    let calls = 0;
    const handle = await openLog(log, {
      open: async (path, flags) => {
        calls++;
        if (calls < 3) throw busy();
        return open(path, flags);
      }
    });
    await handle.close();
    expect(calls).toBe(3);
  });

  // A missing file will not appear by waiting, and `load_log` should say so at once.
  it("fails at once on any other error", async () => {
    let calls = 0;
    await expect(
      openLog(join(dir, "missing.log"), {
        open: async (path, flags) => {
          calls++;
          return open(path, flags);
        }
      })
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toBe(1);
  });

  // A lock that never clears must still end the wait, or one stuck file hangs the run.
  it("gives up on a lock that does not clear", async () => {
    await expect(
      openLog(log, {
        open: async () => {
          throw busy();
        },
        waitMs: 200
      })
    ).rejects.toMatchObject({ code: "EBUSY" });
  });

  // The real lock: a process that opens the file without sharing makes Node's open fail
  // with EBUSY, as a scanner does. Only Windows has such locks.
  it.runIf(process.platform === "win32")(
    "reads a log another process holds for a moment",
    async () => {
      const holder = spawn("powershell", [
        "-NoProfile",
        "-Command",
        `$f = [System.IO.File]::Open('${log}', 'Open', 'Read', 'None'); Write-Output locked; Start-Sleep -Milliseconds 700; $f.Close()`
      ]);
      const exited = new Promise((resolve) => holder.once("exit", resolve));
      await new Promise<void>((resolve) => {
        holder.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("locked")) resolve();
        });
      });
      const warnings = await readLog(log, {});
      expect(warnings.unknownCommands.get("v8-version")).toBe(1);
      await exited;
    },
    30_000
  );
});
