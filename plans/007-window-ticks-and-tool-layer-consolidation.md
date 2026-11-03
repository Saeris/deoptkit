# Plan 007: Window profile ticks and consolidate the tool layer

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md` — unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat b733901..HEAD -- src/parser/parseLog.ts src/model/logModel.ts src/analysis/window.ts src/tools src/index.ts` and `git status --short` on those paths. Plans 001 and 003 change `parseLog.ts`; if they landed, the `tick` handler excerpt below is unchanged by them, but re-read the file before editing. Any other mismatch is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (schedule after 001 and 003 to avoid conflicts in `parseLog.ts`)
- **Category**: bug, tech-debt
- **Planned at**: commit `b733901`, 2026-11-03

## Why this matters

Windowing (`fromMark`/`toMark`) is how a session with several benchmark cases is scoped to one case. `applyWindow` recomputes IC, deopt, and map-transition aggregates from per-event timestamps, but profile ticks have no per-sample retention, so `profile` passes through unwindowed. Severity is `base × (1 + log10(1 + occurrences)) × (1 + 4 × heat)` where heat is the function's share of all self ticks, so inside a window every finding is ranked by whole-run heat: a case that runs for 5% of the session cannot have its own hot spot ranked first, and `list_functions` cannot be windowed at all. Alongside this, the three windowed tools repeat the same five-line resolve-and-apply block, `get_findings` has `limit` but no `offset` (an agent cannot page past the first 100) and no `file` filter, and `isUserCode` is duplicated in `findings.ts` and `compare.ts`. Retaining one record per tick is cheap (V8 samples about once per millisecond; a 60 s run is 60k small objects).

## Current state

- `src/parser/parseLog.ts` — the `tick` handler (lines 325–352) counts `selfTicks`/`totalTicks` into `functionTicks` rows keyed by `${functionName}|${file}|${line}|${column}` via `tickRowFor` (lines 111–126); `vmStates` counts per state label; nothing per sample is kept.

  ```ts
      tick: ([
        pc,
        _time,
        _isExternal,
        _tosOrExternal,
        vmState,
        ...stack
      ]): void => {
        tickCount += 1;
        const state = vmStateLabel(vmState);
        vmStates[state] = (vmStates[state] ?? 0) + 1;

        let previous = BigInt(pc ?? "0");
        const top = codeMap.find(previous);
        if (top) tickRowFor(top).selfTicks += 1;

        // Total ticks count each function once per sample, however often it recurs.
        const onStack = new Set<FunctionTicks>();
        if (top) onStack.add(tickRowFor(top));
        for (const field of stack) {
          const address = parseStackAddress(field ?? "", previous);
          if (address === undefined) continue;
          previous = address;
          const entry = codeMap.find(address);
          if (entry) onStack.add(tickRowFor(entry));
        }
        for (const row of onStack) row.totalTicks += 1;
      },
  ```

- `src/model/logModel.ts` — `FunctionTicks` (lines 135–144), `ProfileModel` (lines 146–152: `tickCount`, `vmStates`, `functions`).
- `src/analysis/window.ts` — `resolveWindow` (lines 19–47) and `applyWindow` (lines 59–111); the comment at lines 52–57 documents that ticks are not windowed.
- `src/analysis/findings.ts` lines 139–160 compute heat from `model.profile.functions`.
- Tools: `src/tools/getFindings.ts` lines 56–62 (window block), schema lines 30–50 (no `offset`, no `file`); `src/tools/listIcs.ts` lines 73–80; `src/tools/listDeopts.ts` lines 48–55; `src/tools/listFunctions.ts` (43 lines, no window params); `src/tools/shared.ts` has `paginate`, `matchesFile`, `fileFilterSchema`, `offsetSchema`, `fromMarkSchema`, `toMarkSchema`, `unknownSessionError`.
- `src/analysis/compare.ts` lines 72–75 duplicate `isUserCode` as `isUserFile`.
- Tests: `src/harness/__tests__/harness.spec.ts` already exercises `resolveWindow`/`applyWindow` on a two-case workload (`hot mega` and `clean`) generated at run time.

