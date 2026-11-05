// The low-level Server is the SDK's documented path for "advanced use cases";
// the recommended McpServer.registerTool only accepts zod schemas, and this
// project uses Valibot (docs/SPEC.md §3), so tool listing/dispatch is manual.
/* oxlint-disable typescript/no-deprecated */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { SessionStore } from "./sessions";
import {
  jsonResult,
  type RegisteredTool,
  type ToolContext
} from "./tools/defineTool";
import { compareSessionsTool } from "./tools/compareSessions";
import { getFindings } from "./tools/getFindings";
import { getFunction } from "./tools/getFunction";
import { getMap } from "./tools/getMap";
import { getProfile } from "./tools/getProfile";
import { listDeopts } from "./tools/listDeopts";
import { listFunctions } from "./tools/listFunctions";
import { listIcs } from "./tools/listIcs";
import { listSessions } from "./tools/listSessions";
import { loadLog } from "./tools/loadLog";
import { loadManifest } from "./tools/loadManifest";
import { profileRun } from "./tools/profileRun";
import manifest from "../package.json" with { type: "json" };

const tools: RegisteredTool[] = [
  listSessions,
  loadLog,
  loadManifest,
  profileRun,
  getFindings,
  listIcs,
  listDeopts,
  listFunctions,
  getProfile,
  getMap,
  getFunction,
  compareSessionsTool
];

const ANALYZE_PROMPT_NAME = "analyze-performance";

const analyzePromptText = (command: string): string =>
  [
    `Analyze and improve the V8 optimization behavior of: ${command}`,
    "",
    "Follow this loop:",
    "1. Call profile_run with the command to create a baseline session.",
    "2. Call get_findings on it. Findings are ranked worst-first with explanations and suggested fixes; use get_function or get_map when a finding needs more context.",
    "3. Fix the top finding in the source code (prefer the smallest change that normalizes shapes or stabilizes types).",
    "4. Call profile_run again, then compare_sessions with base = the earlier session and head = the new one.",
    "5. Confirm the finding appears in `resolved` and nothing meaningful appears in `introduced`. If findings remain above severity 30, repeat from step 2.",
    "",
    "Report each iteration's resolved findings and the final compare_sessions summary. Findings may carry an `original` position — when present, edit that file (the source), not the generated one."
  ].join("\n");

/**
 * Surfaced to MCP clients so an agent knows the workflow without reading external docs.
 * Kept short: the how-to detail lives in each tool's description and the analyze prompt.
 */
const SERVER_INSTRUCTIONS = [
  "deoptkit exposes V8 optimization problems (megamorphic inline caches, deopt loops,",
  "hidden-class/map churn, CPU hot spots) in JavaScript/TypeScript running on Node.js.",
  "",
  "Core loop for optimizing a workload:",
  '1. profile_run { command: ["node", "bench.js"] } — runs it under V8 logging, returns a sessionId.',
  "2. get_findings { sessionId } — ranked problems (severity 1-100) with source locations, V8-level",
  '   explanations, and suggested fixes. Start here; it answers "what should I fix first?".',
  "3. Edit the source at the finding's `original` position when present (that is the .ts/.js you wrote),",
  "   otherwise its file/line. Locations are workspace-relative paths (relative to profile_run's cwd,",
  "   load_log's workspaceRoot, or this server's working directory); pass them to your file tools as they are.",
  "   Prefer the smallest change that normalizes object shapes or stabilizes types.",
  "4. profile_run again with compareTo set to the earlier sessionId (or call compare_sessions",
  "   { baseSessionId, headSessionId }) and confirm the finding is in `resolved` and nothing meaningful",
  "   is in `introduced`.",
  "",
  "Drill-down: get_function (annotated source + its ICs/deopts/ticks), get_map (a shape's transition chain),",
  "list_ics / list_deopts / list_functions, and get_profile for the call tree (who calls the hot function,",
  "top-down or bottom-up). Use load_log to analyze an existing v8.log, or load_manifest to",
  "load every log from a `deoptkit/vitest` bench run, then get_findings { sessionIds } for one ranked list",
  "across workers. Windowing: pass fromMark/toMark (from deoptkit/harness",
  "or benchObserved markers) to scope findings to one benchmark case.",
  "",
  "Token budget: get_findings returns each kind's explanation once under `kinds`; use limit, offset,",
  "severityMin, file, and kinds to narrow pages, and list_ics with includeTransitions only for the one",
  "site you are drilling into.",
  "",
  "Warm-up matters: V8 only optimizes hot code, so profile workloads that run the target thousands of times",
  "(the observed() helper in deoptkit/harness encodes this). Profile built output, not source, for libraries.",
  "",
  "Every profile_run/load_log response carries `quality.warnings`; a `cold` or `no-ticks` warning means the findings describe",
  "warm-up, not steady state, and the workload needs more iterations before they are worth acting on. A `sparse-ticks`",
  "warning means IC and map logging starved the profiler: for heat and get_profile, run once more with",
  'categories: ["profile"] and read the call tree from that session.',
  "",
  "Not every polymorphic site is an object-shape problem: a finding whose `receiver` is `string` (V8 string",
  "representations) cannot be fixed by property order, and `array` means mixed elements kinds. get_findings lists",
  "files without a source map under `unmapped`; edit the source that produced them, not the bundle."
].join("\n");

export const createServer = (): Server => {
  const server = new Server(
    { name: manifest.name, version: manifest.version },
    {
      capabilities: { tools: {}, prompts: {} },
      instructions: SERVER_INSTRUCTIONS
    }
  );
  const ctx: ToolContext = { sessions: new SessionStore() };

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map(({ info }) => info)
  }));

  server.setRequestHandler(ListPromptsRequestSchema, () => ({
    prompts: [
      {
        name: ANALYZE_PROMPT_NAME,
        description:
          "Guided profile -> findings -> fix -> compare loop for a Node.js workload",
        arguments: [
          {
            name: "command",
            description: 'The workload to profile, e.g. "node bench.js"',
            required: true
          }
        ]
      }
    ]
  }));

  server.setRequestHandler(GetPromptRequestSchema, (request) => {
    if (request.params.name !== ANALYZE_PROMPT_NAME) {
      throw new Error(`Unknown prompt: ${request.params.name}`);
    }
    const command = request.params.arguments?.["command"] ?? "<command>";
    return {
      description: `V8 optimization analysis loop for: ${command}`,
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: analyzePromptText(command) }
        }
      ]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find(({ info }) => info.name === request.params.name);
    if (!tool) {
      return jsonResult(
        { error: `Unknown tool: ${request.params.name}` },
        { isError: true }
      );
    }
    return tool.invoke(request.params.arguments, ctx);
  });

  return server;
};
