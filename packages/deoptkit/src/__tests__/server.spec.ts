import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../server";

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

const textPayload = (
  result: Awaited<ReturnType<Client["callTool"]>>
): Record<string, unknown> => {
  const [first] = result.content as [{ type: "text"; text: string }];
  return JSON.parse(first.text) as Record<string, unknown>;
};

describe("deoptkit server", () => {
  let client: Client;
  let fixtureDir: string;

  beforeAll(async () => {
    client = await connect();
    fixtureDir = await mkdtemp(join(tmpdir(), "deoptkit-test-"));
  });

  afterAll(async () => {
    await client.close();
    await rm(fixtureDir, { recursive: true, force: true });
  });

  describe("tools/list", () => {
    // Agents discover and call tools purely from this listing; a missing tool or a
    // non-object schema silently breaks every client, so the contract is pinned here.
    it("advertises the session tools with object input schemas", async () => {
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      expect([...byName.keys()].toSorted()).toEqual([
        "compare_sessions",
        "get_findings",
        "get_function",
        "get_map",
        "list_deopts",
        "list_functions",
        "list_ics",
        "list_sessions",
        "load_log",
        "load_manifest",
        "profile_run"
      ]);
      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.description?.length ?? 0).toBeGreaterThan(0);
        expect(tool.title?.length ?? 0).toBeGreaterThan(0);
        expect(typeof tool.annotations?.readOnlyHint).toBe("boolean");
        // Hosts auto-approve read-only tools; mislabeling profile_run would let a host
        // run commands without asking.
        expect(tool.annotations?.readOnlyHint).toBe(
          tool.name !== "profile_run"
        );
      }
      expect(byName.get("load_log")?.inputSchema.required).toContain("path");
    });

    // Instructions are how an agent learns the profile -> findings -> fix -> compare
    // loop without external docs; MCP clients surface them from the initialize result.
    it("surfaces server instructions describing the core workflow", () => {
      const instructions = client.getInstructions() ?? "";
      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions).toContain("profile_run");
      expect(instructions).toContain("get_findings");
      expect(instructions).toContain("compare_sessions");
    });
  });

  describe("prompts", () => {
    it("serves the analyze-performance prompt with the command inlined", async () => {
      const { prompts } = await client.listPrompts();
      expect(prompts.map(({ name }) => name)).toEqual(["analyze-performance"]);
      const prompt = await client.getPrompt({
        name: "analyze-performance",
        arguments: { command: "node bench.js" }
      });
      const [message] = prompt.messages;
      const text = message?.content.type === "text" ? message.content.text : "";
      expect(text).toContain("node bench.js");
      expect(text).toContain("compare_sessions");
    });
  });

  describe("list_sessions", () => {
    it("returns an empty session list on a fresh server", async () => {
      const result = await client.callTool({
        name: "list_sessions",
        arguments: {}
      });
      expect(result.isError ?? false).toBe(false);
      expect(textPayload(result)).toEqual({ sessions: [] });
    });

    // Clients that consume `structuredContent` must see exactly what text consumers see.
    it("returns structuredContent identical to the text payload", async () => {
      const result = await client.callTool({
        name: "list_sessions",
        arguments: {}
      });
      expect(result.structuredContent).toEqual(textPayload(result));
    });
  });

  describe("load_log", () => {
    it("rejects arguments that do not match the schema", async () => {
      const result = await client.callTool({
        name: "load_log",
        arguments: { path: 42 }
      });
      expect(result.isError).toBe(true);
      expect(textPayload(result).error).toBe("Invalid arguments");
    });

    it("reports unreadable paths as errors instead of crashing the server", async () => {
      const result = await client.callTool({
        name: "load_log",
        arguments: { path: join(fixtureDir, "does-not-exist.log") }
      });
      expect(result.isError).toBe(true);
      expect(textPayload(result).error).toMatch(/Cannot read log file/u);
    });

    it("rejects files that are not V8 logs so agents get actionable feedback", async () => {
      const path = join(fixtureDir, "not-a-log.txt");
      await writeFile(path, "hello world\n");
      const result = await client.callTool({
        name: "load_log",
        arguments: { path }
      });
      expect(result.isError).toBe(true);
      expect(textPayload(result).error).toMatch(/does not look like a V8 log/u);
    });

    // The end-to-end promise: run a workload with zero flag knowledge, get ranked
    // findings that name its deliberate pathology.
    it("profile_run profiles a workload and get_findings names its pathology", async () => {
      const workload = join(
        import.meta.dirname,
        "..",
        "..",
        "fixtures",
        "workloads",
        "map-churn.js"
      );
      const result = await client.callTool({
        name: "profile_run",
        arguments: {
          command: ["node", workload],
          cwd: dirname(workload),
          timeoutMs: 60_000
        }
      });
      expect(result.isError ?? false).toBe(false);
      const payload = textPayload(result);
      expect(String(payload.workspaceRoot)).toMatch(/workloads$/u);
      expect((payload.counts as { icSites: number }).icSites).toBeGreaterThan(
        0
      );
      // map-churn runs 1e5 iterations, so a healthy session must come back without a
      // cold warning; otherwise the warning would cry wolf on real workloads.
      const quality = payload.quality as {
        totalTicks: number;
        userFunctionsOptimized: number;
        warnings: { code: string }[];
      };
      expect(typeof quality.totalTicks).toBe("number");
      expect(quality.userFunctionsOptimized).toBeGreaterThanOrEqual(1);
      expect(quality.warnings.map(({ code }) => code)).not.toContain("cold");

      const findings = await client.callTool({
        name: "get_findings",
        arguments: { sessionId: String(payload.sessionId) }
      });
      const { items, kinds } = textPayload(findings) as unknown as {
        items: { kind: string; file: string }[];
        kinds: Record<string, { explanation: string; suggestedFix: string }>;
      };
      // The six template strings were 37-42% of every findings payload; the legend
      // carries them once, and an agent reads the kind's text at most once per response.
      expect(items.length).toBeGreaterThan(0);
      for (const found of items) {
        expect("explanation" in found).toBe(false);
        expect("suggestedFix" in found).toBe(false);
        expect(kinds[found.kind]?.explanation.length ?? 0).toBeGreaterThan(0);
        expect(kinds[found.kind]?.suggestedFix.length ?? 0).toBeGreaterThan(0);
      }
      expect(Object.keys(kinds).toSorted()).toEqual(
        [...new Set(items.map(({ kind }) => kind))].toSorted()
      );
      // Agents pass these strings to Read/Edit; a URL or an absolute path breaks that
      // and wastes a conversion turn.
      const megamorphic = items.filter(
        (found) => found.kind === "megamorphic-ic"
      );
      expect(megamorphic.length).toBeGreaterThan(0);
      for (const found of megamorphic) {
        expect(found.file).toBe("map-churn.js");
        expect(found.file.startsWith("file:")).toBe(false);
      }

      // Without offset an agent can never see past the first page of findings, and
      // without a file filter it cannot focus on the module it is editing.
      const paged = await client.callTool({
        name: "get_findings",
        arguments: { sessionId: String(payload.sessionId), limit: 1, offset: 1 }
      });
      const page = textPayload(paged) as unknown as {
        offset: number;
        items: unknown[];
      };
      expect(page.offset).toBe(1);
      expect(page.items.length).toBeLessThanOrEqual(1);
      expect(page.items).toEqual(items.slice(1, 2));

      const unmatched = await client.callTool({
        name: "get_findings",
        arguments: {
          sessionId: String(payload.sessionId),
          file: "does-not-match"
        }
      });
      const none = textPayload(unmatched) as unknown as {
        totalCount: number;
        items: unknown[];
      };
      expect(none.items).toEqual([]);
      expect(none.totalCount).toBe(0);

      // Drill-down: the annotated snippet marks the polluted read without any file I/O.
      const fn = await client.callTool({
        name: "get_function",
        arguments: {
          sessionId: String(payload.sessionId),
          file: "map-churn.js",
          functionName: "readId"
        }
      });
      expect(fn.isError ?? false).toBe(false);
      const detail = textPayload(fn) as unknown as {
        file: string;
        snippet: { text: string };
        annotations: { note: string }[];
      };
      expect(detail.file).toBe("map-churn.js");
      expect(detail.snippet.text).toContain("return record.id;");
      expect(
        detail.annotations.some((annotation) =>
          annotation.note.includes("megamorphic")
        )
      ).toBe(true);

      // Unbounded histories were 4-5k tokens per page; a bound plus a summary keeps the
      // two facts an agent acts on: how many shapes hit the site and how it escalated.
      const ics = await client.callTool({
        name: "list_ics",
        arguments: {
          sessionId: String(payload.sessionId),
          includeTransitions: true,
          maxTransitions: 2,
          states: ["megamorphic"],
          file: "map-churn.js"
        }
      });
      const { items: sites } = textPayload(ics) as unknown as {
        items: {
          key: string;
          transitionCount: number;
          transitions: unknown[];
          transitionsOmitted: number;
          distinctMaps: number;
          stateHistory: string;
          mapAddresses: string[];
        }[];
      };
      const idSite = sites.find(({ key }) => key === "id");
      if (idSite === undefined)
        throw new Error("expected a megamorphic `id` site in map-churn.js");
      expect(idSite.transitions.length).toBeLessThanOrEqual(2);
      expect(idSite.transitionsOmitted).toBe(
        idSite.transitionCount - idSite.transitions.length
      );
      // Megamorphic means the site saw at least five shapes.
      expect(idSite.distinctMaps).toBeGreaterThanOrEqual(5);
      expect(idSite.stateHistory.endsWith("megamorphic")).toBe(true);
      expect(idSite.mapAddresses.length).toBeGreaterThanOrEqual(1);

      // Closing the loop in one call saves a round trip and the bookkeeping of two
      // session ids on every iteration.
      const fixed = await client.callTool({
        name: "profile_run",
        arguments: {
          command: ["node", join(dirname(workload), "map-churn-fixed.js")],
          cwd: dirname(workload),
          timeoutMs: 60_000,
          compareTo: String(payload.sessionId)
        }
      });
      expect(fixed.isError ?? false).toBe(false);
      const { comparison } = textPayload(fixed) as unknown as {
        comparison: {
          base: { sessionId: string };
          resolved: {
            kind: string;
            evidence: { key?: string };
          }[];
          kinds: Record<string, unknown>;
        };
      };
      expect(comparison.base.sessionId).toBe(String(payload.sessionId));
      expect(
        comparison.resolved.some(
          (found) =>
            found.kind === "megamorphic-ic" && found.evidence.key === "id"
        )
      ).toBe(true);
      expect(comparison.kinds["megamorphic-ic"]).toBeDefined();
      for (const found of comparison.resolved) {
        expect("explanation" in found).toBe(false);
      }
    }, 120_000);

    // A request that cannot be fulfilled must not cost a workload run: process.exit(3)
    // would surface as an exit code in the payload if the command had been spawned.
    it("profile_run rejects an unknown compareTo before running the command", async () => {
      const result = await client.callTool({
        name: "profile_run",
        arguments: {
          command: ["node", "-e", "process.exit(3)"],
          compareTo: "nope"
        }
      });
      expect(result.isError).toBe(true);
      const payload = textPayload(result);
      expect(payload.error).toMatch(/Unknown session/u);
      expect(Object.keys(payload)).toEqual(["error"]);
    });

    // A worthless session must announce itself where the agent looks first: both in
    // the response that created it and again on get_findings, which an agent would
    // otherwise read as "no findings, nothing wrong".
    it("profile_run flags a trivial workload and get_findings repeats the warnings", async () => {
      const result = await client.callTool({
        name: "profile_run",
        arguments: { command: ["node", "-e", "1 + 1"], timeoutMs: 60_000 }
      });
      expect(result.isError ?? false).toBe(false);
      const payload = textPayload(result);
      const quality = payload.quality as { warnings: { code: string }[] };
      const codes = quality.warnings.map(({ code }) => code);
      expect(codes.includes("no-user-code") || codes.includes("cold")).toBe(
        true
      );

      const findings = await client.callTool({
        name: "get_findings",
        arguments: { sessionId: String(payload.sessionId) }
      });
      const { qualityWarnings } = textPayload(findings) as unknown as {
        qualityWarnings: { sessionId: string; code: string }[];
      };
      expect(qualityWarnings.map(({ code }) => code)).toEqual(codes);
      for (const warning of qualityWarnings) {
        expect(warning.sessionId).toBe(String(payload.sessionId));
      }
    }, 120_000);

    it("reports unknown sessions as errors on analysis tools", async () => {
      const result = await client.callTool({
        name: "get_findings",
        arguments: { sessionId: "nope" }
      });
      expect(result.isError).toBe(true);
      expect(textPayload(result).error).toMatch(/Unknown session/u);
    });

    it("parses a minimal V8 log into a session and reports it in list_sessions", async () => {
      const path = join(fixtureDir, "real.v8.log");
      await writeFile(
        path,
        "v8-version,13,6,233,10,-node.18,0\nshared-library,foo,0x1,0x2,0\n"
      );
      const result = await client.callTool({
        name: "load_log",
        arguments: { path }
      });
      expect(result.isError ?? false).toBe(false);
      const payload = textPayload(result);
      expect(payload.sessionId).toMatch(/^s\d+$/u);
      expect(payload.v8Version).toBe("13.6.233.10.-node.18.0");
      expect(payload.counts).toEqual({
        icSites: 0,
        deoptSites: 0,
        mapsCreated: 0,
        mapTransitionSites: 0,
        profileTicks: 0,
        codeEntries: 0
      });

      const sessions = await client.callTool({
        name: "list_sessions",
        arguments: {}
      });
      const listed = textPayload(sessions).sessions as { id: string }[];
      expect(listed.map(({ id }) => id)).toContain(payload.sessionId);
    });
  });
});