Conventions: additive model changes only (the `LogModel` is a public type exported from `src/index.ts`); Valibot schemas with `v.description`; tool handlers return `jsonResult(...)`; tests say why.

## Commands you will need

| Purpose                   | Command                                                                      | Expected on success |
| ------------------------- | ---------------------------------------------------------------------------- | ------------------- |
| Format + lint + typecheck | `vp check --fix`                                                             | clean               |
| Targeted tests            | `vp test src/harness/__tests__/harness.spec.ts src/__tests__/server.spec.ts` | pass                |
| All tests                 | `vp test`                                                                    | all pass            |

## Scope

**In scope**:

- `src/model/logModel.ts`, `src/parser/parseLog.ts` (tick handler and model assembly only)
- `src/analysis/window.ts`, `src/analysis/findings.ts` (export `isUserCode` only), `src/analysis/compare.ts` (import it)
- `src/tools/shared.ts`, `src/tools/getFindings.ts`, `src/tools/listIcs.ts`, `src/tools/listDeopts.ts`, `src/tools/listFunctions.ts`
- `src/harness/__tests__/harness.spec.ts`, `src/__tests__/server.spec.ts` (extend)
- `src/__tests__/sessions.spec.ts`, `src/analysis/__tests__/findings.spec.ts` (add `samples: []` to their hand-built `profile` literals; amendment of 2026-11-03 after the executor found that the required field broke them)
- `src/analysis/__tests__/window.spec.ts` (create; second amendment of 2026-11-03: the harness workload records zero ticks on fast machines, so a window test on the tick-bearing `megamorphic` workload is required to exercise the function-key round trip)
- `.bumpy/007-windowed-ticks.md` (create)

**Out of scope**:

- `get_function` and `get_map` — leave unwindowed in this plan.
- Call-tree construction (`get_profile`) — a separate direction item; keep the sample record minimal but sufficient for it (see Step 1).
- `src/sessions.ts` — memory cap unchanged.

## Git workflow

- Branch: `advisor/007-windowed-ticks` from `main`.
- Suggested commit: `Analysis: window profile ticks and share the tool windowing helper`.
- Bump file `.bumpy/007-windowed-ticks.md` with `"deoptkit": minor` and body: `fromMark/toMark windows now scope profile ticks too, so findings inside a window rank by the window's own heat; list_functions accepts fromMark/toMark; get_findings accepts offset and file.`
- Do NOT push or open a PR unless the operator instructed it. No attribution lines.

## Steps

### Step 1: Retain samples

- `src/model/logModel.ts`: add `export interface TickSample { time: number; vmState: string; /** Function key of the frame at the top of the stack, when resolved. */ self: string | undefined; /** Distinct function keys anywhere on the stack (including `self`). */ onStack: string[]; }` and `samples: TickSample[]` to `ProfileModel`. Document the key format as `${functionName}|${file}|${line}|${column}`, matching `FunctionTicks`.
- `src/parser/parseLog.ts`: in the `tick` handler, stop ignoring `_time` (rename to `time`), build the sample from the already-computed `top` and `onStack` rows (derive keys with the same template `tickRowFor` uses; extract a `functionKey(entry)` helper so the two cannot drift), push it to a `samples` array, and include `samples` in the returned `profile`.

**Verify**: `vp check --fix` → clean; `vp test src/parser/__tests__/parseLog.spec.ts` → passes (tick counts unchanged).

### Step 2: Window the profile

