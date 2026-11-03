# Plan 012: Slim tool responses (explanations once per kind, bounded IC histories, one-call re-profile and compare)

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md` — unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 37e6251..HEAD -- packages/deoptkit/src/tools packages/deoptkit/src/server.ts packages/deoptkit/src/__tests__/server.spec.ts` must print nothing, and `packages/deoptkit/src/analysis/findings.ts` must still contain `const EXPLANATIONS: Record<` (plan 015 may edit the same file's `heatOf`; that is fine). Compare the excerpts under "Current state" with the live files; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/011-workspace-relative-paths-and-portable-baselines.md
- **Category**: dx (agent token efficiency)
- **Planned at**: commit `37e6251`, 2026-11-03

## Why this matters

deoptkit is built for agents, and every byte a tool returns is a token the agent pays for on every turn afterwards. Measured on 2026-11-03 through the built server against the fixture sessions:

| Response                             | Size                    | Of which                                                                            |
| ------------------------------------ | ----------------------- | ----------------------------------------------------------------------------------- |
| `get_findings` (3–5 findings)        | 2.7–4.3 KB              | 37–42% is `explanation` + `suggestedFix`, six template strings repeated per finding |
| `list_ics` with `includeTransitions` | 15–20 KB per page of 20 | the raw transition list (time/oldState/newState/mapAddress per event)               |
| `compare_sessions`                   | 6.6 KB                  | full findings (with the same template strings) in `resolved` and `introduced`       |

On a real project with a full page of 20 findings, `get_findings` is about 17 KB, of which 6–7 KB say the same six things. The core loop also costs one tool call more than it needs: after a fix the agent calls `profile_run` and then `compare_sessions` with two session ids it must keep track of. Three changes, all in the presentation layer, leave the findings engine, the `findings.json` interchange, and the LSP untouched: explanations move to a per-response `kinds` legend, IC transition histories get a bound and a summary, and `profile_run` can compare against a base session in the same call.

## Current state

Paths relative to `packages/deoptkit/`.

- `src/analysis/findings.ts` lines 35–75: `const EXPLANATIONS: Record<FindingKind, { explanation: string; suggestedFix: string }> = { ... }` (not exported); `finding(...)` spreads `...EXPLANATIONS[kind]` into every `Finding` (lines 114–135). `Finding` (lines 11–27) carries `explanation` and `suggestedFix`; the LSP interchange (`src/cli/ci.ts`, `src/vitest/globalSetup.ts`) and `src/lsp/server.ts` rely on them and are out of scope.
- `src/tools/getFindings.ts` (76 lines; after plan 011):

  ```ts
  const findings = computeFindings(model)
    .filter(
      (candidate) =>
        (kinds === undefined || kinds.includes(candidate.kind)) &&
        (severityMin === undefined || candidate.severity >= severityMin) &&
        matchesFile(candidate.file, file)
    )
    .map((candidate) => presentLocation(session, candidate));
  return jsonResult(paginate(findings, limit, offset));
  ```

  Its `description` says "Each finding has a severity (1-100), source location, explanation, and suggested fix."

- `src/tools/compareSessions.ts` (60 lines; after plan 011): builds `comparison = compareSessions(base.model, head.model)` and returns `{ base, head, ...comparison, resolved: …presentLocation(base, found), introduced: …presentLocation(head, found), persisting, functionDeltas }`.
- `src/tools/listIcs.ts` lines 86–105:

  ```ts
  const page = paginate(sites, limit, offset);
  return jsonResult({
    ...page,
    items: page.items.map((site) =>
      presentLocation(session, {
        type: site.type,
        file: site.file,
        functionName: site.functionName,
        line: site.line,
        column: site.column,
        key: site.key,
        worstState: site.worstState,
        transitionCount: site.transitions.length,
        ...(includeTransitions === true
          ? { transitions: site.transitions }
          : {})
      })
    )
  });
  ```

  `IcTransition` is `{ time; oldState; newState; mapAddress }` (`src/model/logModel.ts` lines 33–38); transitions are in log order.

- `src/tools/profileRun.ts` lines 58–118: handler runs the workload, parses, `ctx.sessions.add(..., model, cwd ?? process.cwd())`, and returns `{ sessionId, workspaceRoot, v8Version, exit, counts, markers, warnings }`. Its schema has `command`, `cwd`, `env`, `timeoutMs`, `categories`.
- `src/tools/shared.ts` (after plan 011): schemas, `windowedModel`, `unknownSessionError`, `paginate`, `matchesFile`, `presentLocation`, `presentFile`.
- `src/server.ts` lines 65–88: `SERVER_INSTRUCTIONS` (the core loop; step 4 reads "profile_run again, then compare_sessions { baseSessionId, headSessionId } to confirm the finding is in `resolved` and nothing meaningful is in `introduced`.").
- `src/__tests__/server.spec.ts`: `textPayload(result)` helper; the `profile_run` test (around lines 152–240) profiles `fixtures/workloads/map-churn.js` with `cwd: dirname(workload)`, then calls `get_findings`, pages it, filters by file, and calls `get_function`; a `list_sessions` test asserts `structuredContent` equals the text payload.
- `src/analysis/__tests__/compare.spec.ts` profiles `map-churn.js` then `map-churn-fixed.js` and asserts the `id` megamorphic finding is `resolved` (the same pair proves `compareTo` below).

Conventions: Valibot schemas with `v.description`; `jsonResult` for every response; tests say why; soft-wrapped markdown.

## Commands you will need

| Purpose                   | Command                                                     | Expected on success |
| ------------------------- | ----------------------------------------------------------- | ------------------- |
| Install                   | `vp install`                                                | exit 0              |
| Format + lint + typecheck | `vp check --fix`                                            | clean               |
| Server spec               | `vp -C packages/deoptkit test src/__tests__/server.spec.ts` | passes              |
| All tests                 | `vp test`                                                   | all pass            |
| Build                     | `vp -C packages/deoptkit pack`                              | `Build complete`    |

## Scope

**In scope** (relative to `packages/deoptkit/`):

- `src/analysis/findings.ts` (export the explanations table only)
- `src/tools/shared.ts`, `src/tools/getFindings.ts`, `src/tools/compareSessions.ts`, `src/tools/listIcs.ts`, `src/tools/profileRun.ts`
- `src/server.ts` (instructions string)
- `src/__tests__/server.spec.ts`
- `.bumpy/012-slim-responses.md` (repository root; create)

**Out of scope**:

- The `Finding` type and `computeFindings`: the interchange and LSP keep per-finding explanations.
- `src/analysis/compare.ts`, `src/cli/**`, `src/lsp/**`, `src/vitest/**`.
- `outputSchema` declarations (deferred since plan 008).

## Git workflow

- Branch: `exec/plan-012` in a dedicated worktree; stay there.
- One commit: `Tools: explanations once per kind, bounded IC histories, profile_run compareTo`.
- Bump file `.bumpy/012-slim-responses.md`:

  ```markdown
  ---
  "deoptkit": minor
  ---

  `get_findings` and `compare_sessions` now return each finding kind's explanation and suggested fix once, under `kinds`, instead of repeating them on every finding (about 40% of the payload); `list_ics` summarizes each site's state history and distinct map count and bounds `includeTransitions` with `maxTransitions`; `profile_run` accepts `compareTo` to re-profile and return the before/after comparison in one call.
  ```

- Do NOT push or open a PR. No attribution lines.

## Steps

### Step 1: Export the legend and add presentation helpers

In `src/analysis/findings.ts` rename `EXPLANATIONS` to `FINDING_EXPLANATIONS` and export it (`export const FINDING_EXPLANATIONS: Record<FindingKind, { explanation: string; suggestedFix: string }>`); update the one use in `finding(...)`.

In `src/tools/shared.ts` add:

```ts
import type { Finding, FindingKind } from "../analysis/findings";
import { FINDING_EXPLANATIONS } from "../analysis/findings";

/** A finding as tools report it: the per-kind text lives in the response's `kinds` legend. */
export type SlimFinding<T extends Finding = Finding> = Omit<
  T,
  "explanation" | "suggestedFix"
>;

export const slimFinding = <T extends Finding>({
  explanation: _explanation,
  suggestedFix: _suggestedFix,
  ...rest
}: T): SlimFinding<T> => rest;

/**
 * Explanation and suggested fix for every kind present in `findings`, once each.
 * Measured 37–42% of a get_findings payload before this legend existed.
 */
export const kindsLegend = (
  findings: ReadonlyArray<Pick<Finding, "kind">>
): Partial<
  Record<FindingKind, { explanation: string; suggestedFix: string }>
> =>
  Object.fromEntries(
    [...new Set(findings.map(({ kind }) => kind))].map((kind) => [
      kind,
      FINDING_EXPLANATIONS[kind]
    ])
  );
```

**Verify**: `vp check --fix` → clean.

### Step 2: `get_findings` and `compare_sessions`

`getFindings.ts`: after `paginate`, return `jsonResult({ ...page, items: page.items.map(slimFinding), kinds: kindsLegend(page.items) })`. Update the description: "Each finding has a severity (1-100), source location, and evidence; the explanation and suggested fix for each kind present are returned once under `kinds`."

`compareSessions.ts`: `resolved` and `introduced` map through `slimFinding` after `presentLocation`, and the response gains `kinds: kindsLegend([...comparison.resolved, ...comparison.introduced])`. Mention `kinds` in the description.

**Verify**: `vp check --fix` → clean.

### Step 3: `list_ics` histories

In `listIcs.ts`:

- Add a `maxTransitions` input: `v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200), v.description("With includeTransitions: at most this many of the most recent transitions per site (default 20)")))`.
- For every item add `stateHistory`: the site's `newState` sequence with consecutive repeats collapsed, joined by `→` (for example `uninitialized→monomorphic→polymorphic→megamorphic`), and `distinctMaps`: the number of distinct `mapAddress` values in its transitions. Comment: how many shapes hit the site is the number that tells an agent whether to normalize shapes or split the call site; the history shows how fast it escalated.
- With `includeTransitions`: `transitions` becomes the last `maxTransitions ?? 20` entries, plus `transitionsOmitted: site.transitions.length - transitions.length` and `mapAddresses`: up to 8 distinct addresses, most recent first (the input to `get_map`).
- Update the description: "Transitions are omitted unless includeTransitions is set, and then bounded by maxTransitions."

**Verify**: `vp check --fix` → clean.

### Step 4: `profile_run` with `compareTo`

In `compareSessions.ts` extract the response body into an exported `comparisonPayload(base: Session, head: Session)` (everything inside `jsonResult({...})`), and have the tool handler return `jsonResult(comparisonPayload(base, head))`.

In `profileRun.ts`:

- Add `compareTo: v.optional(v.pipe(sessionIdSchema, v.description("A base session to compare the new session against; the response then includes `comparison`, the same payload compare_sessions returns")))` (import `sessionIdSchema` and `unknownSessionError` from `./shared`).
- At the top of the handler, before running anything: `const base = compareTo === undefined ? undefined : ctx.sessions.get(compareTo); if (compareTo !== undefined && !base) return unknownSessionError(compareTo);` (never spawn a workload for a request that cannot be fulfilled).
- After `ctx.sessions.add(...)`, include `...(base ? { comparison: comparisonPayload(base, session) } : {})` in the response.
- Update the description's last sentence: "Then call get_findings; pass compareTo after a fix to get the before/after comparison in the same call."

**Verify**: `vp check --fix` → clean.

### Step 5: Instructions

In `src/server.ts` `SERVER_INSTRUCTIONS`, change step 4 to: "profile_run again with compareTo set to the earlier sessionId (or call compare_sessions { baseSessionId, headSessionId }) and confirm the finding is in `resolved` and nothing meaningful is in `introduced`." Add after the windowing paragraph: "Token budget: get_findings returns each kind's explanation once under `kinds`; use limit, offset, severityMin, file, and kinds to narrow pages, and list_ics with includeTransitions only for the one site you are drilling into."

**Verify**: `grep -c "compareTo" packages/deoptkit/src/server.ts` ≥ 1.

### Step 6: Tests

In `src/__tests__/server.spec.ts`, inside the existing `profile_run` test (so no extra workload run is needed for the first three assertions):

- After `get_findings`: every item lacks `explanation` and `suggestedFix` (`expect("explanation" in found).toBe(false)`), `kinds` has a key for every `kind` present in `items` and each entry has a non-empty `explanation` and `suggestedFix`. Comment: the six template strings were 37–42% of every findings payload; the legend carries them once, and an agent reads the kind's text at most once per response.
- `list_ics { sessionId, includeTransitions: true, maxTransitions: 2 }` on the megamorphic `id` site (filter by `states: ["megamorphic"]`, `file: "map-churn.js"`): `transitions.length <= 2`, `transitionsOmitted === transitionCount - transitions.length`, `distinctMaps >= 5` (the site saw at least five shapes, which is what megamorphic means), `stateHistory` ends with `megamorphic`, `mapAddresses.length >= 1`. Comment: unbounded histories were 4–5k tokens per page.
- Then profile `map-churn-fixed.js` (same directory) with `compareTo: sessionId`: `comparison.base.sessionId === sessionId`, `comparison.resolved` contains a `megamorphic-ic` with `evidence.key === "id"`, `comparison.kinds["megamorphic-ic"]` is defined, and no item in `comparison.resolved` has `explanation`. Comment: closing the loop in one call saves a round trip and the bookkeeping of two session ids on every iteration. Raise that test's timeout to `120_000`.
- A new small test: `profile_run` with `compareTo: "nope"` returns `isError` with `Unknown session` and does not run the command (use `command: ["node", "-e", "process.exit(3)"]`; the error text must not mention exit code 3).
- Keep the `structuredContent` parity test as is (it still holds; `jsonResult` is unchanged).

**Verify**: `vp -C packages/deoptkit test src/__tests__/server.spec.ts` → passes; `vp test` → all pass; `vp -C packages/deoptkit pack` → `Build complete`.

## Test plan

- Extended `server.spec.ts`: legend shape, IC history bound and summary, `compareTo` happy path and unknown base.
- Verification: `vp test` → all pass.

## Done criteria

- [ ] `vp check` exits 0; `vp test` exits 0 with the new assertions
- [ ] `grep -n "FINDING_EXPLANATIONS" packages/deoptkit/src/analysis/findings.ts packages/deoptkit/src/tools/shared.ts` finds the export and its import
- [ ] `get_findings` items carry no `explanation`; the response has `kinds`
- [ ] `list_ics` items carry `stateHistory` and `distinctMaps`; `includeTransitions` output is bounded by `maxTransitions`
- [ ] `profile_run` accepts `compareTo` and returns `comparison`
- [ ] `vp -C packages/deoptkit pack` exits 0
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated (skip if your reviewer maintains the index)

## STOP conditions

- The "Current state" excerpts do not match the live code (plan 011 must have landed; plan 015 may have changed `heatOf` in `findings.ts`, which is fine).
- Removing `explanation` from tool output breaks a test outside the in-scope list (none is expected; `compare.spec.ts` and `findings.spec.ts` test the engine, not the tools): report which.
- The SDK or Valibot rejects the `compareTo` schema reuse of `sessionIdSchema` (it is a `v.pipe`); report the error.

## Maintenance notes

- Any new tool that returns findings must go through `slimFinding` and attach `kindsLegend`; the `Finding` type keeps the text for the interchange, so forgetting is silent, which is why the server spec asserts the absence.
- If `outputSchema` is added later, the legend is `Partial<Record<FindingKind, …>>`.
- `maxTransitions` is a per-site bound; the page `limit` bounds sites. Both default small on purpose.
