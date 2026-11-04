# Plan 006: Add an opt-in `nativeEsm` mode to the vitest preset

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md` — unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat b733901..HEAD -- src/vitest docs/recipes.md README.md` and `git status --short` on those paths. Confirm plans 002, 003, and 004 are DONE. Compare the excerpts below with the live code; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED
- **Depends on**: plans/002-remove-development-export-conditions.md, plans/003-normalize-script-url-queries.md, plans/004-vitest-preset-e2e-test.md
- **Category**: dx
- **Planned at**: commit `b733901`, 2026-11-03

## Why this matters

By default Vitest executes benchmark files through Vite's module runner, which rewrites every module before V8 sees it: imports become property reads on module-namespace objects, modules are wrapped in functions, and line numbers shift (recovered later through inline source maps). For a tool whose purpose is to show what V8 does to the user's code, that is a layer of indirection: in the audit's probe, two of the five IC sites attributed to the bench file were loads of the imported bindings `getX` and `shapes`, which do not exist as property accesses in the shipped code. Vitest 5 provides `experimental.viteModuleRunner: false` so Node imports the files natively (TypeScript via Node's built-in type stripping, which preserves positions), and `experimental.nodeLoader: false` to disable the transform loader that only exists for `vi.mock` and `import.meta.vitest`. In native mode the probe reported the megamorphic site at its true position (`lib.ts:2:49`) with no synthetic sites. Native mode also exposed two things that are why this stays opt-in for now: Vitest appends `?vitest=<timestamp>` to script URLs (fixed by plan 003), and an inlined copy of the hot IC is attributed to the caller's file and out-ranks the real site (severity 66 vs 35) until inlining-aware attribution lands (see "awaiting selection" in `plans/README.md`).

## Current state

- `src/vitest/index.ts` (48 lines). `DeoptKitPresetOptions` (lines 6–11) has `outDir?` and `categories?`; `DeoptKitTestConfig` (lines 13–17) has `pool`, `execArgv`, `globalSetup`; the return at lines 43–47 builds those three keys.
- Vitest 5.0.5 types (`node_modules/vitest/dist/chunks/plugin.d.*.d.ts`, search for `viteModuleRunner`): under `test.experimental`, `viteModuleRunner?: boolean` ("Controls whether Vitest uses Vite's module runner to run the code or fallback to the native `import`", default `true`) and `nodeLoader?: boolean` ("If module runner is disabled, Vitest uses a module loader to transform files to support `import.meta.vitest` and `vi.mock`… If you don't use these features, you can disable this").
- `src/vitest/__tests__/e2eProject.ts` (from plan 004) accepts `configExtra` spliced into the `test` object, and `preset.e2e.spec.ts` runs the module-runner project.
- `docs/recipes.md` "Vitest bench mode" section and `README.md` "Vitest bench mode" section document the preset options.

Requirements for native mode that the docs must state: Node ≥ 22.18 (or ≥ 23.6) so `.ts` bench files load without flags; bench files must be plain ESM resolvable by Node (relative imports with extensions, no Vite aliases or plugins); the code under observation should be built output, which is already this project's guidance (`docs/BENCHMARKING.md` §2.3).

## Commands you will need

| Purpose                   | Command                                           | Expected on success |
| ------------------------- | ------------------------------------------------- | ------------------- |
| Format + lint + typecheck | `vp check --fix`                                  | clean               |
| E2E tests                 | `vp test src/vitest/__tests__/preset.e2e.spec.ts` | passes              |
| All tests                 | `vp test`                                         | all pass            |
| Build                     | `vp pack`                                         | `Build complete`    |

## Scope

**In scope**:

- `src/vitest/index.ts`
- `src/vitest/__tests__/preset.spec.ts` (extend)
- `src/vitest/__tests__/preset.e2e.spec.ts` (extend)
- `docs/recipes.md`, `README.md` (the Vitest bench mode sections only)
- `.bumpy/006-native-esm.md` (create)

**Out of scope**:

- Making native mode the default (a later decision once inlining attribution lands).
- `src/parser/**` — URL normalization is plan 003; do not add workarounds here.
- `src/bench/index.ts` — unchanged.

## Git workflow

