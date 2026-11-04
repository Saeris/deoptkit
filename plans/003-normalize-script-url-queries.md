# Plan 003: Normalize script URLs by stripping query strings and fragments

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md` — unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat b733901..HEAD -- src/parser/parseLog.ts` and `git status --short src/parser`. If plan 001 has landed, the `code-deopt` handler will differ from the `b733901` excerpt (it then calls `parseDeoptLocation`); that is expected. Any other mismatch with the excerpts below is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (run after 001 if both are scheduled, to avoid conflicting edits in the same file)
- **Category**: bug
- **Planned at**: commit `b733901`, 2026-11-03

## Why this matters

Module loaders append cache-busting queries to the URLs they import. Vitest 5's native loader (used when `experimental.viteModuleRunner` is `false`) imports a benchmark file as `file:///…/probe.bench.ts?vitest=1793711375348`; Vite's dev server appends `?t=…` and `?v=…`. V8 logs the URL verbatim, so the parser stores it verbatim in `code-creation` entries, `script-source` keys, IC sites, deopt sites, and tick rows. Three things break: `findingIdentity` (`kind|file|function|detail`) includes the timestamp, so `compare_sessions` and `deoptkit ci` baselines never match across runs; `SourceMapResolver` and the LSP's staleness check call `fileURLToPath` and `readFileSync` on a path that contains `?vitest=…`, which does not exist; and `toUri` in the LSP publishes a diagnostic URI the editor does not associate with the open file. This was observed directly while probing the vitest preset in native mode: the probe's finding on the bench file carried `?vitest=1793711375348` in its `file`.

Query strings never identify a different script for the purposes of this tool, so normalizing them away at the model boundary is correct and removes an entire class of run-to-run instability.

## Current state

- `src/parser/parseLog.ts` — three places where script URLs enter the model:
  - `splitEntryName` (lines 58–84) derives `file` from the trailing `url:line:column` of a `code-creation` entry name; it is the source of `file` for IC sites, tick rows, and the function index.
  - the `script-source` handler (lines 239–241) keys `scripts` by the URL field.
  - the `code-deopt` handler (lines 242–282; after plan 001, `parseDeoptLocation`) takes the deopt position's `file` from the location field.

Excerpts:

```ts
// lines 29-30
/** Trailing `url:line:column` in a code entry name, e.g. `getX file:///a/b.js:6:14`. */
const SOURCE_REF_RE = /^(?<file>.+):(?<line>\d+):(?<column>\d+)$/u;
```

```ts
// lines 58-84
const splitEntryName = (
  name: string
): {
  functionName: string;
  file: string | undefined;
  line: number | undefined;
  column: number | undefined;
} => {
  const spaceIndex = name.lastIndexOf(" ");
  if (spaceIndex !== -1) {
    const match = SOURCE_REF_RE.exec(name.slice(spaceIndex + 1));
    if (match?.groups) {
      return {
        functionName: name.slice(0, spaceIndex),
        file: match.groups["file"],
        line: Number(match.groups["line"]),
        column: Number(match.groups["column"])
      };
    }
  }
  return {
    functionName: name,
    file: undefined,
    line: undefined,
    column: undefined
  };
};
```

```ts
// lines 239-241
    "script-source": ([, url, source]): void => {
      if (url !== undefined && source !== undefined) scripts.set(url, source);
    },
```

A minimal synthetic log is an accepted test input in this repo for format-level behavior (see `src/__tests__/server.spec.ts:201-206`, which writes a two-line log). Real-log tests use `generateWorkloadLog` from `src/parser/__tests__/helpers.ts`.

## Commands you will need

| Purpose                   | Command                                         | Expected on success                              |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------ |
| Format + lint + typecheck | `vp check --fix`                                | `Found no warnings, lint errors, or type errors` |
| One test file             | `vp test src/parser/__tests__/parseLog.spec.ts` | passes                                           |
| All tests                 | `vp test`                                       | all pass                                         |

## Scope

**In scope**:

- `src/parser/parseLog.ts`
- `src/parser/__tests__/parseLog.spec.ts`
- `.bumpy/003-script-urls.md` (create)

**Out of scope**:

- `src/sourcemaps/resolver.ts`, `src/lsp/server.ts`, `src/cli/ci.ts` — they consume normalized URLs once the parser emits them; no edits.
- `src/analysis/compare.ts` — identity format unchanged.
- Non-`file:` URLs (`node:`, `data:`): leave untouched; they never carry loader queries.

## Git workflow

- Branch: `advisor/003-script-urls` from `main`.
- Suggested commit: `Parser: strip loader query strings from script URLs`.
- Bump file `.bumpy/003-script-urls.md` with `"deoptkit": patch` and the body: `Script URLs are normalized at parse time: loader cache-busting queries such as Vitest's ?vitest=<timestamp> no longer leak into finding identities, baselines, source-map lookups, or LSP diagnostics.`
- Do NOT push or open a PR unless the operator instructed it. No attribution lines.

