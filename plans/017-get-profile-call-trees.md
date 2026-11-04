# Plan 017: `get_profile` call trees (top-down and bottom-up, just-my-code)

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md` — unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1bfded1..HEAD -- packages/deoptkit/src/analysis/window.ts packages/deoptkit/src/server.ts plugins/deoptkit/skills/deoptkit/SKILL.md` must print nothing; plans 014, 016, and 020 may run concurrently and touch other parts of `parseLog.ts` and `logModel.ts`, so for those compare only the excerpts below and STOP on a mismatch there.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/015-inlining-aware-attribution.md
- **Category**: direction
- **Planned at**: commit `1bfded1`, 2026-11-03

## Why this matters

`list_functions` is a flat profile: it says `parseRecord` has 40% self time but not who calls it or what it calls, so an agent deciding whether a hot site matters has to guess the call path. `docs/SPEC.md` §4 lists `get_profile` with `flat`, `top-down`, and `bottom-up` views and just-my-code filtering, and BENCHMARKING §9 scheduled it for v1.3; it never shipped. Plan 015 made every sample carry inlining-resolved frames, so the tree costs nothing new to collect: retain the ordered frame list per sample and fold it into a pruned tree on demand. With just-my-code on by default, a 20-node tree answers "where does the time under my code go" in one call, in the size budget of a findings page.

## Current state

Paths relative to `packages/deoptkit/`, at `1bfded1`.

- `src/parser/parseLog.ts` lines 584–624, the `tick` handler (after plan 015):

  ```ts
  let previous = BigInt(pc ?? "0");
  // Inlined code runs under the caller's code address; the innermost frame is the
  // function actually executing, so it gets the self tick.
  const top = resolvePc(previous, "sampled")?.frames ?? [];
  const self = top.at(0);
  if (self) tickRowFor(self).selfTicks += 1;

  // Total ticks count each function once per sample, however often it recurs.
  // Keyed by function key; insertion order keeps the stack innermost first.
  const onStack = new Map<string, FunctionTicks>();
  const pushFrames = (frames: Frame[]): void => {
    for (const frame of frames)
      onStack.set(functionKey(frame), tickRowFor(frame));
  };
  pushFrames(top);
  for (const field of stack) {
    const address = parseStackAddress(field ?? "", previous);
    if (address === undefined) continue;
    previous = address;
    pushFrames(resolvePc(address, "return")?.frames ?? []);
  }
  for (const row of onStack.values()) row.totalTicks += 1;
  samples.push({
    time: Number(time),
    vmState: state,
    self: self ? functionKey(self) : undefined,
    onStack: [...onStack.keys()]
  });
  ```

  `functionKey(entry)` = `${functionName}|${file}|${line}|${column}`.

