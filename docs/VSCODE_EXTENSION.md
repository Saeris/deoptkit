# VSCode extension: repository layout decision

Spike memo for [plan 009](../plans/009-vscode-extension-spike.md). Steps 2–5 of that plan (apply the layout, build the extension skeleton, wire the publishing pipeline, smoke test) wait on the decision below.

## Decision

**Option A, the Yarn workspace conversion**, recorded by the maintainer on 2026-11-03. The conversion is its own plan, [plan 010](../plans/010-yarn-workspace-conversion.md), which supersedes Step 2 of plan 009; the extension skeleton, pipeline, and smoke test (plan 009 Steps 3–5) run once plan 010 has landed.

Answers to the open questions below, chosen as defaults the maintainer can overrule:

1. Publisher id `saeris`.
2. Package name `deoptkit-vscode`, display name `deoptkit`, marketplace id `saeris.deoptkit-vscode`.
3. `engines.vscode: ^1.125.0` with `@types/vscode` 1.125, as in mirrordown. `vscode-languageclient` 11 needs only `^1.91.0`.
4. Both. The client starts the server as a `module` over stdio, so `vscode-languageclient` spawns the extension host's own Node and nothing depends on the user's `PATH`. It prefers the workspace's installed package when `<folder>/node_modules/deoptkit/dist/main.mjs` exists (no producer/server skew), otherwise it runs the server bundled in the extension (self-contained install). `deoptkit.serverCommand`, when set, replaces both. Bundling needs a `deoptkit/lsp` export, added in plan 009 Step 3.
5. No run-bench command in the thin client.
6. First workspace folder only, documented as a limitation; one client per folder can follow if asked for.
7. Commit `extensions/*/.vscode/launch.json` through a `.gitignore` exception so F5 debugging works from a fresh clone.

## Goal

A thin VSCode language client for `deoptkit lsp`, so VSCode users get the same squiggles and Problems panel entries that Neovim, Helix, and Zed users already get from a one-line config (README, "Inline editor diagnostics (LSP)"). The extension holds no analysis logic: the engine writes `.deopt/findings.json` (through `deoptkit ci` or the `deoptkit/vitest` preset), the server maps it to diagnostics, and the extension only starts the server and lets `vscode-languageclient` render what it publishes. This is the "30-line shell" of [BENCHMARKING.md §8](./BENCHMARKING.md) item 1, not the decorations-and-CodeLens "extension proper" of item 2, which stays gated on demand.

Behaviour:

- Start the server over stdio with `vscode-languageclient`, with the workspace folder as its working directory. The server resolves both `--findings` and every finding's `file` against its cwd (`resolvePath` in `src/lsp/server.ts`), so a wrong cwd produces no diagnostics and no error.
- Attach to the JavaScript and TypeScript language ids, matching the Helix/Zed wiring in the README.
- Send nothing after `initialized`: `initialize` returns `textDocumentSync: 0`, and the server polls the findings file every 250 ms and pushes `textDocument/publishDiagnostics` itself.

Settings:

- `deoptkit.findingsPath`: default `.deopt/findings.json`, passed as `--findings`; a relative path resolves against the workspace folder.
- `deoptkit.serverCommand`: the command that starts the server. Its default depends on open question 4: either `npx deoptkit lsp`, which runs the workspace's installed `deoptkit` bin, or empty, meaning "use the server bundled in the extension".

## Facts the options rest on

Verified at commit `beba57c`, and in `@varlock/bumpy` 1.19.0 (the version in `yarn.lock`):

