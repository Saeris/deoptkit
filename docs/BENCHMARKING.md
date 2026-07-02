# Benchmarking & workflow integration (post-v1 spec)

How to put real application and library code under deopt-mcp's observation, and where the tool hooks into everyday JS/TS development workflows. This extends [SPEC.md](./SPEC.md) §8; that section's summary defers to this document.

## 1. The two kinds of signal, and why it changes the strategy

deopt-mcp emits two classes of signal with opposite statistical properties:

| Class          | Signals                                         | Properties                                                                                                                                         |
| -------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Structural** | IC worst-states, deopt sites/reasons, map churn | Nearly deterministic given the same inputs. Machine load, CPU model, and run-to-run variance barely matter: a site goes megamorphic or it doesn't. |
| **Timing**     | profile ticks (self/total)                      | Noisy. Needs warm machines, repetition, and statistical honesty. Windows sampling granularity is ~15ms.                                            |

Traditional benchmarking lives entirely in the timing class and is notoriously un-CI-able. deopt-mcp's practical edge is the structural class: **"did this change make `parseRecord` megamorphic?" is a stable, machine-independent question — gateable in CI exactly like a failing test.** The strategy that follows uses structural signals as the regression gate and timing signals only for ranking (which finding matters most) and local investigation.

## 2. The observation model (constraints everything else obeys)

1. **The unit of observation is a process.** V8 logging flags are startup flags; they do not propagate to child processes, and `NODE_OPTIONS` rejects them. Single-process workloads are trivially observable; worker-spawning workloads need per-case recipes (§6) or are out of scope.
2. **Warm-up is mandatory.** Sparkplug/Maglev/TurboFan tier-up needs thousands of executions, and IC feedback needs enough traffic to escalate. A single test assertion or one render observes nothing. Rule of thumb: ≥10k iterations of the code under observation, and ≥1s total runtime if tick data matters.
3. **Observe built output for libraries.** Bundling changes object shapes, function identities, and inlining; profiling `src/` tells you about code users never run. The source-map layer reports positions back in the original files either way.
4. **Instrumented code lies.** Coverage and Wallaby-style instrumentation change the optimization behavior being measured (function sizes cross inlining thresholds, injected closures alter IC feedback). Observation runs must be uninstrumented.
5. **Harness noise requires windowing.** In a vitest worker, most log events come from vitest itself. Just-my-code filtering (shipped) handles attribution; time-windowing (§3) isolates _which benchmark case_ caused an event when several share a file.

## 3. Harness helpers: `deopt-mcp/harness` (v1.1)

A tiny runtime-side module imported by workloads and benchmarks:

