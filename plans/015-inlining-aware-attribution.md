# Plan 015: Attribute ICs, ticks, and map transitions through V8's inlining tables (`code-source-info`)

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md` — unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 4e0de7e..HEAD -- packages/deoptkit/src/parser packages/deoptkit/src/model packages/deoptkit/src/analysis/findings.ts packages/deoptkit/src/analysis/__tests__/findings.spec.ts packages/deoptkit/src/__tests__/sessions.spec.ts packages/deoptkit/src/vitest/__tests__/preset.e2e.spec.ts packages/deoptkit/docs` and compare the excerpts under "Current state" with the live files. Plans 011–014 may have landed in between and touch `src/tools/**`, `src/cli/**`, and `src/analysis/findings.ts` (plan 013/014 may add fields to tool outputs); differences confined to those are expected. On a mismatch inside `src/parser/**` or `src/model/**`, STOP.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans/010-yarn-workspace-conversion.md
- **Category**: correctness
- **Planned at**: commit `4e0de7e`, 2026-11-03

## Why this matters

When TurboFan or Maglev inlines a callee into its caller, every event V8 logs for the inlined code carries the caller's code address. deoptkit resolves events by address through the code map, so today:

- IC events from an inlined site are attributed to the caller's function, and their logged line/column are the callee's script offset looked up in the caller's script. In the same file that happens to give the right line; across files it points at a random position in the caller. The audit reproduced this on the vitest preset in native-ESM mode: the inlined copy of `getX`'s megamorphic load appeared as a second, higher-ranked finding on `probe.bench.ts` (severity 66) next to the real one in `lib.ts` (35). `docs/recipes.md` documents the ghost as a known caveat and `src/vitest/__tests__/preset.e2e.spec.ts` lines 167–171 deliberately refrain from asserting its absence.
- Profiler ticks inside inlined code count as self time of the caller. On the `megamorphic` fixture (probe run 2026-11-03 against `fixtures/logs/node-26/megamorphic.log`), 7 of the 16 user-code ticks fall inside `getX` inlined into the top-level OSR loop, so `getX` shows zero self ticks and the findings engine papers over it with a file-level heat fallback (`src/analysis/findings.ts` lines 153–159), which also inflates every other finding in a hot file.
- Map transition sites attributed by pc have the same caller bias.

V8 logs everything needed to undo this: every `code-creation` line ends with the function's SharedFunctionInfo address, and `--log-source-code` emits a `code-source-info` line per code object with a code-offset → script-offset table that names the inlining id of each position, an inlining table mapping ids to inlined functions and call sites, and the SharedFunctionInfo addresses of the inlined functions. The fixtures contain 74–96 such lines each; the parser currently counts them as unknown commands. V8's own JavaScript tools decode only the `C<offset>O<offset>` pairs and ignore the inlining tables, so the decoder below is original work from the format V8 writes (`src/logging/log.cc`, `LogSourceCodeInformation`), not a port.

## Current state

Paths are relative to `packages/deoptkit/`.

- `src/parser/parseLog.ts`:
  - lines 265–302, the `code-creation` handler, destructures `[kind, kindNum, time, start, size, name]` and ignores the two trailing fields (SharedFunctionInfo address, optimization marker). It calls `codeMap.add(entry)` and maintains `functionIndex` keyed by `${functionName}|${file}|${line}|${column}`.
  - lines 303–305, `script-source`: `([, url, source]) => scripts.set(normalizeScriptUrl(url), source)`; the script id (first field) is dropped.
  - lines 222–255, `handleIc`: `const code = codeMap.find(BigInt(pc))`; site key `${type}|${code?.file ?? "?"}|${line}|${column}|${key}`; `file: code?.file`, `functionName: code?.functionName`, `line: Number(line)`, `column: Number(column)`.
  - lines 307–356, `code-deopt`: ignores `_inliningId` and `_scriptOffset`; `functionName` comes from `codeMap.find(address)` for non-inlined deopts and from the `enclosingFunctionName` heuristic (lines 150–167, "the index has no end positions, so this is a heuristic") otherwise.
  - lines 362–395, `map`: `const code = codeMap.find(address)`; site keyed `${code?.file ?? "?"}|${line}|${column}`.
  - lines 399–433, `tick`: `const top = codeMap.find(previous)`; `tickRowFor(top).selfTicks += 1`; `onStack` built from `functionKey(entry)` for each stack address; `samples.push({ time, vmState, self: top ? functionKey(top) : undefined, onStack: [...onStack.keys()] })`.
  - lines 170–172, `functionKey(entry) = \`${entry.functionName}|${entry.file}|${entry.line}|${entry.column}\``.
  - lines 447–475, the returned `LogModel` (`codeEntryCount: codeMap.count`, `warnings`).
