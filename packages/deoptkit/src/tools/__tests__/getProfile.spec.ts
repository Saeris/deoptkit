import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateWorkloadLog } from "../../parser/__tests__/helpers";
import { SessionStore } from "../../sessions";
import { getProfile } from "../getProfile";
import { loadLogFile } from "../loadLog";

interface Node {
  file?: string;
  selfTicks: number;
  totalTicks: number;
  folded?: { file?: string; selfTicks: number }[];
  children: Node[];
}

interface Payload {
  view: string;
  tickCount: number;
  attributedTicks: number;
  roots: Node[];
  error?: string;
}

const payloadOf = (result: { content: unknown }): Payload => {
  const [first] = result.content as [{ type: "text"; text: string }];
  return JSON.parse(first.text) as Payload;
};

const walk = (nodes: Node[]): Node[] =>
  nodes.flatMap((node) => [node, ...walk(node.children)]);

describe("get_profile", () => {
  let fixtureDir: string;
  let sessions: SessionStore;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "deoptkit-profile-"));
    sessions = new SessionStore();
    await loadLogFile(generateWorkloadLog("megamorphic", fixtureDir), {
      sessions
    });
  }, 60_000);

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it("shows only the user's own code, folding builtin ticks into the loop that called them", async () => {
    // Most megamorphic ticks land in LoadIC_Megamorphic with no JS frame; an agent
    // editing megamorphic.js needs that time on the user line, not missing from the tree.
    const result = await getProfile.invoke({ sessionId: "s1" }, { sessions });
    const payload = payloadOf(result);

    expect(result.isError).toBeUndefined();
    expect(payload.tickCount).toBeGreaterThan(5);
    expect(payload.attributedTicks).toBeGreaterThanOrEqual(1);
    expect(payload.roots.length).toBeGreaterThan(0);
    for (const node of walk(payload.roots)) {
      expect(node.totalTicks).toBeGreaterThanOrEqual(node.selfTicks);
      expect(node.file).toMatch(/megamorphic\.js$/);
      expect(node.file).not.toMatch(/^([A-Za-z]:|\/|file:)/);
      // Folded frames are presented like nodes: workspace-relative, never a URL.
      for (const frame of node.folded ?? []) {
        expect(frame.selfTicks).toBeLessThanOrEqual(node.selfTicks);
        expect(frame.file ?? "").not.toMatch(/^([A-Za-z]:|\/|file:)/);
      }
    }
  });

  it("roots the bottom-up view at the functions that ran, so their self ticks add up to the attributed ticks", async () => {
    // Bottom-up is for "what is hot, and who calls it"; if root self ticks did not
    // partition the samples, the ranking of hot functions would be unreliable.
    const payload = payloadOf(
      await getProfile.invoke(
        { sessionId: "s1", view: "bottom-up", minPercent: 0, limit: 50 },
        { sessions }
      )
    );

    expect(payload.view).toBe("bottom-up");
    expect(payload.roots.length).toBeGreaterThan(0);
    expect(
      payload.roots.reduce((sum, { selfTicks }) => sum + selfTicks, 0)
    ).toBe(payload.attributedTicks);
  });

  it("attributes at least as many samples when dependencies and internals are included", async () => {
    // Turning just-my-code off can only add samples (those with no user frame).
    const mine = payloadOf(
      await getProfile.invoke({ sessionId: "s1" }, { sessions })
    );
    const everything = payloadOf(
      await getProfile.invoke(
        { sessionId: "s1", justMyCode: false },
        { sessions }
      )
    );

    expect(everything.attributedTicks).toBeGreaterThanOrEqual(
      mine.attributedTicks
    );
  });

  it("reports an unknown marker as a window error instead of an empty tree", async () => {
    const result = await getProfile.invoke(
      { sessionId: "s1", fromMark: "no-such-marker" },
      { sessions }
    );

    expect(result.isError).toBe(true);
    expect(payloadOf(result).error).toContain("no-such-marker");
  });

  it("names the unknown session", async () => {
    const result = await getProfile.invoke({ sessionId: "nope" }, { sessions });

    expect(result.isError).toBe(true);
    expect(payloadOf(result).error).toContain("nope");
  });
});
