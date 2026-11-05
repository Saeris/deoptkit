<div align="center">

# 🔥 deoptkit

A V8 deoptimization toolkit for JavaScript and TypeScript on Node.js — visibility into inline cache states, deoptimizations, hidden-class (map) churn, and CPU profile data, packaged for AI agents and everyday dev workflows.

</div>

---

deoptkit began as a rebuild of Microsoft's [Deopt Explorer](https://github.com/microsoft/deoptexplorer-vscode) VSCode extension, re-targeted at AI agents instead of humans and updated for modern V8 (tested against V8 14 / Node 26; the original supported V8 8–9). Where the extension offered tree views and editor decorations to browse, deoptkit answers the question agents actually ask: **"what should I fix first?"** — with ranked findings, explanations, suggested fixes, and a first-class before/after comparison to verify the fix worked.

Background reading: the TypeScript team's [Introducing Deopt Explorer](https://devblogs.microsoft.com/typescript/introducing-deopt-explorer/) article, where this class of analysis produced an 8–10% compiler speedup.

## What's in the kit

deoptkit ships several surfaces over one engine, all from the `deoptkit` package:

| Surface                                      | What it is                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **MCP server** (`deoptkit` / `deoptkit mcp`) | Eleven tools + a prompt that let an AI agent profile a workload, get ranked findings, drill in, and verify fixes.                    |
| **`deoptkit ci`**                            | Snapshot-style regression gate: fails CI when a change introduces new structural findings (megamorphic ICs, deopt loops, map churn). |
| **`deoptkit lsp`**                           | A language server that publishes findings as inline editor diagnostics (squiggles + Problems panel).                                 |
| **`deoptkit/harness`**                       | `mark()` / `observed()` / `interleaved()` — plant in-log window markers, warm up hot code, and time variants against each other.     |
| **`deoptkit/vitest`** + **`deoptkit/bench`** | A `vitest bench` preset that records V8 logs per worker, and `benchObserved()` to window each case.                                  |
| **`deoptkit/serve`**                         | `driveServer()` — boot an SSR app in-process and drive it with requests so its runtime is observable.                                |
| **library API** (`deoptkit`)                 | `parseLog`, `computeFindings`, `compareSessions`, `runWorkload`, … for building your own tooling.                                    |

## Quick start (AI agent + MCP)

For Claude Code the fastest path is the plugin: run `/plugin marketplace add Saeris/deoptkit`, then `/plugin install deoptkit@deoptkit`. It registers the server and adds a skill with the workflow. The manual registration below works for any MCP host.

Register the stdio server with your MCP host. For **Claude Code**, add to `.mcp.json` in your project (or run `claude mcp add`):

```json
{
  "mcpServers": {
    "deopt": {
      "command": "npx",
      "args": ["-y", "deoptkit"]
    }
  }
}
```

For **VSCode** (Copilot Chat / MCP-capable extensions), add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "deopt": { "command": "npx", "args": ["-y", "deoptkit"] }
  }
}
```

The server advertises `instructions` describing the workflow, so a connected agent knows what to do without reading this file. The loop:

1. `profile_run { command: ["node", "bench.js"] }` — runs the workload under V8 logging flags (no flag knowledge needed) and loads the result as a session.
2. `get_findings { sessionId }` — everything wrong, ranked worst-first with severity 1–100, source locations, V8-level explanations, and suggested-fix categories.
3. Fix the top finding — at its `original` position when present (that's the source you wrote), otherwise its file/line (paths are relative to the project, ready for your editor or file tools).
4. `profile_run` again, then `compare_sessions { baseSessionId, headSessionId }` — reports the findings your change resolved, any regressions it introduced, and per-function CPU deltas.

Drill-down tools when a finding needs more context: `get_function` (annotated source + its ICs/deopts/ticks), `get_map` (a hidden class's transition chain and which call sites it polluted), `list_ics`, `list_deopts`, `list_functions`, `get_profile` (the call tree: who calls the hot function, top-down or bottom-up), `load_log` (analyze an existing `v8.log`), `load_manifest` (load every log from a vitest bench run), `list_sessions`.

> **Warm-up matters.** V8 only optimizes hot code, so profile a workload that runs the target thousands of times — the `observed()` helper below encodes this. For libraries, profile the **built** output, not source: bundling changes shapes and inlining. The server flags cold runs: `profile_run` and `load_log` return `quality.warnings` when no user function reached an optimizing tier, no profiler ticks were recorded, or the ticks are too sparse to rank by (`sparse-ticks`: IC and map logging starved the sampler; profile once more with `categories: ["profile"]` for the call tree). `get_findings` also lists the files on the page that have no source map under `unmapped`, so a bundle built without one is not mistaken for the source.

## Benchmarking your own code

### Standalone scripts

```js
// bench/parse.bench.mjs
import { observed } from "deoptkit/harness";
import { parseRecord } from "../dist/index.mjs";