- `src/parser/codeMap.ts` (79 lines): `add`, `find(address)` (containing range), `move`, `delete`; no lookup by exact start address.
- `src/parser/csv.ts`: fields are split on `,`; `\n`, `\\`, `\xNN`, and `\uNNNN` escapes are decoded, so a synthetic log line may contain `\n` (two characters) inside a field to encode a newline.
- `src/model/logModel.ts`: `CodeEntry { start: bigint; size: number; kind: string; functionName: string; file?; line?; column? }` (lines 92–101); `IcSite` (41–55); `DeoptSite` (73–89); `TickSample { time; vmState; self; onStack }` (163–170); `LogModel` (205–219) with `codeEntryCount` and `warnings`.
- `src/analysis/findings.ts` lines 138–159:

  ```ts
  export const computeFindings = (model: LogModel): Finding[] => {
    const totalSelfTicks = Math.max(
      1,
      model.profile.functions.reduce((sum, row) => sum + row.selfTicks, 0)
    );
    const heatByFunction = new Map<string, number>();
    const heatByFile = new Map<string, number>();
    for (const row of model.profile.functions) {
      const share = row.selfTicks / totalSelfTicks;
      const key = `${row.functionName}|${row.file}`;
      heatByFunction.set(key, (heatByFunction.get(key) ?? 0) + share);
      if (row.file !== undefined) {
        heatByFile.set(row.file, (heatByFile.get(row.file) ?? 0) + share);
      }
    }
    // Inlining attributes ticks to the caller, so a site's own function often shows no
    // heat even when it dominates the profile; the file-level share is the fallback.
    const heatOf = (functionName: string | undefined, file: string): number =>
      Math.max(
        heatByFunction.get(`${functionName}|${file}`) ?? 0,
        heatByFile.get(file) ?? 0
      );
  ```

- Tests that build `LogModel` literals and must gain any new required field: `src/analysis/__tests__/findings.spec.ts` lines 31–45 and `src/__tests__/sessions.spec.ts` lines 5–21 (`emptyModel`).
- `src/vitest/__tests__/preset.e2e.spec.ts` lines 167–171 (comment) and 172–188 (the native-mode test that finds the `lib.ts` site but does not assert the absence of a `probe.bench.ts` copy); lines 86–109 (module-runner test with the same shape).
- `docs/recipes.md`, "Vitest bench mode", last sentence of the `nativeEsm` paragraph: "One caveat for now: when V8 inlines a hot call site into its caller, the inlined copy of the site can be reported in the caller's file as well as the original, so the same property access may appear twice."

The log format (V8 `src/logging/log.cc`, verified against `fixtures/logs/node-26/*.log` on 2026-11-03):

