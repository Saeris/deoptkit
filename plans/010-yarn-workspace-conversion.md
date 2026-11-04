# Plan 010: Convert the repository to a Yarn workspace with `deoptkit` at `packages/deoptkit`

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md` — unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat f850bbe..HEAD -- package.json vite.config.ts tsconfig.json README.md .github/workflows src/vitest/__tests__/e2eProject.ts` must print nothing (no changes since this plan was written), and `git status --short` must be empty apart from `node_modules`. Compare the excerpts under "Current state" with the live files; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (plans 001–008 are DONE and no other executor is running)
- **Category**: tech-debt / migration
- **Planned at**: commit `f850bbe`, 2026-11-03

## Why this matters

The maintainer chose Option A of `docs/VSCODE_EXTENSION.md`: the VSCode extension for `deoptkit lsp` will live in this repository as a second workspace package that bundles the server and releases in lockstep with the engine through bumpy. That needs a Yarn workspace, and bumpy 1.19 only versions packages matched by the `workspaces` globs, so the npm package itself must move out of the root. The target layout is the maintainer's mirrordown convention: a private root that holds the toolchain, `packages/*` for npm packages, `extensions/*` for VSCode extensions. This plan performs only the mechanical conversion. Nothing the published package exports, ships, or does changes; consumers see the same tarball with the same `exports`, `bin`, and `files`.

## Current state

Verified at `f850bbe`. The repository is a single package at the root.

- `package.json` (root) is the published package `deoptkit` 0.1.0: no `private`, no `workspaces`, `"bin": "./dist/main.mjs"`, `"files": ["dist/**/*", "THIRD_PARTY_NOTICES.md"]`, `exports` pointing only at `./dist/*`, `peerDependencies.vitest: ">=5"` (optional), `scripts` (`ci`, `build`, `check`, `format`, `test`), `devDependencies` (`@saeris/configs`, `@types/node`, `@varlock/bumpy`, `@vitest/coverage-v8: catalog:`, `typescript: 6.0.3`, `vite-plus: catalog:`, `vitest: catalog:`), `resolutions` (`vite`, `vitest`), `engines.node: >=22`, `packageManager: yarn@4.18.1`, `dependencies` (`@jridgewell/trace-mapping`, `@modelcontextprotocol/sdk`, `@valibot/to-json-schema`, `valibot`).
- `vite.config.ts` (root), 37 lines:

  ```ts
  import { defineConfig } from "vite-plus";
  import { lint, fmt } from "@saeris/configs";
  import manifest from "./package.json" with { type: "json" };

  export default defineConfig({
    lint,
    fmt,
    // ── Builds (tsdown) ─────────────────────────────────────────────────
    pack: {
      entry: {
        index: "./src/index.ts",
        main: "./src/main.ts",
        harness: "./src/harness/index.ts",
        vitest: "./src/vitest/index.ts",
        "vitest-global-setup": "./src/vitest/globalSetup.ts",
        bench: "./src/bench/index.ts",
        serve: "./src/serve/index.ts"
      },
      clean: true,
      format: [`esm`],
      dts: true,
      outDir: `./dist`
    },
    // ── Testing (Vitest) ────────────────────────────────────────────────
    test: {
      name: manifest.name,
      globals: true,
      include: ["**/*.{test,spec}.{ts,tsx}"],
      // Claude Code executor worktrees live under .claude/; their copies of the
      // suite must not run as part of this checkout.
      exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**"],
      environment: "node",
      passWithNoTests: true
    }
  });
  ```

- `tsconfig.json` (root):

  ```json
  {
    "extends": "@saeris/configs/tsconfig",
    "include": ["**/*.ts"],
    "exclude": ["node_modules", "dist"],
    "compilerOptions": {
      // project-local paths live here, not in the shared base
      "outDir": "./dist",
      "rootDir": "."
    }
  }
  ```

