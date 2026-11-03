# Plan 005: Make the vitest preset write `findings.json` so the editor loop closes

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md` — unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat b733901..HEAD -- src/vitest src/cli/ci.ts src/lsp/server.ts README.md docs/BENCHMARKING.md docs/SPEC.md` and `git status --short` on the same paths. Confirm plan 004 is DONE and `src/vitest/__tests__/e2eProject.ts` exists. Compare the excerpts below against the live code; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/004-vitest-preset-e2e-test.md
- **Category**: bug (documented behavior not implemented)
- **Planned at**: commit `b733901`, 2026-11-03

## Why this matters

The headline developer experience in the README and in BENCHMARKING §8 is: run `vitest bench --watch`, the preset rewrites `.deopt/findings.json`, and `deoptkit lsp` turns the findings into squiggles. Today the preset's teardown writes only `manifest.json`; `findings.json` is written exclusively by `deoptkit ci`, which profiles standalone scripts, not Vitest workers. A Vitest user who follows the docs gets no diagnostics at all. All the pieces exist in the same package: `parseLog`, `computeFindings`, `SourceMapResolver`, and the interchange format `deoptkit ci` already writes and the LSP already validates. The teardown runs once in the main Vitest process after all workers exit, which is the right place.

## Current state

- `src/vitest/globalSetup.ts` (60 lines) — `teardown` at lines 45–60:

  ```ts
  /** After the bench run, list the V8 logs the workers produced for `load_manifest`. */
  export const teardown = async (): Promise<void> => {
    const outDir = requireOutDir();
    const entries = await readdir(outDir);
    const manifest: DeoptKitManifest = {
      createdAt: new Date().toISOString(),
      outDir,
      logfiles: entries
        .filter((name) => /^v8-.*\.log$/u.test(name))
        .map((name) => join(outDir, name))
    };
    await writeFile(
      join(outDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
  };
  ```

- `src/cli/ci.ts` — the producer of the interchange today. `LocatedFinding` (lines 100–102) is `Finding & { original?: { file; line; column } }`; `analyzeScript` (lines 112–134) maps `computeFindings(model)` through `resolver.resolve(found.file, found.line, found.column)`; the file is written at lines 237–241 as `{ createdAt, findings: allFindings }` where each finding also carries `script`.
- `src/lsp/server.ts` — `findingsFileSchema` (lines 28–31) requires `createdAt: string` and `findings: Array<{ kind, severity, file, line, column, summary, explanation?, suggestedFix?, original? }>`; unknown keys are ignored by Valibot's `v.object`. `toDiagnostics(payload, staleFor)` (lines 76–102) is exported and pure.
- `src/sourcemaps/resolver.ts` — `SourceMapResolver(model).resolve(file, line, column)` returns `{ file, line, column } | undefined`; `withOriginal(resolver, item)` attaches `original` when it resolves.
- Docs that describe the intended behavior: `README.md:110` ("`deoptkit ci` (and the vitest workflow) write `.deopt/findings.json`"), `README.md:116` (the watch loop sentence), `docs/BENCHMARKING.md:109` and the §4 list (which still says `poolOptions.forks.execArgv`), `docs/SPEC.md` §8 (same stale key).
- `vite.config.ts` bundles `src/vitest/globalSetup.ts` as its own entry (`vitest-global-setup`), so importing the parser from it is fine; the bundle grows by the parser and findings code (about 60 kB, the same chunk `dist/main.mjs` already shares).

Conventions: relative imports within `src`; errors that should not abort a run are written to `process.stderr` with a `deoptkit:` prefix (see `src/lsp/server.ts:219`); markdown soft-wrapped.

## Commands you will need

| Purpose                   | Command                                           | Expected on success                                      |
| ------------------------- | ------------------------------------------------- | -------------------------------------------------------- |
| Format + lint + typecheck | `vp check --fix`                                  | clean                                                    |
| E2E test file             | `vp test src/vitest/__tests__/preset.e2e.spec.ts` | passes                                                   |
| All tests                 | `vp test`                                         | all pass                                                 |
| Build                     | `vp pack`                                         | `Build complete`; `dist/vitest-global-setup.mjs` present |

## Scope

**In scope**:

- `src/vitest/globalSetup.ts`
- `src/vitest/__tests__/preset.e2e.spec.ts` (extend)
- `src/vitest/__tests__/preset.spec.ts` (extend the teardown test)
- `README.md` (lines 110–116 area), `docs/BENCHMARKING.md` (§4 list and §8 sentence), `docs/SPEC.md` (§8 paragraph)
- `.bumpy/005-preset-findings.md` (create)

**Out of scope**:

- `src/cli/ci.ts` — do not refactor it to share code; a small duplication of the "findings with original positions" mapping is acceptable here (CLAUDE.md Rule 2). If you find yourself needing more than ten shared lines, STOP and propose a shared helper instead.
- `src/lsp/**` — the schema already accepts the payload.
- The manifest format — unchanged; `load_manifest` depends on it.

## Git workflow

