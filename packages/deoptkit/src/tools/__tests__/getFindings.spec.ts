import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateWorkloadLog } from "../../parser/__tests__/helpers";
import { SessionStore } from "../../sessions";
import { getFindings } from "../getFindings";
import { loadLogFile } from "../loadLog";

const payloadOf = (result: { content: unknown }): Record<string, unknown> => {
  const [first] = result.content as [{ type: "text"; text: string }];
  return JSON.parse(first.text) as Record<string, unknown>;
};

describe("get_findings", () => {
  let fixtureDir: string;
  let sessions: SessionStore;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "deoptkit-findings-"));
    const logfile = generateWorkloadLog("map-churn", fixtureDir);
    // Two sessions of identical content: what two workers running the same bench
    // file produce.
    sessions = new SessionStore();
    await loadLogFile(logfile, { sessions });
    await loadLogFile(logfile, { sessions });
  }, 60_000);

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it("merges the findings of several sessions by identity and lists the sessions each appeared in", async () => {
    // Without the merge the agent calls get_findings per worker and dedupes by hand;
    // the identities must line up across processes for that to be avoidable.
    const single = payloadOf(
      await getFindings.invoke({ sessionId: "s1", limit: 100 }, { sessions })
    );
    const merged = payloadOf(
      await getFindings.invoke(
        { sessionIds: ["s1", "s2"], limit: 100 },
        { sessions }
      )
    );
    expect(single["totalCount"]).toBeGreaterThan(0);
    expect(merged["totalCount"]).toBe(single["totalCount"]);
    const items = merged["items"] as Record<string, unknown>[];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item["sessions"]).toEqual(["s1", "s2"]);
      expect("explanation" in item).toBe(false);
    }
    expect(merged["kinds"]).toBeDefined();
  });

  it("keeps the single-session shape free of a sessions field", async () => {
    // Agents with one log must not pay for (or be confused by) merge bookkeeping.
    const payload = payloadOf(
      await getFindings.invoke({ sessionId: "s1" }, { sessions })
    );
    const items = payload["items"] as Record<string, unknown>[];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect("sessions" in item).toBe(false);
    }
  });

  it("names the unknown session instead of silently ranking the rest", async () => {
    const result = await getFindings.invoke(
      { sessionIds: ["s1", "nope"] },
      { sessions }
    );
    expect(result.isError).toBe(true);
    expect(String(payloadOf(result)["error"])).toContain("nope");
  });

  it("asks for a session when none is given", async () => {
    const result = await getFindings.invoke({}, { sessions });
    expect(result.isError).toBe(true);
    expect(String(payloadOf(result)["error"])).toContain("sessionId");
  });
});