const inputs = makeVariedInputs(); // realistic, varied shapes — not homogeneous
observed("parse record", (i) => parseRecord(inputs[i % inputs.length]), {
  iterations: 50_000
});
```

Then `profile_run { command: ["node", "bench/parse.bench.mjs"] }` and window the findings with `fromMark: "parse_record_start", toMark: "parse_record_end"`.

To check that a fix is also faster, time the two versions against each other in one process with `interleaved()`: every round runs each variant once in rotating order, and the medians over rounds are what to compare (back-to-back before/after runs on a busy machine drift by 30% or more).

```js
import { interleaved } from "deoptkit/harness";
import { parseRecord as before } from "../dist-before/index.mjs";
import { parseRecord as after } from "../dist/index.mjs";

const { variants } = interleaved(
  "parse record",
  {
    before: (i) => before(inputs[i % inputs.length]),
    after: (i) => after(inputs[i % inputs.length])
  },
  { rounds: 9, iterations: 20_000 }
);
console.log(variants.before.medianMs, variants.after.medianMs);
```

Schema-driven inputs (Valibot + [Valimock](https://github.com/Saeris/valimock)) are the easiest way to get _realistically varied_ shapes — see [docs/recipes.md](../../docs/recipes.md).

### Vitest bench mode

Requires Vitest 5, where `bench` is a test-context fixture.

```ts
// vite.config.ts
import { defineConfig } from "vitest/config";
import { deoptKit } from "deoptkit/vitest";

export default defineConfig({
  test: { ...deoptKit({ outDir: ".deopt" }) }
});
```

```ts
// src/__benchmarks__/parse.bench.ts
import { test } from "vitest";
import { benchObserved } from "deoptkit/bench";
import { parseRecord } from "../parse";

