# Plan 004: End-to-end test for the `deoptkit/vitest` bench preset

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md` — unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat b733901..HEAD -- src/vitest src/bench package.json` and `git status --short src/vitest src/bench package.json`. The working tree differs from `b733901` here by design (the preset's `execArgv` fix and the `benchObserved` rewrite); confirm the live files match the excerpts below. Confirm plan 002 is DONE in `plans/README.md`.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/002-remove-development-export-conditions.md
- **Category**: tests
- **Planned at**: commit `b733901`, 2026-11-03

## Why this matters

The shipped 0.1.0 preset returned `poolOptions: { forks: { execArgv } }`. Vitest 4 had already removed `poolOptions`, so Vitest silently ignored the V8 flags and the preset never produced a single log; `load_manifest` would always report an empty manifest. The only test checked the returned object's shape, which is exactly the kind of test that cannot fail when the integration breaks. The fix (top-level `execArgv`) is in the working tree, but nothing proves it: no test spawns Vitest with the preset and asserts that a V8 log, a manifest, and `benchObserved` markers appear. This plan adds that test. It was prototyped during the audit against the built package: one forked worker, one `v8-<pid>.log`, markers `get_x_start`/`get_x_end`, and a `megamorphic-ic` finding on the probe library's `getX`, whose generated position (`lib.ts:3`) resolves through Vitest's inline source map to the original `lib.ts:2`.

Plan 005 (findings.json from the preset) and plan 006 (native ESM mode) extend this harness, so build it with reuse in mind.

## Current state

- `src/vitest/index.ts` — the preset (48 lines). Lines 13–17 and 43–47:

  ```ts
  export interface DeoptKitTestConfig {
    pool: "forks";
    execArgv: string[];
    globalSetup: string[];
  }
  // …
  return {
    pool: "forks",
    execArgv: v8FlagsFor(join(outDir, "v8-%p.log"), options.categories),
    globalSetup: ["deoptkit/vitest/global-setup"]
  };
  ```

- `src/vitest/globalSetup.ts` — `setup` refuses coverage; `teardown` (lines 45–60) writes `<outDir>/manifest.json` with `{ createdAt, outDir, logfiles }`.
- `src/bench/index.ts` — `benchObserved(bench, name, fn, options?)` registers a benchmark through the Vitest 5 `bench` fixture with `beforeAll`/`afterAll` hooks that call `mark(`${name}_start`)` / `mark(`${name}_end`)`.
- `src/vitest/__tests__/preset.spec.ts` — the existing shape-only tests; keep them.
- `package.json` — `exports` resolve `deoptkit/vitest`, `deoptkit/vitest/global-setup`, and `deoptkit/bench` to `dist/*.mjs` (after plan 002). `vp pack` builds `dist/`; the `vp` binary is `node_modules/vite-plus/bin/vp`. The Vitest CLI is `node_modules/vitest/vitest.mjs` (Vitest 5.0.5 via the Vite+ catalog).
- Benchmark discovery: Vitest 5 only runs files matching `benchmark.include` (default `**/*.{bench,benchmark}.?(c|m)[jt]s?(x)`) and only under `vitest bench` (or `benchmark.enabled`). The `bench` fixture is available only in those files.

Reference harness (verified during the audit; adapt, do not copy blindly). Temp project files:

`lib.ts`

```ts
export interface Shape {
  x: number;
  [k: string]: number;
}
export const getX = (obj: Shape): number => obj.x;
export const shapes: Shape[] = [
  { x: 1 },
  { a: 1, x: 2 },
  { a: 1, b: 2, x: 3 },
  { a: 1, b: 2, c: 3, x: 4 },
  { a: 1, b: 2, c: 3, d: 4, x: 5 },
  { a: 1, b: 2, c: 3, d: 4, e: 5, x: 6 },
  { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, x: 7 },
  { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, x: 8 }
];
```

`probe.bench.ts`

```ts
import { test } from "vitest";
import { benchObserved } from "deoptkit/bench";
import { getX, shapes } from "./lib.ts";

test("get x", async ({ bench }) => {
  await benchObserved(bench, "get x", () => {
    let sum = 0;
    for (let i = 0; i < 20_000; i++) sum += getX(shapes[i % shapes.length]!);
    return sum;
  }).run();
});
```

`vitest.config.mts`

```ts
import { defineConfig } from "vitest/config";
import { deoptKit } from "deoptkit/vitest";
export default defineConfig({
  test: {
    ...deoptKit({ outDir: "<absolute temp outDir, forward slashes>" }),
    benchmark: { include: ["**/*.bench.ts"] }
  }
});
```

Resolution inside the temp project is provided by two directory links in `<temp>/node_modules`: `vitest` → `<repo>/node_modules/vitest` and `deoptkit` → `<repo>` (the repository root, so the package's own `exports` map is exercised exactly as for an npm consumer). `fs.symlinkSync(target, path, "junction")` creates these on Windows without elevated privileges and creates ordinary symlinks elsewhere. Run Vitest with `cwd` set to the temp project: `spawnSync(process.execPath, [join(repo, "node_modules/vitest/vitest.mjs"), "bench", "--run", "--config", configPath], { cwd: temp, encoding: "utf8" })`. Observed result: exit 0, `Test Files 1 passed`, one `v8-<pid>.log`, `manifest.json`.

Conventions: tests in `__tests__/*.spec.ts`, intent comments on every test, real V8 output (nothing mocked), temp dirs from `mkdtemp(join(tmpdir(), "deoptkit-…"))` removed in `afterAll`, generous timeouts on spawning tests (`60_000`–`120_000`). Windows CI is a lane in `.github/workflows/ci.yml`, so the test must pass on Windows.

## Commands you will need

| Purpose                                               | Command                                           | Expected on success |
| ----------------------------------------------------- | ------------------------------------------------- | ------------------- |
| Build dist (the test does this itself in `beforeAll`) | `vp pack`                                         | `Build complete`    |
| One test file                                         | `vp test src/vitest/__tests__/preset.e2e.spec.ts` | passes              |
| All tests                                             | `vp test`                                         | all pass            |
| Format + lint + typecheck                             | `vp check --fix`                                  | clean               |

## Suggested executor toolkit

- `testing-best-practices` skill.
- Wallaby (`mcp__wallaby__wallaby_failingTests`) for iteration; note this test spawns processes and takes several seconds.

## Scope

**In scope**:

- `src/vitest/__tests__/preset.e2e.spec.ts` (create)
- `src/vitest/__tests__/e2eProject.ts` (create; the reusable harness: write files, link `node_modules`, run Vitest, parse logs, clean up)
- `.bumpy/004-preset-e2e.md` (create, empty bump: tests only)

**Out of scope**:

- `src/vitest/index.ts`, `src/vitest/globalSetup.ts`, `src/bench/index.ts` — the code under test; if the test reveals a bug, STOP and report it instead of fixing it here.
- `vite.config.ts` test config — the new file matches the existing `include` pattern `**/*.{test,spec}.{ts,tsx}`.
- CI workflow files.

## Git workflow

- Branch: `advisor/004-preset-e2e` from `main`.
- Suggested commit: `Tests: run the vitest bench preset end to end against the built package`.
- Empty bump file `.bumpy/004-preset-e2e.md` with frontmatter `"deoptkit": none` and body `Added an end-to-end test for the vitest bench preset (no runtime change).`
- Do NOT push or open a PR unless the operator instructed it. No attribution lines.

## Steps

### Step 1: Build the harness module

Create `src/vitest/__tests__/e2eProject.ts` exporting:

- `createE2eProject(options: { name: string; configExtra?: string }): Promise<E2eProject>` which: makes `mkdtemp(join(tmpdir(), "deoptkit-e2e-"))`; writes `lib.ts`, `probe.bench.ts`, and `vitest.config.mts` (from the reference above; `configExtra` is spliced into the `test` object so plan 006 can add `experimental` options); creates `node_modules/vitest` and `node_modules/deoptkit` links with `symlinkSync(target, path, "junction")`; returns `{ dir, outDir, configPath, run(): SpawnSyncReturns<string>, cleanup(): Promise<void> }`.
- `cleanup` must remove the two links with `unlinkSync` (or `rmSync` on the link path only) **before** `rm(dir, { recursive: true, force: true })`, then assert `existsSync(join(repo, "node_modules/vitest/package.json"))` and `existsSync(join(repo, "package.json"))` so a recursion into a link target can never pass silently.
- `ensureDist()`: if `join(repo, "dist/vitest.mjs")` is missing, run `spawnSync(process.execPath, [join(repo, "node_modules/vite-plus/bin/vp"), "pack"], { cwd: repo })` and throw on non-zero status. The repo root is `join(import.meta.dirname, "..", "..", "..")`.

Use forward slashes in the paths written into the config file (`.replaceAll("\\", "/")`).

**Verify**: `vp check --fix` → clean.

### Step 2: Write the test

Create `src/vitest/__tests__/preset.e2e.spec.ts`:

- `beforeAll`: `ensureDist()`, `createE2eProject({ name: "runner" })`, `run()`; timeout `120_000`.
- Test "forked bench workers run under V8 logging and the teardown writes the manifest": exit status `0`; stdout contains `Test Files  1 passed`; `manifest.json` parses with `logfiles.length >= 1`; every listed logfile exists and matches `/v8-\d+\.log$/`. Comment: the 0.1.0 preset emitted a config key Vitest ignores and produced no log at all; only a real spawn can prove the flags reach workers.
- Test "benchObserved brackets the case with markers": parse each log with `parseLog` (import from `../../parser/parseLog`); at least one log has markers including `get_x_start` and `get_x_end`, and `get_x_start`'s first time is `<` `get_x_end`'s last time.
- Test "findings in a bench worker locate user code and resolve to original positions": `computeFindings(model)` contains a `megamorphic-ic` whose `evidence.key === "x"` and whose `file` ends with `lib.ts`; `new SourceMapResolver(model).resolve(file, line, column)` returns an original position whose `file` ends with `lib.ts` and `line === 2` (the `getX` line). Comment: Vite's module runner serves transformed code, so generated lines differ from source; the inline source map is what makes the finding editable.
- `afterAll`: `cleanup()`; unset `process.env["DEOPTKIT_OUT_DIR"]` (the preset sets it in whichever process evaluates the config; the spawned Vitest process did, not this one, but keep the test hygienic).

**Verify**: `vp test src/vitest/__tests__/preset.e2e.spec.ts` → 3 tests pass.

### Step 3: Full run

**Verify**: `vp test` → all files pass; `vp check` → clean; `git status --short` shows only the in-scope files and (if generated) `dist/` is ignored.

## Test plan

- New: 3 tests as above in `preset.e2e.spec.ts`.
- Pattern: `src/cli/__tests__/ci.spec.ts` (temp dir, spawn-backed, long timeouts).
- Verification: `vp test` → all pass, including on the Windows CI lane.

## Done criteria

- [ ] `vp check` exits 0
- [ ] `vp test` exits 0; `preset.e2e.spec.ts` contains 3 passing tests
- [ ] After a run, the temp project is gone and `node_modules/vitest/package.json` still exists in the repository
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- Plan 002 is not DONE (resolution through `exports` could select `src/` paths).
- `symlinkSync(…, "junction")` throws `EPERM`/`EACCES` on your machine or CI; report the platform and error rather than substituting a copy of `node_modules`.
- The spawned Vitest run exits 0 but produces no `v8-*.log`: that is a preset bug, which this plan must report, not fix.
- The `megamorphic-ic` finding is absent: check the probe body ran at least 20,000 iterations (tinybench may stop early on very fast functions); if raising iterations to 100,000 still yields no megamorphic site, report.

## Maintenance notes

- The harness resolves `deoptkit` through the real `exports` map against `dist/`, so it also acts as a publish-shape check; keep `ensureDist()` rather than aliasing to `src/`.
- Plan 005 adds `findings.json` assertions here; plan 006 adds a second project with `configExtra` enabling native ESM.
- If Vitest changes the `bench` fixture or `benchmark.include` default, this is the test that will fail first; read its stdout in the failure output before touching the preset.
