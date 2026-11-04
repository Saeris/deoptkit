# Plan 002: Remove `development` export conditions that point at unshipped `src/`

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md` — unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat b733901..HEAD -- package.json vite.config.ts` and `git status --short package.json vite.config.ts`. The working tree already differs from `b733901` in `package.json` (dependency bumps from the toolchain migration); confirm the `exports` block still matches the excerpt below. On a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `b733901`, 2026-11-03

## Why this matters

Every entry in the package's `exports` map lists a `development` condition first, pointing at `./src/*.ts`. The `files` field ships only `dist/**` and `THIRD_PARTY_NOTICES.md`, so those targets do not exist in the published package. Conditional exports do not fall back when a selected target is missing: a resolver that applies the `development` condition fails outright. This was reproduced against a simulated tarball (package.json plus `dist/`): a Vitest 5 benchmark file importing `deoptkit/bench` under `experimental.viteModuleRunner: false` failed with `Cannot find module …/node_modules/deoptkit/src/bench/index.ts`. Vite's own resolver adds `development` whenever `NODE_ENV` is not `production`, which is the normal state inside Vitest, so the two surfaces built specifically for Vitest users (`deoptkit/vitest`, `deoptkit/bench`) are the ones most exposed. The condition is a monorepo convention carried over from the maintainer's other repositories (workspace consumers importing TypeScript source directly); this repository is a single published package with no workspace consumers, so the condition has no beneficiary here.

## Current state

- `package.json` — the `exports` block at lines 32–76 (excerpt below); `files` at lines 25–28 is `["dist/**/*", "THIRD_PARTY_NOTICES.md"]`.
- `vite.config.ts` — the `pack.entry.index` entry at line 11 reads the development path out of the manifest: `index: manifest.exports["."].import.development,`.
- No source or test file imports the package by its own name (`grep -rn "from \"deoptkit" src` matches only doc comments; the string `"deoptkit/vitest/global-setup"` at `src/vitest/index.ts:46` is a specifier resolved inside the consumer's project, not here).

Excerpt (`package.json`, lines 32–53, pattern repeats for `./vitest/global-setup`, `./bench`, `./serve`):

```json
  "exports": {
    ".": {
      "import": {
        "development": "./src/index.ts",
        "types": "./dist/index.d.mts",
        "default": "./dist/index.mjs"
      }
    },
    "./harness": {
      "import": {
        "development": "./src/harness/index.ts",
        "types": "./dist/harness.d.mts",
        "default": "./dist/harness.mjs"
      }
    },
    "./vitest": {
      "import": {
        "development": "./src/vitest/index.ts",
        "types": "./dist/vitest.d.mts",
        "default": "./dist/vitest.mjs"
      }
    },
```

Conventions: tests in `src/__tests__/*.spec.ts` with a comment stating why the behavior matters. JSON is formatted by `vp check --fix` (oxfmt).

## Commands you will need

| Purpose                   | Command              | Expected on success                                                          |
| ------------------------- | -------------------- | ---------------------------------------------------------------------------- |
| Install                   | `vp install`         | exit 0                                                                       |
| Format + lint + typecheck | `vp check --fix`     | `Found no warnings, lint errors, or type errors`                             |
| All tests                 | `vp test`            | all pass                                                                     |
| Build                     | `vp pack`            | `Build complete`; `dist/` contains `index.mjs`, `bench.mjs`, `vitest.mjs`, … |
| Tarball contents          | `npm pack --dry-run` | file list contains no `src/` entries                                         |

## Scope

**In scope** (the only files you should modify):

- `package.json` (the `exports` block only)
- `vite.config.ts` (line 11 only)
- `src/__tests__/packageExports.spec.ts` (create)
- `.bumpy/002-exports.md` (create)

**Out of scope**:

- `tsconfig.json` and `@saeris/configs` — the shared config may declare `customConditions`; it is irrelevant once nothing self-references the package by name. Do not edit.
- Any other `package.json` field (dependencies were just migrated; leave them).

## Git workflow

- Branch: `advisor/002-exports` from `main`.
- Suggested commit: `Package: drop development export conditions that point at unshipped src/`.
- Bump file `.bumpy/002-exports.md`:

  ```markdown
  ---
  "deoptkit": patch
  ---

  Removed the `development` export conditions, which pointed at TypeScript sources that are not part of the published package and broke resolution of `deoptkit/bench` and `deoptkit/vitest` under Vitest's native loader.
  ```

- Do NOT push or open a PR unless the operator instructed it. No attribution lines.

## Steps

### Step 1: Edit the exports map

Delete the six `"development": "./src/…"` lines (one per subpath) so each entry reads `{ "import": { "types": "./dist/….d.mts", "default": "./dist/….mjs" } }`. Leave `"./package.json": "./package.json"` as is.

**Verify**: `grep -c '"development"' package.json` → `0`.

### Step 2: Fix the pack entry

In `vite.config.ts` line 11 replace `manifest.exports["."].import.development` with the literal `"./src/index.ts"` so it matches the sibling entries on lines 12–17.

**Verify**: `vp check --fix` → clean. `vp pack` → `Build complete`, and `ls dist/index.mjs dist/bench.mjs dist/vitest.mjs dist/harness.mjs dist/serve.mjs dist/vitest-global-setup.mjs` lists all six.

### Step 3: Guard it with a test

Create `src/__tests__/packageExports.spec.ts` that imports `../../package.json` with `{ type: "json" }`, walks every value under `exports` (recursing into condition objects), and asserts each leaf target string either equals `./package.json` or starts with `./dist/`. Comment: the published tarball contains only `dist/`, so any export target outside it is unresolvable for consumers; this test exists because a `development` condition pointing at `src/` once broke `deoptkit/bench` for Vitest users.

**Verify**: `vp test src/__tests__/packageExports.spec.ts` → passes. Temporarily re-adding one `development` line must make it fail (then revert).

### Step 4: Confirm consumer resolution

With `dist/` built (Step 2), run from the repository root:

```
node --input-type=module -e "const m = await import('deoptkit/bench'); console.log(Object.keys(m))"
```

Node resolves a package's own name through its `exports` map when run inside the package directory.

**Verify**: prints `[ 'benchObserved' ]`.

## Test plan

- New: `src/__tests__/packageExports.spec.ts` (every export target is shipped).
- Pattern: a plain `describe`/`it` file; see `src/__tests__/sessions.spec.ts` for the minimal structure.
- Verification: `vp test` → all pass.

## Done criteria

- [ ] `grep -c '"development"' package.json` prints `0`
- [ ] `vp check` exits 0
- [ ] `vp test` exits 0 with the new test passing
- [ ] `vp pack` exits 0 and `npm pack --dry-run` lists no `src/` entries
- [ ] The Step 4 command prints `[ 'benchObserved' ]`
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- The `exports` block does not match the excerpt.
- `vp check` reports type-aware lint errors mentioning conditions or module resolution after Step 1 (the shared config might rely on the condition; report rather than editing `tsconfig.json`).
- Anything under `src/` imports `deoptkit/…` by name (none found at planning time).

## Maintenance notes

- If this repository ever becomes a Yarn workspace with a VSCode extension package that wants to import TypeScript source directly (see plan 009), add the `development` condition back only together with a build step that guarantees `dist/` is what gets published, and keep the new test's rule (targets must be shipped) in force by having it accept `./src/` only when `files` includes `src`.