test("parse record", async ({ bench }) => {
  await benchObserved(bench, "parse record", () => parseRecord(next())).run();
});
```

Run `vitest bench`, then `load_manifest { path: ".deopt/manifest.json" }` to load every worker's log as a session. (Coverage must be off — the preset refuses to run otherwise, since instrumentation changes optimization behavior.) To observe the shipped code at exact source positions, without Vite's module runner in between, use `deoptKit({ nativeEsm: true })`; see the [recipe](../../docs/recipes.md) for its requirements.

Full recipes, including SSR apps (Next/Astro via `deoptkit/serve`) and builds, live in [docs/recipes.md](../../docs/recipes.md).

## Inline editor diagnostics (LSP)

`deoptkit ci` (and the vitest workflow) write `.deopt/findings.json`. Point the language server at it to get deopt squiggles in your editor:

```bash
deoptkit lsp --findings .deopt/findings.json
```

The server watches the file and republishes on every change, so `vitest bench --watch` rewrites `.deopt/findings.json` on every run and the squiggles update live. It publishes diagnostics at source-mapped original positions with the explanation and suggested fix in the hover; severity maps from the finding score (error ≥ 60, warning ≥ 25, info below), and findings older than the file they annotate downgrade to info with a re-run hint.

**Editor wiring.** The server speaks standard LSP (`initialize` + push-model `publishDiagnostics`), so any editor with a generic LSP client works today:

- **Neovim**: `vim.lsp.start({ name = "deoptkit", cmd = { "npx", "deoptkit", "lsp" }, root_dir = vim.fn.getcwd() })`
- **Helix / Zed**: register a language server with command `npx deoptkit lsp` and attach it to `javascript`/`typescript`.

**VSCode**: install the `deoptkit` extension (marketplace id `saeris.deoptkit-vscode`). It starts `deoptkit lsp` for the first workspace folder and shows findings as squiggles and Problems entries. It runs the workspace's installed `deoptkit` (`node_modules/deoptkit/dist/main.mjs`, the same version that wrote `findings.json`) and falls back to the server bundled with the extension when there is none. Two settings: `deoptkit.findingsPath` (default `.deopt/findings.json`, relative to the workspace folder) and `deoptkit.serverCommand` (a command such as `["npx", "deoptkit", "lsp"]` that replaces both server choices). VSCode + Claude Code users also get the same findings through the **MCP server** — the agent reads them via `get_findings` and reports them in chat, which needs no editor setup at all.

## CI regression gating

```bash
deoptkit ci bench/parse.bench.mjs             # first run writes .deopt/baselines/…, passes
deoptkit ci bench/parse.bench.mjs             # exit 1 only on NEW structural findings
deoptkit ci --update bench/parse.bench.mjs    # accept current findings as the baseline
```

Baselines contain identity-only structural findings (no line numbers, severities, or timing), so they survive unrelated edits and noisy CI runners — this is the payoff of deoptkit's structural-vs-timing split. On GitHub Actions, new findings also emit `::warning` annotations at their source-mapped positions. Commit `.deopt/baselines/` to make "no new megamorphic sites" a guarded invariant.

Identities use paths relative to the directory `deoptkit ci` runs in, so run it from the same project directory locally and in CI and the committed baseline matches everywhere.

Findings that sit on a threshold can flicker between runs; build the baseline with `deoptkit ci --accumulate` over a few runs so that only genuinely new sites fail the gate.

This repository gates itself the same way: `bench/parse.bench.mjs` parses a fixture log under observation and `.github/workflows/ci.yml` runs `deoptkit ci` over it against the committed baseline.

## What the signals mean

| Signal              | What it tells you                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Megamorphic IC**  | A property/call site saw 5+ object shapes; V8 fell back to generic hash lookups there                                                                                           |
| **Deopt loop**      | TurboFan repeatedly optimized and discarded the same code — type instability after warm-up                                                                                      |
| **Map churn**       | One constructor/site produces many hidden classes for conceptually one type (conditional or variably-ordered property init) — the root cause behind polymorphic reads elsewhere |
| **Dictionary mode** | Objects at a store site left fast-properties mode (keyed stores past V8's 12-field soft limit, or `delete`); every access on them is a hash lookup                              |
| **Profile ticks**   | Where CPU time actually goes; severity ranking weights every other signal by this                                                                                               |

IC findings also say what reached the site: `receiver: "string"` means polymorphism over V8's own string representations (not fixable by property order), `"array"` means arrays differing only by elements kind (keep each array's element type uniform), and both rank below object-shape polymorphism.

## Contributing

The project uses [Vite+][viteplus] as a unified toolchain (Oxlint + Oxfmt + tsdown + Vitest) and [Bumpy][bumpy] for versioning and release. Run `vp install`, `vp check --fix`, and `vp test` from the repository root, and `vp pack` and `node fixtures/generate.mjs` from this package directory. See the [repository README](../../README.md) for the repository layout, and [docs/SPEC.md](../../docs/SPEC.md) and [docs/BENCHMARKING.md](../../docs/BENCHMARKING.md) for the design and roadmap.

## Acknowledgements

deoptkit derives its log-parsing approach from [deoptexplorer-vscode](https://github.com/microsoft/deoptexplorer-vscode) (MIT), which in turn incorporates code from [V8](https://v8.dev)'s tick processor (BSD-3-Clause) and [thlorenz/deoptigate](https://github.com/thlorenz/deoptigate) (MIT). Portions of `src/parser/csv.ts` are derived from V8's `tools/csvparser.mjs`. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## License

Released under the [MIT license][license] © [Drake Costa][personal-website].

[viteplus]: https://viteplus.dev/
[bumpy]: https://bumpy.varlock.dev/
[license]: ./LICENSE.md
[personal-website]: https://saeris.gg
