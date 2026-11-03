import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../server";

// The plugin lives at the repository root, outside the npm package.
const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const readRepoFile = async (...segments: string[]): Promise<string> =>
  readFile(join(repoRoot, ...segments), "utf8");

const connect = async (): Promise<Client> => {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    createServer().connect(serverTransport),
    client.connect(clientTransport)
  ]);
  return client;
};

describe("claude Code plugin", () => {
  let client: Client;

  beforeAll(async () => {
    client = await connect();
  });

  afterAll(async () => {
    await client.close();
  });

  // The skill is a projection of the server: a tool the server adds or renames must
  // show up in the skill, or agents following the skill call tools that do not exist.
  it("mentions every tool the server advertises in the workflow skill", async () => {
    const { tools } = await client.listTools();
    const skill = await readRepoFile(
      "plugins",
      "deoptkit",
      "skills",
      "deoptkit",
      "SKILL.md"
    );
    const missing = tools
      .map((tool) => tool.name)
      .filter((name) => !skill.includes(name));
    expect(missing).toEqual([]);
  });

  // Claude Code loads only the frontmatter description to decide when to invoke the
  // skill; an empty or oversized one means it never triggers or is rejected.
  it("gives the skill a non-empty frontmatter description under 1024 characters", async () => {
    const skill = await readRepoFile(
      "plugins",
      "deoptkit",
      "skills",
      "deoptkit",
      "SKILL.md"
    );
    const description = /^---\r?\n[\s\S]*?^description:\s*(.+)$/m.exec(
      skill
    )?.[1];
    expect(description?.trim().length ?? 0).toBeGreaterThan(0);
    expect(description?.trim().length ?? 0).toBeLessThan(1024);
  });

  // The plugin must keep launching the published package; a typo here installs an
  // MCP server that never starts, and nothing else in the repo would notice.
  it("registers the deopt server from the published deoptkit package", async () => {
    const config = JSON.parse(
      await readRepoFile("plugins", "deoptkit", ".mcp.json")
    ) as { mcpServers?: { deopt?: { args?: string[] } } };
    expect(
      config.mcpServers?.deopt?.args?.some((arg) => arg.startsWith("deoptkit"))
    ).toBe(true);
  });

  // `/plugin install deoptkit@deoptkit` resolves through this listing; a wrong source
  // path makes the documented install command fail for every user.
  it("lists the plugin in the marketplace at its in-repo source", async () => {
    const marketplace = JSON.parse(
      await readRepoFile(".claude-plugin", "marketplace.json")
    ) as { plugins: { name: string; source: string }[] };
    expect(marketplace.plugins.map((plugin) => plugin.source)).toContain(
      "./plugins/deoptkit"
    );
  });
});
