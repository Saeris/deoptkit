#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server";

// stdout carries the MCP protocol; anything human-facing must go to stderr.
const server = createServer();
await server.connect(new StdioServerTransport());
console.error("deopt-mcp: MCP server listening on stdio");