- This repo is one published package: the root `package.json` is `deoptkit`, has no `private` and no `workspaces`, `bin` is `./dist/main.mjs`, and `files` is `["dist/**/*", "THIRD_PARTY_NOTICES.md"]`. Yarn 4.18.1 with a `catalog:` block in `.yarnrc.yml`; Vite+ 1.4.
- Bumpy discovers the root package only when the workspace glob list is empty (`discoverWorkspace`). Once `package.json` has `workspaces`, only packages matching those globs are versioned and published.
- Bumpy always trusts commands declared under `packages` in `.bumpy/_config.json`. `allowCustomCommands` is needed only when `buildCommand`, `publishCommand`, or `checkPublished` live in a package's own `package.json` `bumpy` field (`loadPackageConfig`). Mirrordown uses the per-package form, hence its `allowCustomCommands: true`; this repo uses the root-config form. Either works for the extension; pick one in Step 4 rather than mixing them.
- Bumpy runs `buildCommand` with the package directory as cwd, so `packages.deoptkit.buildCommand: "vp pack"` keeps working after a move as long as that directory has its own `vite.config.ts` with the `pack` block.
- `release.yml`'s `changes` job picks between the bump and publish jobs with a `dorny/paths-filter` on `package.json` alone, so any layout with a second released package in this repo must widen that filter. The publish job also runs a bare `vp pack` at the root before `bumpy ci release`.
- `runLsp` is reachable only through the bin (`src/main.ts`); no public subpath exports it. Bundling the server from the published npm package needs a new `deoptkit/lsp` export.
- When `findings.json` fails the server's schema (`v.safeParse` in `publish`), the server clears every diagnostic and reports nothing. A server and a producer from different `deoptkit` versions therefore fail silently if the interchange changes.
- Yarn 4.18.1 refuses two workspaces with the same `name` ("Duplicate workspace name"), so inside one Yarn project the extension cannot also be named `deoptkit`.
- Mirrordown's release workflow pre-builds its `mdit-*` dists before releasing because the extensions' `vp pack` otherwise silently externalizes the plugin and ships a broken `.vsix` (comment in its `release.yml`).
- Plans 006 and 007 are in progress against `src/` (`plans/README.md`).

## Option A: Yarn workspace conversion

The root becomes `"private": true` with `"workspaces": ["packages/*", "extensions/*"]`, the npm package moves to `packages/deoptkit`, and the extension lives in `extensions/deoptkit-vscode`. This is mirrordown's layout.

What moves or changes:

- Into `packages/deoptkit/`: `src/` (52 tracked files), `fixtures/` (5), `package.json`, the `pack` and `test` parts of `vite.config.ts`, `tsconfig.json`, `THIRD_PARTY_NOTICES.md` (listed in `files`), and the `README.md`, `LICENSE.md`, and `CHANGELOG.md` that npm shows for the package, since npm takes those from the package directory. The GitHub-facing root README can stay and link down, or be duplicated.
- Stays at the root: `.bumpy/` (bump files are keyed by package name, so the pending ones stay valid and `packages.deoptkit` keeps its key), `.yarnrc.yml` and its catalog, `.yarn/releases`, `yarn.lock` (regenerated), `docs/`, `plans/`, `.github/`, and a root `vite.config.ts` carrying `lint` and `fmt`, as mirrordown's does.
- Path edits: README links and `src/` mentions, `docs/*.md`, every `plans/*.md` that cites `src/...`, `tsconfig.json`, and both `ci.yml` and `release.yml` (the `changes` filter becomes `packages/*/package.json` and `extensions/*/package.json`, and the bare `vp pack` step must target the package).
- Unchanged inside the moved package: `files`, `bin`, and `exports`. Consumers see no difference.

Benefits:

- Exact match with the maintainer's existing convention: mirrordown's `extensions/markdown-abbr` package, `vite.config.ts`, and `.vscodeignore` can be copied almost verbatim.
- The extension takes `"deoptkit": "workspace:*"` and can bundle the LSP server into the `.vsix`, so installing the extension is enough to get squiggles.
- One release train: bumpy's `releaseTriggeringDevDeps` (or an explicit `cascadeFrom`) releases the extension whenever the bundled `deoptkit` changes, so the bundled server never lags the engine at release time.
- A change to the findings interchange lands in one PR across producer, server, and client, and CI can test all three at the same commit. That matters more once BENCHMARKING §8 item 2 needs richer data than diagnostics.

Costs:

- The largest diff of the three: every tracked path under `src/` and `fixtures/` moves (git records renames, but `git log` and blame need `--follow` across the move).
- It conflicts with any branch in flight against `src/`, so it should land on its own after plans 006 and 007 merge.
- Root `vp check` and `vp test` must be re-pointed at the workspaces; mirrordown's root `vite.config.ts` and its `vp run --filter` CI step show the pattern.
- Bundling through `deoptkit`'s exports needs a `./lsp` subpath export plus a pre-built `dist` (mirrordown's pre-build step). The alternative is a relative import of `packages/deoptkit/src/lsp/server.ts` from the extension's server entry, which needs neither.