- `code-creation,JS,<kind>,<time>,<address>,<size>,<name> <url>:<line>:<col>,<sfi>,<marker>`; e.g. `code-creation,JS,13,671755,0x2b65f2c4a40,676,hot file:///C:/.../deopt-loop.js:13:13,0x2fcf93e4cd0,*'`. `<sfi>` is the SharedFunctionInfo address, stable across the function's tiers (the same `0x15f6acd85e0` appears on the `^` and `+'` entries of `isPathSeparator`). Non-JS code-creation lines (`Builtin`, `RegExp`, …) have no sfi field.
- `sfi-move,<from>,<to>`: a SharedFunctionInfo was moved by GC (none in the fixtures; real logs can contain them).
- `script-source,<scriptId>,<url>,<source>`: emitted once per script before the first `code-source-info` that references it.
- `code-source-info,<address>,<scriptId>,<startPos>,<endPos>,<positions>,<inlining>,<inlinedSfis>`, written immediately after the `code-creation` line of the same `<address>`:
  - `<positions>`: a concatenation of `C<codeOffset>O<scriptOffset>` tokens, each optionally followed by `I<inliningId>`; code offsets ascend. Example from `deopt-loop.log`: `C343O2103I0C343O2127I0C363O2127I0...C454O2103I1...`. For baseline code the `C` values are pc offsets; for interpreted code they are bytecode offsets, and the `code-creation` address/size of an interpreted entry is the bytecode array, so `pc - start` is directly comparable in every tier.
  - `<inlining>`: `F<functionIndex>O<scriptOffset>` tokens, each optionally followed by `I<parentInliningId>`; the token index is the inlining id. `<functionIndex>` may be empty (unknown function). `O` is the call-site offset in the parent (the enclosing inlined function when `I` is present, else the code object's own function). Example: `F0O664F0O621`.
  - `<inlinedSfis>`: `S<sfiAddress>` tokens; the token index is the `<functionIndex>` above. Example: `S0x2fcf93e4c88`.
  - A code object without inlining has empty `<inlining>` and `<inlinedSfis>` fields (`,,` at the end).
- `LoadIC,<pc>,<time>,<line>,<column>,<old>,<new>,<map>,<key>,<modifier>,<slowReason>`: V8 computes `<line>/<column>` by taking the frame's `pc`, finding the last `positions` entry whose code offset is at or below `pc - start`, and resolving that entry's **script offset against the caller's script** regardless of inlining. The position is 1-based; `obj.x` logs the column of `x`.
- `tick,<pc>,<time>,<isExternal>,<tosOrExternal>,<vmState>,<stack...>`: `<pc>` is the top of stack; stack addresses are absolute or `+n`/`-n` relative to the previous one (`parseStackAddress`).
- `code-deopt,<time>,<size>,<address>,<inliningId>,<scriptOffset>,<kind>,<location>,<reason>`: `<inliningId>` is `-1` for the code object's own function, else an index into that object's inlining table.
- Script offsets are UTF-16 code-unit offsets into the script source; line N (1-based) starts after the (N-1)th `\n`; column is 1-based.

Probe results (2026-11-03, script in the reviewer's scratchpad, not committed): on `megamorphic.log` 16 user-code ticks land in the OSR'd top-level code (`o*` marker); decoding the inlining tables resolves 7 of them to `getX`. On `deopt-loop.log` all 6 user-code `LoadIC` events are logged from non-inlined `getX` tiers (no inlined IC events), and `hot`'s optimized code has inlining tables naming `getX`'s sfi.

Conventions: parser handlers are closures inside `parseLog`; tests use `generateWorkloadLog` for real logs and `writeFile` for synthetic ones (see `src/parser/__tests__/parseLog.spec.ts`, "parseLog with loader query strings"); every test states why the behavior matters; markdown soft-wrapped.

## Commands you will need

| Purpose                   | Command                                                                | Expected on success            |
| ------------------------- | ---------------------------------------------------------------------- | ------------------------------ |
| Install                   | `vp install` (repository root)                                         | exit 0                         |
| Format + lint + typecheck | `vp check --fix`                                                       | clean                          |
| Parser spec               | `vp -C packages/deoptkit test src/parser/__tests__/parseLog.spec.ts`   | passes                         |
| Findings spec             | `vp -C packages/deoptkit test src/analysis/__tests__/findings.spec.ts` | passes                         |
| E2E spec                  | `vp -C packages/deoptkit test src/vitest/__tests__/preset.e2e.spec.ts` | passes (runs `vp pack` itself) |
| All tests                 | `vp test`                                                              | all pass                       |

## Scope

**In scope** (relative to `packages/deoptkit/`):

- `src/parser/parseLog.ts`, `src/parser/codeMap.ts`, `src/parser/sourceInfo.ts` (create: decoder + position resolution), `src/parser/__tests__/parseLog.spec.ts`, `src/parser/__tests__/sourceInfo.spec.ts` (create)
- `src/model/logModel.ts`
- `src/analysis/findings.ts`, `src/analysis/__tests__/findings.spec.ts`
- `src/__tests__/sessions.spec.ts` (only the `emptyModel` literal)
- `src/vitest/__tests__/preset.e2e.spec.ts`
- `docs/recipes.md` (remove the caveat sentence), `THIRD_PARTY_NOTICES.md` (no change expected; see Step 1)
- `.bumpy/015-inlining.md` at the repository root (create)

**Out of scope**:

- `src/analysis/window.ts` and `src/tools/**`: sample and row shapes do not change; windowing keeps working.
- `src/analysis/compare.ts`: identities are unaffected.
- Line-level tick counts inside `get_function` (SPEC §4): deferred to plan 017, which builds on the frames this plan resolves.
- Any change to how deopt _positions_ are parsed (`parseDeoptLocation` stays the source of the site position); only the deopt's `functionName` resolution changes.

## Git workflow

- Branch: `exec/plan-015` in a dedicated worktree; stay there.
- One commit: `Parser: resolve inlined positions through code-source-info for ICs, ticks, maps, and deopts`.
- Bump file `.bumpy/015-inlining.md`:

  ```markdown
  ---
  "deoptkit": minor
  ---

  The parser now decodes V8's `code-source-info` inlining tables: inline-cache events, profiler ticks, map transitions, and deopts inside inlined code are attributed to the inlined function at its own source position instead of the caller's. Inlined copies of a megamorphic site no longer appear as a second finding in the caller's file, and functions that only ever run inlined now receive their own self ticks.
  ```

- Do NOT push or open a PR. No attribution lines.

## Steps

### Step 1: The decoder

Create `src/parser/sourceInfo.ts`:

```ts
/** Decoded `code-source-info` for one code object. Arrays are parallel, sorted by code offset. */
export interface SourceInfo {
  scriptId: string;
  codeOffsets: Int32Array;
  scriptOffsets: Int32Array;
  /** Inlining id per position, -1 when the position is in the code object's own function. */
  inliningIds: Int32Array;
  /** Index = inlining id. */
  inlining: Array<{
    functionIndex: number | undefined;
    /** Call-site script offset in the parent (the function named by `parent`, or the code object's own). */
    scriptOffset: number;
    parent: number | undefined;
  }>;
  /** Index = `functionIndex`; SharedFunctionInfo addresses as logged (e.g. "0x2fcf93e4c88"). */
  inlinedSfis: string[];
}

