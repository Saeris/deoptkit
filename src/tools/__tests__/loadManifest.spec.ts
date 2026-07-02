import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { generateWorkloadLog } from "../../parser/__tests__/helpers";
import { SessionStore } from "../../sessions";
import { loadManifest } from "../loadManifest";

const payloadOf = (result: { content: unknown }): Record<string, unknown> => {
  const [first] = result.content as [{ type: "text"; text: string }];
  return JSON.parse(first.text) as Record<string, unknown>;
};

describe("load_manifest", () => {
  let fixtureDir: string;
  let logfile: string;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "deoptkit-manifest-"));
    logfile = generateWorkloadLog("map-churn", fixtureDir);
  }, 60_000);

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it("loads every listed log as a session and reports per-log outcomes", async () => {
    const manifestPath = join(fixtureDir, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        outDir: fixtureDir,
        logfiles: [logfile, join(fixtureDir, "missing.log")]
      })
    );
    const sessions = new SessionStore();
    const result = await loadManifest.invoke(
      { path: manifestPath },
      { sessions }
    );
    expect(result.isError ?? false).toBe(false);
    const payload = payloadOf(result);
    expect(payload["loadedCount"]).toBe(1);
    const outcomes = payload["sessions"] as Record<string, unknown>[];
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]?.["sessionId"]).toBe("s1");
    expect(String(outcomes[1]?.["error"])).toMatch(/Cannot read log file/u);
    expect(sessions.list()).toHaveLength(1);
  });

  it("rejects files that are not manifests", async () => {
    const bogus = join(fixtureDir, "bogus.json");
    await writeFile(bogus, JSON.stringify({ hello: "world" }));
    const result = await loadManifest.invoke(
      { path: bogus },
      { sessions: new SessionStore() }
    );
    expect(result.isError).toBe(true);
  });
});
