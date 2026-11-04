import { existsSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import {
  LanguageClient,
  TransportKind,
  type ServerOptions
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

const LANGUAGES = [
  "javascript",
  "javascriptreact",
  "typescript",
  "typescriptreact"
];

/**
 * Which server to run, in order of preference: the user's explicit command, the
 * workspace's own installed deoptkit (the same version that wrote findings.json),
 * else the copy bundled with this extension. `module` servers run on the extension
 * host's Node, so nothing depends on the user's PATH.
 */
const serverFor = (
  folder: vscode.WorkspaceFolder,
  context: vscode.ExtensionContext
): ServerOptions => {
  const config = vscode.workspace.getConfiguration("deoptkit");
  const findings = join(
    folder.uri.fsPath,
    config.get<string>("findingsPath") ?? ".deopt/findings.json"
  );
  const custom = config.get<string[]>("serverCommand") ?? [];
  const options = { cwd: folder.uri.fsPath };
  if (custom.length > 0) {
    const [command = "", ...args] = custom;
    return { command, args: [...args, "--findings", findings], options };
  }
  const installed = join(
    folder.uri.fsPath,
    "node_modules",
    "deoptkit",
    "dist",
    "main.mjs"
  );
  if (existsSync(installed)) {
    return {
      module: installed,
      transport: TransportKind.stdio,
      args: ["lsp", "--findings", findings],
      options
    };
  }
  return {
    module: context.asAbsolutePath("dist/server.cjs"),
    transport: TransportKind.stdio,
    args: ["--findings", findings],
    options
  };
};

export const activate = async (
  context: vscode.ExtensionContext
): Promise<void> => {
  // Thin client: one server for the first workspace folder (memo decision 6).
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) return;
  client = new LanguageClient(
    "deoptkit",
    "deoptkit",
    serverFor(folder, context),
    {
      documentSelector: LANGUAGES.map((language) => ({
        scheme: "file",
        language
      }))
    }
  );
  context.subscriptions.push(client);
  await client.start();
};

export const deactivate = (): Thenable<void> | undefined => client?.stop();