- `src/model/logModel.ts` lines 174–181, `TickSample { time; vmState; self: string | undefined; /** Distinct function keys anywhere on the stack (including self), innermost first. */ onStack: string[] }`; `ProfileModel { tickCount; vmStates; functions: FunctionTicks[]; samples: TickSample[] }`.
- `src/analysis/window.ts` lines 57–79, `rowFromKey(key): FunctionTicks` (module-private; rebuilds a row from a function key, splitting from the right with `"undefined"` → `undefined`), and `windowProfile` (lines 81–108) recounting `selfTicks`/`totalTicks` from `sample.self` and `sample.onStack`; `applyWindow` keeps `samples` filtered by time.
- `src/analysis/findings.ts` line 30, `isUserCode(file)`.
- `src/tools/listFunctions.ts`: the flat profile tool (`sortBy`, `file`, window, paging; items through `presentFile`).
- `src/tools/shared.ts`: `sessionIdSchema`, `limitSchema` (1–100, default 20), `fromMarkSchema`, `toMarkSchema`, `fileFilterSchema`, `windowedModel`, `unknownSessionError`, `presentFile`, `matchesFile`.
- `src/server.ts` lines 31–43, the `tools` array (eleven tools) and `SERVER_INSTRUCTIONS` ("Drill-down: get_function ..., get_map ..., list_ics / list_deopts / list_functions ...").
- `src/__tests__/server.spec.ts` lines 44–72 pin the tool names (`toSorted()` list) and assert `annotations.readOnlyHint` per tool; `src/__tests__/plugin.spec.ts` (plan 019) asserts every advertised tool name appears in `plugins/deoptkit/skills/deoptkit/SKILL.md` at the repository root, whose "The loop" section lists the drill-down tools.
- `src/analysis/__tests__/window.spec.ts` asserts an unbounded window reproduces `model.profile` with `toEqual` (so new sample fields must survive `windowProfile`'s `samples` passthrough).
- Fixture facts: `megamorphic.log` has about 60 ticks of which 16–19 land in user code (the OSR'd top-level loop, with some resolving to inlined `getX`); the remaining ticks are in the `LoadIC_Megamorphic` builtin with no JS frame on the sampled stack.

Conventions: Valibot schemas; `defineTool` with `title` and `annotations`; tests say why; soft-wrapped markdown.

## Commands you will need

| Purpose                   | Command                                                                                                                                                                                                      | Expected on success |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| Install                   | `vp install`                                                                                                                                                                                                 | exit 0              |
| Format + lint + typecheck | `vp check --fix`                                                                                                                                                                                             | clean               |
| Specs                     | `vp -C packages/deoptkit test src/analysis/__tests__/profile.spec.ts src/analysis/__tests__/window.spec.ts src/tools/__tests__/getProfile.spec.ts src/__tests__/server.spec.ts src/__tests__/plugin.spec.ts` | pass                |
| All tests                 | `vp test`                                                                                                                                                                                                    | all pass            |

## Scope

**In scope** (relative to `packages/deoptkit/` unless noted):

- `src/parser/parseLog.ts` (the `tick` handler's `samples.push` only), `src/model/logModel.ts` (`TickSample`)
- `src/analysis/window.ts` (export `rowFromKey`), `src/analysis/profile.ts` (create), `src/analysis/__tests__/profile.spec.ts` (create)
- `src/tools/getProfile.ts` (create), `src/tools/__tests__/getProfile.spec.ts` (create)
- `src/server.ts` (register the tool; one sentence in the instructions)
- `src/__tests__/server.spec.ts` (tool list)
- Repository root `plugins/deoptkit/skills/deoptkit/SKILL.md` (add `get_profile` to the drill-down sentence)
- `.bumpy/017-get-profile.md` (repository root; create)

**Out of scope**:

- `list_functions` (stays the flat view; `get_profile` adds trees).
- Line-level ticks inside `get_function` (a later plan can reuse the frames).
- Any change to how frames are resolved (plan 015).

## Git workflow

- Branch: `exec/plan-017` in a dedicated worktree; stay there.
- One commit: `Tools: get_profile call trees from retained sample frames`.
- Bump file `.bumpy/017-get-profile.md`:

  ```markdown
  ---
  "deoptkit": minor
  ---

  New `get_profile` tool: top-down and bottom-up call trees built from the profiler samples (inlining-resolved), filtered to the user's own code by default, pruned by depth, width, and share, and windowed by harness markers like every other tool.
  ```

- Do NOT push or open a PR. No attribution lines.

## Steps

### Step 1: Retain the frame list

`src/model/logModel.ts`, `TickSample`: add `/** Every resolved frame innermost first, repeats included (inlined callees expand to their own frames); the material for call trees. */ frames: string[];`.

`src/parser/parseLog.ts`, tick handler: collect the frames in order while pushing (`const frames: string[] = []` filled inside `pushFrames` with `functionKey(frame)` for each frame) and add `frames` to `samples.push`.

`src/analysis/window.ts`: export `rowFromKey` (no other change; `windowProfile` passes `samples` through).

**Verify**: `vp check --fix` → clean; `vp -C packages/deoptkit test src/analysis/__tests__/window.spec.ts` → passes.

### Step 2: The tree builder

Create `src/analysis/profile.ts`:

```ts
export interface ProfileNode {
  functionName: string;
  file: string | undefined;
  line: number | undefined;
  column: number | undefined;
  selfTicks: number;
  totalTicks: number;
  children: ProfileNode[];
}

export interface ProfileTreeOptions {
  view: "top-down" | "bottom-up";
  /** Drop frames outside user code (node: internals, node_modules); default true. */
  justMyCode: boolean;
  maxDepth: number;
  /** Children kept per node, by totalTicks. */
  limit: number;
  /** Children below this share of the attributed ticks are dropped. */
  minPercent: number;
}

export interface ProfileTree {
  tickCount: number;
  /** Samples that contributed a path (with justMyCode: samples with at least one user frame). */
  attributedTicks: number;
  roots: ProfileNode[];
}

export const buildProfileTree = (profile: ProfileModel, options: ProfileTreeOptions): ProfileTree
```

Algorithm: for each sample, take `frames` (innermost first); with `justMyCode`, keep only frames whose `rowFromKey(key).file` passes `isUserCode` (import from `./findings`); skip the sample if nothing remains. Top-down path = kept frames outermost first; bottom-up path = kept frames innermost first. Insert the path into a trie keyed by function key: every node on the path gets `totalTicks += 1` once per sample (dedupe repeated keys within one path so recursion does not double count), and the path's last node (top-down: the innermost; bottom-up: the root, i.e. the self function) gets `selfTicks += 1`. After building, prune recursively: sort children by `totalTicks` desc, drop those below `minPercent / 100 * attributedTicks`, keep the first `limit`, stop at `maxDepth`. Node identity fields come from `rowFromKey`. Comment: just-my-code treats a builtin called from user code as time of the nearest user frame, which is what an agent editing that code needs.

Create `src/analysis/__tests__/profile.spec.ts` with synthetic samples (build a `ProfileModel` literal with `functions: []`, `vmStates: {}`, and `samples` whose `frames` are keys like `c|file:///app/c.js|1|1`): samples `[c,b,a]`, `[c,b,a]`, `[b,a]`, `[a]`, `[x|node:internal/x|1|1, b, a]` and assert: top-down roots = `[a]` with `totalTicks 5`, `selfTicks 1`, child `b` `totalTicks 4` `selfTicks 2` (the `x` sample counts as `b`'s self with justMyCode), child `c` `totalTicks 2`; bottom-up roots sorted by total: `c` (2) with child `b` then `a`, `b` (2) ..., `a` (1); with `justMyCode: false` the fifth sample produces an `x` leaf under `b`; `minPercent: 50` prunes `c`; `limit: 1` keeps one child; `attributedTicks` equals 5. Comments: an agent reads these trees to find who calls the hot thing; a double-counted recursive frame or a mis-rooted bottom-up tree sends it to the wrong function.

**Verify**: `vp -C packages/deoptkit test src/analysis/__tests__/profile.spec.ts` → passes.

### Step 3: The tool

Create `src/tools/getProfile.ts`: `name: "get_profile"`, `title: "CPU call tree"`, description "Call tree from the profiler samples: top-down (who calls what, from the roots) or bottom-up (hot functions and their callers). Defaults to the user's own code with builtins and dependencies folded into their nearest user caller; pruned by maxDepth, limit (children per node), and minPercent (share of attributed ticks). Window with fromMark/toMark like get_findings.", annotations `{ readOnlyHint: true, idempotentHint: true }`, schema `{ sessionId, view?: picklist ["top-down","bottom-up"] (default top-down), justMyCode?: boolean (default true), maxDepth?: integer 1–32 (default 8), limit?: integer 1–50 (default 10), minPercent?: number 0–100 (default 1), fromMark?, toMark? }` (descriptions on each). Handler: `windowedModel`, `buildProfileTree(model.profile, …)`, then present every node's `file` through `presentFile(session, node)` recursively, and return `{ view, tickCount, attributedTicks, roots }`.

Register it in `src/server.ts` after `listFunctions` in the `tools` array, and in `SERVER_INSTRUCTIONS` extend the drill-down sentence: "list_ics / list_deopts / list_functions, and get_profile for the call tree (who calls the hot function, top-down or bottom-up)".

Add `get_profile` to the drill-down sentence of `plugins/deoptkit/skills/deoptkit/SKILL.md` (the skill is pinned to the server's tool list by `plugin.spec.ts`).

**Verify**: `vp check --fix` → clean; `vp -C packages/deoptkit test src/__tests__/plugin.spec.ts` → passes.

### Step 4: Tests

- `src/__tests__/server.spec.ts`: add `get_profile` to the pinned tool-name list.
- Create `src/tools/__tests__/getProfile.spec.ts` modelled on `getFindings.spec.ts`: load `generateWorkloadLog("megamorphic", dir)` through `loadLogFile`; `get_profile { sessionId: "s1" }` → `tickCount > 5`, `attributedTicks >= 1`, every root has `totalTicks >= selfTicks` and a `file` that is a relative path ending with `megamorphic.js` (just-my-code keeps only user frames; comment: builtin ticks under the loop must fold into it, not vanish); `view: "bottom-up"` → roots non-empty and the sum of root `selfTicks` equals `attributedTicks`; `justMyCode: false` → `attributedTicks >= ` the just-my-code value; an unknown marker in `fromMark` → the usual window error.

**Verify**: the specs pass; `vp test` → all pass; `vp -C packages/deoptkit pack` → `Build complete`.

## Test plan

- New `profile.spec.ts` (synthetic trees, pruning, recursion dedupe), `getProfile.spec.ts` (fixture smoke, views, window error); extended `server.spec.ts` tool list.
- Verification: `vp test` → all pass.

## Done criteria

- [ ] `vp check` and `vp test` exit 0; `vp -C packages/deoptkit pack` exits 0
- [ ] `tools/list` advertises `get_profile` with `readOnlyHint: true`
- [ ] `plugin.spec.ts` passes (skill mentions `get_profile`)
- [ ] `window.spec.ts` still passes (frames survive windowing)
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated (skip if your reviewer maintains the index)

## STOP conditions

- The tick handler excerpt does not match (plan 015 must have landed).
- The megamorphic fixture run in `getProfile.spec.ts` has `attributedTicks === 0` with just-my-code (would mean user frames are not resolving); report `list_functions`' top rows.
- `plugin.spec.ts` fails for a tool other than `get_profile`.

## Maintenance notes

- `frames` roughly doubles per-sample memory versus `onStack`; samples are small (tens of thousands per session at most), but if a real log makes this noticeable, store frames as indices into a key table.
- `get_function` line-level ticks can be built from `frames` plus the resolver's `at` positions later; plan 015 kept `Frame.at` for that.
- `minPercent` is relative to attributed ticks, so a just-my-code tree with few user ticks still shows its structure.
