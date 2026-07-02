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

### Schema-driven input generation (Valibot + Valimock, v1.1)

Hand-writing "realistic, varied input shapes" is the weakest link in the convention above — so derive them instead. A Valibot schema with `v.optional()` fields is a **shape generator**: it encodes exactly which structural variations exist in the domain, and [Valimock](https://github.com/Saeris/valimock) manufactures them. The agent-adoptable pattern becomes mechanical:

1. Pick the hot function; find (or write) the Valibot schema describing its input.
2. Generate a pool of mocks — **seeded**, so runs are reproducible and CI baselines stable (faker must be seeded; document the incantation in the recipe).
3. `observed("case", () => fn(mocks[i++ % mocks.length]))` → `profile_run` → `get_findings`.

This subjects the function to the same shape polymorphism production data has (optional fields present/absent, unions taking different arms), which is precisely the pathology class the tool detects. One honest caveat for the recipe: schema-level variety can overstate what a _specific call site_ sees in practice — findings from mocked stress are strong hypotheses, confirmed by checking whether the shapes in `get_map`'s evidence actually co-occur in real traffic.

**Dogfood target:** [Discordkit](https://github.com/discordkit/discordkit) (Valibot schemas for Discord API objects, shape-heavy parsers/serializers) with Valimock as generator — and **Valimock itself as a subject**, since it has a real deopt-regression history (recursive schema walking is a classic churn/megamorphism habitat). The v1.1 graduation exercise: run the full loop on Valimock, land a fix for a real finding verified by `compare_sessions`. Synthetic fixtures prove the machinery; a real library with a perf history proves the product.

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

## 8. Lint-channel integration: ESLint + Oxlint (v1.3)

Structural signals are deterministic **given runtime inputs** — they are not statically derivable from code, because morphism is a property of the data flowing through a site, not the site itself (`return obj.x` is monomorphic or megamorphic depending on callers a linter cannot see). A "static deopt linter" is therefore mostly impossible; what works is splitting the idea in two:

1. **Findings as diagnostics (the valuable half).** Observation runs (bench or `deopt-mcp ci`) write `.deopt/findings.json`; a lint rule (`deopt-mcp/report-findings`) reads it and emits each finding as a warning at its `original` source position. Findings then flow through the channel developers and agents already consume — editor squiggles, `eslint .` output, CI annotations, LSP diagnostics — with the explanation and suggested fix in the message. Oxlint's JS-plugin support is ESLint-rule-API compatible, so one implementation serves both. Staleness handling: the rule includes the observation timestamp and goes silent (or downgrades to info) when the findings file is older than the source file it annotates.
2. **A few honestly-static heuristic rules (the modest half).** Only patterns visible in code alone: `delete obj.prop` on non-dictionary-intended objects, conditional property assignment in constructors/factories, inconsistent property order across literals of the same conceptual type. These ship as **suggestions, not auto-fixes** — the one plausible codemod is map-churn normalization (rewrite conditional assignments to unconditional fixed-order initialization with `null`/`undefined` defaults), and even that changes enumerable keys, so it stays a suggestion an agent or human applies deliberately.

## 9. Delivery order

| Release | Contents                                                                                                                                                                            | Rationale                                                        |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| v1.1    | harness (`mark`/`observed`), window params on tools, vitest bench preset + `load_manifest`, bench convention + schema-driven (Valimock) recipe docs; dogfood on Valimock/Discordkit | Makes observation easy where warm-up already exists              |
| v1.2    | `deopt-mcp ci` + baselines, `deopt-mcp/serve` + Next/Astro/build recipes                                                                                                            | Makes it durable (CI) and applicable to apps, not just libraries |
| v1.3    | findings-as-diagnostics lint rule (ESLint/Oxlint) + static heuristic rules, child-process flag propagation research, `get_profile` call trees, npm publish of the above             | Depth and reach                                                  |

## 10. Open questions

1. Marker mechanism: confirm `eval`-named functions reliably produce `code-creation` events across tiers/versions (they should — lazy compilation on first call); pick the fallback only if not.
2. Should `deopt-mcp ci` also run vitest-bench manifests, or only plain bench scripts? (Leaning: plain scripts first; manifest support when the preset stabilizes.)
3. Baseline granularity: per-bench-file vs one repo-wide file (leaning per-file, mirroring snapshot conventions).
4. Does Valimock's current API accept a caller-provided seeded faker instance? If not, that is the first upstream PR the dogfood exercise produces.
5. Lint staleness policy: silent vs info-level when findings predate the file's mtime (leaning info-level so the signal's existence stays discoverable).
