// The low-level Server is the SDK's documented path for "advanced use cases";
// the recommended McpServer.registerTool only accepts zod schemas, and this
// project uses Valibot (docs/SPEC.md §3), so tool listing/dispatch is manual.
/* oxlint-disable typescript/no-deprecated */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { SessionStore } from "./sessions";
import {
  jsonResult,
  type RegisteredTool,
  type ToolContext
} from "./tools/defineTool";
import { listSessions } from "./tools/listSessions";
import { loadLog } from "./tools/loadLog";
import manifest from "../package.json" with { type: "json" };

const tools: RegisteredTool[] = [listSessions, loadLog];

export const createServer = (): Server => {
  const server = new Server(
    { name: manifest.name, version: manifest.version },
    { capabilities: { tools: {} } }
  );
  const ctx: ToolContext = { sessions: new SessionStore() };

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map(({ info }) => info)
  }));

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