## Steps

### Step 1: Add the normalizer

In `src/parser/parseLog.ts`, near `SOURCE_REF_RE`, add and export:

```ts
/**
 * Loaders append cache-busting queries to file URLs (Vitest `?vitest=<ts>`, Vite
 * `?t=`); they do not identify a different script, so drop them at the model
 * boundary. Non-file URLs pass through untouched.
 */
export const normalizeScriptUrl = (url: string): string => {
  if (!url.startsWith("file:")) return url;
  const cut = url.search(/[?#]/u);
  return cut === -1 ? url : url.slice(0, cut);
};
```

**Verify**: `vp check` → clean (the export is unused for now; oxlint does not flag unused exports).

### Step 2: Apply it at every entry point

- `splitEntryName`: `file: normalizeScriptUrl(match.groups["file"] ?? "")` (keep the `undefined` fallback branch as is).
- `script-source`: `scripts.set(normalizeScriptUrl(url), source)`.
- `code-deopt`: normalize the `file` of the site position (and of every `inlinedAt` entry if plan 001 landed) before building `siteKey`.

Note on ordering: `SOURCE_REF_RE` splits on the last two `:` groups, so a query like `?vitest=123` sits inside the `file` group and is stripped correctly by Step 1; a query containing `:digits:digits` at its very end is not a case any known loader produces (see STOP conditions).

**Verify**: `vp check --fix` → clean; `vp test src/parser/__tests__/parseLog.spec.ts` → passes.

### Step 3: Tests

In `src/parser/__tests__/parseLog.spec.ts` add:

1. Unit tests for `normalizeScriptUrl`: `file:///C:/app/lib.ts?vitest=123` → `file:///C:/app/lib.ts`; `file:///app/x.js?t=1#frag` → `file:///app/x.js`; `node:internal/x` unchanged; a URL without a query unchanged.
2. A synthetic-log test: write a temp file with these lines (one per line, exact field counts matter):

   ```
   v8-version,14,6,0,0,-node.1,0
   code-creation,JS,10,50,0x1000,64,getX file:///C:/app/lib.ts?vitest=123:2:49,0x2fcf,+'
   script-source,84,file:///C:/app/lib.ts?vitest=123,export const getX = (o) => o.x;
   LoadIC,0x1010,100,2,49,1,N,0x2,x
   ```

   Parse it and assert: `model.ics[0].file === "file:///C:/app/lib.ts"`, `model.scripts.has("file:///C:/app/lib.ts")`, `model.functionIndex[0].file === "file:///C:/app/lib.ts"`, and no key in `model.scripts` contains `?`. Comment: Vitest's native loader appends `?vitest=<timestamp>` to every bench file it imports; without normalization each run produces a different finding identity, so CI baselines never match.

**Verify**: `vp test` → all pass.

## Test plan

- New: 4 unit assertions for `normalizeScriptUrl`; 1 synthetic-log integration test covering code map, script sources, and IC attribution.
- Pattern: `src/__tests__/server.spec.ts:201-206` for writing a minimal log to a temp dir.
- Verification: `vp test` → all pass.

## Done criteria

- [ ] `vp check` exits 0
- [ ] `vp test` exits 0 with the new tests passing
- [ ] `grep -n "normalizeScriptUrl" src/parser/parseLog.ts` shows the definition plus at least three call sites
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- The excerpts do not match the live code (beyond the plan 001 change noted in the drift check).
- A real log generated by `generateWorkloadLog` starts producing `badLines > 0` after the change (run the full `parseLog.spec.ts`; its `counts unhandled commands` test asserts `badLines === 0`).
- You find file URLs in real logs whose query contains `:<digits>:<digits>` at the end; the regex ordering assumption would then be wrong and needs the maintainer's input.

## Maintenance notes

- Normalization is the single choke point for script identity; any new handler that reads a URL from a log field must call `normalizeScriptUrl`. Reviewers should grep for new `file:` consumers in the parser.
- POSIX paths can legally contain `?`; this tool now treats everything after the first `?` in a `file:` URL as a query. Document this in `docs/recipes.md` only if a user reports it.
