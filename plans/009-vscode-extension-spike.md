# Plan 009: VSCode extension spike — layout decision, skeleton, publishing pipeline

> **Executor instructions**: This is a spike plan: Step 1 produces a decision memo and then STOPS for the maintainer's choice. Steps 2–5 are executed only after that choice is recorded. Follow every verification command. When done, update the status row for this plan in `plans/README.md` — unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat b733901..HEAD -- src/lsp src/main.ts package.json .bumpy .github/workflows` and `git status --short` on those paths. Confirm plan 005 is DONE (a live `findings.json` producer exists). Compare the excerpts below with the live files; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: L (coarse; the spike itself is M, the full extension depends on the layout decision)
- **Risk**: MED
- **Depends on**: plans/005-vitest-preset-writes-findings-json.md, plans/010-yarn-workspace-conversion.md (the maintainer chose Option A on 2026-11-03; plan 010 performs the layout change Step 2 describes)
- **Category**: direction
- **Planned at**: commit `b733901`, 2026-11-03

## Why this matters

`deoptkit lsp` publishes findings as standard LSP diagnostics, and Neovim, Helix, and Zed can attach to it with a one-line config. VSCode, the editor the primary audience uses alongside Claude Code, has no generic LSP client, so VSCode users get squiggles only through a dedicated extension. The README names this as the tracked next step and BENCHMARKING §8 scopes it as "a thin projection over the maintained engine and findings interchange, never load-bearing logic". The maintainer's mirrordown repository already publishes VSCode extensions with the same toolchain (Vite+, bumpy, vsce), so the publishing pipeline is a known pattern to copy rather than design. The open question is repository layout: this repo is a single published package at the root, while mirrordown is a Yarn workspace with a private root and `extensions/*`. That decision belongs to the maintainer; this spike lays out both options with their costs and builds the skeleton once chosen.

## Current state

- `src/lsp/server.ts` — `runLsp(args, streams?)`: stdio LSP server, `--findings <path>` (default `.deopt/findings.json`), `initialize` → `{ capabilities: { textDocumentSync: 0 }, serverInfo }`, pushes `textDocument/publishDiagnostics` on every change of the findings file (polling every 250 ms), downgrades stale findings. `src/main.ts` dispatches `deoptkit lsp`.
- `package.json` — single package `deoptkit`, `bin: ./dist/main.mjs`, `packageManager: yarn@4.18.1`, no `workspaces`, `private` absent.
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

- `.github/workflows/release.yml` — `bump` and `publish` jobs run `vp dlx @varlock/bumpy ci release` with `GH_TOKEN`, `BUMPY_GH_TOKEN`, `NO_COLOR`, `YARN_ENABLE_COLORS`; the publish job runs `vp pack` first. Gated on `github.repository == 'Saeris/deoptkit'`.
- `.yarnrc.yml` carries a `catalog:` block (vite-plus, vitest, vite, @vitest/coverage-v8) written by `vp migrate`.

The mirrordown pattern (from `C:\GitHub\@saeris\markdown`, read during the audit; inlined here because the executor may not have access):

`extensions/markdown-abbr/package.json` (relevant fields)

```json
{
  "name": "markdown-abbr",
  "displayName": "Markdown Abbreviation <abbr>",
  "version": "0.1.2",
  "publisher": "saeris",
  "main": "./dist/index.cjs",
  "browser": "./dist/index.cjs",
  "devDependencies": {
    "@mirrordown/mdit-abbr": "workspace:*",
    "@types/vscode": "^1.125.0"
  },
  "contributes": { "markdown.markdownItPlugins": true },
  "activationEvents": [],
  "engines": { "vscode": "^1.125.0" },
  "bumpy": {
    "buildCommand": "vp pack && vp exec vsce package --no-dependencies",
    "publishCommand": "vp exec vsce publish --no-dependencies",
    "skipNpmPublish": true
  }
}
```