- Branch: `advisor/005-preset-findings` from `main`.
- Suggested commit: `Vitest preset: write findings.json on teardown so the LSP loop closes`.
- Bump file `.bumpy/005-preset-findings.md` with `"deoptkit": minor` and body: `The deoptkit/vitest preset now writes <outDir>/findings.json after each bench run (findings with source-mapped original positions), so deoptkit lsp shows diagnostics straight from vitest bench runs.`
- Do NOT push or open a PR unless the operator instructed it. No attribution lines.

## Steps

### Step 1: Extend the teardown

In `src/vitest/globalSetup.ts`:

- Import `parseLog` from `../parser/parseLog`, `computeFindings` and `type Finding` from `../analysis/findings`, and `SourceMapResolver` from `../sourcemaps/resolver`.
- After writing the manifest, iterate `manifest.logfiles` sequentially (memory: each parsed model is tens of MB). For each: `const model = await parseLog(logfile)`, `const resolver = new SourceMapResolver(model)`, map `computeFindings(model)` to `{ ...finding, original?, script: logfile }` using `resolver.resolve(finding.file, finding.line, finding.column)`. Wrap each log in `try/catch`; on failure write `deoptkit: could not analyze ${logfile}: ${message}\n` to `process.stderr` and continue.
- Write `join(outDir, "findings.json")` as `{ createdAt: new Date().toISOString(), outDir, findings }` with two-space indentation and a trailing newline, matching `ci.ts`.
- Export the interchange type: `export interface DeoptKitFindingsFile { createdAt: string; outDir: string; findings: Array<Finding & { original?: { file: string; line: number; column: number }; script: string }>; }`.

**Verify**: `vp check --fix` → clean. `vp pack` → `Build complete`.

### Step 2: Unit-level coverage of the teardown

In `src/vitest/__tests__/preset.spec.ts`, extend `writes a manifest of produced logs on teardown`: instead of the fake `v8-12345.log` with a one-line body, generate a real log into `outDir` with `generateWorkloadLog("map-churn", outDir)` renamed to `v8-12345.log` (or write it directly under that name by passing the workload name; check the helper's signature at `src/parser/__tests__/helpers.ts:29`), then after `teardown()` assert `findings.json` exists, `findings.length > 0`, every finding has `script === join(outDir, "v8-12345.log")`, and at least one has `kind === "megamorphic-ic"`. Keep the manifest assertions. Raise the test timeout to `60_000`. Comment: the interchange is what the LSP reads; a teardown that writes the manifest but no findings leaves editors blind.

**Verify**: `vp test src/vitest/__tests__/preset.spec.ts` → passes.

### Step 3: End-to-end assertion

In `src/vitest/__tests__/preset.e2e.spec.ts` add a test "the teardown writes findings.json that the LSP can publish": read `<outDir>/findings.json`, assert it contains a `megamorphic-ic` with `evidence.key === "x"` and an `original` whose `file` ends with `lib.ts` and `line === 2`; then call `toDiagnostics(payload, () => false)` (import from `../../lsp/server`) and assert the map has a key ending in `lib.ts` whose first diagnostic has `range.start.line === 1` (0-based) and `code === "megamorphic-ic"`.

**Verify**: `vp test src/vitest/__tests__/preset.e2e.spec.ts` → all tests pass.

### Step 4: Docs

- `README.md` around line 116: make the loop sentence true and specific: `vitest bench --watch` rewrites `.deopt/findings.json` on every run, and `deoptkit lsp` republishes. Remove the "re-run `ci`" intermediate step.
- `docs/BENCHMARKING.md` §4 list: item 1 says `poolOptions.forks.execArgv` → `execArgv`; item 3 becomes "Writes a manifest (`manifest.json`) and the findings interchange (`findings.json`, with source-mapped original positions) after the run."
- `docs/SPEC.md` §8 paragraph: `poolOptions.forks.execArgv` → `execArgv`.

Keep prose soft-wrapped (no inserted line breaks inside paragraphs).

**Verify**: `grep -rn "poolOptions" README.md docs/` → no matches.

### Step 5: Full verification

**Verify**: `vp check` → clean; `vp test` → all pass.

## Test plan

- Extended unit test in `preset.spec.ts` (teardown writes findings from a real log).
- New e2e test in `preset.e2e.spec.ts` (findings.json → LSP diagnostics).
- Pattern: existing tests in the same files.
- Verification: `vp test` → all pass.

## Done criteria

- [ ] `vp check` exits 0
- [ ] `vp test` exits 0; the two new/extended tests pass
- [ ] `grep -rn "poolOptions" README.md docs/ src/` returns nothing
- [ ] `vp pack` exits 0
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- Plan 004 is not DONE.
- The e2e run's `findings.json` has no `original` on the `lib.ts` finding: the module runner's inline source map did not reach the log (check that the log's `script-source` entry for `lib.ts` contains `sourceMappingURL=`); report rather than loosening the assertion.
- Bundling `globalSetup.ts` with the parser makes `vp pack` warn about `onlyBundle`/external hints you do not understand; report the warning text.

## Maintenance notes

- `ci.ts` and the teardown now both produce the interchange; if the format gains fields, change both and the LSP schema together. A follow-up could extract `locateFindings(model, resolver)` into `src/analysis/` once a third producer appears.
- Teardown time grows with log size (about 100 ms per 11 MB log); long bench suites with many workers will notice. Parallel parsing is deliberately avoided for memory; revisit if users report slow teardowns.
