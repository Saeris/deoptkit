# Plan 020: One keyed IC site per position, and "Insufficient type feedback" deopts classified as soft

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md` — unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1bfded1..HEAD -- packages/deoptkit/src/parser/parseLog.ts packages/deoptkit/src/model/logModel.ts packages/deoptkit/src/analysis/findings.ts packages/deoptkit/src/analysis/compare.ts packages/deoptkit/src/tools/listIcs.ts packages/deoptkit/src/tools/getFunction.ts` must print nothing (plans 014, 016, and 017 may run concurrently and touch other parts of `parseLog.ts`/`logModel.ts`/`findings.ts`; if the diff is non-empty, compare only the excerpts below and STOP on a mismatch there).

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/015-inlining-aware-attribution.md
- **Category**: correctness
- **Planned at**: commit `1bfded1`, 2026-11-03

## Why this matters

Dogfooding `deoptkit ci` on this repository's own parser (plan 018) showed the gate flickering between runs. The root cause is a modeling defect, not noise: the parser keys IC sites by `type|file|line|column|key`, so a keyed access such as `vmStates[state]` (`src/parser/parseLog.ts`, the `tick` handler) becomes one "site" per runtime key (`js`, `gc`, `other`, `bytecode_compiler`, `external`, ...). V8's feedback is per slot, one per syntactic site: when the name at a keyed site changes, the slot goes megamorphic, and the key on the logged line is simply whichever key was being accessed at that moment. Splitting by key makes the megamorphic transition land on a random key each run, produces several half-sites with 1–4 transitions each, and gives agents a finding that names a property ("went megamorphic for property gc") that is not the problem. One site per position with the distinct keys as evidence is both the correct model and the stable identity the CI gate needs.

The same dogfood run showed a `deopt-loop` finding flickering on `#indexBefore` with the reason `Insufficient type feedback for binary operation`. Modern V8 logs these bailouts as `deopt-eager`, but they mean optimized code reached an expression that had never executed in that tier (the old soft-deopt meaning): warm-up, not type instability. Counting two of them as a "loop" ranks a non-problem above real ones and gates CI on tier-up timing.

## Current state

Paths relative to `packages/deoptkit/`, at `1bfded1`.

