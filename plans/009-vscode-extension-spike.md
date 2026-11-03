# Plan 009: VSCode extension — thin `deoptkit lsp` client in `extensions/deoptkit-vscode`

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md` — unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: confirm plan 010 is DONE in `plans/README.md`, `ls extensions` fails (no extensions yet), and `git diff --stat 4e0de7e..HEAD -- packages/deoptkit/package.json packages/deoptkit/vite.config.ts .bumpy/_config.json .github/workflows/release.yml .github/workflows/ci.yml .gitignore package.json README.md` shows only changes made by plans 011–019 (bench script, plugin rows, `scripts`); compare the excerpts below with the live files and STOP on a mismatch in `exports`, `pack.entry`, `.bumpy/_config.json`, or the workflows.

## Status

- **Priority**: P2
- **Effort**: M (the layout decision and conversion already landed in plan 010)
- **Risk**: MED
- **Depends on**: plans/005-vitest-preset-writes-findings-json.md, plans/010-yarn-workspace-conversion.md
- **Category**: direction
- **Planned at**: commit `4e0de7e`, 2026-11-03 (revised; the original spike's Step 1 produced `docs/VSCODE_EXTENSION.md` at `8cf852c`)

## Why this matters

`deoptkit lsp` publishes findings as standard LSP diagnostics and Neovim, Helix, and Zed attach to it with one line of config, but VSCode, the editor the primary audience uses next to Claude Code, has no generic LSP client. The maintainer decided (memo `docs/VSCODE_EXTENSION.md`, "Decision", 2026-11-03) to host the extension in this repository as a workspace package that bundles the server and releases in lockstep with the engine through bumpy. This plan builds that thin client: it starts the server, lets `vscode-languageclient` render what it publishes, and adds nothing of its own (BENCHMARKING §8: "a thin projection over the maintained engine and findings interchange, never load-bearing logic").

## Current state

- Decisions recorded in `docs/VSCODE_EXTENSION.md` ("Decision"): publisher `saeris`; name `deoptkit-vscode`, display name `deoptkit`; `engines.vscode: ^1.125.0`; server started as a `module` over stdio, preferring the workspace's installed `deoptkit` (`<folder>/node_modules/deoptkit/dist/main.mjs`) and falling back to a server bundled in the extension, with `deoptkit.serverCommand` overriding both; no run-bench command; first workspace folder only; `extensions/*/.vscode/launch.json` committed through a `.gitignore` exception. The memo's "Behaviour" and "Settings" sections describe the client; its "Smoke test" heading is empty and this plan fills it.
- Repository layout after plan 010: private root `package.json` (`"workspaces": ["packages/*", "extensions/*"]`, devDependencies include `vite-plus`, `vitest`, `typescript`, `@saeris/configs`, `@varlock/bumpy`), root `vite.config.ts` (`lint`, `fmt`, `run.tasks.build: vp run -r build`, `test.projects: ["packages/*"]`), root `tsconfig.json` (`include: ["**/*.ts"]`, excludes `node_modules`, `.yarn`, `.claude`, `**/dist/**`), the engine at `packages/deoptkit`.
- `packages/deoptkit/package.json` `exports` (all pointing at `./dist/*`): `.`, `./harness`, `./vitest`, `./vitest/global-setup`, `./bench`, `./serve`, `./package.json`. No `./lsp` export; `runLsp` is reachable only through the bin (`src/main.ts` dispatches `deoptkit lsp`).
- `packages/deoptkit/vite.config.ts` `pack.entry`: `index`, `main`, `harness`, `vitest`, `vitest-global-setup`, `bench`, `serve` (all `./src/...`); `format: ["esm"]`, `dts: true`, `clean: true`, `outDir: ./dist`.
- `packages/deoptkit/src/lsp/server.ts`: `export const runLsp = async (args: string[], streams?: LspStreams): Promise<number>`; `--findings <path>` (default `.deopt/findings.json`) resolved against `process.cwd()`; polls the file every 250 ms; `initialize` returns `{ capabilities: { textDocumentSync: 0 }, serverInfo: { name: "deoptkit", version } }`; it imports `../../package.json` for the version.
- `.bumpy/_config.json`:

  ```json
  {
    "$schema": "../node_modules/@varlock/bumpy/config-schema.json",
    "baseBranch": "main",
    "changelog": "github",
    "githubRelease": true,
    "packages": {
      "deoptkit": {
        "buildCommand": "vp pack"
      }
    }
  }
  ```

  Bumpy 1.19's schema (`node_modules/@varlock/bumpy/config-schema.json`) accepts per-package `buildCommand`, `publishCommand`, `skipNpmPublish`, and `releaseTriggeringDevDeps` ("Names (or globs) of devDependencies that are release-relevant: a change to one requires a release of this package, and (for internal workspace deps) its own releases cascade here ... The usual reason is a dep bundled into the published output"). Root-config commands are always trusted; this repo uses the root-config form, so no `allowCustomCommands`.