## Option B: workspace without moving the root package

Keep `deoptkit` at the root and add `"workspaces": ["extensions/*"]`.

Benefits: the smallest diff. Nothing under `src/` moves, and docs and plans keep their paths.

Costs and risks:

- Bumpy stops releasing `deoptkit`. With a non-empty glob list, bumpy 1.19.0 never looks at the root package, so the npm package silently drops out of versioning and publishing. A candidate fix is `"workspaces": [".", "extensions/*"]`: reading bumpy's glob expander, `.` resolves to the root directory. Whether Yarn 4.18.1 accepts `.` as a workspace pattern is unverified and needs a dry run (`vp install`, then a bumpy dry run of `ci release`) before this option is viable.
- Yarn convention says workspace roots are private (`yarn init -w` sets `private`). A search of the vendored Yarn 4.18.1 release found no warning or error for a non-private root, so this looks like convention rather than enforcement; the same dry run confirms it.
- The published `package.json` carries a `workspaces` field: harmless for consumers, but unusual. `files` already whitelists `dist/**/*` and `THIRD_PARTY_NOTICES.md`, so `extensions/` stays out of the tarball.
- Root configs reach into the extension: `vite.config.ts` includes `**/*.{test,spec}.{ts,tsx}` and `tsconfig.json` includes `**/*.ts`, so the extension's sources and tests would be type-checked and run under the root package's config unless excluded.
- `release.yml`'s `changes` filter must add `extensions/*/package.json`.
- Bundling works by relative import of `src/lsp/server.ts`, with no new export.

## Option C: separate repository