export const decodeSourceInfo = (scriptId: string, positions: string, inlining: string, inlinedSfis: string): SourceInfo
```

Decode `positions` with `/C(\d+)O(\d+)(?:I(\d+))?/gu`, `inlining` with `/F(\d*)O(\d+)(?:I(\d+))?/gu` (empty `F` → `functionIndex: undefined`), and `inlinedSfis` by splitting on `S` and dropping empty strings. Also export:

```ts
/** Position entry for a code offset: the last entry at or below it, or undefined before the first. */
export const positionAt = (info: SourceInfo, codeOffset: number): { scriptOffset: number; inliningId: number } | undefined
```

(binary search over `codeOffsets`), and a small line-table helper for script offsets:

```ts
export class ScriptPositions {
  constructor(source: string); // builds lineStarts: [0, ...indexes after each "\n"]
  /** 1-based line and column of a UTF-16 offset. */
  at(offset: number): { line: number; column: number };
}
```

Create `src/parser/__tests__/sourceInfo.spec.ts`: decode the real line `C21O3048C42O3234I0C454O2103I1` + `F0O664F0O621I0` + `S0x2fcf93e4c88S0x15f6acd85e0` and assert the arrays, `inliningIds` of `-1/0/1`, the second inlining entry's `parent === 0`; `positionAt` returns the entry at an exact offset, the previous entry between offsets, and `undefined` below the first; `ScriptPositions` on `"ab\ncd\n"` maps offset 0 → 1:1, 3 → 2:1, 4 → 2:2. Comment: V8 writes these tables and nothing else tells inlined code apart from its caller.

No license text is added: the decoder is written from the format description, not from V8 or Deopt Explorer source.

**Verify**: `vp -C packages/deoptkit test src/parser/__tests__/sourceInfo.spec.ts` → passes.

### Step 2: Model and code map

In `src/model/logModel.ts`:

- `CodeEntry` gains `sfi?: string | undefined` and `source?: SourceInfo | undefined` (import the type from `../parser/sourceInfo`).
- `LogModel` gains `/** code-source-info lines decoded; 0 means the log lacks --log-source-code tables and attribution falls back to the caller. */ codeSourceInfoCount: number;` next to `codeEntryCount`.

In `src/parser/codeMap.ts` add `/** The entry that starts exactly at `start`, if any. */ at(start: bigint): CodeEntry | undefined` using `#indexBefore` and an equality check.

Update the two `LogModel` literals (`findings.spec.ts`, `sessions.spec.ts`) with `codeSourceInfoCount: 0`.

**Verify**: `vp check --fix` → clean (every other literal is produced by `parseLog`).

### Step 3: Parser bookkeeping

In `src/parser/parseLog.ts` add, inside `parseLog`:

- `const sfiIndex = new Map<string, { functionName: string; file: string | undefined; line: number | undefined; column: number | undefined }>()`, filled by the `code-creation` handler for `JS` entries: destructure `[kind, kindNum, time, start, size, name, sfi]`, set `entry.sfi = sfi`, and `if (sfi !== undefined && !sfiIndex.has(sfi)) sfiIndex.set(sfi, { functionName, file, line, column })` (first tier wins; all tiers name the same function).
- An `sfi-move` handler: `([from, to]) => { const info = sfiIndex.get(from); if (info && to) sfiIndex.set(to, info); }` (keep the old key: tables logged before the move still reference it).
- `script-source`: also `scriptUrls.set(id, normalizedUrl)` where `id` is the first field (`const scriptUrls = new Map<string, string>()`).
- A `code-source-info` handler: `([address, scriptId, , , positions, inlining, inlinedSfis])` → `const entry = codeMap.at(BigInt(address))`; if found, `entry.source = decodeSourceInfo(scriptId, positions ?? "", inlining ?? "", inlinedSfis ?? "")` and `codeSourceInfoCount += 1`.
- A lazily-built `ScriptPositions` cache keyed by script URL (`positionsFor(url): ScriptPositions | undefined`, reading `scripts.get(url)`).
- The resolver:

  ```ts
  interface Frame {
    /** Identity of the function the position belongs to (code-creation name fields). */
    functionName: string;
    file: string | undefined;
    line: number | undefined;
    column: number | undefined;
    /** Where inside that function the pc is, when the script's source is known. */
    at: { line: number; column: number } | undefined;
  }
  /** Frames for a pc, innermost first: inlined functions (via the entry's tables) then the entry's own function. */
  const resolvePc = (pc: bigint): { entry: CodeEntry; frames: Frame[] } | undefined
  ```

  Algorithm: `entry = codeMap.find(pc)`; if no `entry.source`, return one frame for the entry itself with `at: undefined`. Otherwise `pos = positionAt(entry.source, Number(pc - entry.start))`; if undefined, same single frame. Else walk: `let scriptOffset = pos.scriptOffset; let id = pos.inliningId; while (id >= 0) { const inl = entry.source.inlining[id]; if (!inl) break; const sfi = inl.functionIndex === undefined ? undefined : entry.source.inlinedSfis[inl.functionIndex]; const info = sfi === undefined ? undefined : sfiIndex.get(sfi); frames.push({ ...(info ?? { functionName: "(inlined)", file: entry.file, line: undefined, column: undefined }), at: positionsFor(info?.file ?? entry.file)?.at(scriptOffset) }); scriptOffset = inl.scriptOffset; id = inl.parent ?? -1; }` then push the entry's own frame with `at: positionsFor(entry.file)?.at(scriptOffset)`. Guard the loop with a step counter of 64.

- `functionKey` must accept a `Frame` as well as a `CodeEntry` (both have `functionName|file|line|column`), and `tickRowFor` likewise.

**Verify**: `vp check --fix` → clean.

### Step 4: Apply the resolver

- `handleIc`: `const resolved = resolvePc(BigInt(pc))`; `const frame = resolved?.frames[0]`; `const inlined = (resolved?.frames.length ?? 0) > 1`. When `inlined && frame?.at` use `frame.at.line/column` and `frame.file`/`frame.functionName`; otherwise keep today's values (`code?.file`, `code?.functionName`, logged `line`/`column`). The site key uses the chosen file/line/column.
- `tick`: `const top = resolvePc(previous)`; self goes to `top.frames[0]`; `onStack` is seeded with every frame of `top` (innermost first), then each stack address contributes _all_ of its frames. Keep `samples.push` unchanged in shape (`self` = key of `top.frames[0]`).
- `map`: resolve the pc the same way as `handleIc` (file/functionName/line/column from the innermost frame when inlined).
- `code-deopt`: `const entry = codeMap.find(BigInt(address))`; `const id = Number(inliningId)`; when `entry?.source && id >= 0` take `entry.source.inlining[id]` → `inlinedSfis[functionIndex]` → `sfiIndex.get(sfi)?.functionName`; when `id < 0` take `entry?.functionName`; fall back to `enclosingFunctionName` only when neither is available. Remove the comment that calls the address "the caller" (it is now resolved).
- Return `codeSourceInfoCount` in the model.