- `.github/workflows/release.yml`: `changes` job filters `packages/*/package.json` and `extensions/*/package.json`; `bump` and `publish` jobs run `vp dlx @varlock/bumpy ci release` with `GH_TOKEN`, `BUMPY_GH_TOKEN`, `NO_COLOR`, `YARN_ENABLE_COLORS`; the publish job runs `vp -C packages/deoptkit pack` first. `.github/workflows/ci.yml`: `vp check` then `vp test` (plan 018 may add a gate step after them).
- Root `.gitignore` contains the line `.vscode` (ignores every `.vscode` directory) and `**/dist/`.
- Versions on npm (checked 2026-11-03): `vscode-languageclient` 11.0.0 (`engines.vscode ^1.91.0`), `@types/vscode` 1.144.0 (pin `^1.125.0` to match `engines`), `@vscode/vsce` 4.1.0 (`engines.node >= 22`).
- Mirrordown's extension files to copy (from `C:\GitHub\@saeris\markdown\extensions\markdown-abbr`), inlined:

  `.vscodeignore`:

  ```
  .vscode/**
  .gitignore
  node_modules
  src
  **/*.map
  **/*.ts
  vite.config.*
  tsconfig.json
  ```

  `tsconfig.json`:

  ```json
  {
    "extends": "../../tsconfig.json",
    "compilerOptions": {
      "rootDir": "src",
      "outDir": "dist"
    },
    "include": ["src"]
  }
  ```

  `vite.config.ts` (its `pack` block bundles the workspace plugin into a CJS extension):

  ```ts
  import { defineConfig } from "vite-plus";

  export default defineConfig({
    run: {
      tasks: {
        build: {
          command: "vp pack && vp exec vsce package --no-dependencies",
          cache: true
        }
      }
    },
    pack: {
      entry: "src/index.ts",
      deps: {
        resolveDepSubpath: true,
        alwaysBundle: [/^@mirrordown\//]
      },
      dts: false,
      format: "cjs"
    }
  });
  ```

- Package README, "Inline editor diagnostics (LSP)" (`packages/deoptkit/README.md`), ends with the paragraph beginning "**VSCode** has no built-in generic LSP client, so a dedicated deoptkit extension is the tracked next step".
- Root `README.md` has a "Packages" table (rows for `deoptkit` and, after plan 019, the Claude Code plugin).

Conventions: Vite+ for everything; soft-wrapped markdown; no attribution lines; bump files under `.bumpy/` keyed by package name.

## Commands you will need

| Purpose                         | Command                                                                   | Expected on success                                               |
| ------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Install                         | `vp install`                                                              | exit 0; `yarn workspaces list` shows `extensions/deoptkit-vscode` |
| Build the engine (needed first) | `vp -C packages/deoptkit pack`                                            | `Build complete`; `packages/deoptkit/dist/lsp.mjs` exists         |
| Build the extension             | `vp -C extensions/deoptkit-vscode pack`                                   | `Build complete`; `dist/extension.cjs` and `dist/server.cjs`      |
| Package the extension           | `cd extensions/deoptkit-vscode && vp exec vsce package --no-dependencies` | `deoptkit-vscode-0.0.0.vsix` written                              |
| List the vsix                   | `cd extensions/deoptkit-vscode && vp exec vsce ls --no-dependencies`      | lists `dist/extension.cjs`, `dist/server.cjs`, no `node_modules`  |
| Format + lint + typecheck       | `vp check --fix`                                                          | clean                                                             |
| Tests                           | `vp test`                                                                 | all pass (the extension has no test project)                      |
| Bumpy sees the extension        | `vp dlx @varlock/bumpy status`                                            | lists `deoptkit-vscode` with its pending bump                     |

## Scope

**In scope**:

- `extensions/deoptkit-vscode/` (create): `package.json`, `vite.config.ts`, `tsconfig.json`, `.vscodeignore`, `src/extension.ts`, `src/server.ts`, `README.md`, `CHANGELOG.md` (empty), `LICENSE.md` (copy of root), `.vscode/launch.json`
- `packages/deoptkit/package.json` (`./lsp` export), `packages/deoptkit/vite.config.ts` (`lsp` entry), `packages/deoptkit/src/__tests__/packageExports.spec.ts` (only if the new export needs a case; it should pass unchanged)
- Root `package.json` (`@vscode/vsce` devDependency), `.bumpy/_config.json`, `.github/workflows/release.yml`, `.github/workflows/ci.yml`, `.gitignore`
- `packages/deoptkit/README.md` (the VSCode paragraph), root `README.md` (Packages row)
- `docs/VSCODE_EXTENSION.md` ("Smoke test" section)
- `.bumpy/009-vscode-extension.md` (create)

**Out of scope**:

- Decorations, CodeLens, gutter icons, status bar, commands, multi-root support: not in the thin client.
- Any logic in the extension beyond choosing and starting the server.
- `packages/deoptkit/src/lsp/**` (the server is unchanged; only an export is added).
- Marketplace publishing itself (needs the `VSCE_PAT` secret the maintainer configures).

## Git workflow

- Branch: `exec/plan-009` in a dedicated worktree; stay there.
- Two commits: `Engine: export deoptkit/lsp for bundling the language server`, then `VSCode: thin LSP client extension and vsce publishing pipeline`.
- Bump file `.bumpy/009-vscode-extension.md`:

  ```markdown
  ---
  "deoptkit": minor
  "deoptkit-vscode": minor
  ---

  Added the `deoptkit/lsp` export (the language server as a library entry) and the `deoptkit-vscode` extension, a thin VSCode client that starts `deoptkit lsp` from the workspace's installed deoptkit or from the server bundled with the extension and shows findings as diagnostics.
  ```

- Do NOT push or open a PR. No attribution lines.

## Steps

### Step 1: The `deoptkit/lsp` export

In `packages/deoptkit/vite.config.ts` add `lsp: "./src/lsp/server.ts"` to `pack.entry`. In `packages/deoptkit/package.json` add, after `./serve`:

```json
    "./lsp": {
      "import": {
        "types": "./dist/lsp.d.mts",
        "default": "./dist/lsp.mjs"
      }
    },
```

Commit as `Engine: export deoptkit/lsp for bundling the language server`.

**Verify**: `vp -C packages/deoptkit pack` → `Build complete` and `ls packages/deoptkit/dist/lsp.mjs packages/deoptkit/dist/lsp.d.mts` lists both; `vp -C packages/deoptkit test src/__tests__/packageExports.spec.ts` → passes; `cd packages/deoptkit && node --input-type=module -e "const m = await import('deoptkit/lsp'); console.log(Object.keys(m))"` prints a list containing `runLsp`.

### Step 2: Extension package

Create `extensions/deoptkit-vscode/package.json`:

```json
{
  "name": "deoptkit-vscode",
  "displayName": "deoptkit",
  "version": "0.0.0",
  "description": "V8 deoptimization findings from deoptkit (megamorphic inline caches, deopt loops, hidden-class churn) as inline diagnostics",
  "categories": ["Linters", "Other"],
  "keywords": ["v8", "performance", "deoptimization", "profiling"],
  "license": "MIT",
  "author": "Drake Costa <drake@saeris.gg> (https://saeris.gg)",
  "repository": {
    "type": "git",
    "url": "https://github.com/Saeris/deoptkit.git",
    "directory": "extensions/deoptkit-vscode"
  },
  "publisher": "saeris",
  "main": "./dist/extension.cjs",
  "engines": {
    "vscode": "^1.125.0"
  },
  "activationEvents": [
    "onLanguage:javascript",
    "onLanguage:javascriptreact",
    "onLanguage:typescript",
    "onLanguage:typescriptreact",
    "workspaceContains:.deopt/findings.json"
  ],
  "contributes": {
    "configuration": {
      "title": "deoptkit",
      "properties": {
        "deoptkit.findingsPath": {
          "type": "string",
          "default": ".deopt/findings.json",
          "description": "The findings interchange written by `deoptkit ci` or the deoptkit/vitest preset, relative to the workspace folder."
        },
        "deoptkit.serverCommand": {
          "type": "array",
          "items": { "type": "string" },
          "default": [],
          "description": "Command that starts the language server, e.g. [\"npx\", \"deoptkit\", \"lsp\"]. Leave empty to use the workspace's installed deoptkit, or the server bundled with this extension when there is none."
        }
      }
    }
  },
  "scripts": {
    "build": "vp pack && vp exec vsce package --no-dependencies"
  },
  "devDependencies": {
    "@types/vscode": "^1.125.0",
    "deoptkit": "workspace:*",
    "vscode-languageclient": "^11.0.0"
  }
}
```