In `src/analysis/window.ts` `applyWindow`: filter `samples` by `inRange(time)`, then rebuild `profile` from the kept samples: `tickCount = samples.length`, `vmStates` recounted, `functions` recomputed as `FunctionTicks` rows (`selfTicks` from `self`, `totalTicks` from `onStack`), sorted by `selfTicks` descending like the parser does. The row's `functionName`/`file`/`line`/`column` come from splitting the key on `|` (file may be `undefined` when the segment is the string `undefined`; mirror how the key was built). Update the doc comment at lines 52–57 (ticks are now windowed; the map registry still passes through). While there, recompute each windowed deopt site's `inlinedCount` from the kept events (`events.filter((event) => event.inlinedAt !== undefined).length`); plan 001 added the field and `applyWindow` carried it over unwindowed, so a windowed site could report `inlinedCount > count`.

**Verify**: `vp test src/harness/__tests__/harness.spec.ts` → passes.

### Step 3: Share the window helper and extend tools

- `src/tools/shared.ts`: add `export const windowedModel = (session: Session, window: MarkWindow): LogModel | { error: string }` that returns `session.model` when both marks are undefined, else `resolveWindow` + `applyWindow` or the error object. Import types from `../sessions` and `../analysis/window`.
- Replace the inline blocks in `getFindings.ts`, `listIcs.ts`, `listDeopts.ts` with `const model = windowedModel(session, { fromMark, toMark }); if ("error" in model) return jsonResult(model, { isError: true });`.
- `listFunctions.ts`: add `fromMark`/`toMark` to the schema and use `windowedModel`; `tickCount`/`vmStates` in the response come from the windowed model.
- `getFindings.ts`: add `offset: offsetSchema` and `file: fileFilterSchema`; filter with `matchesFile(candidate.file, file)` and paginate with `offset`.
- `findings.ts`: `export const isUserCode`; `compare.ts`: delete `isUserFile` and import `isUserCode`.

**Verify**: `vp check --fix` → clean; `vp test src/__tests__/server.spec.ts` → passes.

### Step 4: Tests

- `harness.spec.ts`: add a test that windows the model to the `clean` case and asserts `windowed.profile.tickCount <= model.profile.tickCount`, `sum(selfTicks) === windowed.profile.tickCount`, every retained sample's `time` is within the window, and (when `model.profile.tickCount > 0`) the `hot mega` function's self ticks in the `clean` window are `<=` its self ticks in the full model. Keep thresholds loose: Windows samples at about 15 ms. Comment: ranking inside a case must use that case's heat, or multi-case bench sessions rank by whichever case ran longest.
- `server.spec.ts`: in the existing `profile_run … get_findings` flow, call `get_findings` with `limit: 1, offset: 1` and assert `offset === 1` and `items.length <= 1`; call with `file: "does-not-match"` and assert `items` is empty while `totalCount === 0`.

**Verify**: `vp test` → all pass.

## Test plan

- New assertions in `harness.spec.ts` (windowed ticks) and `server.spec.ts` (paging and file filter).
- Pattern: the existing tests in those files.
- Verification: `vp test` → all pass.

## Done criteria

- [ ] `vp check` exits 0
- [ ] `vp test` exits 0 with the new assertions
- [ ] `grep -rn "resolveWindow(model" src/tools` returns nothing (all tools use `windowedModel`)
- [ ] `grep -n "isUserFile" src/analysis/compare.ts` returns nothing
- [ ] `list_functions` schema (`tools/list` output) includes `fromMark` and `toMark`; `get_findings` includes `offset` and `file`
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- The `tick` handler no longer matches the excerpt (another plan changed it); re-read and reconcile, and if the sample fields cannot be derived from what the handler computes, report.
- Memory: parsing `fixtures/logs/node-26/megamorphic.log` after Step 1 retains more than 2× the heap it did before (measure with `process.memoryUsage().heapUsed` around `parseLog`; baseline is about 38 MB). Report numbers.
- The harness workload yields zero ticks on the machine (possible on fast Windows runs): make the assertions conditional on `tickCount > 0` as described, do not loosen further.

## Maintenance notes

- `samples` is the foundation for `get_profile` call trees (awaiting selection): keep `onStack` ordered innermost-first if a future change touches it, and document it in the type.
- Any new session-scoped tool must use `windowedModel`; reviewers should reject hand-rolled window blocks.