**Verify**: `vp -C packages/deoptkit test src/parser/__tests__/parseLog.spec.ts` → the existing tests still pass (the deopt-loop test still finds one `getX` site; the megamorphic test still finds the `x` site at line 7).

### Step 5: Parser tests

In `src/parser/__tests__/parseLog.spec.ts` add a describe `parseLog resolves inlined positions through code-source-info` that writes this synthetic log (one line per array element, joined with `\n`; the `\n` inside the two `script-source` fields are the literal two characters backslash and `n`):

```ts
const LIB = "file:///app/lib.js";
const MAIN = "file:///app/main.js";
[
  "v8-version,14,0,0,0,-node.0,0",
  `script-source,7,${LIB},export const getX = (o) => o.x;\\n`,
  `script-source,8,${MAIN},// caller\\nimport { getX } from "./lib.js";\\nfunction hot(o) { return getX(o); }\\n`,
  `code-creation,JS,10,1000,0x1000,64,getX ${LIB}:1:21,0x7001,~`,
  "code-source-info,0x1000,7,20,31,C0O21C8O27C16O29,,",
  `code-creation,JS,13,2000,0x2000,256,hot ${MAIN}:3:13,0x7002,*`,
  "code-source-info,0x2000,8,43,78,C0O59C16O72C32O29I0C48O75,F0O72,S0x7001",
  "LoadIC,0x1012,2500,1,30,0,1,0x9000,x,,",
  "LoadIC,0x2028,3000,2,20,P,N,0x9001,x,,",
  "tick,0x2028,3100,0,0x0,0,0x2010",
  "map,Transition,3300,0x8001,0x8002,0x2028,2,20,,x",
  `code-deopt,3200,256,0x2000,0,29,deopt-eager,<${LIB}:1:30> inlined at <${MAIN}:3:30>,wrong map`,
  ""
].join("\n");
```

Facts about this log, for the assertions: in `lib.js` the `x` of `o.x` is at script offset 29 = line 1, column 30; `getX` is declared at 1:21. In `main.js` line 3 starts at offset 43, `hot` is declared at 3:13, and the call `getX(o)` is at offset 72 = line 3, column 30. `hot`'s table says code offset 32 is `lib.js` offset 29 inside inlining entry 0, whose function is `S0x7001` (`getX`) called from offset 72. The second `LoadIC` (pc `0x2028`, code offset 40 → entry `C32O29I0`) is V8's view of the inlined load, and its logged `2,20` is offset 29 looked up in `main.js` (line 2, column 20), the garbage a cross-file inlining produces. The tick's top frame is that same pc; its second stack address `0x2010` (offset 16 → `C16O72`, not inlined) is `hot` itself.

Assert:

1. `model.warnings.unknownCommands["code-source-info"]` is undefined and `model.codeSourceInfoCount === 2`.
2. Exactly one IC site has `key === "x"`; it has `file === LIB`, `line === 1`, `column === 30`, `functionName === "getX"`, `transitions.length === 2`, `worstState === "megamorphic"`. Comment: without the tables the second event becomes a second site in `main.js` at 2:20 — the ghost finding the e2e suite guards against.
3. `model.profile.samples[0]` has `self === \`getX|${LIB}|1|21\``and`onStack`equal to`[\`getX|${LIB}|1|21\`, \`hot|${MAIN}|3|13\`]`; the `getX`row has`selfTicks 1, totalTicks 1`, the `hot`row`selfTicks 0, totalTicks 1`.
4. `model.maps.transitionSites[0]` has `file === LIB`, `functionName === "getX"`, `line === 1`, `column === 30`.
5. `model.deopts[0]` has `functionName === "getX"` and `inlinedCount === 1`.

In the existing `parseLog on a real generated V8 log` describe add one test: `model.codeSourceInfoCount` is greater than 50 and `model.warnings.unknownCommands` has no `code-source-info` key. Comment: the real flag set must keep producing the tables, or every attribution silently degrades to the caller.

**Verify**: `vp -C packages/deoptkit test src/parser/__tests__/parseLog.spec.ts` → passes.

### Step 6: Heat without the file-level crutch

In `src/analysis/findings.ts` replace the `heatOf` definition and its comment:

```ts
// With inlining tables decoded, a function's own self ticks are its heat. Logs
// without tables (no --log-source-code) still attribute inlined ticks to the caller,
// so there, and only there, the file-level share stands in.
const heatOf = (functionName: string | undefined, file: string): number =>
  model.codeSourceInfoCount > 0
    ? (heatByFunction.get(`${functionName}|${file}`) ?? 0)
    : Math.max(
        heatByFunction.get(`${functionName}|${file}`) ?? 0,
        heatByFile.get(file) ?? 0
      );
```

In `src/analysis/__tests__/findings.spec.ts` add a calibration test: two synthetic models identical except `codeSourceInfoCount` (0 vs 1), each with one megamorphic `LoadIC` site in function `cold` of `file:///app/hot.js` and a profile whose only self ticks belong to function `other` in the same file. With tables present the finding's severity must be strictly lower than without them. Comment: the file-level fallback existed only because inlined ticks were lost; once they are attributed, charging a cold function with its file's heat overstates every finding in a hot file.

**Verify**: `vp -C packages/deoptkit test src/analysis/__tests__/findings.spec.ts` → passes, including `ranks the hot megamorphic IC as the top finding of its session` (if that test now fails because `getX` receives fewer ticks than the file, STOP and report the severities of the top three findings).

### Step 7: End-to-end ghost assertion

In `src/vitest/__tests__/preset.e2e.spec.ts`:

- Native-mode describe: delete the comment lines 167–171 that explain why the absence is not asserted, and add to the existing test: `expect(findings.filter((f) => f.kind === "megamorphic-ic" && f.evidence["key"] === "x" && !f.file.endsWith("lib.ts"))).toEqual([])`. Comment: V8 inlines `getX` into the bench function; before the tables were decoded the inlined copy was a second, higher-ranked finding in the bench file.
- Module-runner describe, test `findings in a bench worker locate user code and resolve to original positions`: add the same assertion over `models.flatMap(computeFindings)`.

In `docs/recipes.md` remove the sentence beginning "One caveat for now: when V8 inlines a hot call site into its caller".

**Verify**: `vp -C packages/deoptkit test src/vitest/__tests__/preset.e2e.spec.ts` → both describes pass; `grep -n "One caveat for now" docs/recipes.md` prints nothing.

### Step 8: Full gates

**Verify**: `vp check` → clean; `vp test` → all pass; `vp -C packages/deoptkit pack` → `Build complete`.

## Test plan

- New: `src/parser/__tests__/sourceInfo.spec.ts` (decoder, lookup, line table); synthetic-log describe in `parseLog.spec.ts` (ICs, ticks, maps, deopts attributed to the inlinee); fixture assertion that tables are decoded; findings calibration test; e2e ghost assertions in both modes.
- Pattern: `parseLog.spec.ts` "parseLog with loader query strings" (synthetic log via `writeFile`), `findings.spec.ts` "scoring calibration" (synthetic models).
- Verification: `vp test` → all pass.

## Done criteria

- [ ] `vp check` exits 0; `vp test` exits 0
- [ ] `grep -n "code-source-info" packages/deoptkit/src/parser/parseLog.ts` finds the handler
- [ ] The synthetic-log describe passes with the five assertions above
- [ ] `grep -n "One caveat for now" packages/deoptkit/docs/recipes.md docs/recipes.md` prints nothing
- [ ] `vp -C packages/deoptkit pack` exits 0
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated (skip if your reviewer maintains the index)

## STOP conditions

- The `code-creation` or `code-source-info` field order in the live fixtures differs from the format section (check with `grep -m2 "^code-source-info" packages/deoptkit/fixtures/logs/node-26/deopt-loop.log` after `node fixtures/generate.mjs`); report the lines.
- The e2e ghost assertion fails in native mode after Steps 3–4: capture every `megamorphic-ic` finding with key `x` (file, line, column, functionName, transitions) and report them rather than loosening the assertion.
- `ranks the hot megamorphic IC as the top finding of its session` fails after Step 6 (see Step 6).
- Any change would be needed in `src/analysis/window.ts` or `src/tools/**`.

## Maintenance notes

- `Frame` and `resolvePc` are the hook for plan 017 (`get_profile` call trees) and for line-level ticks in `get_function`; keep them inside the parser until a second consumer appears, then export from `src/parser/sourceInfo.ts`.
- If V8 changes the `code-source-info` token letters, the decoder's regexes are the only place to update; the fixture assertion on `codeSourceInfoCount` catches silent loss.
- `sfiIndex` keeps moved keys alive; if memory on very long logs becomes a concern, prune entries whose SFI no longer appears in any live code entry.
