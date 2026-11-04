# Plan 014: Readable optimization tiers and session quality warnings (cold runs, no ticks, no user code)

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md` — unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1bfded1..HEAD -- packages/deoptkit/src/tools/loadLog.ts packages/deoptkit/src/tools/profileRun.ts packages/deoptkit/src/tools/loadManifest.ts packages/deoptkit/src/tools/getFunction.ts` must print nothing; plans 016, 017, and 020 may run concurrently and touch other parts of `parseLog.ts`, `logModel.ts`, `findings.ts`, and `getFindings.ts`, so for those files compare only the excerpts below and STOP on a mismatch there.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/015-inlining-aware-attribution.md
- **Category**: dx (agent accuracy)
- **Planned at**: commit `1bfded1`, 2026-11-03

## Why this matters

Two things make agents waste iterations today. First, `get_function` reports `optimizationTiers: [10, 11, 13]`: V8's internal `CodeKind` numbers, which shift between V8 versions and mean nothing to a reader; the stable information is the tier marker V8 writes on every `code-creation` line (`~` interpreted, `^` baseline, `+` Maglev, `*` TurboFan), which plan 015 now captures. Second, nothing tells an agent that a session is worthless: a workload that ran for a few milliseconds has no profiler ticks, a workload that never warmed up has no function in an optimizing tier, and a wrong `cwd` or command produces a log with no user code at all. The server's instructions say "warm-up matters", but the data to check it is in the model and never surfaced, so agents chase findings from cold runs. A `quality` block on every session-creating response, and a warning on `get_findings` when it is degraded, turns the rule into a check.

## Current state

Paths relative to `packages/deoptkit/`, at `1bfded1`.

- `src/parser/parseLog.ts` lines 395–451, the `code-creation` handler (after plan 015): destructures `[kind, kindNum, time, start, size, name, sfi, tierMarker]`, stores `entry.marker = tierMarker` for `JS` entries, and maintains `functionIndex`:

  ```ts
  if (entry.file === undefined || entry.line === undefined) return;
  const key = `${entry.functionName}|${entry.file}|${entry.line}|${entry.column}`;
  let info = functionIndex.get(key);
  if (!info) {
    info = {
      functionName: entry.functionName,
      file: entry.file,
      line: entry.line,
      column: entry.column ?? 0,
      tiers: [],
      codeCreations: 0
    };
    functionIndex.set(key, info);
  }
  info.codeCreations += 1;
  const tier = Number(kindNum);
  if (!info.tiers.includes(tier)) info.tiers.push(tier);
  ```

- `src/model/logModel.ts` lines 194–202, `FunctionInfo { functionName; file; line; column; /** code-creation kind numbers observed — each optimization tier logs its own creation. */ tiers: number[]; codeCreations: number; }`; `CodeEntry.marker` (line 109) documents the marker alphabet: `~` interpreted, `^` baseline, `+` Maglev, `*` TurboFan, `o` prefix for OSR, trailing `'` for context-specialized. Observed in the fixtures: `~`, `^`, `+'`, `*'`, `o*`, `o+`, and an empty marker (V8 writes nothing for interpreted code whose optimization is disabled).
- `src/tools/getFunction.ts` line 145: `optimizationTiers: fn?.tiers`.
- `src/tools/loadLog.ts` lines 13–32 (`LoadOutcome` with `counts`, `markers`, `warnings`) and 58–77 (the returned outcome); `src/tools/profileRun.ts` lines 113–134 (the same fields plus `exit`, after plan 012 also `comparison`); `src/tools/loadManifest.ts` spreads `loadLogFile` outcomes.
- `src/tools/getFindings.ts` (after plan 013): loops over sessions, returns `{ ...page, items, kinds }`.
- `src/analysis/findings.ts` line 30: `isUserCode(file)` (after plan 018 it normalizes backslashes).
- `src/parser/__tests__/parseLog.spec.ts`: the megamorphic describe asserts `fn?.tiers.length >= 2` for `getX` (test "captures script sources and a function index"); the deopt-loop describe exists; the synthetic inlining describe writes `code-creation` lines with markers `~` and `*`.
- `src/__tests__/server.spec.ts`: `profile_run` test on `map-churn.js`; a `textPayload` helper.
- Fixture facts: in `deopt-loop.log` the function `hot` is created with marker `*'` (TurboFan) and `getX` with `+'`; in `megamorphic.log` the top-level script code is `o*` (OSR TurboFan) and `getX` reaches `+'`.

Conventions: tests say why; soft-wrapped markdown; tool outputs through `jsonResult`.

## Commands you will need

| Purpose                   | Command                                                                                                                                  | Expected on success |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Install                   | `vp install`                                                                                                                             | exit 0              |
| Format + lint + typecheck | `vp check --fix`                                                                                                                         | clean               |
| Specs                     | `vp -C packages/deoptkit test src/parser/__tests__/parseLog.spec.ts src/analysis/__tests__/quality.spec.ts src/__tests__/server.spec.ts` | pass                |
| All tests                 | `vp test`                                                                                                                                | all pass            |

