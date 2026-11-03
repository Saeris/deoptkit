# Plan 019: Ship a Claude Code plugin (marketplace + MCP server + workflow skill)

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md` — unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 4e0de7e..HEAD -- packages/deoptkit/src/server.ts packages/deoptkit/README.md README.md .gitignore` must print nothing, and `ls plugins .claude-plugin` must fail (neither exists yet). Compare the excerpts under "Current state" with the live files; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/010-yarn-workspace-conversion.md
- **Category**: direction, dx
- **Planned at**: commit `4e0de7e`, 2026-11-03

## Why this matters

Claude Code is the primary host for deoptkit's primary audience, and onboarding today is a hand-written `.mcp.json` (package README, "Quick start"). Claude Code plugins bundle an MCP server registration with a skill, install with two slash commands from a GitHub repository, and update when the repository changes. The plugin stays a thin projection: the MCP server config points at the published npm package, and the skill carries only the workflow and recipes the README and the server's `instructions` already state, so the engine remains the single source of truth. A test pins the skill to the server's tool list so the two cannot drift apart silently.

## Current state

- Plugin layout and manifest format (from the Claude Code docs, `code.claude.com/docs/en/plugins-reference` and `.../plugins/marketplace-reference`, read 2026-11-03):
  - Plugin root holds `.claude-plugin/plugin.json` (manifest; `name` is the only required key, kebab-case; `version`, `description`, `author { name }`, `homepage`, `repository`, `license`, `keywords` are the standard metadata fields), `.mcp.json` (an `mcpServers` map, loaded automatically), and `skills/<name>/SKILL.md` (one directory per skill, scanned automatically). Everything except the manifest lives at the plugin root, not inside `.claude-plugin/`.
  - A marketplace is `.claude-plugin/marketplace.json` at the marketplace root (here: the repository root). Required: `name` (letters, digits, `.`, `_`, `-`), `owner { name }`, `plugins[]` with `name` and `source`; a plugin inside the same repository uses a relative source string that must start with `./`. The marketplace's `name` must not be one of the reserved names (`claude-*`, `anthropic-*`, `npm`, `github`, …; `deoptkit` is fine).
  - Users add a GitHub-hosted marketplace with `/plugin marketplace add <owner>/<repo>` (CLI: `claude plugin marketplace add <owner>/<repo>`) and install with `/plugin install <plugin>@<marketplace>` (CLI: `claude plugin install <plugin>@<marketplace>`). `claude plugin validate <path>` validates a plugin directory or a marketplace root; `--plugin-dir <path>` loads a plugin for one session without installing.
  - A `CLAUDE.md` at the plugin root is not loaded and triggers a validator warning; instructions belong in the skill.
- The server's own instructions, which the skill projects (`packages/deoptkit/src/server.ts` lines 65–85):

  ```ts
  const SERVER_INSTRUCTIONS = [
    "deoptkit exposes V8 optimization problems (megamorphic inline caches, deopt loops,",
    "hidden-class/map churn, CPU hot spots) in JavaScript/TypeScript running on Node.js.",
    "",
    "Core loop for optimizing a workload:",
    '1. profile_run { command: ["node", "bench.js"] } — runs it under V8 logging, returns a sessionId.',
    "2. get_findings { sessionId } — ranked problems (severity 1-100) with source locations, V8-level",
    '   explanations, and suggested fixes. Start here; it answers "what should I fix first?".',
    "3. Edit the source at the finding's `original` position when present (that is the .ts/.js you wrote),",
    "   otherwise its file/line. Prefer the smallest change that normalizes object shapes or stabilizes types.",
    "4. profile_run again, then compare_sessions { baseSessionId, headSessionId } to confirm the finding is",
    "   in `resolved` and nothing meaningful is in `introduced`.",
    "",
    "Drill-down: get_function (annotated source + its ICs/deopts/ticks), get_map (a shape's transition chain),",
    "list_ics / list_deopts / list_functions. Use load_log to analyze an existing v8.log, or load_manifest to",
    "load every log from a `deoptkit/vitest` bench run. Windowing: pass fromMark/toMark (from deoptkit/harness",
    "or benchObserved markers) to scope findings to one benchmark case.",
    "",
    "Warm-up matters: V8 only optimizes hot code, so profile workloads that run the target thousands of times",
    "(the observed() helper in deoptkit/harness encodes this). Profile built output, not source, for libraries."
  ].join("\n");
  ```

  Later plans (011–014) may have reworded this block; read the live text and project the live text.

- The eleven tool names, pinned by `packages/deoptkit/src/__tests__/server.spec.ts` lines 47–59: `compare_sessions`, `get_findings`, `get_function`, `get_map`, `list_deopts`, `list_functions`, `list_ics`, `list_sessions`, `load_log`, `load_manifest`, `profile_run`. Plan 017 may add `get_profile`; the skill test below reads the live list, so it adapts.
- Package README "Quick start (AI agent + MCP)" (`packages/deoptkit/README.md` lines 29–52) shows the manual `.mcp.json` for Claude Code and `.vscode/mcp.json` for VSCode, then the loop. `docs/recipes.md` holds the bench-script, Valimock, vitest, SSR, and CI recipes.
- Root `README.md` (written by plan 010) has a "Packages" table with one row.
- Root `.gitignore` ignores `.claude/` (Claude Code local state) but not `.claude-plugin/`.
- Root `package.json` `workspaces` are `packages/*` and `extensions/*`; a `plugins/` directory is not a workspace member (no `package.json` inside it), so bumpy and yarn ignore it.
- The `claude` CLI is installed on the maintainer's machine (this plan is executed on it), so `claude plugin validate` is available for verification.

