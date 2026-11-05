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

const isEnabled = (): boolean =>
  vscode.workspace.getConfiguration("deoptkit").get<boolean>("enable") ?? true;

const start = async (
  folder: vscode.WorkspaceFolder,
  context: vscode.ExtensionContext
): Promise<void> => {
  if (client !== undefined) return;
  // A fresh client per start: stopping one disposes its transport, so a restart
  // after a toggle spawns a new server rather than reviving the old process.
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
  await client.start();
};

/** Stopping the client also clears every diagnostic it published. */
const stop = async (): Promise<void> => {
  const running = client;
  client = undefined;
  await running?.stop();
};

export const activate = async (
  context: vscode.ExtensionContext
): Promise<void> => {
  // Thin client: one server for the first workspace folder (memo decision 6).
  const folder = vscode.workspace.workspaceFolders?.[0];
  context.subscriptions.push(
    // The toggle writes the setting rather than flipping private state, so the
    // choice survives a reload and shows up in the settings UI. It is scoped to
    // the workspace, like the server, so silencing one project leaves the rest.
    vscode.commands.registerCommand("deoptkit.toggle", async () => {
      const config = vscode.workspace.getConfiguration("deoptkit");
      const next = !(config.get<boolean>("enable") ?? true);
      await config.update(
        "enable",
        next,
        folder === undefined
          ? vscode.ConfigurationTarget.Global
          : vscode.ConfigurationTarget.Workspace
      );
      vscode.window.setStatusBarMessage(
        `deoptkit: ${next ? "enabled" : "disabled"}`,
        3000
      );
    }),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (
        !event.affectsConfiguration("deoptkit.enable") ||
        folder === undefined
      )
        return;
      if (isEnabled()) await start(folder, context);
      else await stop();
    }),
    { dispose: () => void stop() }
  );
  if (folder !== undefined && isEnabled()) await start(folder, context);
};

export const deactivate = (): Thenable<void> | undefined =>
  client === undefined ? undefined : stop();
