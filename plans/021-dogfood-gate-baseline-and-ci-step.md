# Plan 021: Commit the parser's `deoptkit ci` baseline and enable the CI gate (plan 018, part 2)

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md` — unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: confirm plans 018, 020 and 022 are DONE in `plans/README.md`; `ls packages/deoptkit/bench/parse.bench.mjs` succeeds; `ls packages/deoptkit/.deopt` fails (nothing committed yet); `grep -c "accumulate" packages/deoptkit/src/cli/ci.ts` ≥ 3; `grep -c "distinctKeys" packages/deoptkit/src/parser/parseLog.ts` ≥ 1; `grep -c "normalizeV8Name" packages/deoptkit/src/parser/parseLog.ts` ≥ 2. On a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/018-dogfood-ci-gate.md (part 1), plans/020-keyed-ic-sites-and-soft-feedback-deopts.md, plans/022-stable-identities-and-shape-stable-parser.md
- **Category**: direction, dx
- **Planned at**: commit `1bfded1`, 2026-11-03

## Why this matters

Plan 018 landed the bench (`packages/deoptkit/bench/parse.bench.mjs`), the `--accumulate` flag, source-mapped baseline identities, and the Windows `node_modules` fix, but stopped short of committing a baseline because the gate flickered: one keyed IC site was modeled as a site per runtime key, so the megamorphic entry named a random key each run. Plan 020 fixed the model (one keyed site per position, feedback deopts classified soft). What remains is the last mile: generate a baseline that stays clean across runs, commit it, and run the gate on one CI lane, so a parser change that creates a new megamorphic site or a real deopt loop fails CI.

## Current state

Paths relative to the repository root.

- `packages/deoptkit/bench/parse.bench.mjs`: generates a fresh V8 log of the megamorphic fixture, parses it 20 times inside `parse_log_start`/`parse_log_end` markers, imports `../dist/index.mjs` and `../dist/harness.mjs`.
- `packages/deoptkit/src/cli/ci.ts`: `deoptkit ci [--update|--accumulate] [--out-dir <dir>] <script.mjs> [...]`; `--accumulate` writes the union of the existing baseline and the current run; identities use the source-mapped original file (so parser findings read `src/parser/...`); gated kinds are `megamorphic-ic`, `map-churn`, `deopt-loop`.
- `packages/deoptkit/package.json` script `"bench": "node dist/main.mjs ci bench/parse.bench.mjs"`.
- `packages/deoptkit/src/__tests__/bench.spec.ts`: smoke test that the bench runs against built output; its comment says the bench "is meant to run under `deoptkit ci` on one CI lane".
- Root `.gitignore` ends with `.deopt/*` and `!.deopt/baselines/`.
- `.github/workflows/ci.yml`: matrix (`node-version: ["22", "lts", "latest"]` on `ubuntu-latest`, plus `lts` on `windows-latest`); steps checkout, setup-vp, `vp -C packages/deoptkit pack`, `vp -C extensions/deoptkit-vscode pack`, `vp check`, `vp test`.
- Package README, "CI regression gating": three-command example, the relative-identity sentence (plan 011), the `--accumulate` sentence (plan 018).
- Plan 018's last accumulated baseline (not committed) had 13 entries: churn in `computeFindings`, `finding`, `readLog`, and the server chunk's top-level code (source-mapped to `src/tools/listIcs.ts`), keyed megamorphic ICs in `parseLog.ts` (`map`, `tick`), `score`, `finding`, `parseIcState`, `readLog`, and the `#indexBefore` deopt loop.
- The first attempt at this plan (after 020, before 022) could not converge: identities carried per-process V8 symbol hashes, anonymous functions pooled into one `map-churn` entry per file, the `tick` and `map` counters' keyed sites flickered with the sampled VM states, and `#indexBefore` flickered between one and two eager deopts. Plan 022 fixed each at the source. After it, no `|tick|` or `|map|` megamorphic entries exist (the counters are `Map`s), no identity contains `hash`, and a one-bailout-per-tier site reports as `eager-deopt`, which is not gated.

Conventions: soft-wrapped markdown; no attribution lines.

## Commands you will need

| Purpose       | Command (from `packages/deoptkit`)                               | Expected on success                                   |
| ------------- | ---------------------------------------------------------------- | ----------------------------------------------------- |
| Build         | `vp -C . pack` (or `vp -C packages/deoptkit pack` from the root) | `Build complete`                                      |
| Accumulate    | `node dist/main.mjs ci --accumulate bench/parse.bench.mjs`       | `baseline accumulated (N finding(s); +M new)`, exit 0 |
| Plain gate    | `node dist/main.mjs ci bench/parse.bench.mjs`                    | exit 0, no `NEW finding(s)` line                      |
| Checks (root) | `vp check --fix`, `vp test`                                      | clean, all pass                                       |

## Scope

**In scope**:

- `packages/deoptkit/.deopt/baselines/bench__parse.bench.mjs.json` (create and commit)
- `.github/workflows/ci.yml`
- `packages/deoptkit/README.md` (one sentence), `packages/deoptkit/src/__tests__/bench.spec.ts` (comment only)
- `.bumpy/021-dogfood-gate.md` (create)

**Out of scope**: everything else. In particular, do not fix findings the baseline records; the maintainer reads them.

## Git workflow

- Branch: `exec/plan-021` in a dedicated worktree; stay there.
- One commit: `CI: gate the parser with deoptkit ci against a committed baseline`.
- Bump file `.bumpy/021-dogfood-gate.md` with `"deoptkit": none` and body: `The repository now runs deoptkit ci on its own parser (bench/parse.bench.mjs) against a committed baseline.`
- Do NOT push or open a PR. No attribution lines.

## Steps

### Step 1: Baseline

From `packages/deoptkit`, after `vp -C . pack`: run `node dist/main.mjs ci --accumulate bench/parse.bench.mjs` five times (the first prints `no baseline — wrote N finding(s)`), then the plain gate three times. Every plain run must exit 0 and print no `NEW finding(s)` line (notices about baselined findings that no longer occur are fine). If a plain run reports NEW, run two more accumulate rounds and repeat the three plain runs once; if NEW still appears, STOP and report its identities.

Inspect the baseline: no `file:///`, no `node_modules`, no drive letter; `grep -c " hash " <baseline>` → 0; no identity containing `|tick|` or `|map|` (the parser's counters are no longer keyed stores); no `map-churn` entry with an empty function name whose anchor is inside a named function (`"functionName": ""` entries must be module top-level code); no `deopt-loop` entry whose summary mentions `Insufficient type feedback` and none for `#indexBefore`.

**Verify**: `git status --short` shows the baseline as the only untracked path under `.deopt/`; paste the `findings` array in NOTES.

### Step 2: CI step and docs

In `.github/workflows/ci.yml`, after the `vp test` step:

```yaml
# deoptkit observing its own parser (docs/BENCHMARKING.md §5, §7): a structural
# regression gate over bench/parse.bench.mjs against the committed baseline in
# packages/deoptkit/.deopt/baselines. One lane only: each V8 major optimizes
# differently and the baseline is a snapshot of the LTS lane's behavior.
- if: matrix.node-version == 'lts' && matrix.os == 'ubuntu-latest'
  working-directory: packages/deoptkit
  run: node dist/main.mjs ci bench/parse.bench.mjs
```

(The engine is already built earlier in the job.) In the package README's "CI regression gating" section add: "This repository gates itself the same way: `bench/parse.bench.mjs` parses a fixture log under observation and `.github/workflows/ci.yml` runs `deoptkit ci` over it against the committed baseline." In `bench.spec.ts` change the comment to say the CI gate runs on one matrix lane and this test proves on every lane that the subject still runs.

**Verify**: `grep -c "bench/parse.bench.mjs" .github/workflows/ci.yml` → 1; `vp check --fix` → clean; `vp test` → all pass.

### Step 3: Commit

Stage the baseline, the workflow, the README, the spec comment, and the bump file; commit.

**Verify**: `git show --stat HEAD` lists exactly those five files.

## Done criteria

- [ ] Three consecutive plain gate runs exit 0 with no NEW findings
- [ ] The baseline is committed and portable (no absolute paths)
- [ ] `ci.yml` runs the gate on the `lts`/`ubuntu-latest` lane
- [ ] `vp check` and `vp test` exit 0
- [ ] `plans/README.md` status row updated (skip if your reviewer maintains the index)

## STOP conditions

- Plan 020 is not DONE.
- NEW findings persist after the extra accumulate rounds; report them.
- The bench exits non-zero after a fresh build.

## Maintenance notes

- When a parser change intentionally changes a gated finding, run `node dist/main.mjs ci --update bench/parse.bench.mjs` in `packages/deoptkit` and commit the baseline with the change; use `--accumulate` to absorb threshold flicker.
- The first CI run on the LTS lane is the real test of cross-platform stability; if it reports NEW findings that do not reproduce locally, regenerate the baseline with that lane's Node major.