- `.yarnrc.yml`: `catalog:` block (vite, vite-plus, vitest, @vitest/coverage-v8), `nodeLinker: node-modules`, `yarnPath: .yarn/releases/yarn-4.18.1.cjs`. Unchanged by this plan.
- `.bumpy/_config.json`: `packages.deoptkit.buildCommand: "vp pack"`. Bumpy runs it with the package directory as cwd, so it keeps working after the move. Unchanged by this plan.
- `.github/workflows/ci.yml`: steps `vp check` and `vp test` at the root; a comment at line 20 mentions `fixtures/workloads`. `.github/workflows/release.yml`: the `changes` job filters on `package.json` (lines 29–31) and the `publish` job runs a bare `vp pack` (line 86) before `bumpy ci release`.
- Tracked files that move: everything under `src/` (52 files) and `fixtures/` (5 files: `generate.mjs`, `workloads/*.js`; `fixtures/logs/**` is gitignored), plus `package.json`, `vite.config.ts`, `tsconfig.json`, `README.md`, `CHANGELOG.md`, `THIRD_PARTY_NOTICES.md`. `LICENSE.md` is copied (npm needs it in the package directory; the root keeps one too, as mirrordown does).
- Files that stay at the root: `.bumpy/`, `.github/`, `.yarn/`, `.yarnrc.yml`, `yarn.lock`, `.gitignore`, `.gitattributes`, `CLAUDE.md`, `LICENSE.md`, `docs/`, `plans/`.
- Code that resolves paths relative to the repository and therefore needs attention:
  - `src/vitest/__tests__/e2eProject.ts` lines 14–15, 56–67, 105–108, 117–128, 129–142: `REPO = join(import.meta.dirname, "..", "..", "..")` is used both as the package to link (`node_modules/deoptkit` → `REPO`) and as the place to find `node_modules/vitest` and `node_modules/vite-plus/bin/vp`. After the move, three levels up is `packages/deoptkit` (right for the package link, wrong for hoisted dependencies, which live in the root `node_modules`). Excerpt:

    ```ts
    /** Root of the checkout the tests run in, so nothing here hard-codes a path. */
    const REPO = join(import.meta.dirname, "..", "..", "..");
    ...
    export const ensureDist = (): void => {
      const result = spawnSync(
        process.execPath,
        [join(REPO, "node_modules", "vite-plus", "bin", "vp"), "pack"],
        { cwd: REPO, encoding: "utf8" }
      );
    ...
      const links = [
        [join(dir, "node_modules", "vitest"), join(REPO, "node_modules", "vitest")],
        [join(dir, "node_modules", "deoptkit"), REPO]
      ] as const;
    ...
        spawnSync(
          process.execPath,
          [
            join(REPO, "node_modules", "vitest", "vitest.mjs"),
            "bench",
            "--run",
            "--config",
            configPath
          ],
          { cwd: dir, encoding: "utf8" }
        ),
    ...
        if (
          !existsSync(join(REPO, "node_modules", "vitest", "package.json")) ||
          !existsSync(join(REPO, "package.json"))
        ) {
    ```

    Verified at `f850bbe`: `require.resolve("vitest/package.json")` and `require.resolve("vite-plus/package.json")` both resolve (the packages export `./package.json`), and `node_modules/vite-plus/bin/vp` exists.

  - `src/parser/__tests__/helpers.ts:4-11`, `src/cli/__tests__/ci.spec.ts:7-14`, `src/__tests__/server.spec.ts:153-160` locate `fixtures/workloads` three levels up from their `__tests__` directory. `fixtures/` moves together with `src/`, so these stay correct. Do not edit them.
  - `src/server.ts:29` (`../package.json`), `src/lsp/server.ts:7` (`../../package.json`), `src/__tests__/packageExports.spec.ts` (`../../package.json`), `vite.config.ts:3` (`./package.json`), `fixtures/generate.mjs` (`import.meta.url`-relative) are all relative within the package and move with it. Do not edit them.
