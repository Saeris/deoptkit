# Plan 011: Report workspace-relative paths to agents and make `deoptkit ci` baselines portable

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md` — unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 4e0de7e..HEAD -- packages/deoptkit/src/analysis packages/deoptkit/src/cli packages/deoptkit/src/sessions.ts packages/deoptkit/src/tools packages/deoptkit/src/server.ts packages/deoptkit/src/sourcemaps packages/deoptkit/README.md` must print nothing. Compare the excerpts under "Current state" with the live files; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/010-yarn-workspace-conversion.md
- **Category**: correctness, dx
- **Planned at**: commit `4e0de7e`, 2026-11-03

## Why this matters

Two problems share one cause: every location deoptkit reports is the absolute `file:///C:/...` URL V8 logged.

1. Agents cannot hand that string to their file tools. Claude Code's Read and Edit take filesystem paths, so every finding costs the agent a conversion step, and absolute URLs are the longest field in every item (measured on the fixture sessions: the `file` string is 60–70 bytes of each 400-byte finding). The project spec promised the opposite: "Positions are ... reported as workspace-relative `file:line:column` (1-based) — directly usable in Read/Edit tool calls" (`docs/SPEC.md` §2, principle 4).
2. `deoptkit ci` baselines are machine-specific. `findingIdentity` embeds the absolute URL, `deoptkit ci` writes those identities into `.deopt/baselines/*.json`, and the README tells users to commit that directory so "no new megamorphic sites" is a guarded invariant. A baseline written in `C:\GitHub\deoptkit` never matches a CI checkout in `/home/runner/work/deoptkit`, so the first CI run reports every finding as NEW and the gate is useless. Plan 018 (dogfooding `deoptkit ci` in this repository's CI) cannot land until this is fixed.

The fix is one presentation rule: a file inside the workspace is shown as a forward-slash path relative to the workspace root; a file outside it as an absolute forward-slash path; anything that is not a file (`node:` internals, eval'd code) unchanged. The model keeps URLs internally (source maps, `isUserCode`, and the `findings.json` interchange read by `deoptkit lsp` all key on them); only tool responses and baseline identities change.

## Current state

All paths below are relative to `packages/deoptkit/` (the package moved there in plan 010; line numbers are unchanged by the move).

- `src/analysis/compare.ts`, around lines 56–74:

  ```ts
  /**
   * Stable identity for a finding across runs of edited code: kind + file + function +
   * the IC key / churned properties / deopt reasons — deliberately not line numbers,
   * which shift with every edit. Shared by compare_sessions and `deoptkit ci` baselines.
   */
  export const findingIdentity = (found: Finding): string => {
    const detail =
      asString(found.evidence["key"]) ??
      asJoinedStrings(found.evidence["propertyNames"]) ??
      asJoinedStrings(found.evidence["reasons"]) ??
      "";
    return `${found.kind}|${found.file}|${found.functionName ?? ""}|${detail}`;
  };
  ```

- `src/cli/ci.ts` lines 71–80 (`toEntries`), 82–88 (`baselinePathFor`, already relative to `process.cwd()`), 104–110 (`gitHubAnnotation`, already relativizes), 112–134 (`analyzeScript`), 191–199:

  ```ts
  const toEntries = (findings: Finding[]): BaselineEntry[] =>
    findings
      .filter(({ kind }) => GATED_KINDS.has(kind))
      .map((found) => ({
        identity: findingIdentity(found),
        kind: found.kind,
        file: found.file,
        functionName: found.functionName,
        summary: found.summary
      }));
  ...
      const known = new Set(baseline.findings.map(({ identity }) => identity));
      const current = new Set(entries.map(({ identity }) => identity));
      const introduced = findings.filter(
        (found) =>
          GATED_KINDS.has(found.kind) && !known.has(findingIdentity(found))
      );
      const resolved = baseline.findings.filter(
        ({ identity }) => !current.has(identity)
      );
  ```

- `src/sessions.ts` lines 4–10 and 34–49: `Session { id; source; loadedAt; model }`; `SessionStore.add(source: string, model: LogModel): Session`.
- `src/tools/shared.ts` (95 lines): schemas, `windowedModel`, `unknownSessionError`, `paginate`, `matchesFile`. No location helper yet.
- `src/sourcemaps/resolver.ts` lines 122–131:

  ```ts
  /** Attach `original` to any located item when a source map resolves its position. */
  export const withOriginal = <
    T extends { file?: string | undefined; line: number; column: number }
  >(
    resolver: SourceMapResolver,
    item: T
  ): T & { original?: OriginalPosition } => {
    const original = resolver.resolve(item.file, item.line, item.column);
    return original ? { ...item, original } : item;
  };
  ```

  `OriginalPosition.file` is a `file:` URL (lines 93–106 build it with `pathToFileURL`).

- Tools that emit locations: `src/tools/getFindings.ts` lines 66–75 (`.map((candidate) => withOriginal(resolver, candidate))`), `src/tools/listIcs.ts` lines 86–105 (`withOriginal(resolver, { type, file, functionName, line, column, key, worstState, transitionCount, ...transitions })`), `src/tools/listDeopts.ts` lines 54–64, `src/tools/listFunctions.ts` lines 45–53 (rows are `FunctionTicks` with optional `file`/`line`), `src/tools/getFunction.ts` lines 158–179 (`file: url`, `original: resolverFor(session).resolve(...)`), `src/tools/compareSessions.ts` lines 26–38 (spreads `compareSessions(base.model, head.model)`, whose `resolved`/`introduced` are `Finding[]`, `persisting[].file`, `functionDeltas[].file`).
- Session creators: `src/tools/loadLog.ts` lines 32–75 (`loadLogFile(path, ctx)` → `ctx.sessions.add(path, model)`) and 84–95 (schema has only `path`); `src/tools/profileRun.ts` lines 29–31 (`cwd` optional input), 92–97 (`ctx.sessions.add(\`profile_run: ...\`, model)`); `src/tools/loadManifest.ts`lines 55–60 (calls`loadLogFile(logfile, ctx)`).
- `src/server.ts` lines 65–85: `SERVER_INSTRUCTIONS`, which tells agents to "Edit the source at the finding's `original` position when present ... otherwise its file/line".
- Measured at `f850bbe` through the built server: every `file` in `get_findings`, `list_ics`, `list_deopts`, `list_functions`, `get_function`, and `compare_sessions` is `file:///C:/GitHub/@saeris/deopt-mcp/fixtures/workloads/<name>.js`.
- Tests that touch these paths: `src/__tests__/server.spec.ts` (profile_run → get_findings asserts `found.file.endsWith("map-churn.js")`), `src/cli/__tests__/ci.spec.ts` (baseline lifecycle; `baseline.script` asserted equal to the absolute temp path `app`), `src/__tests__/sessions.spec.ts` (calls `store.add(name, model)` with two arguments), `src/tools/__tests__/loadManifest.spec.ts`.

Conventions: Valibot schemas with `v.description`; every tool responds through `jsonResult`; tests state in a comment why the behavior matters (see `src/__tests__/server.spec.ts:186-187`); markdown soft-wrapped; no attribution lines.

## Commands you will need

| Purpose                   | Command                                                     | Expected on success                                 |
| ------------------------- | ----------------------------------------------------------- | --------------------------------------------------- |
| Install                   | `vp install` (repository root)                              | exit 0                                              |
| Format + lint + typecheck | `vp check --fix` (repository root)                          | `Found no warnings, lint errors, or type errors`    |
| One spec                  | `vp -C packages/deoptkit test src/cli/__tests__/ci.spec.ts` | passes                                              |
| All tests                 | `vp test` (repository root)                                 | all pass (80 at the start of this plan, more after) |
| Build                     | `vp -C packages/deoptkit pack`                              | `Build complete`                                    |

## Scope

**In scope** (relative to `packages/deoptkit/` unless noted):

- `src/analysis/paths.ts` (create), `src/analysis/__tests__/paths.spec.ts` (create)
- `src/sessions.ts`, `src/__tests__/sessions.spec.ts` (only if the signature change needs it)
- `src/tools/shared.ts`, `src/tools/loadLog.ts`, `src/tools/loadManifest.ts`, `src/tools/profileRun.ts`, `src/tools/getFindings.ts`, `src/tools/listIcs.ts`, `src/tools/listDeopts.ts`, `src/tools/listFunctions.ts`, `src/tools/getFunction.ts`, `src/tools/compareSessions.ts`
- `src/server.ts` (the instructions string only)
- `src/cli/ci.ts`, `src/cli/__tests__/ci.spec.ts`
- `src/__tests__/server.spec.ts`
- `README.md` (package README: the "Quick start" loop and "CI regression gating" sections)
- `.bumpy/011-paths.md` at the repository root (create)

**Out of scope**:

- `src/analysis/compare.ts`: `findingIdentity` keeps its URL-based identity for `compare_sessions`, which compares two sessions from the same machine. Portability is applied in `ci.ts` by normalizing the file before computing the identity.
- `src/analysis/findings.ts`, `src/model/**`, `src/parser/**`: the model keeps URLs.
- `src/lsp/**` and the `findings.json` interchange written by `ci.ts` and `src/vitest/globalSetup.ts`: unchanged (the LSP resolves both URLs and paths, and changing the interchange would couple this plan to the editor loop).
- `docs/SPEC.md` (the promise already matches what this plan implements).

## Git workflow

- Branch: you are on `exec/plan-011` in a dedicated worktree; stay there.
- One commit: `Tools: report workspace-relative paths; portable deoptkit ci baselines`.
- Bump file `.bumpy/011-paths.md`:

  ```markdown
  ---
  "deoptkit": minor
  ---

  Tool responses now report every location as a workspace-relative path (relative to `profile_run`'s `cwd`, `load_log`/`load_manifest`'s new `workspaceRoot`, or the server's working directory) that agents can pass straight to their file tools; files outside the workspace appear as absolute paths. `deoptkit ci` baselines now store identities with paths relative to the working directory, so a committed baseline matches on every machine and CI runner.
  ```

- Do NOT push or open a PR. No attribution lines.

## Steps

### Step 1: The path rule

Create `src/analysis/paths.ts`:

```ts
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Present a script location the way an agent's file tools want it: a forward-slash
 * path relative to `root` for files inside the workspace, an absolute forward-slash
 * path for files outside it, and the input unchanged when it is not a file at all
 * (`node:` internals, eval'd code, unparsable URLs).
 */
export const toWorkspacePath = (file: string, root: string): string => {
  let path: string;
  if (file.startsWith("file:")) {
    try {
      path = fileURLToPath(file);
    } catch {
      return file;
    }
  } else if (isAbsolute(file)) {
    path = file;
  } else {
    return file;
  }
  const rel = relative(resolve(root), path);
  const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  return (inside ? rel : path).replaceAll("\\", "/");
};
```

Create `src/analysis/__tests__/paths.spec.ts` with platform-neutral cases built from `node:path`/`node:url` (use `join(tmpdir(), "ws")` as the root and `pathToFileURL(join(root, "src", "a.ts")).href` as input so the test is correct on Windows and POSIX): inside → `src/a.ts`; nested root with a sibling file outside → the absolute path with forward slashes (compare against `join(tmpdir(), "other", "b.js").replaceAll("\\", "/")`); `node:internal/x` and `evalmachine.<anonymous>` unchanged; a plain absolute OS path inside the root → relative; `file:` URL with a `?vitest=` query never reaches here (normalized at the parser), so no case. Comment: agents hand these strings to Read/Edit, and a CI baseline must not depend on where the checkout lives.

**Verify**: `vp -C packages/deoptkit test src/analysis/__tests__/paths.spec.ts` → passes.

### Step 2: Sessions carry a workspace root

In `src/sessions.ts`: add `/** Absolute directory that reported paths are relative to. */ workspaceRoot: string;` to `Session`, and change `add(source: string, model: LogModel, workspaceRoot: string = process.cwd()): Session` to store `resolve(workspaceRoot)` (import `resolve` from `node:path`). Existing two-argument callers keep working.

In `src/tools/loadLog.ts`: `loadLogFile(path, ctx, workspaceRoot?: string)` passes `workspaceRoot` to `add`; the `load_log` schema gains `workspaceRoot: v.optional(v.pipe(v.string(), v.description("Directory that reported paths are relative to (default: the server's working directory)")))` and the handler forwards it; the outcome object gains `workspaceRoot: session.workspaceRoot`. In `src/tools/loadManifest.ts`: the same optional `workspaceRoot` input, forwarded to every `loadLogFile` call. In `src/tools/profileRun.ts`: `ctx.sessions.add(..., model, cwd ?? process.cwd())` and `workspaceRoot` in the response next to `sessionId`.

**Verify**: `vp check --fix` → clean; `vp -C packages/deoptkit test src/__tests__/sessions.spec.ts src/tools/__tests__/loadManifest.spec.ts` → pass.

### Step 3: One presentation helper for every tool

In `src/tools/shared.ts` add:

```ts
import type { OriginalPosition } from "../sourcemaps/resolver";
import { resolverFor, withOriginal } from "../sourcemaps/resolver";
import { toWorkspacePath } from "../analysis/paths";

/**
 * How every tool reports a location: the source-mapped `original` attached when a map
 * resolves it, and both `file`s rewritten as workspace-relative paths (see
 * `toWorkspacePath`). The model itself keeps V8's URLs.
 */
export const presentLocation = <
  T extends { file?: string | undefined; line: number; column: number }
>(
  session: Session,
  item: T
): T & { original?: OriginalPosition } => {
  const located = withOriginal(resolverFor(session), item);
  const root = session.workspaceRoot;
  return {
    ...located,
    ...(located.file === undefined
      ? {}
      : { file: toWorkspacePath(located.file, root) }),
    ...(located.original === undefined
      ? {}
      : {
          original: {
            ...located.original,
            file: toWorkspacePath(located.original.file, root)
          }
        })
  };
};

/** `presentLocation` for rows whose position is optional (profile rows). */
export const presentFile = <T extends { file?: string | undefined }>(
  session: Session,
  item: T
): T =>
  item.file === undefined
    ? item
    : { ...item, file: toWorkspacePath(item.file, session.workspaceRoot) };
```

Then replace every `withOriginal(resolver, …)` call in `getFindings.ts`, `listIcs.ts`, `listDeopts.ts` with `presentLocation(session, …)` and drop the now-unused `resolverFor` imports and `resolver` locals. In `listFunctions.ts` map the page items through `presentFile(session, row)`. In `getFunction.ts`: `file: toWorkspacePath(url, session.workspaceRoot)` (the `knownScripts` error list too), and `original` mapped through `toWorkspacePath` when defined. In `compareSessions.ts`: map `resolved` and `introduced` through `presentLocation(head, …)` for `introduced` and `presentLocation(base, …)` for `resolved`, and `persisting[].file` / `functionDeltas[].file` through `toWorkspacePath(file, head.workspaceRoot)`.

Keep the text/`structuredContent` parity: `jsonResult` is untouched.

**Verify**: `vp check --fix` → clean.

### Step 4: Tell agents

In `src/server.ts` `SERVER_INSTRUCTIONS`, change step 3 to read: "Edit the source at the finding's `original` position when present (that is the .ts/.js you wrote), otherwise its file/line. Locations are workspace-relative paths (relative to profile_run's cwd, load_log's workspaceRoot, or this server's working directory); pass them to your file tools as they are."

In `README.md` (package): in the Quick start loop, step 3, add "(paths are relative to the project, ready for your editor or file tools)"; in "CI regression gating", add one sentence after the paragraph about baselines: "Identities use paths relative to the directory `deoptkit ci` runs in, so run it from the same project directory locally and in CI and the committed baseline matches everywhere."

**Verify**: `grep -n "workspace-relative" packages/deoptkit/src/server.ts` → one match; `vp check --fix` → clean.

### Step 5: Portable `deoptkit ci` baselines

In `src/cli/ci.ts`:

- Import `toWorkspacePath` from `../analysis/paths`.
- Add `const portable = (found: Finding): Finding => ({ ...found, file: toWorkspacePath(found.file, process.cwd()) });` with a comment: baselines are committed and compared on other machines, so identities must not contain the checkout path.
- `toEntries`: compute `const entry = portable(found)` and use it for `identity`, `file`, and `functionName`.
- The `introduced` filter: `!known.has(findingIdentity(portable(found)))`.
- Leave `allFindings` (the `findings.json` interchange) and `gitHubAnnotation` unchanged.

In `src/cli/__tests__/ci.spec.ts`:

- Make the suite run from the temp directory so the script is inside the workspace: in `beforeAll`, after `mkdtemp`, record `const previousCwd = process.cwd()` and call `process.chdir(dir)`; restore it in `afterAll` before `rm`. (The Vitest config uses the forks pool, so `chdir` affects only this spec's process.)
- Extend "gates structural regressions against a checked-in baseline": after the first run, read the baseline and assert for every entry that `entry.file` does not start with `file:`, `isAbsolute(entry.file)` is false, `entry.identity` contains `entry.file`, and for the `map-churn-fixed` baseline specifically that `entry.file === "app.js"`. Comment: a baseline is committed and must match on any machine; an absolute path in the identity makes every CI run fail with "NEW" findings.
- Keep `expect(baseline.script).toBe(app)` (the script path is display-only).

**Verify**: `vp -C packages/deoptkit test src/cli/__tests__/ci.spec.ts` → passes.

### Step 6: Server contract test

In `src/__tests__/server.spec.ts`, in the `profile_run` test: pass `cwd: dirname(workload)` in the `profile_run` arguments (import `dirname` from `node:path`), assert the response has `workspaceRoot` ending with `workloads`, and for the megamorphic finding assert `found.file === "map-churn.js"` (exact) and `found.file` does not start with `file:`. In the `get_function` call assert `detail.file === "map-churn.js"`. Comment: agents pass these strings to Read/Edit; a URL or an absolute path breaks that and wastes a conversion turn.

**Verify**: `vp -C packages/deoptkit test src/__tests__/server.spec.ts` → passes; then `vp test` at the root → all pass; `vp -C packages/deoptkit pack` → `Build complete`.

## Test plan

- New: `src/analysis/__tests__/paths.spec.ts` (the rule, platform-neutral).
- Extended: `src/cli/__tests__/ci.spec.ts` (baseline entries are relative), `src/__tests__/server.spec.ts` (tool responses are relative, `workspaceRoot` reported).
- Verification: `vp test` → all pass.

## Done criteria

- [ ] `vp check` exits 0
- [ ] `vp test` exits 0 with the new and extended tests passing
- [ ] `grep -rn "withOriginal(resolver" packages/deoptkit/src/tools` prints nothing
- [ ] `grep -n "workspaceRoot" packages/deoptkit/src/tools/loadLog.ts packages/deoptkit/src/tools/profileRun.ts packages/deoptkit/src/tools/loadManifest.ts` finds the input or output in each
- [ ] A baseline written by `deoptkit ci` from the package directory contains no `file:///` string (`grep -c "file:///" <baseline>` → 0)
- [ ] `vp -C packages/deoptkit pack` exits 0
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated (skip if your reviewer maintains the index)

## STOP conditions

- The "Current state" excerpts do not match the live code.
- `process.chdir` throws in the test process (would mean the pool is not `forks`); report rather than switching pools.
- Any existing test outside the in-scope list fails after Step 3 for a reason other than a path now being relative (if it is only that, extend the in-scope list by that spec file and fix the assertion, noting it in your report).
- Windows drive-letter casing makes `relative()` return `..`-prefixed paths for files that are inside the root (check with `node -e` if the paths test fails on this machine); report the two strings.

## Maintenance notes

- Future tools that report locations must use `presentLocation`/`presentFile`; never emit `site.file` raw.
- If the `findings.json` interchange is ever relativized, update `src/lsp/server.ts` (`toUri`, `staleFor`) in the same change and keep the LSP's cwd equal to the workspace root.
- `compare_sessions` across sessions with different `workspaceRoot`s reports paths relative to the head session's root.