## Scope

**In scope** (relative to `packages/deoptkit/`):

- `src/parser/parseLog.ts` (the `code-creation` handler's tier bookkeeping only), `src/model/logModel.ts` (`FunctionInfo`)
- `src/analysis/quality.ts` (create), `src/analysis/__tests__/quality.spec.ts` (create)
- `src/tools/loadLog.ts`, `src/tools/profileRun.ts`, `src/tools/getFindings.ts`, `src/tools/getFunction.ts`
- `src/server.ts` (one sentence in the instructions)
- `src/parser/__tests__/parseLog.spec.ts`, `src/__tests__/server.spec.ts`
- `README.md` (package; one sentence in the "Warm-up matters" note)
- `.bumpy/014-quality.md` (repository root; create)

**Out of scope**:

- `src/tools/loadManifest.ts` (it spreads `loadLogFile`'s outcome and inherits `quality`).
- Severity scoring; `quality` informs, it does not rank.
- The `tick`, `map`, `handleIc` handlers (plans 017, 016, 020).

## Git workflow

- Branch: `exec/plan-014` in a dedicated worktree; stay there.
- One commit: `Analysis: tier names from V8 markers and session quality warnings`.
- Bump file `.bumpy/014-quality.md`:

  ```markdown
  ---
  "deoptkit": minor
  ---

  Functions now report their optimization tiers by name (interpreted, baseline, maglev, turbofan, plus an OSR flag) instead of V8's internal kind numbers. `profile_run`, `load_log`, and `load_manifest` return a `quality` block (user-code ticks, optimized user functions, user IC sites) with warnings for cold runs, runs without profiler ticks, and runs that observed no user code; `get_findings` repeats those warnings so a worthless session is never mistaken for a clean one.
  ```

- Do NOT push or open a PR. No attribution lines.

## Steps

### Step 1: Tier names

In `src/model/logModel.ts` add `export type Tier = "interpreted" | "baseline" | "maglev" | "turbofan";` and change `FunctionInfo.tiers` to `/** Optimization tiers observed for this function, from the code-creation markers, in first-seen order. */ tiers: Tier[];` plus `/** True when any tier was entered through on-stack replacement (an `o` marker prefix). */ osr: boolean;`.

In `src/parser/parseLog.ts` add a module-level helper:

```ts
/** V8's code-creation marker → tier. An empty marker is interpreted code whose optimization V8 disabled. */
const tierOf = (marker: string | undefined): Tier => {
  const core = (marker ?? "").replace(/^o/u, "").replace(/'$/u, "");
  switch (core) {
    case "^":
      return "baseline";
    case "+":
      return "maglev";
    case "*":
      return "turbofan";
    default:
      return "interpreted";
  }
};
```

and in the handler replace the two `tier` lines with `const tier = tierOf(tierMarker); if (!info.tiers.includes(tier)) info.tiers.push(tier); if (tierMarker?.startsWith("o")) info.osr = true;` (initialize `osr: false`). `kindNum` becomes unused: rename it `_kindNum` in the destructuring.

In `src/tools/getFunction.ts`: `optimizationTiers: fn?.tiers, osr: fn?.osr`.

**Verify**: `vp check --fix` → clean; `vp -C packages/deoptkit test src/parser/__tests__/parseLog.spec.ts` → passes (the `tiers.length >= 2` assertion still holds).

### Step 2: Quality

Create `src/analysis/quality.ts`:

```ts
import { isUserCode } from "./findings";
import type { LogModel } from "../model/logModel";

export interface QualityWarning { code: "no-ticks" | "cold" | "no-user-code"; message: string; }

export interface SessionQuality {
  totalTicks: number;
  /** Samples whose innermost frame is user code. */
  userCodeTicks: number;
  userFunctions: number;
  /** User functions that reached Maglev or TurboFan. */
  userFunctionsOptimized: number;
  userIcSites: number;
  warnings: QualityWarning[];
}

export const sessionQuality = (model: LogModel): SessionQuality
```

Compute from `model.functionIndex` (user = `isUserCode(info.file)`; optimized = `tiers` includes `maglev` or `turbofan`), `model.ics` (user sites), and `model.profile.functions` (`userCodeTicks` = sum of `selfTicks` over rows with `isUserCode(row.file)`). Warnings, in this order:

- `no-user-code` when `userFunctions === 0 && userIcSites === 0`: "No user code was observed: only node: internals and dependencies ran. Check the command, its cwd, and that the workload actually executes your code."
- `cold` (only when user code exists) when `userFunctionsOptimized === 0`: "No user function reached an optimizing tier (Maglev or TurboFan): V8 never optimized this workload, so inline-cache states reflect warm-up, not steady state. Run the hot code thousands of times (observed() from deoptkit/harness) before trusting findings."
- `no-ticks` when `model.profile.tickCount === 0`: "No profiler ticks were recorded: the run was shorter than one sampling interval (about 1 ms on Linux and macOS, about 15 ms on Windows), so findings cannot be ranked by heat."

Create `src/analysis/__tests__/quality.spec.ts`: synthetic models (copy the literal shape from `src/__tests__/sessions.spec.ts`'s `emptyModel`, adding `functionIndex` entries) covering each warning and a healthy model (one user function with `tiers: ["interpreted", "turbofan"]`, ticks, an IC site → no warnings); plus a fixture test on `generateWorkloadLog("deopt-loop", dir)` asserting no `cold` and no `no-user-code` warning and `userFunctionsOptimized >= 1` (the fixture's `hot` is TurboFan code by construction: its deopts need optimized code). Comments: an agent reading findings from a cold run optimizes warm-up artifacts; the healthy case guards against a warning that fires on every run.

**Verify**: `vp -C packages/deoptkit test src/analysis/__tests__/quality.spec.ts` → passes.

### Step 3: Surface it

- `src/tools/loadLog.ts`: add `quality: SessionQuality` to the success `LoadOutcome` and `quality: sessionQuality(model)` to the returned object. `load_manifest` inherits it.
- `src/tools/profileRun.ts`: add `quality: sessionQuality(model)` next to `counts`.
- `src/tools/getFindings.ts`: for each session, compute `sessionQuality(windowedModelOrModel)`; when any session has warnings, add `qualityWarnings: Array<{ sessionId; code; message }>` to the response (omit the field when empty, so single-session healthy responses are unchanged). Use the unwindowed `session.model` for quality (a window can legitimately contain no ticks).
- `src/server.ts` instructions, after the "Warm-up matters" paragraph: "Every profile_run/load_log response carries `quality.warnings`; a `cold` or `no-ticks` warning means the findings describe warm-up, not steady state, and the workload needs more iterations before they are worth acting on."
- Package `README.md`, the "Warm-up matters" note: add "The server flags cold runs: `profile_run` and `load_log` return `quality.warnings` when no user function reached an optimizing tier or no profiler ticks were recorded."

**Verify**: `vp check --fix` → clean.

### Step 4: Tests

- `src/parser/__tests__/parseLog.spec.ts`: in the deopt-loop describe add a test that the `hot` function's `tiers` contains `"turbofan"` and `getX`'s contains `"maglev"` or `"turbofan"` (comment: V8's kind numbers shift between versions; the marker alphabet does not, and agents read these names); in the synthetic inlining describe, assert `functionIndex` for `hot` has `tiers: ["turbofan"]` and `getX` `["interpreted"]`, `osr: false`. Add a small synthetic log with markers `o*`, `+'`, `^`, and an empty marker for four functions and assert their tiers and `osr`.
- `src/__tests__/server.spec.ts`: in the `profile_run` test assert `payload.quality` has numeric `totalTicks` and `userFunctionsOptimized >= 1` and no `cold` warning (the map-churn workload runs 1e5 iterations; if this proves flaky on the Windows lane, assert only the block's shape and move the `cold` absence to the deopt-loop fixture in `quality.spec.ts`, and say so in NOTES). Add a test: `profile_run` on `["node", "-e", "1 + 1"]` succeeds (it may produce no user code) and its `quality.warnings` codes include `no-user-code` or `cold`; then `get_findings` on that session returns `qualityWarnings` with the same codes. Comment: a worthless session must announce itself where the agent looks first.

**Verify**: the specs pass; `vp test` → all pass; `vp -C packages/deoptkit pack` → `Build complete`.

## Test plan

- New `quality.spec.ts`; extended `parseLog.spec.ts` and `server.spec.ts`.
- Verification: `vp test` → all pass.

## Done criteria

- [ ] `vp check` and `vp test` exit 0; `vp -C packages/deoptkit pack` exits 0
- [ ] `grep -n "kindNum" packages/deoptkit/src/parser/parseLog.ts` finds only the `_kindNum` destructuring (the number is no longer stored)
- [ ] `grep -n "quality" packages/deoptkit/src/tools/loadLog.ts packages/deoptkit/src/tools/profileRun.ts packages/deoptkit/src/tools/getFindings.ts` finds all three
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated (skip if your reviewer maintains the index)

## STOP conditions

- The `code-creation` handler excerpt does not match (plan 015 must have landed; plans 016/017/020 do not touch this handler).
- The deopt-loop fixture's `hot` has no `turbofan` tier in your run; report the markers seen (`grep "hot file" <log>`).
- `getFindings.ts` has changed shape beyond plan 013's version in a way that prevents adding `qualityWarnings` cleanly; report.

## Maintenance notes

- `Tier` names are the public vocabulary; if V8 adds a tier marker, extend `tierOf` and the union together.
- `quality` is computed on demand (cheap: one pass over `functionIndex` and `profile.functions`); do not cache it on the session.
- The thresholds are binary on purpose (zero optimized functions, zero ticks); calibrate finer warnings only with real data.
