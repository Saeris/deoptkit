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
import { listDeopts } from "./tools/listDeopts";
import { listFunctions } from "./tools/listFunctions";
import { listIcs } from "./tools/listIcs";
import { listSessions } from "./tools/listSessions";
import { loadLog } from "./tools/loadLog";
import { profileRun } from "./tools/profileRun";
import manifest from "../package.json" with { type: "json" };

const tools: RegisteredTool[] = [
  listSessions,
  loadLog,
  profileRun,
  getFindings,
  listIcs,
  listDeopts,
  listFunctions,
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

export const createServer = (): Server => {
  const server = new Server(
    { name: manifest.name, version: manifest.version },
    { capabilities: { tools: {}, prompts: {} } }
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
