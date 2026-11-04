# Plan 022: Stable finding identities and shape-stable parser hot paths (prerequisite for the dogfood gate)

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md` — unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**, from the repository root: `plans/README.md` shows 016, 017 and 020 as DONE; `grep -c 'const siteKey = keyed' packages/deoptkit/src/parser/parseLog.ts` → 1; `grep -c 'site.functionName}|\${site.file}' packages/deoptkit/src/analysis/findings.ts` → 1; `grep -c 'sfi?: string' packages/deoptkit/src/model/logModel.ts` → 1; `grep -c 'hard.length >= 2' packages/deoptkit/src/analysis/findings.ts` → 1; `grep -c 'vmStates\[state\]' packages/deoptkit/src/parser/parseLog.ts` → 1. On any mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MEDIUM (changes what `deopt-loop` and `map-churn` mean; both changes are covered by tests and a bump note)
- **Depends on**: plans/020-keyed-ic-sites-and-soft-feedback-deopts.md, plans/016-map-details-parsing.md, plans/014-tier-names-and-session-quality.md
- **Category**: correctness, direction
- **Planned at**: commit `64dc486`, 2026-11-03

## Why this matters

Plan 021 tried to commit a `deoptkit ci` baseline for the parser's own bench and could not: seven accumulate runs grew the baseline by one entry every time and six plain runs all failed. Three parser-level causes, all measured on `packages/deoptkit/bench/parse.bench.mjs`:

1. **Per-process symbol hashes leak into identities.** V8 prints private names and symbols as `symbol("#lineStarts" hash 3ab4a261)` or `symbol(hash 18e5b02f)` in both IC keys (403 IC lines per run) and map transition property names (188 lines per run); the hash differs on every process. The parser stores the string verbatim, so `findingIdentity` (which joins `key` or `propertyNames`) is different in every run. This also wastes agent tokens on meaningless hex.
2. **Map churn is grouped by function name, so every anonymous function in a file merges into one finding.** 373 of the 1,350 JS code entries in a bench log are anonymous (V8 names them `""`): curried arrows such as the parser's IC handler, module top-level code, class field initializers. `computeFindings` keys churn groups by `${functionName}|${file}`, so the object literals of a dozen unrelated anonymous functions in `parseLog.ts` land in one group, share property names like `file` and `line`, and trip the branching threshold. The resulting finding ("56 map transitions created in one function", function name empty) is a false positive by construction.
3. **Two eager deopts at one position is not a loop when they come from different tiers.** With Maglev on, a function climbs Ignition → Maglev → TurboFan; one "wrong map" bailout per tier is V8 learning, not instability. `CodeMap.#indexBefore` deopts once from Maglev in most runs and from both tiers in some, so it flickers between `eager-deopt` (not gated) and `deopt-loop` (gated).

Two deoptkit-internal sites also flicker in and out of the baseline: the `tick` handler's `vmStates[state]` and the `map` handler's `mapEventCounts[kind]` are keyed stores whose key set depends on which VM states the sampler happened to catch, so they are megamorphic in some runs and polymorphic in others. And `CodeEntry` objects are built in three shapes (non-JS; JS with `sfi` and `marker` assigned after construction; JS plus `source` assigned later), which is why `#indexBefore`'s `.start` load in the parser's hottest loop is polymorphic and bails out at all.

This plan fixes all five. After it, plan 021 can be re-run unchanged except for its expectations.

## Current state

Paths relative to `packages/deoptkit`. Line numbers are from commit `64dc486`.

`src/parser/parseLog.ts`:

- Line 182: `const vmStates: Record<string, number> = {};` and the `tick` handler (around line 644): `vmStates[state] = (vmStates[state] ?? 0) + 1;`. The record is placed into the model's `profile.vmStates` at the end of `parseLog`.
- The `map` handler (around line 593): `mapEventCounts[kind] = (mapEventCounts[kind] ?? 0) + 1;` where `mapEventCounts` is a `Record<string, number>` declared near line 182 and placed into `maps.eventCounts` at the end. Further down the same handler builds transition sites:

```ts
const at = eventSite(address, line, column);
const siteKey = `${at.file ?? "?"}|${at.line}|${at.column}`;
let site = transitionSites.get(siteKey);
if (!site) {
  site = {
    file: at.file,
    functionName: at.functionName,
    line: at.line,
    column: at.column,
    propertyNames: [],
    count: 0,
    events: []
  };
  transitionSites.set(siteKey, site);
}
site.count += 1;
site.events.push({
  time: timestamp,
  propertyName: name === "" ? undefined : name,
  mapAddress: to ?? ""
});
if (name && !site.propertyNames.includes(name)) site.propertyNames.push(name);
```

Above that, `entry.propertyName = name === "" ? undefined : name;` stores the same raw name on the `MapEntry`.

- `eventSite` (around line 269) returns `{ file, functionName, line, column }`: from the innermost inlined frame when the pc resolved through `code-source-info`, otherwise from `resolved.entry` (the code object's own function) with the logged line and column.
- `handleIc` (around line 373) destructures the IC line's `key` and uses it for `siteKey` (named sites), `site.key`, `site.keys` and the `siteKeys` set (keyed sites).
- The `code-creation` handler (around line 460):

```ts
const entry: CodeEntry = {
  start: BigInt(start ?? "0"),
  size: Number(size),
  kind: kind ?? "unknown",
  ...splitEntryName(name ?? "")
};
codeMap.add(entry);
if (kind !== "JS") return;
entry.sfi = sfi;
entry.marker = tierMarker;
```

and `entry.source = ...` is assigned in the `code-source-info` handler. `tierOf(marker)` (line 41) maps a marker to the `Tier` union from `src/model/logModel.ts` (line 203: `"interpreted" | "baseline" | "maglev" | "turbofan"`).

- The `code-deopt` handler (around line 528) resolves `const entry = codeMap.find(BigInt(address ?? "0"));` and pushes `{ time, reason }` events (with `inlinedAt` when inlined) onto the `DeoptSite`.

`src/model/logModel.ts`:

- `CodeEntry` (line 99): `sfi?: string | undefined;`, `marker?: string | undefined;`, `source?: SourceInfo | undefined;`.
- `DeoptEvent` (line 72): `{ time: number; reason: string; inlinedAt?: SourcePosition[] }`.
- `MapTransitionSite` (line 141): `file`, `functionName`, `line`, `column`, `propertyNames`, `count`, `events`.

`src/parser/codeMap.ts`: `#indexBefore` binary-searches `this.#entries[mid].start`; `move` rebuilds an entry with `{ ...entry, start: to }`.

`src/analysis/findings.ts`:

- Deopt classification (around lines 280–345): `hard` and `feedback` event lists per site; `if (hard.length >= 2 && site.kind === "eager")` → `deopt-loop` with evidence `{ kind, count, reasons, inlinedCount }`; `else if (hard.length === 1 && site.kind === "eager")` → `eager-deopt`; feedback events → `soft-deopt`; legacy `site.kind === "soft"` path unchanged.
- `FINDING_EXPLANATIONS["deopt-loop"].explanation` (line 60) starts "TurboFan-optimized code for this position was discarded multiple times (eager deopts)."
- Churn grouping (around line 352): `const key = \`${site.functionName}|${site.file}\`;`over`model.maps.transitionSites`, then the branching/volume thresholds and the `map-churn`finding with evidence`{ transitionCount, propertyNames, maxTransitionsPerProperty, exampleMaps }`.

`src/analysis/compare.ts` `findingIdentity` (line 61) joins `kind`, `file`, `functionName ?? ""` and a detail taken from `evidence.key`, `propertyNames`, `reasons` or `icType`.

Tests that pin current behavior: `src/analysis/__tests__/findings.spec.ts` ("computeFindings for insufficient-type-feedback deopts": `kindsFor("wrong map", "wrong map")` → `["deopt-loop"]`; the deopt-loop fixture test requires a `deopt-loop` finding at `getX` with `count >= 2`; the fixture site has at least 5 eager deopts per `src/parser/__tests__/parseLog.spec.ts`), `src/parser/__tests__/parseLog.spec.ts` (synthetic logs in "parseLog models keyed IC sites by position" show the IC line format; the real-log tests assert `vmStates` content), `src/parser/__tests__/codeMap.spec.ts` (constructs `CodeEntry` literals).

Conventions: 2-space indent, double quotes, `const` arrows, explicit return types on exported functions, `oxlint` clean, comments explain why. Soft-wrapped markdown. No attribution lines in commits.

## Commands you will need

| Purpose          | Command (repository root)                                              | Expected on success                        |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------------ |
| Install          | `vp install`                                                           | exit 0 (peer warnings are fine)            |
| Format and lint  | `vp check --fix`                                                       | no lint or type errors                     |
| Tests            | `vp test`                                                              | all pass, none skipped                     |
| One spec         | `vp -C packages/deoptkit test src/analysis/__tests__/findings.spec.ts` | `Test Files 1 passed`                      |
| Build            | `vp -C packages/deoptkit pack`                                         | `Build complete`                           |
| Bench under gate | `cd packages/deoptkit && node dist/main.mjs ci bench/parse.bench.mjs`  | prints findings; exit code irrelevant here |

## Scope

**In scope**: `packages/deoptkit/src/parser/parseLog.ts`, `src/parser/codeMap.ts` (only if the type change forces it), `src/model/logModel.ts`, `src/analysis/findings.ts`, `src/parser/__tests__/parseLog.spec.ts`, `src/parser/__tests__/codeMap.spec.ts` (literal fixes), `src/analysis/__tests__/findings.spec.ts`, any other spec whose `CodeEntry` or `DeoptEvent` literal the type checker flags, `.bumpy/022-stable-identities.md` (create).

**Out of scope**: `src/cli/ci.ts`, `src/analysis/compare.ts` (identities stay as they are; the inputs become stable), the thresholds `CHURN_BRANCH_THRESHOLD` and `CHURN_VOLUME_THRESHOLD`, `parseIcState` and `readLog` dispatch tables (their keyed sites are stable run to run and belong in the baseline), `src/analysis/window.ts`, docs, `plans/021-*.md`, the baseline itself.

## Git workflow

- Branch: `exec/plan-022` in a dedicated worktree; stay there.
- One commit: `Analysis: stable identities, per-function churn groups, tier-aware deopt loops`.
- Bump file `.bumpy/022-stable-identities.md` with `"deoptkit": minor` and body: `Finding identities are now stable across processes: V8's per-process symbol hashes are stripped from IC keys and map property names (printed as Symbol(#name)), map churn is grouped per function by position so anonymous functions and module top-level code no longer merge into one finding, and deopt-loop requires the same optimized tier to deoptimize a position twice (one Maglev plus one TurboFan bailout is warm-up and reports as eager-deopt with per-tier counts). The parser's own tick and map counters and CodeEntry construction are shape-stable.`
- Do NOT push or open a PR. No attribution lines.

## Steps

### Step 1: Normalize V8 symbol prints

In `parseLog.ts`, near `SOURCE_REF_RE`, add:

```ts
/**
 * V8 prints private names and symbols as `symbol("#count" hash 1cbf5b91)` (or
 * `symbol(hash 49c8685)` without a description); the hash is per process, so it
 * must not reach IC keys, property names or finding identities. The replacement
 * matches the `Symbol(description)` form that map-details parsing produces.
 */
const SYMBOL_PRINT_RE = /^symbol\((?:"(?<description>.*)" )?hash [0-9a-f]+\)$/u;

const normalizeV8Name = (name: string): string => {
  const match = SYMBOL_PRINT_RE.exec(name);
  return match ? `Symbol(${match.groups?.["description"] ?? ""})` : name;
};
```

Apply it in `handleIc` to the destructured `key` before any use (`const key = normalizeV8Name(rawKey ?? "")`, keeping the existing empty/undefined handling) and in the `map` handler to `name` before `entry.propertyName`, `site.events`, and `site.propertyNames` are set.

Tests, in `parseLog.spec.ts` as a new describe "parseLog strips per-process symbol hashes" using a synthetic log in the style of the keyed-site tests: one `LoadIC` line whose key is `symbol("#count" hash 1cbf5b91)`, one `KeyedLoadIC` line whose key is `symbol(hash 49c8685)`, and one `map,Transition,...` line (shape: `map,Transition,<time>,<from>,<to>,<pc>,<line>,<column>,,<name>` with a pc inside the code-creation entry's range) whose name is `symbol("#lineStarts" hash 3ab4a261)`. Assert `key === "Symbol(#count)"`, `keys` contains `"Symbol()"`, and the transition site's `propertyNames` equals `["Symbol(#lineStarts)"]`, with a comment saying why (identities and agent output must not change between processes).

**Verify**: `vp -C packages/deoptkit test src/parser/__tests__/parseLog.spec.ts` → all pass.

### Step 2: Group map churn per function by position

- `logModel.ts` `MapTransitionSite`: add `functionLine: number | undefined;` and `functionColumn: number | undefined;` after `functionName`, documented as "Start position of the enclosing function (the code object's, or the inlined function's), so churn can be grouped per function even when the function is anonymous."
- `parseLog.ts` `eventSite`: return `functionLine` and `functionColumn` alongside `functionName` (from `frame.line`/`frame.column` on the inlined path, `resolved?.entry.line`/`column` otherwise). Set both on new transition sites. IC sites do not change.
- `findings.ts` churn grouping: `const key = \`${site.functionName}|${site.file}|${site.functionLine}|${site.functionColumn}\`;`. The finding's `functionName` and anchor stay as they are, so identities keep their current form.
- Fix every `MapTransitionSite` literal the type checker flags in specs (add the two fields).

Test, in `findings.spec.ts`: build a `LogModel` (reuse `modelWith` from the keyed-site describe) with two transition sites in one file, both `functionName: ""`, at different `functionLine`s, each with events for the same three property names from one parent each (`transitionsPerName` would be 2 per name if merged, 1 if split). Assert no `map-churn` finding; then the same two sites with equal `functionLine`/`functionColumn` and a third site, so one name reaches `CHURN_BRANCH_THRESHOLD`, yields exactly one. The comment must say that anonymous functions and module top-level code share the empty name and must not pool their transitions.

**Verify**: `vp check --fix` clean; `vp -C packages/deoptkit test src/analysis/__tests__/findings.spec.ts` → all pass.

### Step 3: Tier-aware deopt loops

- `logModel.ts` `DeoptEvent`: add `tier?: Tier;` documented as "Optimization tier of the code that bailed out, from the code object's marker; absent when the code object is unknown."
- `parseLog.ts` `code-deopt` handler: `tier: entry === undefined ? undefined : tierOf(entry.marker)` on each pushed event (keep `inlinedAt` handling as is).
- `findings.ts`: replace the `hard.length >= 2` rule. Count `hard` events per tier (`undefined` tier counts as its own bucket `"unknown"`); `const repeats = Math.max(0, ...counts)`; `deopt-loop` when `repeats >= 2 && site.kind === "eager"`, otherwise `eager-deopt` when `hard.length >= 1 && site.kind === "eager"` (the summary says `${hard.length} eager deopt(s): ...` with the count when above one). Add `tiers: Record<string, number>` to the evidence of both. Update the `deopt-loop` explanation to: "The same optimized tier (Maglev or TurboFan) discarded its code for this position more than once: V8 re-optimized with the new type feedback and still bailed out. Each cycle wastes compilation work and runs deoptimized code until V8 re-optimizes; repeated offenders can be permanently disabled from optimization." Keep the suggested fix. Add to the `eager-deopt` explanation: " One bailout per tier while a function climbs Ignition → Maglev → TurboFan is normal warm-up."
- Tests in `findings.spec.ts`: extend the `deoptSite` helper to accept events with tiers. Cases: two "wrong map" from `turbofan` → `["deopt-loop"]`; one `maglev` plus one `turbofan` "wrong map" → `["eager-deopt"]` with `evidence.count === 2` and `evidence.tiers` equal to `{ maglev: 1, turbofan: 1 }`; the existing feedback cases unchanged. The fixture test ("detects the deopt loop") must still pass as written.

**Verify**: `vp -C packages/deoptkit test src/analysis/__tests__/findings.spec.ts src/parser/__tests__/parseLog.spec.ts` → all pass. If the deopt-loop fixture test fails because the fixture's deopts no longer repeat within one tier, STOP and report the per-tier counts.

### Step 4: Shape-stable parser counters

In `parseLog.ts` make `vmStates` and `mapEventCounts` `Map<string, number>` during parsing (`counts.set(key, (counts.get(key) ?? 0) + 1)`), and convert with `Object.fromEntries(...)` where the model is assembled, so `ProfileModel.vmStates` and `maps.eventCounts` keep their `Record<string, number>` types and the existing tests keep passing.

**Verify**: `grep -c 'vmStates\[' packages/deoptkit/src/parser/parseLog.ts` → 0; `grep -c 'mapEventCounts\[' packages/deoptkit/src/parser/parseLog.ts` → 0; `vp -C packages/deoptkit test src/parser/__tests__/parseLog.spec.ts` → all pass.

### Step 5: One shape for CodeEntry

In `logModel.ts` make `sfi`, `marker` and `source` required with `| undefined` (drop the `?`). In the `code-creation` handler build the entry in one literal with `sfi: undefined, marker: undefined, source: undefined` after the spread (declaration order is the shape), and keep the later assignments. Fix every literal the type checker flags (`codeMap.spec.ts`, any other spec). `move`'s spread keeps the order and needs no change.

**Verify**: `vp check --fix` clean; `vp test` → all pass.

### Step 6: Measure on the bench, then commit

Build (`vp -C packages/deoptkit pack`), then from `packages/deoptkit` run `node dist/main.mjs ci --out-dir "$TMP/deopt-022" bench/parse.bench.mjs` twice with a fresh out dir (first run writes a baseline, second compares; use a scratch directory outside the repo and delete it afterwards). Record in NOTES: the number of baseline entries, whether any identity contains `hash`, whether any `map-churn` entry has an empty function name, and whether the second run printed `NEW finding(s)`. Do not commit a baseline.

Create the bump file, run `vp check --fix` and `vp test`, and commit.

**Verify**: `git show --stat HEAD` lists only in-scope files; `git status --short` clean.

## Done criteria

- [ ] No IC key or map property name in a parsed model contains `hash` (Step 1 test)
- [ ] Churn groups are keyed by function position; the new spec proves anonymous functions do not pool (Step 2)
- [ ] `deopt-loop` requires two bailouts from one tier; one-per-tier reports as `eager-deopt` with `tiers` evidence; the fixture loop is still detected (Step 3)
- [ ] No keyed stores on `vmStates` or `mapEventCounts` in the parser (Step 4)
- [ ] `CodeEntry` is one shape (Step 5)
- [ ] `vp check` and `vp test` exit 0; bump file present; one commit
- [ ] `plans/README.md` status row updated (skip if your reviewer maintains the index)

## STOP conditions

- The drift check fails.
- The deopt-loop fixture no longer yields a `deopt-loop` finding after Step 3.
- A symbol print in a fixture log does not match `SYMBOL_PRINT_RE` (report the exact line).
- The Step 6 second run reports NEW findings whose identities contain `hash` or an empty function name with `map-churn`.

## Maintenance notes

- Plan 021 re-runs after this lands; its Step 1 expectations change: no `|tick|` entries, no `hash` in any identity, no `#indexBefore` deopt-loop.
- If V8 changes its symbol print format, the Step 1 test fails loudly; extend `SYMBOL_PRINT_RE` rather than loosening the test.
- A future change that adds a field to `CodeEntry` must add it to the construction literal, or the `#indexBefore` load goes polymorphic again; the dogfood gate will catch that as a new `eager-deopt` only if it loops, so review for it.
