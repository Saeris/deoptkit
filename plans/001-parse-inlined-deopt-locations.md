# Plan 001: Parse inlined deopt locations and attribute deopt sites to functions

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md` — unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat b733901..HEAD -- src/parser/parseLog.ts src/model/logModel.ts src/analysis/findings.ts src/analysis/compare.ts` and `git status --short src/parser src/model src/analysis`. If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `b733901`, 2026-11-03 (working tree also carries the uncommitted Vite+ 1.4 / Vitest 5 migration; none of this plan's files were touched by it)

## Why this matters

V8 logs a deopt that happened inside inlined code as `<file:line:col> inlined at <file:line:col>` (possibly chained). The parser's regex is anchored on both ends and uses a greedy `.+` for the file, so it "matches" by swallowing `…:10:14> inlined at <file:///…/deopt-loop.js` as the file name and taking the outermost caller's line and column. The result is a deopt site whose `file` is garbage and whose position belongs to the caller, not the deopting expression. Parsing `fixtures/workloads/deopt-loop.js` today produces a top-ranked `deopt-loop` finding (severity 28) at line 16 with a file ending in `…:10:14> inlined at <…/deopt-loop.js`, while the same loop's non-inlined events form a second site at line 10. Downstream, the LSP builds a URI from that string, the source-map resolver cannot open it, `deoptkit ci` emits a bogus `::warning file=` path, and the one deopt loop is counted as two sites of 5 and 4 instead of one of 9. Five of the eleven `code-deopt` events in that fixture are inlined; in optimized real-world code this is the common case.

Separately, deopt sites carry no `functionName` even though the `code-deopt` line's address field is the start address of the code object that deopted (verified: `0x2b65f304140` in the fixture matches a `code-creation,JS,…,0x2b65f304140,164,getX …` line), so the existing `CodeMap` can name it.

After this plan: one site per innermost deopt position, with `functionName`, the inlining chain preserved per event, and `inlinedCount` in finding evidence.

## Current state

- `src/parser/parseLog.ts` — streaming V8 log parser; the `code-deopt` handler is at lines 242–282.
- `src/model/logModel.ts` — the `LogModel` types; `DeoptEvent` and `DeoptSite` at lines 59–77.
- `src/analysis/findings.ts` — `computeFindings`; the deopt loop at lines 218–261 passes `undefined` as the function name for heat (line 228).
- `src/analysis/compare.ts` — `findingIdentity` (lines 61–67) builds `kind|file|functionName|detail`; for deopts `detail` is the sorted reason set.
- `src/parser/codeMap.ts` — `CodeMap.find(address: bigint)` resolves an address to a `CodeEntry` with `functionName`, `file`, `line`, `column`.

Excerpts (`src/parser/parseLog.ts`):

```ts
// lines 32-33
/** Deopt location field, e.g. `<file:///a/b.js:23:1>`. */
const DEOPT_LOCATION_RE = /^<(?<file>.+):(?<line>\d+):(?<column>\d+)>$/u;
```

```ts
// lines 242-282
    "code-deopt": ([
      time,
      _size,
      _address,
      _inliningId,
      _scriptOffset,
      kind,
      location,
      reason
    ]): void => {
      const match = DEOPT_LOCATION_RE.exec(location ?? "");
      if (!match?.groups)
        throw new Error(`unrecognized deopt location: ${location}`);
      const file = match.groups["file"] ?? "";
      const line = match.groups["line"] ?? "";
      const column = match.groups["column"] ?? "";
      const parsedKind = parseDeoptKind(kind ?? "");
      const siteKey = `${parsedKind}|${file}|${line}|${column}`;
      const timestamp = Number(time);
      let site = deoptSites.get(siteKey);
      if (!site) {
        site = {
          file,
          line: Number(line),
          column: Number(column),
          kind: parsedKind,
          reasons: [],
          count: 0,
          firstTime: timestamp,
          lastTime: timestamp,
          events: []
        };
        deoptSites.set(siteKey, site);
      }
      site.count += 1;
      site.lastTime = Math.max(site.lastTime, timestamp);
      site.firstTime = Math.min(site.firstTime, timestamp);
      site.events.push({ time: timestamp, reason: reason ?? "" });
      if (reason && !site.reasons.includes(reason)) site.reasons.push(reason);
    },
```

Excerpt (`src/model/logModel.ts`, lines 59–77):

```ts
export interface DeoptEvent {
  time: number;
  reason: string;
}

/** All deoptimizations observed at one source position. */
export interface DeoptSite {
  file: string;
  line: number;
  column: number;
  kind: DeoptKind;
  /** Distinct V8 bailout reasons seen here, e.g. "Insufficient type feedback for generic named access". */
  reasons: string[];
  count: number;
  firstTime: number;
  lastTime: number;
  /** Individual deopt occurrences, for time-window filtering. */
  events: DeoptEvent[];
}
```

Excerpt (`src/analysis/findings.ts`, lines 218–237):

```ts
  for (const site of model.deopts) {
    if (!isUserCode(site.file)) continue;
    const events = site.events.filter(({ reason }) => !isOsrNoise(reason));
    if (events.length === 0) continue;
    const count = events.length;
    const reasons = [
      ...new Set(
        events.map(({ reason }) => reason).filter((reason) => reason !== "")
      )
    ].sort();
    const heat = heatOf(undefined, site.file);
    if (site.kind === "eager" && count >= 2) {
      findings.push(
        finding(
          "deopt-loop",
          site,
          `${count} eager deopts at the same position (${reasons.join("; ")})`,
          score("deopt-loop", count, heat),
          { kind: site.kind, count, reasons }
        )
      );
```

Raw log lines this plan must handle (from `fixtures/logs/node-26/deopt-loop.log`, regenerate with `node fixtures/generate.mjs` if absent):

```
code-deopt,667958,256,0x2b65f304140,-1,576,deopt-eager,<file:///C:/GitHub/@saeris/deopt-mcp/fixtures/workloads/deopt-loop.js:10:14>,wrong map
code-deopt,668012,1280,0x2b65f304240,0,576,deopt-eager,<file:///C:/GitHub/@saeris/deopt-mcp/fixtures/workloads/deopt-loop.js:10:14> inlined at <file:///C:/GitHub/@saeris/deopt-mcp/fixtures/workloads/deopt-loop.js:16:12>,wrong map
```

Conventions to match: arrow-function `const` exports, no classes except where state demands it, handler arity guarded with `?? ""` (lines are typed `Array<string | undefined>` because real logs contain truncated lines, see `src/parser/logReader.ts:5-10`). Tests live in `__tests__/*.spec.ts` beside the code, generate real V8 logs with `generateWorkloadLog` from `src/parser/__tests__/helpers.ts`, and carry a comment explaining why the behavior matters (CLAUDE.md Rule 8). Markdown and comments are soft-wrapped, never hard-wrapped.

## Commands you will need

| Purpose                   | Command                                         | Expected on success                              |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------ |
| Install                   | `vp install`                                    | exit 0                                           |
| Format + lint + typecheck | `vp check --fix`                                | `Found no warnings, lint errors, or type errors` |
| All tests                 | `vp test`                                       | all files pass (56 tests before this plan)       |
| One test file             | `vp test src/parser/__tests__/parseLog.spec.ts` | that file passes                                 |
| Build                     | `vp pack`                                       | `Build complete`                                 |

## Suggested executor toolkit

- Wallaby is configured: `mcp__wallaby__wallaby_failingTests` (or `npx -y @wallabyjs/cli run --skill`) gives faster feedback than `vp test`; see `CLAUDE.md`.
- `testing-best-practices` skill when writing the new tests.

## Scope

**In scope** (the only files you should modify):

- `src/parser/parseLog.ts`
- `src/model/logModel.ts`
- `src/analysis/findings.ts`
- `src/parser/__tests__/parseLog.spec.ts`
- `src/analysis/__tests__/findings.spec.ts`
- `.bumpy/001-inlined-deopts.md` (create)

**Out of scope** (do NOT touch, even though they look related):

- `src/analysis/compare.ts` — `findingIdentity` already includes `functionName`; it starts working for deopts automatically once sites carry one. Do not change the identity format (checked-in `deoptkit ci` baselines depend on it).
- `src/tools/listDeopts.ts`, `src/tools/getFunction.ts` — they spread `DeoptSite`, so the new fields flow through without edits.
- `src/lsp/**`, `src/cli/ci.ts` — consumers of `file`; they are fixed by this plan's output, not by edits.
- Any `code-source-info` parsing (inlining tables): a separate, larger plan.

## Git workflow

- Branch: `advisor/001-inlined-deopts` from `main`.
- Commit style from `git log`: short imperative subject, e.g. `Findings: discount keyed-IC megamorphism (Valimock calibration)`. Suggested: `Parser: keep inlined deopts at their innermost position and name their function`.
- Add a bump file `.bumpy/001-inlined-deopts.md`:

  ```markdown
  ---
  "deoptkit": patch
  ---

  Deopts inside inlined code are now attributed to their innermost source position (one site per position, with the inlining chain kept per event) and carry the deopting function's name.
  ```

- Do NOT push or open a PR unless the operator instructed it. No attribution lines in commit messages.

## Steps

### Step 1: Extend the model

In `src/model/logModel.ts`:

- Add `export interface SourcePosition { file: string; line: number; column: number; }` above `DeoptEvent`.
- `DeoptEvent` gains `/** Callers this deopt was inlined into, innermost first; absent when not inlined. */ inlinedAt?: SourcePosition[];`
- `DeoptSite` gains `/** Name of the function containing this position, resolved from the code map when available. */ functionName: string | undefined;` and `/** Events whose code was inlined into a caller when they deopted. */ inlinedCount: number;`

**Verify**: `vp check` → type errors in `src/parser/parseLog.ts` only (the site literal lacks the new fields); nothing else.

### Step 2: Parse the location chain

In `src/parser/parseLog.ts`, replace `DEOPT_LOCATION_RE` (lines 32–33) with an exported helper:

```ts
const DEOPT_POSITION_RE = /^<(?<file>.+):(?<line>\d+):(?<column>\d+)>$/u;

/**
 * V8 writes a deopt location as `<url:line:col>` and, for code inlined into a
 * caller, appends ` inlined at <url:line:col>` once per inlining level. The first
 * segment is the deopting expression; the rest is the caller chain, innermost first.
 */
export const parseDeoptLocation = (
  location: string
): { site: SourcePosition; inlinedAt: SourcePosition[] } | undefined => {
  const positions: SourcePosition[] = [];
  for (const segment of location.split(" inlined at ")) {
    const match = DEOPT_POSITION_RE.exec(segment);
    if (!match?.groups) return undefined;
    positions.push({
      file: match.groups["file"] ?? "",
      line: Number(match.groups["line"]),
      column: Number(match.groups["column"])
    });
  }
  const [site, ...inlinedAt] = positions;
  return site ? { site, inlinedAt } : undefined;
};
```

Import `SourcePosition` from `../model/logModel`.

**Verify**: `vp check` → still only the site-literal error from Step 1.

### Step 3: Use it in the handler and resolve the function name

Rewrite the `code-deopt` handler (lines 242–282) so that:

- `const parsed = parseDeoptLocation(location ?? ""); if (!parsed) throw new Error(...)` (keep the throw: `readLog` counts it as a bad line rather than aborting, the existing contract).
- `siteKey` uses `parsed.site` (`kind|file|line|column`), so inlined and non-inlined events of the same expression merge into one site.
- The site is created with `functionName` and `inlinedCount: 0`; each event pushes `{ time, reason, ...(parsed.inlinedAt.length > 0 ? { inlinedAt: parsed.inlinedAt } : {}) }` and increments `inlinedCount` when inlined.
- Function name resolution, in this order: (1) when `parsed.inlinedAt.length === 0`, `codeMap.find(BigInt(address ?? "0"))?.functionName` (rename `_address` to `address`); (2) otherwise, or when (1) yields nothing, the `FunctionInfo` in `functionIndex` with the same `file` whose `(line, column)` is the greatest that is `<=` the site position (functions are compiled before they deopt, so the index is populated by then). If a later event resolves a name for a site created without one, fill it in. Keep this lookup a small local helper (`enclosingFunctionName(file, line, column)`); do not add a new index structure.

**Verify**: `vp check --fix` → clean. `vp test src/parser/__tests__/parseLog.spec.ts` → passes (existing assertions still hold).

### Step 4: Feed the function name into findings

In `src/analysis/findings.ts` line 228, change `heatOf(undefined, site.file)` to `heatOf(site.functionName, site.file)`, and add `inlinedCount: site.inlinedCount` to the evidence objects of the `deopt-loop`, `eager-deopt`, and `soft-deopt` findings. `finding(kind, site, …)` already copies `site.functionName`.

**Verify**: `vp check` → clean. `vp test src/analysis/__tests__/findings.spec.ts` → passes.

### Step 5: Tests

Add to `src/parser/__tests__/parseLog.spec.ts`:

1. A unit test for `parseDeoptLocation` using the two raw location strings quoted in "Current state": the plain one yields `inlinedAt: []`; the chained one yields `site` at line 10 column 14 and `inlinedAt[0]` at line 16 column 12, both with `file` equal to the exact URL (no `>` or `<` characters).
2. An integration test on `generateWorkloadLog("deopt-loop", dir)`: among `model.deopts` filtered to `deopt-loop.js`, exactly one `eager` site has `line === 10 && column === 14`; its `functionName` is `"getX"`, `count >= 5`, `inlinedCount >= 1`, and no deopt site's `file` includes `"inlined at"`. Comment: the deopt-loop fixture is the tool's definition of the pathology, and a loop split across inlined and non-inlined copies would be under-counted.

Extend the existing `detects the deopt loop` test in `src/analysis/__tests__/findings.spec.ts` to also assert `loop.functionName === "getX"` and `loop.file.includes("inlined at") === false`.

**Verify**: `vp test` → all pass, including the 3 new or extended assertions.

## Test plan

- New: `parseDeoptLocation` unit test (plain and chained); deopt-loop integration test (single merged site, function name, inlined count, clean file URL).
- Extended: findings deopt-loop test (function name, clean file).
- Pattern: model after the `beforeAll` + `generateWorkloadLog` structure already in `src/parser/__tests__/parseLog.spec.ts`.
- Verification: `vp test` → all files pass.

## Done criteria

- [ ] `vp check` exits 0 with no warnings
- [ ] `vp test` exits 0; the new tests exist and pass
- [ ] `grep -n "DEOPT_LOCATION_RE" src/parser/parseLog.ts` returns nothing
- [ ] `node --input-type=module -e "const m = await import('./dist/index.mjs'); const model = await m.parseLog('fixtures/logs/node-26/deopt-loop.log'); console.log(model.deopts.filter(d => d.file.includes('inlined at')).length)"` prints `0` (run `vp pack` and `node fixtures/generate.mjs` first if `dist/` or the log is missing)
- [ ] No files outside the in-scope list are modified (`git status --short`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts.
- A freshly generated `deopt-loop.log` has `code-deopt` lines whose fourth comma-separated field does not match the start address of any `code-creation` line (check with `grep`); the function-name resolution assumption would be wrong.
- The Node on the machine emits a deopt location format other than `<url:line:col>` segments joined by `inlined at`.
- The existing `compare.spec.ts` starts failing: that means the identity change affected matching and must be reviewed by the maintainer.

## Maintenance notes

- Merging inlined and non-inlined events into one site changes `count` for sites that were previously split; `deoptkit ci` baselines identify findings by kind, file, function, and reasons, not counts, so existing baselines survive.
- `inlinedAt` is per event so a later inlining-aware attribution plan can group by caller without re-parsing.
- The `enclosingFunctionName` heuristic uses function start positions only (the index has no end positions). Review: nested functions declared after the deopting expression in the same enclosing function would be chosen wrongly; acceptable until `code-source-info` ranges are parsed.