`vite.config.ts`:

```ts
import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      build: {
        command: "vp pack && vp exec vsce package --no-dependencies",
        cache: true
      }
    }
  },
  // The extension host provides `vscode`; everything else must be inside the .vsix.
  pack: {
    entry: { extension: "src/extension.ts", server: "src/server.ts" },
    deps: {
      neverBundle: ["vscode"],
      alwaysBundle: ["vscode-languageclient", "deoptkit"]
    },
    dts: false,
    format: "cjs",
    outDir: "./dist"
  }
});
```

`tsconfig.json` and `.vscodeignore` exactly as mirrordown's (inlined above). `CHANGELOG.md` empty (bumpy writes it); `LICENSE.md` copied from the root.

`src/server.ts` (the bundled server entry):

```ts
// Stdio entry for the server bundled with the extension; `deoptkit lsp` behaviour.
import { runLsp } from "deoptkit/lsp";

runLsp(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`deoptkit lsp failed: ${String(error)}\n`);
    process.exitCode = 1;
  }
);
```

`src/extension.ts`:

```ts
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
```

`.vscode/launch.json` (standard "Run Extension" configuration: `type: "extensionHost"`, `args: ["--extensionDevelopmentPath=${workspaceFolder}/extensions/deoptkit-vscode"]`, `preLaunchTask` omitted). `README.md`: what it shows, how findings get produced (`deoptkit ci` / the vitest preset), the two settings, the server-selection order, the first-folder limitation, and a link to the package README.

Root `.gitignore`: after the `.vscode` line add

```
!extensions/*/.vscode/
extensions/*/.vscode/*
!extensions/*/.vscode/launch.json
```

Root `package.json` devDependencies: add `"@vscode/vsce": "^4.1.0"`.

**Verify**: `vp install` → exit 0 and `yarn workspaces list` includes `extensions/deoptkit-vscode`; `vp -C packages/deoptkit pack` then `vp -C extensions/deoptkit-vscode pack` → `Build complete` with `dist/extension.cjs` and `dist/server.cjs`; `grep -c 'require("vscode")' extensions/deoptkit-vscode/dist/extension.cjs` ≥ 1 (host-provided, not bundled); `grep -c "vscode-languageclient" extensions/deoptkit-vscode/dist/extension.cjs` → 0 after the first require line (it is bundled: `grep -c "LanguageClient" …` ≥ 1 and no `require("vscode-languageclient` string); `vp check --fix` → clean; `git status --short` shows `extensions/deoptkit-vscode/.vscode/launch.json` as addable.

### Step 3: Headless check of the bundled server

Run, from the repository root (one line; adapt the path separator for Git Bash):

```
node -e "const {spawn}=require('node:child_process');const p=spawn(process.execPath,['extensions/deoptkit-vscode/dist/server.cjs','--findings','nope.json']);let out='';p.stdout.on('data',d=>{out+=d;if(out.includes('serverInfo')){console.log(out.split('\r\n\r\n').pop());p.kill();}});const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{capabilities:{}}});p.stdin.write('Content-Length: '+Buffer.byteLength(body)+'\r\n\r\n'+body);setTimeout(()=>{console.error('timeout');p.kill();process.exit(1)},5000)"
```

**Verify**: prints a JSON response containing `"serverInfo":{"name":"deoptkit"`.

### Step 4: Packaging and release pipeline

- `cd extensions/deoptkit-vscode && vp exec vsce package --no-dependencies` → a `.vsix`; `vp exec vsce ls --no-dependencies` lists `dist/extension.cjs`, `dist/server.cjs`, `package.json`, `README.md`, `LICENSE.md`, `CHANGELOG.md` and nothing under `node_modules` or `src`. Add `**/*.vsix` to the root `.gitignore`.
- `.bumpy/_config.json`: add

  ```json
      "deoptkit-vscode": {
        "buildCommand": "vp pack && vp exec vsce package --no-dependencies",
        "publishCommand": "vp exec vsce publish --no-dependencies",
        "skipNpmPublish": true,
        "releaseTriggeringDevDeps": ["deoptkit"]
      }
  ```

  under `packages`, so an engine release cascades into an extension release and the extension never ships a stale bundled server.