A new `Saeris/deoptkit-vscode` repository; nothing changes here. The extension depends on the published `deoptkit` package and spawns `npx deoptkit lsp` (the workspace's installed bin) or the configured `deoptkit.serverCommand`.

Benefits:

- Zero impact on this package's layout, pipeline, or in-flight plans.
- Running the workspace's own bin means the server always comes from the same `deoptkit` that wrote `findings.json`, so there is no interchange skew.
- The extension can be named `deoptkit` (marketplace id `saeris.deoptkit`), since no Yarn project holds both.

Costs:

- Two release trains and two pipelines: bumpy, vsce, and `VSCE_PAT` configured twice.
- Interchange or CLI-flag changes need coordinated PRs and releases across repositories, and skew between the extension and the user's installed `deoptkit` shows up only at runtime.
- No self-contained install by default: the user needs `deoptkit` in the workspace. The `deoptkit/vitest` preset already requires that, and `deoptkit ci` usually runs from it too, so most projects with findings have the bin. Bundling the server instead needs a public `deoptkit/lsp` export (a small change in this repo) and brings back producer/server skew.

## Comparison

|                                               | A: workspace conversion                                                            | B: workspace at the root                                                      | C: separate repository                                |
| --------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------- |
| Churn in this repo                            | High: moves `src/`, `fixtures/`, configs; path edits in docs, plans, workflows     | Low: a `workspaces` field, config excludes, a wider workflow filter           | None                                                  |
| Release coupling                              | One train; bumpy cascades `deoptkit` releases into the extension                   | One train, but only once bumpy's root discovery is solved                     | Two trains, coordinated by hand                       |
| Self-contained install for users              | Yes: server bundled through `workspace:*`                                          | Yes: server bundled by relative import                                        | No by default; bundling needs a new export here       |
| Consistency with the maintainer's conventions | Exact match with mirrordown                                                        | Partial: same tools, non-private root                                         | Same tools, different layout                          |
| Risk                                          | MED: large mechanical move; conflicts with 006 and 007 unless sequenced after them | HIGH until a dry run passes: bumpy 1.19.0 silently stops releasing `deoptkit` | LOW for this repo; MED long-term from cross-repo skew |

## Recommendation

Option A, landed as its own PR after plans 006 and 007 merge.

1. It matches the maintainer's conventions exactly, so the extension package and publishing pipeline are copied from mirrordown rather than designed.
2. It is the only option where the extension can bundle the server and still release in lockstep with the engine, through bumpy's cascade.
3. It keeps the findings interchange evolving in one place. The BENCHMARKING §8 rule that the extension stays "a thin projection over the maintained engine and findings interchange" holds only while the contract it projects can change atomically with its producer and server.
4. Option B's low churn does not survive contact with bumpy 1.19.0: its simplest form silently stops npm releases, and the fix is unverified.

What would change the recommendation:

- If the extension should always run the workspace's `deoptkit` (open question 4, answered "no bundling"), A loses its self-contained-install advantage. That answer is defensible, because it removes producer/server skew and projects with findings usually have the bin. In that case C is the better trade: zero churn here for a client of a few dozen lines.
- If a dry run shows Yarn 4.18.1 accepts `"workspaces": [".", "extensions/*"]` and bumpy then releases both packages cleanly, B delivers everything A does except the exact mirrordown layout, at a fraction of the churn, and becomes the pragmatic choice.

## Open questions for the maintainer

1. Publisher id: `saeris`, as in mirrordown?
2. Extension name and display name. Under A or B the `name` cannot be `deoptkit` (Yarn's duplicate-workspace check), so something like `deoptkit-vscode` (marketplace id `saeris.deoptkit-vscode`); under C, `deoptkit` is possible.
3. Minimum VSCode version: reuse mirrordown's `engines.vscode: ^1.125.0`, or go lower for reach? If a bundled server runs on the editor's own Node runtime rather than the user's `node`, that runtime must also satisfy `deoptkit`'s `engines.node: >=22`.
4. Bundle the server, require a workspace install, or both (prefer the workspace bin when present, fall back to the bundled server)? This sets the `deoptkit.serverCommand` default and is the answer most likely to change the recommendation.
5. Should the client later offer a "run bench" command, and if so what does it run (`vitest bench`, `deoptkit ci <script>`)?
6. Multi-root workspaces: one server per workspace folder, each with its own `findings.json`, or only the first folder?
7. The root `.gitignore` ignores `.vscode`. Should the extension's `.vscode/launch.json` for F5 debugging be committed through an exception?

## Smoke test

Recorded 2026-11-03 on Windows 10 with Node 26.13.0, from a clean build of `packages/deoptkit` followed by `extensions/deoptkit-vscode`.

Verified headlessly:

- `vp -C extensions/deoptkit-vscode pack` writes exactly `dist/extension.cjs` and `dist/server.cjs`, also on repeated runs. The two entries are separate pack configs on purpose: with one config tsdown put its runtime helpers in a chunk named after the extension entry, `server.cjs` required that chunk, and the server died outside the extension host with `Cannot find module 'vscode'`. `server.cjs` now has no relative `require`, and `vscode` is required only by `extension.cjs`, which bundles `vscode-languageclient`.
- `vp exec vsce package --no-dependencies` writes `deoptkit-vscode-0.0.0.vsix` (8 files, about 147 KB) and `vp exec vsce ls --no-dependencies` lists only:

  ```
  CHANGELOG.md
  LICENSE.md
  package.json
  README.md
  dist/extension.cjs
  dist/server.cjs
  ```

  Nothing under `node_modules` or `src` ships.

- Spawning `node extensions/deoptkit-vscode/dist/server.cjs --findings nope.json`, sending a framed LSP `initialize` request on stdin, returns:

  ```json
  {
    "jsonrpc": "2.0",
    "id": 1,
    "result": {
      "capabilities": { "textDocumentSync": 0 },
      "serverInfo": { "name": "deoptkit", "version": "0.1.0" }
    }
  }
  ```

Not verified, and left to the maintainer: the in-editor check, which needs a display. Install the vsix with `code --install-extension extensions/deoptkit-vscode/deoptkit-vscode-0.0.0.vsix`, open a workspace whose `.deopt/findings.json` annotates a source file, and confirm that squiggles and Problems entries appear on the annotated lines and that the findings downgrade to Information after editing that file. Also exercise the server selection once each: with `deoptkit` in the workspace's `node_modules`, without it (the bundled server), and with `deoptkit.serverCommand` set.