- Docs that describe the layout: `README.md` (the full package README; its `src/...` and `fixtures/...` mentions become correct relative to the package directory once it moves; its `./docs/*.md` link targets do not), `docs/SPEC.md` §3 (a `src/` tree described as "Single package (this repo)").
- Suite baseline at `f850bbe`: `vp test` reports 16 test files and 80 tests, all passing. `vp check` prints `Found no warnings, lint errors, or type errors`.

The target layout is copied from mirrordown (`C:\GitHub\@saeris\markdown`, the maintainer's other workspace). Its relevant files are inlined here so you need not read that repository.

Root `package.json` of mirrordown (shape to copy; names differ):

```json
{
  "name": "@mirrordown/markdown",
  "private": true,
  "license": "MIT",
  "author": "Drake Costa <drake@saeris.io> (https://saeris.gg)",
  "repository": "git@github.com:mirrordown/mirrordown.git",
  "workspaces": ["docs", "extensions/*", "packages/*"],
  "type": "module",
  "scripts": { "prepare": "vp config" },
  "devDependencies": {
    "@saeris/configs": "^1.6.1",
    "@types/node": "^26.0.0",
    "@varlock/bumpy": "^1.15.0",
    "@vscode/vsce": "^3.9.2",
    "typescript": "^6.0.3",
    "vite-plus": "catalog:",
    "vitest": "catalog:"
  },
  "resolutions": {
    "vite": "npm:@voidzero-dev/vite-plus-core@1.4.0",
    "vitest": "5.0.5"
  },
  "packageManager": "yarn@4.17.0"
}
```

A mirrordown package's `vite.config.ts` (`packages/core`):

```ts
import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      build: { command: "vp pack", cache: true },
      dev: { command: "vp pack --watch", cache: false }
    }
  },
  pack: {
    entry: { index: "src/index.ts" },
    dts: true
  }
});
```

Mirrordown's root `vite.config.ts` carries `lint`, `fmt`, a `run.tasks.build` of `vp run -r build`, and the `test` block; package configs carry `pack`, `run.tasks`, and any package-specific test settings. Vite+ runs `vp check`, `vp lint`, and `vp fmt` from the root config across all packages (`node_modules/vite-plus/docs/guide/monorepo.md`), and `vp -C <dir> <command>` targets one package.

Conventions: Vite+ for everything (`vp install`, `vp check --fix`, `vp test`, `vp pack`); JSON and markdown are formatted by oxfmt through `vp check --fix`; markdown prose is soft-wrapped (never insert line breaks inside a paragraph); commit messages are `Area: imperative summary` with no attribution lines.

## Commands you will need

| Purpose                      | Command                                      | Expected on success                                                                            |
| ---------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Install (also after moves)   | `vp install`                                 | exit 0; `yarn.lock` updated                                                                    |
| Workspace membership         | `yarn workspaces list`                       | lists `.` and `packages/deoptkit`                                                              |
| Format + lint + typecheck    | `vp check --fix`                             | `Found no warnings, lint errors, or type errors`                                               |
| All tests (root)             | `vp test`                                    | 16 files, 80 tests pass                                                                        |
| Build the package            | `vp -C packages/deoptkit pack`               | `Build complete`; `packages/deoptkit/dist/main.mjs` exists                                     |
| Tarball contents             | `cd packages/deoptkit && npm pack --dry-run` | lists `dist/…`, `THIRD_PARTY_NOTICES.md`, `README.md`, `LICENSE.md`, `package.json`; no `src/` |
| Pending releases (read-only) | `vp dlx @varlock/bumpy status`               | lists `deoptkit` with its pending bumps                                                        |
| Wallaby (optional)           | `npx -y @wallabyjs/cli run --skill`          | a Markdown report whose `All Tests` section counts 80 tests                                    |

Run `vp install` once before anything else: a fresh worktree has no `node_modules`.

## Scope

**In scope** (the only files you may create, move, or modify):

- Root: `package.json`, `vite.config.ts`, `tsconfig.json`, `README.md`, `yarn.lock` (regenerated by `vp install`), `.github/workflows/ci.yml` (one comment), `.github/workflows/release.yml` (filter and build step), `docs/SPEC.md` (one sentence in §3), `.bumpy/010-workspace.md` (create).
- `packages/deoptkit/**`: the moved files, a copied `LICENSE.md`, and edits to the moved `package.json`, `vite.config.ts`, `tsconfig.json`, `README.md`, and `src/vitest/__tests__/e2eProject.ts`.

**Out of scope** (do NOT touch, even though they look related):

- `plans/*.md` including `plans/README.md`: the plans are historical records and the reviewer maintains the index.
- `.bumpy/_config.json`, `.yarnrc.yml`, `.gitignore`, `CLAUDE.md`, `docs/BENCHMARKING.md`, `docs/recipes.md`, `docs/VSCODE_EXTENSION.md`.
- Every file under `src/` other than `src/vitest/__tests__/e2eProject.ts`, and everything under `fixtures/`: they move, their contents do not change.
- No `extensions/` directory yet (plan 009 creates it); the `workspaces` glob for it is declared now so plan 009 need not touch the root manifest.

## Git workflow

- Branch: you are already on `exec/plan-010` in a dedicated worktree; stay there.
- Two commits, so history stays readable: first the pure moves (`git mv` only, no content edits) as `Repo: move the deoptkit package to packages/deoptkit`, then everything else as `Repo: convert to a Yarn workspace (private root, packages/*, extensions/*)`. The first commit will not pass `vp check`; that is expected and why the second follows immediately.
- Bump file `.bumpy/010-workspace.md`:

  ```markdown
  ---
  "deoptkit": patch
  ---

  The package now lives at `packages/deoptkit` inside a Yarn workspace and declares `repository.directory`; nothing it ships or exports changed.
  ```

- Do NOT push or open a PR. No attribution lines in commit messages.

## Steps

### Step 0: Baseline

Run `vp install`, then `vp test` and note the reported counts (expected 16 files / 80 tests) and `vp check` (expected clean).

**Verify**: both commands succeed with those results before any file moves.

### Step 1: Move the package with `git mv`

```
mkdir -p packages/deoptkit
git mv src fixtures package.json vite.config.ts tsconfig.json README.md CHANGELOG.md THIRD_PARTY_NOTICES.md packages/deoptkit/
cp LICENSE.md packages/deoptkit/LICENSE.md
git add packages/deoptkit/LICENSE.md
```

Commit as `Repo: move the deoptkit package to packages/deoptkit`.

**Verify**: `git show --stat HEAD | grep -c "=>"` prints at least 60 (renames), and `git status --short` is empty.

### Step 2: Write the private root `package.json`

Create a new root `package.json`:

```json
{
  "name": "deoptkit-workspace",
  "private": true,
  "license": "MIT",
  "author": "Drake Costa <drake@saeris.gg> (https://saeris.gg)",
  "repository": {
    "type": "git",
    "url": "https://github.com/Saeris/deoptkit.git"
  },
  "workspaces": ["packages/*", "extensions/*"],
  "type": "module",
  "scripts": {
    "ci": "vp check && vp test",
    "build": "vp run -r build",
    "check": "vp check",
    "format": "vp check --fix",
    "test": "vp test --fileParallelism"
  },
  "devDependencies": {
    "@saeris/configs": "^1.6.1",
    "@types/node": "^26.6.6",
    "@varlock/bumpy": "^1.19.0",
    "@vitest/coverage-v8": "catalog:",
    "typescript": "6.0.3",
    "vite-plus": "catalog:",
    "vitest": "catalog:"
  },
  "resolutions": {
    "vite": "npm:@voidzero-dev/vite-plus-core@1.4.0",
    "vitest": "5.0.5"
  },
  "engines": {
    "node": ">=22"
  },
  "packageManager": "yarn@4.18.1"
}
```

Then edit `packages/deoptkit/package.json`: replace `scripts` with `{ "build": "vp pack", "test": "vp test" }`, reduce `devDependencies` to `{ "vitest": "catalog:" }` (the package imports Vitest types and lists it as an optional peer), remove `resolutions` and `packageManager` (root-only fields in a workspace), and add `"directory": "packages/deoptkit"` inside `repository` so npm resolves the README's relative links against the package directory. Keep every other field exactly as it is (`name`, `version`, `description`, `keywords`, `homepage`, `license`, `author`, `files`, `type`, `sideEffects`, `bin`, `exports`, `peerDependencies`, `peerDependenciesMeta`, `publishConfig`, `engines`, `dependencies`).

**Verify**: `vp install` → exit 0 and `yarn workspaces list` prints two entries: `.` and `packages/deoptkit` (yarn prefixes each line with `YN0000`).

### Step 3: Split the Vite+ config

Root `vite.config.ts` (new content):

```ts
import { defineConfig } from "vite-plus";
import { lint, fmt } from "@saeris/configs";

export default defineConfig({
  lint,
  fmt,
  run: {
    tasks: {
      build: { command: "vp run -r build", cache: true }
    }
  },
  // Each workspace package carries its own Vitest settings; the root only lists them.
  test: {
    projects: ["packages/*"]
  }
});
```

`packages/deoptkit/vite.config.ts`: remove the `lint`/`fmt` import and keys (they are root-only; Vite+ applies the root settings across packages and recommends against package-level `lint`/`fmt` blocks), keep the `pack` and `test` blocks unchanged, and add the `run.tasks.build` entry so `vp run -r build` works:

```ts
import { defineConfig } from "vite-plus";
import manifest from "./package.json" with { type: "json" };

export default defineConfig({
  run: {
    tasks: {
      build: { command: "vp pack", cache: true }
    }
  },
  // ── Builds (tsdown) ─────────────────────────────────────────────────
  pack: {
    // unchanged
  },
  // ── Testing (Vitest) ────────────────────────────────────────────────
  test: {
    // unchanged
  }
});
```

`test.projects` is a Vitest 5 option (`TestProjectConfiguration[]`, see `node_modules/vitest/dist/chunks/config.d.*.d.ts`); a directory glob selects each package's own `vite.config.ts`.

**Verify**: `vp test` from the root runs the package's suite: the output names the project `deoptkit` and reports 16 test files and 80 tests passing. If the root run discovers zero tests, try the fallback before stopping: replace the root `test` block with `test: { include: ["packages/*/src/**/*.{test,spec}.ts"], exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**"], environment: "node", globals: true }` and keep the package block for `vp -C packages/deoptkit test`. If neither form runs the 80 tests, STOP.

### Step 4: Split the TypeScript config

Root `tsconfig.json`:

```json
{
  "extends": "@saeris/configs/tsconfig",
  "include": ["**/*.ts"],
  "exclude": ["node_modules", ".yarn", ".claude", "**/dist/**"]
}
```

`packages/deoptkit/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "include": ["**/*.ts"],
  "exclude": ["node_modules", "dist"],
  "compilerOptions": {
    // project-local paths live here, not in the shared base
    "outDir": "./dist",
    "rootDir": "."
  }
}
```

(`rootDir: "."` is kept deliberately: `src/server.ts` and `src/lsp/server.ts` import the package's own `package.json`, which a `src` rootDir would reject.)

**Verify**: `vp check --fix` → `Found no warnings, lint errors, or type errors`.

### Step 5: Fix the e2e harness's dependency lookup

In `packages/deoptkit/src/vitest/__tests__/e2eProject.ts`:

- Add `import { createRequire } from "node:module";` and change the `node:path` import to `import { dirname, join } from "node:path";`.
- Replace the `REPO` constant with:

  ```ts
  const require = createRequire(import.meta.url);

  /** The package directory: what a consumer installs as `deoptkit` (package.json + dist). */
  const PACKAGE = join(import.meta.dirname, "..", "..", "..");
  /** Hoisted workspace dependencies resolve from this file like any import would. */
  const VITEST_DIR = dirname(require.resolve("vitest/package.json"));
  const VP_BIN = join(
    dirname(require.resolve("vite-plus/package.json")),
    "bin",
    "vp"
  );
  ```

- `ensureDist`: spawn `[VP_BIN, "pack"]` with `cwd: PACKAGE`.
- `links`: `[join(dir, "node_modules", "vitest"), VITEST_DIR]` and `[join(dir, "node_modules", "deoptkit"), PACKAGE]`.
- `run`: `join(VITEST_DIR, "vitest.mjs")`.
- `cleanup`'s guard: `join(VITEST_DIR, "package.json")` and `join(PACKAGE, "package.json")`.

Update the doc comments to say "package directory" where they said "repository root". Change nothing else in the file.

**Verify**: `vp -C packages/deoptkit test src/vitest/__tests__/preset.e2e.spec.ts` → both describe blocks pass (6 tests). Then `vp test` at the root → 16 files, 80 tests.

### Step 6: Build and tarball checks

**Verify**: `vp -C packages/deoptkit pack` → `Build complete` and `ls packages/deoptkit/dist/index.mjs packages/deoptkit/dist/main.mjs packages/deoptkit/dist/bench.mjs packages/deoptkit/dist/vitest.mjs packages/deoptkit/dist/harness.mjs packages/deoptkit/dist/serve.mjs packages/deoptkit/dist/vitest-global-setup.mjs` lists all seven. Then, inside `packages/deoptkit`: `npm pack --dry-run` lists no `src/` entry and does list `README.md`, `LICENSE.md`, `THIRD_PARTY_NOTICES.md`, `package.json`, `dist/main.mjs`; and `node --input-type=module -e "const m = await import('deoptkit/bench'); console.log(Object.keys(m))"` prints `[ 'benchObserved' ]`.

### Step 7: READMEs and docs

- `packages/deoptkit/README.md` (the moved full README): change the doc links `./docs/recipes.md` (two occurrences), `./docs/SPEC.md`, `./docs/BENCHMARKING.md` to `../../docs/...`; `./LICENSE.md` and `./THIRD_PARTY_NOTICES.md` stay (both files are in the package directory now). Replace the body of the "Contributing" section with one paragraph: the toolchain is Vite+ and bumpy; run `vp install`, `vp check --fix`, and `vp test` from the repository root, `vp pack` and `node fixtures/generate.mjs` from this package directory; link to `../../README.md` for the repository layout and to the two design docs. Keep everything else byte-identical.
- Root `README.md` (new, short, modelled on mirrordown's root README): title `🔥 deoptkit`, the one-paragraph description from the package README, a "Packages" table with one row for `deoptkit` linking to `packages/deoptkit` and its npm page `https://www.npmjs.com/package/deoptkit` (plan 009 adds the extension row), a "Contributing" section with the root commands (`vp install`, `vp check --fix`, `vp test`, `vp -C packages/deoptkit pack`) and links to `docs/SPEC.md`, `docs/BENCHMARKING.md`, `docs/recipes.md`, and `plans/README.md`, and the license line from the package README. Soft-wrapped prose.
- `docs/SPEC.md` §3: after the sentence "Single package (this repo), ESM, Node ≥ 22. Ships both a CLI entry (stdio MCP server) and a programmatic API." add one sentence: "Since the workspace conversion (plan 010) the package lives at `packages/deoptkit/`; the tree below is relative to that directory."
- `.github/workflows/ci.yml` line 20: `fixtures/workloads` → `packages/deoptkit/fixtures/workloads`.
- `.github/workflows/release.yml`: the `changes` filter becomes

  ```yaml
  filters: |
    version:
      - 'packages/*/package.json'
      - 'extensions/*/package.json'
  ```

  and the publish job's `- run: vp pack` becomes `- run: vp -C packages/deoptkit pack`.

**Verify**: `grep -n "\./docs/" packages/deoptkit/README.md` prints nothing; `grep -c "packages/deoptkit" README.md` ≥ 2; `vp check --fix` → clean (it formats the markdown and JSON you wrote).

### Step 8: Bump file, final gates, commit

Create `.bumpy/010-workspace.md` as given under "Git workflow". Run `vp dlx @varlock/bumpy status`; it should list `deoptkit` with pending bumps including this one (if the command needs network access or a token and fails for that reason, paste its output in NOTES instead of stopping). Optionally run `npx -y @wallabyjs/cli run --skill` and note whether its `All Tests` section reports 80 tests (an environment failure here is a NOTE, not a STOP).

**Verify**: `vp check` → clean; `vp test` → 16 files, 80 tests; `git status --short` empty after the second commit `Repo: convert to a Yarn workspace (private root, packages/*, extensions/*)`.

## Test plan

- No new tests: the whole suite is the regression test for this change, and the e2e specs (`preset.e2e.spec.ts`, 6 tests) exercise the only code that encodes repository layout.
- Verification: `vp test` at the root → 16 files / 80 tests, same as the Step 0 baseline.

## Done criteria

- [ ] `yarn workspaces list` prints exactly `.` and `packages/deoptkit`
- [ ] Root `package.json` has `"private": true` and `"workspaces": ["packages/*", "extensions/*"]`; `packages/deoptkit/package.json` has `name` `deoptkit`, the unchanged `exports`, `bin`, `files`, and `repository.directory: "packages/deoptkit"`
- [ ] `vp check` exits 0 at the root
- [ ] `vp test` exits 0 at the root with 16 files / 80 tests
- [ ] `vp -C packages/deoptkit pack` exits 0; `npm pack --dry-run` in the package lists no `src/` entry
- [ ] `grep -n "poolOptions\|\./docs/" packages/deoptkit/README.md` prints nothing
- [ ] `.github/workflows/release.yml` filters on `packages/*/package.json` and builds with `vp -C packages/deoptkit pack`
- [ ] `.bumpy/010-workspace.md` exists
- [ ] No files outside the in-scope list are modified (`git show --stat` of both commits)
- [ ] `plans/README.md` status row updated (skip if your reviewer maintains the index)

## STOP conditions

- The drift check shows changes, or the "Current state" excerpts do not match.
- `vp install` fails for any reason other than a field this plan tells you to remove or add.
- `vp test` at the root runs zero tests with both the `projects` form and the documented fallback.
- `vp check` reports type errors that would need a change under `src/` (other than `e2eProject.ts`) or to `@saeris/configs`.
- The e2e specs fail after Step 5 for a reason other than a wrong path (for example Vitest refusing to run from the junction); report the full output.
- Any `git mv` would touch `plans/`, `docs/`, `.bumpy/`, or `.github/`.

## Maintenance notes

- Plan 009 adds `extensions/deoptkit-vscode`; the `workspaces` glob already covers it. When the extension bundles the server, its build needs `packages/deoptkit/dist` present (mirrordown pre-builds for the same reason), which plan 009 handles in `release.yml`.
- `vp dev`/`vp build`/`vp pack` at the root prompt for a package (or fail in CI); always use `vp -C packages/deoptkit <command>` or `vp run -r build`.
- Executor worktrees are created under `.claude/worktrees/` at the root; the package's Vitest `exclude` still lists `**/.claude/**` so a worktree nested inside a package would be skipped too.
- Bump files stay keyed by package name (`deoptkit`), so the pending `.bumpy/*.md` files remain valid.
