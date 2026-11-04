# Plan 018: Gate this repository's own parser with `deoptkit ci` (self-dogfooding)

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md` — unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: confirm plan 011 is DONE in `plans/README.md` (its portable baselines are what makes a committed baseline meaningful) and that `packages/deoptkit/src/cli/ci.ts` contains the word `portable`. `ls packages/deoptkit/bench` must fail (no bench directory yet). On a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/011-workspace-relative-paths-and-portable-baselines.md
- **Category**: direction, dx
- **Planned at**: commit `4e0de7e`, 2026-11-03

## Why this matters

`docs/BENCHMARKING.md` §5 asks for "one exemplary `bench/` in this repo" and §7 describes `deoptkit ci` as a snapshot-style gate, yet the repository never runs either on itself. The parser is a real hot JavaScript workload (an 11 MB fixture log parses in about 100 ms through `csv.ts`, `logReader.ts`, and `parseLog.ts`), so observing it proves the product on a non-synthetic subject, produces the first real-world calibration data for the severity bands, and turns "a change to the parser made a dispatch site megamorphic" into a CI failure instead of a silent slowdown. It also exercises the whole `profile_run`-free path users rely on (`node bench.mjs` under `deoptkit ci`, built output with source maps, GitHub annotations at original positions).

## Current state

Paths relative to the repository root unless noted.

- `packages/deoptkit/src/cli/ci.ts`: `deoptkit ci [--update] [--out-dir <dir>] <script.mjs> [...]` runs each script under V8 logging (`runWorkload`, 300 s timeout), computes findings, writes `<outDir>/baselines/<slug>.json` on first run, exits 1 on NEW gated findings (`megamorphic-ic`, `map-churn`, `deopt-loop`), emits `::warning` annotations when `GITHUB_ACTIONS=true`, and always rewrites `<outDir>/findings.json`. The slug is `relative(process.cwd(), script)` with non-alphanumerics replaced by `__`; `outDir` defaults to `.deopt`. After plan 011, baseline identities use paths relative to `process.cwd()`.
- `packages/deoptkit/src/collect/runner.ts` exports `v8FlagsFor(logfile, categories?)`, re-exported from `packages/deoptkit/src/index.ts` and therefore available from the built `dist/index.mjs` together with `parseLog` and `computeFindings`. `dist/harness.mjs` exports `mark` and `observed`.
- `packages/deoptkit/fixtures/workloads/megamorphic.js`: the workload whose log the bench parses; `packages/deoptkit/fixtures/generate.mjs` shows how a log is produced (`spawnSync(process.execPath, [...v8Flags(logfile), workload])`).
- `packages/deoptkit/vite.config.ts` `pack` emits `dist/index.mjs`, `dist/harness.mjs`, `dist/main.mjs` (the bin) and `.mjs.map` source maps, so findings in `dist/` resolve to `src/` original positions.
- `.github/workflows/ci.yml` (repository root): one job `ci` over a matrix of `node-version: ["22", "lts", "latest"]` on `ubuntu-latest` plus `node-version: "lts"` on `windows-latest`; steps `actions/checkout@v6`, `voidzero-dev/setup-vp@v1.21.2` (with `node-version: ${{ matrix.node-version }}`, `cache: true`), `vp check`, `vp test`.
- Root `.gitignore` has no `.deopt` entry; `*.log` and `**/dist/` are ignored.
- `packages/deoptkit/package.json` `scripts`: `{ "build": "vp pack", "test": "vp test" }`.
- `packages/deoptkit/src/vitest/__tests__/e2eProject.ts` exports `ensureDist()` (runs `vp pack` in the package directory) and the `PACKAGE` constant pattern (`join(import.meta.dirname, "..", "..", "..")`).
- Package README, "CI regression gating" section (`packages/deoptkit/README.md`, around lines 130–147): three-command example and a paragraph on baselines.

Conventions: ESM `.mjs` bench scripts importing built output (`docs/recipes.md`, "Library bench scripts"); comments explain why; soft-wrapped markdown; no attribution lines.

## Commands you will need

| Purpose                   | Command                                                               | Expected on success                                                                        |
| ------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Install                   | `vp install`                                                          | exit 0                                                                                     |
| Build the package         | `vp -C packages/deoptkit pack`                                        | `Build complete`                                                                           |
| Run the bench alone       | `cd packages/deoptkit && node bench/parse.bench.mjs`                  | exit 0 in under 30 s                                                                       |
| First gate run            | `cd packages/deoptkit && node dist/main.mjs ci bench/parse.bench.mjs` | `no baseline — wrote N finding(s) to .deopt/baselines/bench__parse.bench.mjs.json`, exit 0 |
| Second gate run           | same                                                                  | `clean — matches baseline`, exit 0                                                         |
| Format + lint + typecheck | `vp check --fix`                                                      | clean                                                                                      |
| All tests                 | `vp test`                                                             | all pass                                                                                   |

## Scope

**In scope**:

- `packages/deoptkit/bench/parse.bench.mjs` (create)
- `packages/deoptkit/.deopt/baselines/bench__parse.bench.mjs.json` (create; generated by the first gate run, then committed)
- `packages/deoptkit/src/__tests__/bench.spec.ts` (create)
- `packages/deoptkit/package.json` (add one script)
- `.github/workflows/ci.yml`
- `.gitignore`
- `packages/deoptkit/README.md` ("CI regression gating", one sentence)
- `.bumpy/018-dogfood.md` (create)

**Out of scope**:

- Fixing anything the gate finds in the parser. Commit the baseline that the first run produces, whatever it contains, and list its findings in your report; the maintainer decides what to fix (and a fix lands with `--update`).
- `src/cli/ci.ts` and `docs/BENCHMARKING.md`.
- Timing assertions of any kind (BENCHMARKING §1: timing never gates).

## Git workflow

- Branch: `exec/plan-018` in a dedicated worktree; stay there.
- One commit: `CI: gate the parser with deoptkit ci over bench/parse.bench.mjs`.
- Bump file `.bumpy/018-dogfood.md` with `"deoptkit": none` and body: `The repository now runs deoptkit ci on its own parser (bench/parse.bench.mjs) with a committed baseline.`
- Do NOT push or open a PR. No attribution lines.

## Steps

### Step 1: The bench script

Create `packages/deoptkit/bench/parse.bench.mjs`:

```js
// deoptkit observing its own parser. Generates a fresh V8 log of the megamorphic
// fixture workload, then parses and analyzes it repeatedly inside a marked window.
// Imports the built package: profile what users run (docs/BENCHMARKING.md §2.3).
// Run under the gate with `node dist/main.mjs ci bench/parse.bench.mjs` from the
// package directory (dist/ must be built first).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mark } from "../dist/harness.mjs";
import { computeFindings, parseLog, v8FlagsFor } from "../dist/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workload = join(here, "..", "fixtures", "workloads", "megamorphic.js");
const dir = mkdtempSync(join(tmpdir(), "deoptkit-bench-"));
const logfile = join(dir, "megamorphic.log");

