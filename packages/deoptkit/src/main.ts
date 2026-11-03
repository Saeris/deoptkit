#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runCi } from "./cli/ci";
import { runLsp } from "./lsp/server";
import { createServer } from "./server";

const USAGE = `deoptkit — V8 deoptimization toolkit

Usage:
  deoptkit [mcp]                                    Start the MCP server on stdio (default)
  deoptkit ci [--update] [--out-dir <dir>] <script.mjs> [...]
                                                    Snapshot-gate structural findings against
                                                    checked-in baselines (exit 1 on new findings)
  deoptkit lsp [--findings <path>]                  Language Server publishing findings.json as
                                                    inline diagnostics (default .deopt/findings.json)
  deoptkit help                                     Show this help
`;

const argv = process.argv.slice(2);
const command = argv.at(0);
const rest = argv.slice(1);

if (command === "ci") {
  process.exitCode = await runCi(rest);
} else if (command === "lsp") {
  process.exitCode = await runLsp(rest);
} else if (command === undefined || command === "mcp") {
  // stdout carries the MCP protocol; anything human-facing must go to stderr.
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error("deoptkit: MCP server listening on stdio");
} else if (command === "help" || command === "--help" || command === "-h") {
  process.stdout.write(USAGE);
} else {
  console.error(`deoptkit: unknown command "${command}"\n\n${USAGE}`);
  process.exitCode = 2;
}