`extensions/markdown-abbr/vite.config.ts`

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
    deps: { alwaysBundle: [/^@mirrordown\//] },
    dts: false,
    format: "cjs"
  }
});
```

`extensions/markdown-abbr/.vscodeignore`

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

Root `package.json` there is `"private": true` with `"workspaces": ["docs", "extensions/*", "packages/*"]` and `@vscode/vsce` in devDependencies; the release workflow passes `VSCE_PAT: ${{ secrets.VSCE_PAT }}` to `vp dlx @varlock/bumpy ci release`; the root `.bumpy/_config.json` is `{ "baseBranch": "main", "changelog": "default", "allowCustomCommands": true, "ignore": ["@mirrordown/markdown-docs"] }`. Note `allowCustomCommands: true` is what lets per-package `bumpy.buildCommand`/`publishCommand` run.

Conventions: Vite+ for everything, bumpy for versioning, soft-wrapped markdown, no attribution lines.

## Commands you will need

| Purpose                             | Command                                                         | Expected on success |
| ----------------------------------- | --------------------------------------------------------------- | ------------------- |
| Install                             | `vp install`                                                    | exit 0              |
| Checks                              | `vp check --fix`                                                | clean               |
| Tests                               | `vp test`                                                       | all pass            |
| Build root package                  | `vp pack`                                                       | `Build complete`    |
| Package an extension (after Step 3) | `vp exec vsce package --no-dependencies` (in the extension dir) | a `.vsix` file      |

## Scope

**In scope** (Step 1): `docs/VSCODE_EXTENSION.md` (create) and nothing else.

**In scope** (Steps 2–5, after approval): whatever the chosen layout requires, enumerated in Step 2; at minimum an extension package directory with `package.json`, `src/extension.ts`, `vite.config.ts`, `.vscodeignore`, `README.md`, and changes to the root `package.json`, `.bumpy/_config.json`, `.github/workflows/release.yml`, and `README.md` (Inline editor diagnostics section).

**Out of scope**:

- Decorations, CodeLens, gutter icons, or any rendering beyond what the LSP client provides (BENCHMARKING §8 stage 2 is explicitly "only if the LSP proves demand"; the spike delivers the thin client).
- Running benchmarks from the extension.
- Marketplace listing assets beyond a README and an icon placeholder.

## Git workflow

- Branch: `advisor/009-vscode-extension` from `main`.
- Suggested commits: `Docs: VSCode extension layout decision memo`, then `VSCode: thin LSP client extension and vsce publishing pipeline`.
- Bump file: added in Step 4 once the extension package name exists (`"<extension-name>": minor`), plus `"deoptkit": none` if the root package did not change behavior.
- Do NOT push or open a PR unless the operator instructed it. No attribution lines.

## Steps

### Step 1: Decision memo, then STOP

Write `docs/VSCODE_EXTENSION.md` with:

- The goal (thin LSP client; squiggles and Problems panel from `findings.json`; settings: `deoptkit.findingsPath`, `deoptkit.serverPath` or "use the workspace's `deoptkit` bin via `npx`").
- Option A — **Yarn workspace conversion**: root becomes `private`, the npm package moves to `packages/deoptkit`, the extension lives in `extensions/deoptkit-vscode`. Costs: every path in `README.md`, `.bumpy/_config.json`, `vite.config.ts`, `.github/workflows/*.yml`, `tsconfig.json`, and the plans directory moves; `files`/`bin` unchanged inside the moved package; bumpy's `packages` key stays `deoptkit`. Benefits: matches mirrordown exactly, `workspace:*` dependency from the extension on `deoptkit` so the extension can bundle the LSP server and ship self-contained.
- Option B — **Workspace without moving the root package**: keep `deoptkit` at the root, add `"workspaces": ["extensions/*"]`. Yarn warns that workspace roots should be private; the published root `package.json` would carry the `workspaces` field (harmless for consumers but unusual). Benefits: minimal churn. Risks: `npm publish` of a workspace root and bumpy's handling of a non-private root must be verified in a dry run.
- Option C — **Separate repository** (`Saeris/deoptkit-vscode`): no changes here; the extension depends on the published `deoptkit` npm package and spawns `deoptkit lsp` via `npx` or a configured path. Costs: two release trains, version skew risk; benefits: zero impact on this package's layout.
- Recommendation: state one, with reasons (the audit leans to Option A because it matches the maintainer's conventions and lets the extension bundle the server; say so, and say what would change the recommendation).
- Open questions for the maintainer (publisher id `saeris`, extension name, minimum VSCode version, whether to bundle the server or require a workspace install).

**Verify**: the file exists, is soft-wrapped, and lists the three options and a recommendation. Then **STOP** and report; wait for the maintainer to record the choice at the top of the memo.

### Step 2: Apply the chosen layout

> **Superseded on 2026-11-03**: the maintainer chose Option A and plan 010 performs this step. Confirm plan 010 is DONE in `plans/README.md` (the package then lives at `packages/deoptkit`) and continue with Step 3; read every `src/`, `package.json`, and `vite.config.ts` path in the steps below as relative to `packages/deoptkit/` for the engine and to `extensions/deoptkit-vscode/` for the extension.

Execute only the chosen option's mechanical changes. For Option A, move the package with `git mv` (`src`, `fixtures`, `dist` ignored, `vite.config.ts`, `tsconfig.json`, `package.json`, `THIRD_PARTY_NOTICES.md`, `LICENSE.md` as appropriate) into `packages/deoptkit`, create a private root `package.json` with `workspaces`, `packageManager`, and shared devDependencies, keep `.bumpy/` and `.github/` at the root, and update every path reference (grep for `src/`, `fixtures/`, `vite.config.ts`, `dist/` in `.github`, `.bumpy`, `README.md`, `docs/`). For Option B, add `workspaces` only. For Option C, STOP after Step 1 and report that the work continues in another repository.

**Verify**: `vp install` → exit 0; `vp check` → clean; `vp test` → all pass; `vp pack` (in the package dir for Option A) → `Build complete`.

### Step 3: Extension skeleton

Create `extensions/deoptkit-vscode/`:

- `package.json`: `name: "deoptkit-vscode"`, `displayName: "deoptkit"`, `publisher: "saeris"`, `main: "./dist/extension.cjs"`, `engines.vscode` matching the installed `@types/vscode`, `activationEvents: ["onLanguage:javascript", "onLanguage:typescript", "workspaceContains:.deopt/findings.json"]`, `contributes.configuration` with `deoptkit.findingsPath` (default `.deopt/findings.json`) and `deoptkit.serverCommand` (default `["npx", "deoptkit", "lsp"]`), `devDependencies` `@types/vscode`, `vscode-languageclient`, and (Option A) `deoptkit: "workspace:*"`; the `bumpy` block copied from mirrordown; `private` absent.
- `src/extension.ts`: `activate` creates a `LanguageClient` with `TransportKind.stdio` running the configured command plus `--findings <absolute path>` resolved against the first workspace folder, `documentSelector` for javascript/typescript, and starts it; `deactivate` stops it.
- `vite.config.ts`: `pack: { entry: "src/extension.ts", format: "cjs", dts: false, deps: { neverBundle: ["vscode"], alwaysBundle: ["vscode-languageclient"] } }` plus the `run.tasks.build` from mirrordown. `vscode` must stay external (the host provides it).
- `.vscodeignore` as in mirrordown; `README.md` with install and settings; `CHANGELOG.md` empty (bumpy writes it).

**Verify**: in the extension dir, `vp pack` → `Build complete` with `dist/extension.cjs`; `vp exec vsce package --no-dependencies` → produces `deoptkit-vscode-0.0.0.vsix` (or current version); `grep -c "require(\"vscode\")" dist/extension.cjs` → at least 1 (vscode external).

### Step 4: Publishing pipeline

- Root `.bumpy/_config.json`: add `"allowCustomCommands": true` and a `packages["deoptkit-vscode"]` entry only if bumpy needs it (mirrordown relies on the per-package `bumpy` block; check `node_modules/@varlock/bumpy/config-schema.json`).
- `.github/workflows/release.yml`: pass `VSCE_PAT: ${{ secrets.VSCE_PAT }}` to both `bumpy ci release` steps; for Option A, build the package before the extension so bundling has `dist/` (mirror mirrordown's pre-build step, simplified).
- Add `@vscode/vsce` to the root devDependencies.
- `README.md` Inline editor diagnostics section: replace the "no generic LSP client" paragraph with install instructions for the extension (marketplace id `saeris.deoptkit-vscode`).
- Bump files: `.bumpy/009-vscode-extension.md` with `"deoptkit-vscode": minor` (and `"deoptkit": none` or `patch` if paths moved).

**Verify**: `vp dlx @varlock/bumpy ci plan` (read-only) lists the extension with a pending bump; `vp check` → clean.

### Step 5: Manual smoke test (report, do not automate)

Install the `.vsix` into VSCode (`code --install-extension <file>`), open a project where plan 005's preset or `deoptkit ci` wrote `.deopt/findings.json`, open an annotated file, and confirm squiggles and Problems entries; edit the file and confirm the diagnostic downgrades to Information with the re-run hint. Record the outcome in `docs/VSCODE_EXTENSION.md` under "Smoke test".

## Test plan

- No automated extension tests in this spike (VSCode's test harness needs a display; defer). The LSP server itself is covered by `src/lsp/__tests__/lsp.spec.ts`.
- Pipeline verification via `bumpy ci plan` and `vsce package`.

## Done criteria

- [ ] `docs/VSCODE_EXTENSION.md` exists with options, recommendation, the maintainer's recorded choice, and the smoke-test outcome
- [ ] (Options A/B) `vp install`, `vp check`, `vp test` all exit 0 at the root
- [ ] `vsce package --no-dependencies` produces a `.vsix` in the extension dir
- [ ] `release.yml` passes `VSCE_PAT`; `.bumpy/_config.json` allows custom commands
- [ ] `README.md` no longer says VSCode has no path to diagnostics
- [ ] `plans/README.md` status row updated

## STOP conditions

- After Step 1, always (await the maintainer's choice).
- Option A: any `git mv` would touch `plans/` or `.claude/` (leave those at the root; report if a tool insists).
- Option B: `yarn npm publish --dry-run` or `bumpy ci plan` refuses a non-private workspace root; report the message.
- `vsce` rejects the manifest (missing `repository`, `engines`, or a `publisher` mismatch); report the exact error.
- `vscode-languageclient`'s current major requires a VSCode engine newer than the `@types/vscode` available; report both versions.

## Maintenance notes

- Keep the extension free of analysis logic; everything it shows comes from `findings.json` through the LSP, so engine changes never require an extension release.
- If the server is bundled into the extension (Option A), the extension's version must bump whenever `deoptkit` does; bumpy's dependency tracking handles `workspace:*` consumers, verify in the first real release.
- The `activationEvents` include `workspaceContains:.deopt/findings.json`; if users configure a different `findingsPath`, activation still happens on JS/TS files.