- `src/parser/parseLog.ts` lines 351–392, `handleIc` (after plan 015's `eventSite`):

  ```ts
  const handleIc =
    (type: string) =>
    ([pc, time, line, column, oldState, newState, mapAddress, key]: Array<
      string | undefined
    >): void => {
      const parsedOld = parseIcState(oldState ?? "");
      const parsedNew = parseIcState(newState ?? "");
      if (!parsedOld || !parsedNew)
        throw new Error(`unrecognized IC state: ${oldState}->${newState}`);
      const at = eventSite(BigInt(pc ?? "0"), line, column);
      const siteKey = `${type}|${at.file ?? "?"}|${at.line}|${at.column}|${key}`;
      let site = icSites.get(siteKey);
      if (!site) {
        site = {
          type,
          file: at.file,
          functionName: at.functionName,
          line: at.line,
          column: at.column,
          key: key ?? "",
          worstState: parsedNew,
          transitions: []
        };
        icSites.set(siteKey, site);
      }
      site.transitions.push({
        time: Number(time),
        oldState: parsedOld,
        newState: parsedNew,
        mapAddress: mapAddress ?? ""
      });
      if (icStateRank(parsedNew) > icStateRank(site.worstState))
        site.worstState = parsedNew;
    };
  ```

  `IC_COMMANDS` (lines 21–29) lists `LoadIC`, `StoreIC`, `KeyedLoadIC`, `KeyedStoreIC`, `LoadGlobalIC`, `StoreGlobalIC`, `StoreInArrayLiteralIC`.

- `src/model/logModel.ts` lines 43–57, `IcSite`: `type`, `file`, `functionName`, `line`, `column`, `/** Property key being accessed. */ key: string`, `worstState`, `transitions: IcTransition[]`.
- `src/analysis/findings.ts`:
  - lines 92–98: `const KEYED_IC_DISCOUNT = 0.45;` with the Valimock calibration comment.
  - lines 176–225, the IC loop: `const keyed = site.type.startsWith("Keyed");` megamorphic summary `` `${site.type} for property "${site.key}" went megamorphic (${hits} recorded transitions)${keyed ? " — keyed/dynamic access, often inherent to generic dispatch" : ""}` `` with evidence `{ icType: site.type, key: site.key, worstState: site.worstState, transitions: hits, keyedAccess: keyed }`; the polymorphic branch uses summary `` `${site.type} for property "${site.key}" is polymorphic inside a hot function` `` and evidence `{ icType, key, worstState, transitions }`.
  - lines 228–275, the deopt loop:

    ```ts
    const isOsrNoise = (reason: string): boolean =>
      reason.includes("on stack replacement") || reason.includes("OSR");

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
      const heat = heatOf(site.functionName, site.file);
      if (site.kind === "eager" && count >= 2) {
        findings.push(
          finding(
            "deopt-loop",
            site,
            `${count} eager deopts at the same position (${reasons.join("; ")})`,
            score("deopt-loop", count, heat),
            { kind: site.kind, count, reasons, inlinedCount: site.inlinedCount }
          )
        );
      } else if (site.kind === "eager") {
        findings.push(
          finding(
            "eager-deopt",
            site,
            `Eager deopt: ${reasons.join("; ")}`,
            score("eager-deopt", count, heat),
            { kind: site.kind, count, reasons, inlinedCount: site.inlinedCount }
          )
        );
      } else if (site.kind === "soft") {
        findings.push(
          finding(
            "soft-deopt",
            site,
            `Soft deopt: ${reasons.join("; ")}`,
            score("soft-deopt", count, heat),
            { kind: site.kind, count, reasons, inlinedCount: site.inlinedCount }
          )
        );
      }
    }
    ```

- `src/analysis/compare.ts` lines 62–74, `findingIdentity`: `detail = asString(evidence["key"]) ?? asJoinedStrings(evidence["propertyNames"]) ?? asJoinedStrings(evidence["reasons"]) ?? ""`; identity `` `${kind}|${file}|${functionName ?? ""}|${detail}` ``. Shared by `compare_sessions`, `deoptkit ci` baselines, and `get_findings { sessionIds }`.
- `src/tools/listIcs.ts` lines 118–150 (after plan 012): items are built explicitly (`type, file, functionName, line, column, key, worstState, transitionCount, stateHistory, distinctMaps, ...`).
- `src/tools/getFunction.ts` lines 119–124: IC annotation note `` `${site.type} "${site.key}" reached ${site.worstState} (${site.transitions.length} transitions)` ``.
- `src/cli/ci.ts` `GATED_KINDS` = `megamorphic-ic`, `map-churn`, `deopt-loop` (soft and eager one-offs are not gated).
- Tests: `src/parser/__tests__/parseLog.spec.ts` (fixture describes plus the synthetic-log describe `parseLog resolves inlined positions through code-source-info`, whose log has a single `x` LoadIC site); `src/analysis/__tests__/findings.spec.ts` (synthetic `icSite(type, key)` helper in the scoring test; the keyed-discount test asserts `keyed?.evidence["keyedAccess"] === true` and `keyed?.summary` contains `inherent`; the fixture describe asserts the deopt-loop fixture's `wrong map` loop and `Number(loop?.evidence["count"]) >= 2`); `src/analysis/__tests__/compare.spec.ts` (identity via the `id` named key).
- Observed in the dogfood baseline (plan 018 report): identities `megamorphic-ic|src/parser/parseLog.ts|tick|js`, `...|tick|gc`, `...|tick|other`, `...|tick|bytecode_compiler`, `...|tick|external` appearing in different runs; `deopt-loop|src/parser/codeMap.ts|#indexBefore|Insufficient type feedback for binary operation` appearing and disappearing. The fixture `deopt-loop.js` loop's reason is `wrong map` and must keep being a `deopt-loop`.

Conventions: tests state why; synthetic logs via `writeFile` (see the inlining describe); soft-wrapped markdown.

## Commands you will need

| Purpose                   | Command                                                                                                                                             | Expected on success |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Install                   | `vp install`                                                                                                                                        | exit 0              |
| Format + lint + typecheck | `vp check --fix`                                                                                                                                    | clean               |
| Specs                     | `vp -C packages/deoptkit test src/parser/__tests__/parseLog.spec.ts src/analysis/__tests__/findings.spec.ts src/analysis/__tests__/compare.spec.ts` | pass                |
| All tests                 | `vp test`                                                                                                                                           | all pass            |
| Build                     | `vp -C packages/deoptkit pack`                                                                                                                      | `Build complete`    |

## Scope

**In scope** (relative to `packages/deoptkit/`):

- `src/parser/parseLog.ts` (`handleIc` only), `src/model/logModel.ts` (`IcSite`), `src/analysis/findings.ts` (IC loop and deopt loop), `src/analysis/compare.ts` (`findingIdentity` fallback), `src/tools/listIcs.ts` (one field), `src/tools/getFunction.ts` (annotation note)
- `src/parser/__tests__/parseLog.spec.ts`, `src/analysis/__tests__/findings.spec.ts`, `src/analysis/__tests__/compare.spec.ts`
- `.bumpy/020-keyed-sites.md` (repository root; create)

**Out of scope**:

- `src/cli/ci.ts` and the baseline format (identities change through `findingIdentity` only).
- `KEYED_IC_DISCOUNT` and the severity formula.
- The `map` handler, tick handler, and everything plans 014/016/017 touch.

## Git workflow

- Branch: `exec/plan-020` in a dedicated worktree; stay there.
- One commit: `Parser: keyed IC sites by position; classify insufficient-type-feedback deopts as soft`.
- Bump file `.bumpy/020-keyed-sites.md`:

  ```markdown
  ---
  "deoptkit": minor
  ---

  Keyed inline-cache sites (`obj[key]`) are now one site per code position with the distinct keys as evidence, instead of one site per runtime key, which made the megamorphic finding name a random key and flicker between runs. Deopts V8 reports as "Insufficient type feedback" are classified as soft deopts (warm-up bailouts, not instability) and no longer count toward deopt loops or the CI gate.
  ```

- Do NOT push or open a PR. No attribution lines.

## Steps

### Step 1: The model

In `src/model/logModel.ts`, `IcSite`: change the `key` doc to "Property key being accessed; for keyed ICs the first key observed at the site" and add `/** Distinct keys observed at a keyed site (`obj[key]`), in first-seen order, at most MAX_SITE_KEYS; one entry (the property) for named ICs. */ keys: string[];` plus `/** Number of distinct keys observed, uncapped. */ distinctKeys: number;`.

**Verify**: `vp check` reports the missing fields in `parseLog.ts` and the `findings.spec.ts` / `window.spec.ts` literals that build `IcSite`s (fix them in Step 2/4).

### Step 2: One keyed site per position

In `handleIc`:

- `const keyed = type.startsWith("Keyed");`
- `const siteKey = keyed ? \`${type}|${at.file ?? "?"}|${at.line}|${at.column}\` : \`${type}|${at.file ?? "?"}|${at.line}|${at.column}|${key}\`;` with the comment: V8's feedback is one slot per syntactic site; for keyed access the logged key is only the one being accessed when the slot changed state, so splitting by key invents sites and lands the megamorphic transition on a random key.
- New sites start with `keys: key === undefined || key === "" ? [] : [key]`, `distinctKeys: keys.length`. On every event for a keyed site: if the key is non-empty and not yet in `keys`, increment `distinctKeys` and push when `keys.length < MAX_SITE_KEYS` (a module constant, 32). Named sites keep `keys: [key]`, `distinctKeys: 1`.

Update the `IcSite` literals in `src/analysis/__tests__/findings.spec.ts` (`icSite` helpers in both synthetic tests) with `keys: [key]`, `distinctKeys: 1`, and any other literal `vp check` reports.

**Verify**: `vp check --fix` → clean.

### Step 3: Findings and identity

In `src/analysis/findings.ts`, IC loop:

- Megamorphic, keyed: summary `` `${site.type} at a dynamic-key site went megamorphic (${hits} recorded transitions over ${site.distinctKeys} distinct keys, e.g. ${site.keys.slice(0, 3).map((k) => `"${k}"`).join(", ")}) — often inherent to generic dispatch` ``; evidence `{ icType, keys: site.keys.slice(0, 8), distinctKeys: site.distinctKeys, worstState, transitions: hits, keyedAccess: true }` (no `key`). Named: unchanged.
- Polymorphic, keyed: same treatment (summary mentions the key count; evidence `keys`/`distinctKeys` instead of `key`).

In `src/analysis/compare.ts`, `findingIdentity`: append `?? asString(found.evidence["icType"])` before the final `?? ""`, with a comment: keyed sites carry no single key, so the IC type keeps a function's keyed load and keyed store sites apart.

Deopt loop: before the `kind` branches, split `events` into `const feedback = events.filter(({ reason }) => reason.startsWith("Insufficient type feedback"))` and `const hard = events.filter(...)` (the rest). Comment: modern V8 logs insufficient-type-feedback bailouts as eager deopts, but they mean optimized code reached an expression it had never executed in that tier, the original soft-deopt meaning: warm-up, not instability. Then: if `hard.length >= 2 && site.kind === "eager"` → `deopt-loop` from `hard` (count and reasons from `hard`); else if `hard.length === 1 && site.kind === "eager"` → `eager-deopt` from `hard`; if `feedback.length > 0` (any `site.kind`) → a `soft-deopt` finding with `count: feedback.length` and `reasons` from `feedback` (summary `Soft deopt (insufficient type feedback): …`); and the existing `site.kind === "soft"` branch stays for logs that still write `deopt-soft`. A site can therefore yield two findings (a hard loop and a soft one); that is intended.

**Verify**: `vp check --fix` → clean.

### Step 4: Tools

- `src/tools/listIcs.ts`: add `keys: site.keys` and `distinctKeys: site.distinctKeys` to every item (after `key`).
- `src/tools/getFunction.ts`: the IC annotation note becomes `` `${site.type} ${site.type.startsWith("Keyed") ? `[${site.distinctKeys} keys]` : `"${site.key}"`} reached ${site.worstState} (${site.transitions.length} transitions)` ``.

**Verify**: `vp check --fix` → clean; `vp -C packages/deoptkit test src/__tests__/server.spec.ts` → passes.

### Step 5: Tests

`src/parser/__tests__/parseLog.spec.ts`, new describe `parseLog models keyed IC sites by position` with a synthetic log (same style as the inlining describe; the script source is one line so positions are trivial):

```ts
[
  "v8-version,14,0,0,0,-node.0,0",
  "script-source,7,file:///app/k.js,const f = (o, k) => o[k];\\n",
  "code-creation,JS,10,1000,0x1000,64,f file:///app/k.js:1:11,0x7001,~",
  "KeyedLoadIC,0x1010,2000,1,22,0,1,0x9001,a,,",
  "KeyedLoadIC,0x1010,2100,1,22,1,P,0x9002,b,,",
  "KeyedLoadIC,0x1010,2200,1,22,P,N,0x9003,c,,",
  "KeyedLoadIC,0x1010,2300,1,22,N,N,0x9004,a,,",
  "LoadIC,0x1020,2400,1,22,0,1,0x9005,x,,",
  "LoadIC,0x1020,2500,1,22,1,P,0x9006,y,,",
  ""
].join("\n");
```

Assert: exactly one `KeyedLoadIC` site, with `transitions.length === 4`, `worstState === "megamorphic"`, `keys` deep-equal `["a", "b", "c"]`, `distinctKeys === 3`, `key === "a"`; and two `LoadIC` sites (`x` and `y`), each with one transition. Comment: V8's feedback is one slot per syntactic site; before this change the keyed events became three sites and the megamorphic one named whichever key was being accessed at the time.

`src/analysis/__tests__/findings.spec.ts`:

1. A keyed megamorphic site with `keys: ["js","gc","other"]`, `distinctKeys: 3` yields one `megamorphic-ic` finding whose `evidence` has `keys` and `distinctKeys` and no `key`, whose summary contains `dynamic-key` and `3 distinct keys`, and whose `findingIdentity` (import from `../compare`) ends with `|KeyedLoadIC`. Comment: the identity must not depend on which key crossed the threshold, or CI baselines flicker.
2. A deopt site `kind: "eager"` with two events `Insufficient type feedback for binary operation` yields a `soft-deopt` finding and no `deopt-loop`; a site with two `wrong map` events yields a `deopt-loop`; a site with one `wrong map` and one `Insufficient type feedback for call` yields one `eager-deopt` and one `soft-deopt`. Comment: V8 removed the soft deopt kind and logs feedback bailouts as eager; they are warm-up, not instability, and must not gate CI.
3. The existing fixture test `detects the deopt loop and ranks it above one-off deopts` must still pass unchanged (`wrong map`).

`src/analysis/__tests__/compare.spec.ts`: no change expected; run it.

**Verify**: the three specs pass; `vp test` → all pass; `vp -C packages/deoptkit pack` → `Build complete`.

## Test plan

- New synthetic keyed-site describe in `parseLog.spec.ts`; new keyed-finding and deopt-classification tests in `findings.spec.ts`.
- Verification: `vp test` → all pass.

## Done criteria

- [ ] `vp check` and `vp test` exit 0; `vp -C packages/deoptkit pack` exits 0
- [ ] `grep -n "distinctKeys" packages/deoptkit/src/model/logModel.ts packages/deoptkit/src/parser/parseLog.ts packages/deoptkit/src/analysis/findings.ts packages/deoptkit/src/tools/listIcs.ts` finds all four
- [ ] `grep -n "Insufficient type feedback" packages/deoptkit/src/analysis/findings.ts` finds the classification
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated (skip if your reviewer maintains the index)

## STOP conditions

- The `handleIc` excerpt or the findings deopt loop differs from the excerpts (another plan changed them); report the diff.
- `detects the deopt loop and ranks it above one-off deopts` fails after Step 3 (the fixture's reasons would then not be `wrong map`); report the reasons seen.
- The e2e spec (`src/vitest/__tests__/preset.e2e.spec.ts`) fails after the change (it filters findings by `evidence["key"] === "x"`, a named site, so it should not); report which assertion.

## Maintenance notes

- Plan 021 regenerates the dogfood baseline after this lands; the `tick` keyed site should then appear once as `megamorphic-ic|src/parser/parseLog.ts|tick|KeyedLoadIC` (and once for the store).
- `MAX_SITE_KEYS` bounds memory for truly dynamic sites (thousands of keys); `distinctKeys` stays exact.
- If V8 reintroduces `deopt-soft`, the `site.kind === "soft"` branch already handles it.