- `mark(label)` — records an in-band marker by `eval`-ing a uniquely named no-op function (`__DEOPT_MARK__<label>__<seq>__`) and invoking it once. Its `code-creation` event lands in the V8 log with a timestamp, giving analysis a marker that survives in the log itself — no V8 API, no side files, no clock correlation. (Validate during implementation; fallback is a side JSON of `performance.timeOrigin`-based wall times correlated against the log's `v8-version` timestamp.)
- `observed(label, fn, { iterations = 10_000 })` — wraps a function with `mark(start)` / warm-up loop / `mark(end)`, encoding the warm-up rule so workload authors cannot forget it.
- Zero dependencies, safe to leave in committed benchmark files: when the process is not under V8 logging, markers are inert no-ops (a few wasted evals).

Server side, every session-scoped tool gains an optional `window: { fromMark, toMark }` parameter; the parser records marker events into the model. `get_findings` with a window answers "what went wrong _inside this case_".

## 4. Vitest integration: `deopt-mcp/vitest` (v1.1)

Bench mode, not test mode — `vitest bench` files are already repeated-execution units, so warm-up comes free and the mental model ("benchmarks are where perf lives") matches.

```ts
// vite.config.ts
import { deoptMcp } from "deopt-mcp/vitest";

export default defineConfig({
  test: { benchmark: deoptMcp({ outDir: ".deopt" }) }
});
```

What the preset does:

1. Forces `pool: "forks"` (worker threads share a process → interleaved isolate logs) and injects the V8 flag set via `poolOptions.forks.execArgv`, with per-process logfiles under `outDir`.
2. Refuses to run with coverage enabled (§2.4).
3. Writes a manifest (`.deopt/manifest.json`) mapping bench files → logfiles after the run.
4. Bench cases wrap their bodies with the harness's marks (via a small `benchObserved` helper or a vitest-bench setup hook), so each case is a window.

Agent workflow: run `vitest bench` (via Bash), then `load_log` each manifest entry — or a convenience `load_manifest` tool that loads them all and names sessions after bench files. Positions resolve through the existing source-map layer (vitest serves inline maps), which is why that layer was a prerequisite.

Explicit non-goals: test-mode integration (single assertions can't warm up; noise swamps signal) and Wallaby/Quokka (SPEC §8's instrumentation argument stands).

## 5. Library benchmarking convention (docs + example, v1.1)

For library authors (the original Deopt Explorer audience), the lightest-weight pattern needs no integration at all — it standardizes what `profile_run` points at:

- `bench/*.bench.mjs` — one scenario per file, importing the **built** package (`../dist/index.mjs`).
- Each file: realistic, _varied_ input shapes (synthetic homogeneous data hides shape bugs — the whole point is that production data is polymorphic), `observed()`-wrapped hot loops, results sunk so nothing dead-code-eliminates.
- Observation: `profile_run ["node", "bench/parse.bench.mjs"]` → `get_findings`.

Ship one exemplary `bench/` in this repo's README and a `docs/recipes.md` section. The fixtures in `fixtures/workloads/` already model the anti-patterns; the recipe shows the pro-pattern.

## 6. Framework recipes: drivers, not plugins (v1.2)

Per-framework plugins are the wrong altitude — the frameworks differ only in how you get their request handler into one observable process. Ship **one helper + documented recipes**:

- `deopt-mcp/serve` helper: `driveServer({ start, requests, warmups })` — boots an app's HTTP handler in-process, fires `warmups + requests` fetches at it, then exits cleanly. One process, full observation, works with anything exposing a Node server.
- **Next.js (SSR runtime)**: recipe drives the standalone build's `server.js` (or a custom server using `next({ dev: false })`). Server Components rendering, data transforms, and route handlers get hot under repeated requests — exactly where app-level shape bugs live.
- **Astro (SSR runtime)**: same recipe against the node adapter's standalone entry.
- **Builds**: single-process builds (Astro, Vite plugin pipelines, tsc-shaped tools) work with plain `profile_run` today and make great subjects. `next build` spawns workers whose logs we can't reach — documented limitation, with child-process flag propagation tracked as a research item (a `--require` shim + re-exec is plausible but unproven).
- **Client-side/browser**: out of scope (would require Chrome host support; still a non-goal).

## 7. CI regression gating: `deopt-mcp ci` (v1.2)

The payoff of the structural/timing split — a snapshot-test workflow for optimization health:

```bash
deopt-mcp ci bench/parse.bench.mjs            # run + compare against baseline
deopt-mcp ci --update bench/parse.bench.mjs   # accept current findings as baseline
```

- Baselines: `.deopt/baseline.json` per bench entry, checked in — the structural findings only (kind, file, function, IC key; no line numbers, no severities, no ticks — reusing `compare_sessions`' identity matching).
- Failure = new structural findings vs baseline (a new megamorphic site, a new deopt loop); resolved findings prompt a baseline-refresh notice. Timing is deliberately excluded from gating.
- Runs the same bin, no MCP host needed: the existing `main.ts` grows argv dispatch (`deopt-mcp` with no args = stdio server, unchanged).
- CI examples for GitHub Actions in the docs; works on any runner because structural signals don't care about noisy neighbors.

## 8. Delivery order

| Release | Contents                                                                                                          | Rationale                                                        |
| ------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| v1.1    | harness (`mark`/`observed`), window params on tools, vitest bench preset + `load_manifest`, bench convention docs | Makes observation easy where warm-up already exists              |
| v1.2    | `deopt-mcp ci` + baselines, `deopt-mcp/serve` + Next/Astro/build recipes                                          | Makes it durable (CI) and applicable to apps, not just libraries |
| v1.3    | child-process flag propagation research, `get_profile` call trees (top-down/bottom-up), npm publish of the above  | Depth and reach                                                  |

## 9. Open questions

1. Marker mechanism: confirm `eval`-named functions reliably produce `code-creation` events across tiers/versions (they should — lazy compilation on first call); pick the fallback only if not.
2. Should `deopt-mcp ci` also run vitest-bench manifests, or only plain bench scripts? (Leaning: plain scripts first; manifest support when the preset stabilizes.)
3. Baseline granularity: per-bench-file vs one repo-wide file (leaning per-file, mirroring snapshot conventions).
