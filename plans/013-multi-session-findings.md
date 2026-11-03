# Plan 013: Merge findings across sessions in one `get_findings` call (vitest bench manifests)

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md` — unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: confirm plan 012 is DONE in `plans/README.md`, then `grep -n "kindsLegend\|slimFinding" packages/deoptkit/src/tools/getFindings.ts` must find both. Compare the excerpts under "Current state" with the live files; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/012-slim-tool-responses.md
- **Category**: dx (agent token efficiency)
- **Planned at**: commit `37e6251`, 2026-11-03 (excerpts of `getFindings.ts` describe its state after plan 012)

## Why this matters

The `deoptkit/vitest` preset writes one V8 log per worker process, and `load_manifest` loads each as its own session (`src/tools/loadManifest.ts`, "Load every V8 log listed in a deoptkit manifest ... as sessions"). A bench suite with several files therefore gives the agent N sessions, and the only way to answer "what should I fix first?" is N `get_findings` calls followed by a by-hand merge of findings that are the same site seen from different workers. Every extra call costs the agent the call framing, the result, and a reasoning turn; the merge is error-prone. One `get_findings` over several sessions, deduplicated by finding identity with the sessions it appeared in, answers the question in a single response.

## Current state

Paths relative to `packages/deoptkit/`.

- `src/tools/getFindings.ts` after plan 012: schema `{ sessionId: sessionIdSchema, kinds?, severityMin?, file?, fromMark?, toMark?, limit?, offset? }`; handler: `const session = ctx.sessions.get(sessionId); if (!session) return unknownSessionError(sessionId); const model = windowedModel(session, { fromMark, toMark }); if ("error" in model) return jsonResult(model, { isError: true }); const findings = computeFindings(model).filter(...).map((candidate) => presentLocation(session, candidate)); const page = paginate(findings, limit, offset); return jsonResult({ ...page, items: page.items.map(slimFinding), kinds: kindsLegend(page.items) });`
- `src/tools/shared.ts`: `sessionIdSchema` (`v.pipe(v.string(), v.description("Session id returned by load_log (see list_sessions)"))`), `windowedModel`, `unknownSessionError`, `paginate`, `matchesFile`, `presentLocation`, `slimFinding`, `kindsLegend`.
- `src/analysis/compare.ts` exports `findingIdentity(found): string` = `${kind}|${file}|${functionName ?? ""}|${detail}` (line-number-free identity shared with `deoptkit ci`).
- `src/tools/loadManifest.ts` handler returns `{ loadedCount, sessions: outcomes }` where each outcome is `{ logfile, ...LoadOutcome }` and a successful `LoadOutcome` has `sessionId`.
- `src/tools/__tests__/loadManifest.spec.ts`: invokes the tool directly with `loadManifest.invoke({ path }, { sessions })` and a `payloadOf` helper; generates a `map-churn` log once in `beforeAll`.
- `src/server.ts` `SERVER_INSTRUCTIONS` mention "load_manifest to load every log from a `deoptkit/vitest` bench run".

Conventions: Valibot schemas with `v.description`; tool-level specs call `tool.invoke(args, { sessions })` (see `loadManifest.spec.ts`); tests say why; soft-wrapped markdown.

## Commands you will need

| Purpose                   | Command                                                                                                         | Expected on success |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------- |
| Install                   | `vp install`                                                                                                    | exit 0              |
| Format + lint + typecheck | `vp check --fix`                                                                                                | clean               |
| Tool specs                | `vp -C packages/deoptkit test src/tools/__tests__/getFindings.spec.ts src/tools/__tests__/loadManifest.spec.ts` | pass                |
| All tests                 | `vp test`                                                                                                       | all pass            |

## Scope

**In scope** (relative to `packages/deoptkit/`):

- `src/tools/getFindings.ts`, `src/tools/loadManifest.ts`, `src/tools/shared.ts` (one schema)
- `src/tools/__tests__/getFindings.spec.ts` (create), `src/tools/__tests__/loadManifest.spec.ts`
- `src/server.ts` (one sentence in the instructions)
- `.bumpy/013-multi-session.md` (repository root; create)

**Out of scope**:

- Merging `LogModel`s (address spaces differ per process; findings merge by identity instead).
- Other list tools (`list_ics` etc.) stay single-session; findings are the triage surface.
- `compare_sessions` across session sets.

## Git workflow

- Branch: `exec/plan-013` in a dedicated worktree; stay there.
- One commit: `Tools: get_findings over several sessions, merged by identity`.
- Bump file `.bumpy/013-multi-session.md` with `"deoptkit": minor` and body: `get_findings accepts sessionIds to rank the findings of several sessions (for example every worker log of a vitest bench run) in one response, merged by identity with the sessions each finding appeared in; load_manifest returns the loaded sessionIds ready to pass along.`
- Do NOT push or open a PR. No attribution lines.

## Steps

### Step 1: Schema

In `src/tools/shared.ts` add `export const sessionIdsSchema = v.optional(v.pipe(v.array(sessionIdSchema), v.minLength(1), v.description("Several session ids (for example from load_manifest); findings are merged by identity across them")));`.

In `getFindings.ts` make `sessionId` optional (`v.optional(sessionIdSchema)`) and add `sessionIds: sessionIdsSchema`. At the top of the handler: `const ids = sessionIds ?? (sessionId === undefined ? [] : [sessionId]); if (ids.length === 0) return jsonResult({ error: "Provide sessionId or sessionIds." }, { isError: true });` then resolve every id through `ctx.sessions.get`, returning `unknownSessionError(id)` for the first unknown.

**Verify**: `vp check --fix` → clean.

### Step 2: Merge

Replace the single-session body with a loop over the resolved sessions: for each, `windowedModel(session, { fromMark, toMark })` (an error result returns immediately with the session id prefixed to the message), `computeFindings`, the existing filters, and `presentLocation(session, candidate)`. When `ids.length === 1` the result is exactly today's shape (no extra fields). When more than one: merge by `findingIdentity(candidate)` (import from `../analysis/compare`) computed on the **unpresented** finding (model URLs, before `presentLocation`) so identity is independent of workspace roots; keep the instance with the highest severity as the item, and attach `sessions: string[]` (the ids it appeared in, in input order). Sort merged items by severity descending, then kind weight as `computeFindings` does is not needed: use severity, then `file`, then `line`. Paginate the merged list; `kinds: kindsLegend(page.items)`; items pass through `slimFinding`. Comment: one bench suite is N worker logs; the agent needs one ranked answer, not N.

Update the tool description: "Pass sessionIds instead of sessionId to rank the findings of several sessions (every worker log of a vitest bench run) together; identical findings merge and list the sessions they appeared in."

**Verify**: `vp check --fix` → clean.

### Step 3: `load_manifest` hands over the ids

In `loadManifest.ts` add `sessionIds: loaded.map((outcome) => outcome.sessionId)` to the response (the `loaded` outcomes are the successful ones; narrow the type as needed), and extend the description's last sentence: "The response's sessionIds can be passed straight to get_findings." In `loadManifest.spec.ts` assert `payload["sessionIds"]` equals `["s1"]` in the existing happy-path test. Comment: the agent should never have to pluck ids out of per-log outcomes.

In `src/server.ts`, after "load every log from a `deoptkit/vitest` bench run" add ", then get_findings { sessionIds } for one ranked list across workers".

**Verify**: `vp -C packages/deoptkit test src/tools/__tests__/loadManifest.spec.ts` → passes.

### Step 4: Tool spec

Create `src/tools/__tests__/getFindings.spec.ts` modelled on `loadManifest.spec.ts`: generate the `map-churn` log once (`generateWorkloadLog("map-churn", dir)`), load it twice into one `SessionStore` through `loadLogFile(logfile, { sessions })` (import from `../loadLog`), so `s1` and `s2` are two sessions of identical content (what two workers running the same bench file produce). Tests:

1. `get_findings { sessionIds: ["s1", "s2"] }`: `totalCount` equals `get_findings { sessionId: "s1" }`'s `totalCount` (nothing duplicated), every item has `sessions` deep-equal to `["s1", "s2"]`, no item has `explanation`, and `kinds` is present. Comment: without the merge the agent calls get_findings per worker and dedupes by hand; the identities must line up across processes.
2. `get_findings { sessionId: "s1" }` items have no `sessions` field (single-session shape unchanged).
3. `get_findings { sessionIds: ["s1", "nope"] }` is an error mentioning `nope`.
4. `get_findings {}` is an error mentioning `sessionId`.

**Verify**: `vp -C packages/deoptkit test src/tools/__tests__/getFindings.spec.ts` → passes; `vp test` → all pass.

## Test plan

- New `getFindings.spec.ts` (merge, single-session shape, unknown id, missing id); extended `loadManifest.spec.ts`.
- Verification: `vp test` → all pass.

## Done criteria

- [ ] `vp check` and `vp test` exit 0
- [ ] `get_findings` accepts `sessionIds`; `load_manifest` returns `sessionIds`
- [ ] Single-session responses are byte-for-byte the same shape as before this plan (no `sessions` field)
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated (skip if your reviewer maintains the index)

## STOP conditions

- Plan 012 is not DONE (the `kinds` legend and `slimFinding` are assumed).
- `findingIdentity` is not exported from `src/analysis/compare.ts` (it is at planning time).
- Making `sessionId` optional breaks the `tools/list` contract test in `server.spec.ts` (it asserts `load_log` requires `path`, not `get_findings`'s required list; report if anything else asserts on `get_findings`'s `required`).

## Maintenance notes

- `sessions` on merged items is the only shape difference between the single and multi-session responses; keep it that way so existing consumers see no change.
- If windowing marks differ per worker (they do not in `benchObserved`, which uses the case name), `fromMark/toMark` apply per session and an unknown marker in any session errors the whole call.