- Branch: `advisor/006-native-esm` from `main`.
- Suggested commit: `Vitest preset: opt-in nativeEsm mode runs bench files without Vite's module runner`.
- Bump file `.bumpy/006-native-esm.md` with `"deoptkit": minor` and body: `deoptKit({ nativeEsm: true }) runs bench workers on Node's native ESM loader instead of Vite's module runner, so V8 observes exactly the shipped code at exact source positions.`
- Do NOT push or open a PR unless the operator instructed it. No attribution lines.

## Steps

### Step 1: Add the option

In `src/vitest/index.ts`:

- `DeoptKitPresetOptions` gains `/** Run bench files on Node's native ESM loader instead of Vite's module runner (exact positions, no transform artifacts; requires Node >= 22.18 for .ts files and plain ESM imports). Default false. */ nativeEsm?: boolean;`
- `DeoptKitTestConfig` gains `experimental?: { viteModuleRunner: false; nodeLoader: false };`
- The return includes `...(options.nativeEsm === true ? { experimental: { viteModuleRunner: false as const, nodeLoader: false as const } } : {})`.
- Extend the doc comment with one paragraph on the trade-off (positions and fidelity vs. no Vite transforms).

**Verify**: `vp check --fix` → clean.

### Step 2: Unit test

In `preset.spec.ts` add: `deoptKit({ outDir })` has no `experimental` key; `deoptKit({ outDir, nativeEsm: true }).experimental` equals `{ viteModuleRunner: false, nodeLoader: false }`. Comment: the module runner rewrites imports into property reads that V8 then reports as IC sites; native mode is what makes "the code V8 sees is the code you ship" true.

**Verify**: `vp test src/vitest/__tests__/preset.spec.ts` → passes.

### Step 3: End-to-end test in native mode

In `preset.e2e.spec.ts` add a second project (`createE2eProject({ name: "native", configExtra: "nativeEsm: true" })`, adjusting the harness so `nativeEsm` is passed into the `deoptKit({...})` call rather than spliced beside it, if that is how `configExtra` was implemented). Assert after `run()`: exit 0; a `megamorphic-ic` finding with `evidence.key === "x"` whose `file` ends with `lib.ts`, has no `?` in it, and whose `line === 2` and `functionName === "getX"` **without** source-map resolution (native mode preserves positions); and that no finding's `file` contains `?vitest=`. Do not assert the absence of a second `x` finding on the bench file (known inlining limitation, documented in this plan's "Why this matters"). Comment accordingly.

**Verify**: `vp test src/vitest/__tests__/preset.e2e.spec.ts` → all pass (both projects).

### Step 4: Docs

In `docs/recipes.md` (Vitest bench mode section) add a short paragraph: when to use `nativeEsm: true`, the Node version requirement, the plain-ESM requirement, and the current caveat that inlined call sites can appear twice. Add a one-line mention in `README.md`'s Vitest section pointing at the recipe. Soft-wrapped prose.

**Verify**: `grep -n "nativeEsm" README.md docs/recipes.md` → at least one match in each.

### Step 5: Full verification

**Verify**: `vp check` → clean; `vp test` → all pass; `vp pack` → ok.

## Test plan

- Unit: option on/off shape (2 assertions).
- E2E: native project produces exact-position findings with clean URLs.
- Pattern: plan 004's tests.
- Verification: `vp test` → all pass.

## Done criteria

- [ ] `vp check` exits 0
- [ ] `vp test` exits 0, including the native e2e project
- [ ] `grep -n "nativeEsm" src/vitest/index.ts README.md docs/recipes.md` matches in all three
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- Plans 002, 003, or 004 are not DONE.
- The native run fails with `Cannot find module …/src/…` (plan 002 regressed) or with a TypeScript syntax error from Node (the CI Node version is below 22.18; report the version).
- Vitest 5.0.5's `experimental` type does not accept `nodeLoader` or `viteModuleRunner` (check the type file named in "Current state"); report the exact option names you find instead.

## Maintenance notes

- When inlining-aware attribution lands, revisit the default: native mode should become the default and the module-runner mode the opt-out.
- `experimental.*` options can be renamed by Vitest; the e2e test is the canary. Pin the option names in one place (the preset) so a rename is a one-line change.