- `.github/workflows/release.yml`: add `VSCE_PAT: ${{ secrets.VSCE_PAT }}` to the `env` of both `bumpy ci release` steps. The publish job already builds the engine before bumpy runs; add a comment above that step saying the extension's `vp pack` bundles `deoptkit/lsp` from `packages/deoptkit/dist`, which is why the engine is built first.
- `.github/workflows/ci.yml`: insert `- run: vp -C packages/deoptkit pack` before `vp check` with a comment: the type-aware lint resolves `deoptkit/lsp` through the built `types` export; without `dist/` its types silently become `any` (the same reason mirrordown builds before checking). Also add `- run: vp -C extensions/deoptkit-vscode pack` after it so a broken bundle fails CI.

**Verify**: `vp dlx @varlock/bumpy status` lists `deoptkit-vscode` with the pending minor bump; `vp check` → clean; `vp test` → all pass.

### Step 5: Docs and the smoke test record

- `packages/deoptkit/README.md`, "Inline editor diagnostics (LSP)": replace the "**VSCode** has no built-in generic LSP client…" paragraph with: install the `deoptkit` extension (marketplace id `saeris.deoptkit-vscode`); it starts `deoptkit lsp` on the workspace's installed deoptkit (or its bundled copy) and shows findings as squiggles and Problems entries; the two settings. Keep the MCP sentence about Claude Code users.
- Root `README.md` Packages table: add a row for `deoptkit-vscode` linking to `extensions/deoptkit-vscode` with the marketplace id.
- `docs/VSCODE_EXTENSION.md`, "Smoke test": record what you verified (the vsix contents and the headless `initialize` response) and state explicitly that the in-editor check (squiggles on a file annotated by `.deopt/findings.json`, downgrade to Information after editing) is left to the maintainer, with the command to install the vsix: `code --install-extension extensions/deoptkit-vscode/deoptkit-vscode-0.0.0.vsix`.

**Verify**: `grep -n "no built-in generic LSP client" packages/deoptkit/README.md` prints nothing; `vp check --fix` → clean. Commit as `VSCode: thin LSP client extension and vsce publishing pipeline`.

## Test plan

- No VSCode test harness (needs a display). Coverage comes from: the engine's `src/lsp/__tests__/lsp.spec.ts` (server protocol), `packageExports.spec.ts` (the new export ships), the headless `initialize` check of the bundled server (Step 3), and CI building the extension on every push (Step 4).

## Done criteria

- [ ] `packages/deoptkit` exports `./lsp` and `dist/lsp.mjs` builds
- [ ] `extensions/deoptkit-vscode` builds, packages to a `.vsix` without `node_modules`, and its bundled server answers `initialize` headlessly
- [ ] `.bumpy/_config.json` has the `deoptkit-vscode` entry with `releaseTriggeringDevDeps: ["deoptkit"]`; `bumpy status` lists the extension
- [ ] `release.yml` passes `VSCE_PAT`; `ci.yml` builds the engine before `vp check` and builds the extension
- [ ] `vp check` and `vp test` exit 0 at the root
- [ ] `packages/deoptkit/README.md` no longer says VSCode has no path to diagnostics; `docs/VSCODE_EXTENSION.md` has the smoke-test record
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated (skip if your reviewer maintains the index)

## STOP conditions

- `vsce` rejects the manifest (missing `repository`, `engines`, `publisher` mismatch); report the exact error.
- tsdown cannot bundle `deoptkit/lsp` into CJS (for example an error about the JSON import attribute or top-level await); report the error rather than switching the server to spawn `deoptkit`'s bin.
- The headless `initialize` check times out.
- `vp check` type errors inside `extensions/` that need changes to `packages/deoptkit/src/**`.

## Maintenance notes

- The extension's only engine contact is `deoptkit/lsp`; keep the server free of VSCode knowledge and the client free of analysis knowledge.
- The bundled server is only a fallback; projects with findings normally have `deoptkit` installed, and the client prefers that copy to avoid interchange skew.
- Multi-root workspaces: one client for the first folder (memo decision 6). Adding one client per folder is a small change in `activate` if demand appears.
- `VSCE_PAT` must exist as a repository secret before the first extension release; without it bumpy's `publishCommand` fails for the extension only.