// The child gets its own --logfile, so its log never mixes with the one deoptkit ci
// records for this process.
const run = spawnSync(process.execPath, [...v8FlagsFor(logfile), workload], {
  encoding: "utf8"
});
if (run.status !== 0) throw new Error(`workload failed: ${run.stderr}`);

// Enough repetitions for the parser's hot loops to tier up; each parse is ~100 ms.
const ITERATIONS = 20;
let sink = 0;
mark("parse_log_start");
for (let iteration = 0; iteration < ITERATIONS; iteration++) {
  const model = await parseLog(logfile);
  sink += computeFindings(model).length + model.ics.length;
}
mark("parse_log_end");
rmSync(dir, { recursive: true, force: true });
// Observable result so nothing above is dead code (never throws).
if (sink < 0) throw new Error(`unreachable: ${sink}`);
```

Add `"bench": "node dist/main.mjs ci bench/parse.bench.mjs"` to `packages/deoptkit/package.json` `scripts`.

**Verify**: `vp -C packages/deoptkit pack` → `Build complete`; `cd packages/deoptkit && node bench/parse.bench.mjs` → exit 0 (print nothing on success is fine).

### Step 2: Ignore rules and the baseline

Append to the root `.gitignore`:

```
# deoptkit ci output: baselines are committed, the per-run interchange is not
.deopt/*
!.deopt/baselines/
```

Then, from `packages/deoptkit`: `node dist/main.mjs ci bench/parse.bench.mjs` (first run writes the baseline), then the same command again (must print `clean — matches baseline`). Open `.deopt/baselines/bench__parse.bench.mjs.json`: every `identity` must contain a relative path such as `dist/parseLog-….mjs` and no `file:///` (plan 011's guarantee). Copy the `findings` array into your report's NOTES verbatim.

**Verify**: `git status --short` shows `packages/deoptkit/.deopt/baselines/bench__parse.bench.mjs.json` as untracked and nothing else under `.deopt/`; `grep -c "file:///" packages/deoptkit/.deopt/baselines/bench__parse.bench.mjs.json` → 0.

### Step 3: Smoke test that the bench runs against the built package

Create `packages/deoptkit/src/__tests__/bench.spec.ts`: call `ensureDist()` from `../vitest/__tests__/e2eProject` in `beforeAll` (timeout 60 s), then `spawnSync(process.execPath, ["bench/parse.bench.mjs"], { cwd: PACKAGE, encoding: "utf8" })` where `PACKAGE = join(import.meta.dirname, "..", "..")`, and assert `status === 0` (include `stderr` in the failure message as `server.spec.ts` does for child output). Comment: the CI gate runs on one matrix lane; this proves on every lane that the dogfood subject still runs against the shipped entry points, so a renamed export or a broken harness import fails here, not only in CI.

**Verify**: `vp -C packages/deoptkit test src/__tests__/bench.spec.ts` → passes.

### Step 4: The CI step

In `.github/workflows/ci.yml`, after the `vp test` step add:

```yaml
# deoptkit observing its own parser (docs/BENCHMARKING.md §5, §7): a structural
# regression gate over bench/parse.bench.mjs against the committed baseline in
# packages/deoptkit/.deopt/baselines. One lane only: each V8 major optimizes
# differently and the baseline is a snapshot of the LTS lane's behavior.
- if: matrix.node-version == 'lts' && matrix.os == 'ubuntu-latest'
  run: vp -C packages/deoptkit pack
- if: matrix.node-version == 'lts' && matrix.os == 'ubuntu-latest'
  working-directory: packages/deoptkit
  run: node dist/main.mjs ci bench/parse.bench.mjs
```

In `packages/deoptkit/README.md`, "CI regression gating", add after the three-command example's paragraph: "This repository gates itself the same way: `bench/parse.bench.mjs` parses a fixture log under observation and `.github/workflows/ci.yml` runs `deoptkit ci` over it against the committed baseline."

**Verify**: `node -e "require('node:fs').readFileSync('.github/workflows/ci.yml','utf8')"` succeeds and `grep -c "bench/parse.bench.mjs" .github/workflows/ci.yml` → 1; `vp check --fix` → clean; `vp test` → all pass.

### Step 5: Commit

Stage the bench, the baseline, the spec, the workflow, `.gitignore`, `package.json`, the README, and the bump file; commit.

**Verify**: `git status --short` empty; `git show --stat HEAD` lists exactly those files.

## Test plan

- New: `src/__tests__/bench.spec.ts` (bench runs against built output on every lane).
- The gate itself: two consecutive `deoptkit ci` runs (write, then clean).
- Verification: `vp test` → all pass.

## Done criteria

- [ ] `packages/deoptkit/bench/parse.bench.mjs` exists and exits 0 standalone
- [ ] `packages/deoptkit/.deopt/baselines/bench__parse.bench.mjs.json` is committed and contains no `file:///`
- [ ] A second `node dist/main.mjs ci bench/parse.bench.mjs` prints `clean — matches baseline`
- [ ] `.github/workflows/ci.yml` runs the gate on the `lts`/`ubuntu-latest` lane only
- [ ] `vp check` and `vp test` exit 0
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated (skip if your reviewer maintains the index)

## STOP conditions

- Plan 011 is not DONE, or baseline identities contain `file:///` (portability missing).
- `deoptkit ci` exits 2 (the bench failed to run) after you have confirmed `dist/` is freshly built; report the output.
- The second gate run reports NEW findings on an unchanged tree (non-determinism): run it a third time; if it still differs, report both baselines and STOP (the gated kinds are supposed to be run-stable; the maintainer must look).
- The bench takes longer than 60 s.

## Maintenance notes

- When a parser change intentionally alters a gated finding, run `node dist/main.mjs ci --update bench/parse.bench.mjs` in `packages/deoptkit` and commit the baseline with the change.
- The baseline reflects the Node LTS lane; if the first CI run reports NEW findings that do not reproduce locally, the V8 majors differ: regenerate the baseline with the same Node major as the lane (`nvm`/`fnm`) and commit it.
- The findings in the first baseline are the first real-world calibration data for severity bands (BENCHMARKING §10, item 6); the maintainer should read them.