Conventions: soft-wrapped markdown; JSON formatted by `vp check --fix`; tests state why the behavior matters.

## Commands you will need

| Purpose                   | Command                                                     | Expected on success                            |
| ------------------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| Install                   | `vp install` (repository root)                              | exit 0                                         |
| Validate the plugin       | `claude plugin validate ./plugins/deoptkit`                 | `Validation passed` (warnings allowed, listed) |
| Validate the marketplace  | `claude plugin validate .`                                  | `Validation passed`                            |
| Format + lint + typecheck | `vp check --fix`                                            | clean                                          |
| Skill drift test          | `vp -C packages/deoptkit test src/__tests__/plugin.spec.ts` | passes                                         |
| All tests                 | `vp test`                                                   | all pass                                       |

## Scope

**In scope**:

- `plugins/deoptkit/.claude-plugin/plugin.json`, `plugins/deoptkit/.mcp.json`, `plugins/deoptkit/skills/deoptkit/SKILL.md`, `plugins/deoptkit/README.md` (all create)
- `.claude-plugin/marketplace.json` at the repository root (create)
- `packages/deoptkit/src/__tests__/plugin.spec.ts` (create)
- `packages/deoptkit/README.md` ("Quick start" section), root `README.md` (Packages table)
- `.bumpy/019-plugin.md` (create)

**Out of scope**:

- `packages/deoptkit/src/server.ts` and every other engine file: the skill projects them, never the reverse.
- Hooks, agents, commands, output styles: the plugin ships an MCP server and one skill only.
- Publishing to Anthropic's plugin directory.

## Git workflow

- Branch: you are on `exec/plan-019` in a dedicated worktree; stay there.
- One commit: `Plugin: Claude Code marketplace, MCP server registration, and workflow skill`.
- Bump file `.bumpy/019-plugin.md` with `"deoptkit": none` (the npm package does not change) and body: `Added a Claude Code plugin (plugins/deoptkit) and marketplace so agents can install the deoptkit MCP server and workflow skill with two commands.`
- Do NOT push or open a PR. No attribution lines.

## Steps

### Step 1: Manifest and MCP server

Create `plugins/deoptkit/.claude-plugin/plugin.json`:

```json
{
  "name": "deoptkit",
  "displayName": "deoptkit",
  "version": "0.1.0",
  "description": "V8 deoptimization analysis for Node.js: profile a workload, get ranked findings (megamorphic ICs, deopt loops, map churn), fix, and verify with a before/after comparison.",
  "author": { "name": "Drake Costa", "url": "https://saeris.gg" },
  "homepage": "https://github.com/Saeris/deoptkit#readme",
  "repository": "https://github.com/Saeris/deoptkit",
  "license": "MIT",
  "keywords": ["v8", "performance", "deoptimization", "profiling", "mcp"]
}
```

Create `plugins/deoptkit/.mcp.json`:

```json
{
  "mcpServers": {
    "deopt": {
      "command": "npx",
      "args": ["-y", "deoptkit@latest"]
    }
  }
}
```

(`@latest` keeps the server on the published engine; the plugin never bundles engine code.)

**Verify**: `claude plugin validate ./plugins/deoptkit` → `Validation passed` (a warning about a missing skill is fine until Step 2).

### Step 2: The workflow skill

Create `plugins/deoptkit/skills/deoptkit/SKILL.md` with this frontmatter and a body of at most about 120 lines:

```markdown
---
name: deoptkit
description: Profile a Node.js workload under V8 logging and fix what makes it slow — megamorphic inline caches, deopt loops, hidden-class churn — using the deoptkit MCP tools. Use when asked to optimize, profile, or explain the performance of JavaScript/TypeScript running on Node, or when a benchmark regressed.
---
```

Body sections, in this order, each short and written for an agent that has the `deopt` MCP server connected:

1. **When to reach for it**: structural V8 problems, not wall-clock micro-benchmarks; needs a workload that runs the hot code thousands of times.
2. **The loop**: the four numbered steps from the live `SERVER_INSTRUCTIONS` (profile_run → get_findings → edit at `original` or file/line → profile_run again + compare_sessions), including the drill-down tools and windowing sentence, rewritten as prose but keeping every tool name as it appears in the server (`profile_run`, `get_findings`, `get_function`, `get_map`, `list_ics`, `list_deopts`, `list_functions`, `load_log`, `load_manifest`, `list_sessions`, `compare_sessions`, plus any tool the live server lists that this list lacks).
3. **Token discipline**: start with `get_findings { sessionId, limit: 5 }`; use `severityMin`, `file`, `kinds`, `offset`; only call `list_ics` with `includeTransitions` for one site at a time; prefer `get_function` over reading files when the finding is in built output.
4. **Writing a workload**: the `bench/*.bench.mjs` pattern with `observed()` from `deoptkit/harness` (copy the 8-line example from `docs/recipes.md`, "Library bench scripts"), the "profile built output, not source" rule, the vitest preset in two lines, and `load_manifest` for bench runs.
5. **Reading findings**: one line per kind (`megamorphic-ic`, `polymorphic-ic`, `deopt-loop`, `eager-deopt`, `soft-deopt`, `map-churn`) saying what it means and the usual fix, taken from the `EXPLANATIONS` table in `packages/deoptkit/src/analysis/findings.ts` (paraphrase to one line each).
6. **Verifying**: `compare_sessions` must show the finding in `resolved` and nothing in `introduced`; `deoptkit ci` for a permanent gate (three-line example from the README).

Create `plugins/deoptkit/README.md` (short): what the plugin installs, the two install commands, and a pointer to the package README.

**Verify**: `claude plugin validate ./plugins/deoptkit` → `Validation passed` with no warning about skills; `grep -c "profile_run\|compare_sessions" plugins/deoptkit/skills/deoptkit/SKILL.md` ≥ 2.

### Step 3: Marketplace

Create `.claude-plugin/marketplace.json` at the repository root:

```json
{
  "name": "deoptkit",
  "description": "deoptkit: V8 deoptimization tooling for AI agents",
  "owner": { "name": "Drake Costa", "url": "https://saeris.gg" },
  "plugins": [
    {
      "name": "deoptkit",
      "source": "./plugins/deoptkit",
      "description": "deoptkit MCP server and the profile → findings → fix → compare workflow skill",
      "category": "performance"
    }
  ]
}
```

**Verify**: `claude plugin validate .` → `Validation passed`.

### Step 4: Drift test

Create `packages/deoptkit/src/__tests__/plugin.spec.ts`: connect an in-memory client exactly as `server.spec.ts` does (copy its `connect` helper), call `listTools()`, read `../../../../plugins/deoptkit/skills/deoptkit/SKILL.md` (resolve from `import.meta.dirname`), and assert (a) every advertised tool name appears in the skill text, (b) the skill's frontmatter `description` is non-empty and under 1024 characters, (c) `plugins/deoptkit/.mcp.json` parses and its `mcpServers.deopt.args` contain a string starting with `deoptkit`, (d) `.claude-plugin/marketplace.json` lists a plugin whose `source` is `./plugins/deoptkit`. Comment: the skill is a projection of the server; a tool the server adds or renames must show up in the skill or agents following the skill call tools that do not exist.

**Verify**: `vp -C packages/deoptkit test src/__tests__/plugin.spec.ts` → passes. Temporarily remove one tool name from the skill and confirm the test fails; restore it.

### Step 5: Docs

- `packages/deoptkit/README.md`, "Quick start (AI agent + MCP)": before the manual `.mcp.json` block add a two-line paragraph: for Claude Code the fastest path is the plugin: `/plugin marketplace add Saeris/deoptkit` then `/plugin install deoptkit@deoptkit`, which registers the server and adds a skill with the workflow; the manual registration below works for any MCP host.
- Root `README.md` Packages table: add a row `[deoptkit (Claude Code plugin)](./plugins/deoptkit)` with the same two commands in the description column, and no npm link.

**Verify**: `vp check --fix` → clean; `vp test` → all pass.

## Test plan

- New: `packages/deoptkit/src/__tests__/plugin.spec.ts` (skill lists every live tool; manifests parse).
- Pattern: `src/__tests__/server.spec.ts` (in-memory client).
- Verification: `vp test` → all pass, including the new spec.

## Done criteria

- [ ] `claude plugin validate ./plugins/deoptkit` and `claude plugin validate .` both print `Validation passed`
- [ ] `vp check` exits 0; `vp test` exits 0 with `plugin.spec.ts` passing
- [ ] `plugins/deoptkit/.mcp.json` registers `deopt` via `npx -y deoptkit@latest`
- [ ] Both READMEs mention `/plugin marketplace add Saeris/deoptkit`
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated (skip if your reviewer maintains the index)

## STOP conditions

- `claude plugin validate` reports an error (not a warning) you cannot resolve by following the manifest format above; paste the message.
- The `claude` CLI is unavailable in your environment: complete every other step, state in your report that validation was not run, and do not mark the plan done.
- The live `SERVER_INSTRUCTIONS` text differs from the excerpt (plans 011–014 reword it): that is expected; project the live text and note it. Only STOP if `server.ts` has no `instructions` block at all.

## Maintenance notes

- Bump `plugins/deoptkit/.claude-plugin/plugin.json` `version` whenever the skill text changes; Claude Code pins users to the manifest version until it changes. The npm package version is independent.
- The skill must never state engine behavior the server does not advertise; when a tool is added, update the skill in the same PR or `plugin.spec.ts` fails.
- If the plugin ever needs engine code (hooks or scripts), make `plugins/deoptkit` a workspace package with `bumpy.skipNpmPublish` rather than copying files.
