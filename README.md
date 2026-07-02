<div align="center">

# 🔥 deopt-mcp

An MCP server that gives AI agents visibility into V8's optimization behavior — inline cache states, deoptimizations, hidden-class (map) churn, and CPU profile data — for JavaScript and TypeScript running on Node.js.

</div>

---

deopt-mcp is a rebuild of Microsoft's [Deopt Explorer](https://github.com/microsoft/deoptexplorer-vscode) VSCode extension, re-targeted at AI agents instead of humans and updated for modern V8 (tested against V8 14 / Node 26; the original supported V8 8–9). Where the extension offered tree views and editor decorations to browse, this server answers the question agents actually ask: **"what should I fix first?"** — with ranked findings, explanations, suggested fixes, and a first-class before/after comparison to verify the fix worked.

Background reading: the TypeScript team's [Introducing Deopt Explorer](https://devblogs.microsoft.com/typescript/introducing-deopt-explorer/) article, where this class of analysis produced an 8–10% compiler speedup.

## 🚧 Status

Pre-release. The core loop works end-to-end (see the tools below); source-map support for TypeScript projects, session eviction, and npm publishing are still in progress. See [docs/SPEC.md](./docs/SPEC.md) for the full plan.

## 📦 Setup

Not yet on npm. From a checkout:

```bash
vp install && vp pack
```

Then register the stdio server with your MCP host. For Claude Code, in `.mcp.json`:

```json
{
  "mcpServers": {
    "deopt": {
      "command": "node",
      "args": ["<path-to-checkout>/dist/main.mjs"]
    }
  }
}
```

## 🔧 The workflow

The intended agent loop, in tool calls:

1. `profile_run { command: ["node", "bench.js"] }` — runs the workload under V8 logging flags (no flag knowledge needed) and loads the result as a session.
2. `get_findings { sessionId }` — everything wrong, ranked worst-first with severity 1–100, source locations, V8-level explanations, and suggested-fix categories.
3. Fix the top finding in your code.
4. `profile_run` again, then `compare_sessions { baseSessionId, headSessionId }` — reports the findings your change resolved, any regressions it introduced, and per-function CPU deltas.

Drill-down tools when a finding needs more context: `list_ics` (inline cache sites by state), `list_deopts` (bailout sites with reasons), `list_functions` (flat CPU profile), `get_map` (a hidden class's transition chain and which call sites it polluted), `load_log` (analyze an existing `v8.log` instead of running one), `list_sessions`.

## 🧠 What the signals mean

| Signal             | What it tells you                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Megamorphic IC** | A property/call site saw 5+ object shapes; V8 fell back to generic hash lookups there                                                                                           |
| **Deopt loop**     | TurboFan repeatedly optimized and discarded the same code — type instability after warm-up                                                                                      |
| **Map churn**      | One constructor/site produces many hidden classes for conceptually one type (conditional or variably-ordered property init) — the root cause behind polymorphic reads elsewhere |
| **Profile ticks**  | Where CPU time actually goes; severity ranking weights every other signal by this                                                                                               |

## 🤝 Contributing

The project uses [Vite+][viteplus] as a unified toolchain (Oxlint + Oxfmt + tsdown + Vitest) and [Bumpy][bumpy] for versioning and release.

```bash
vp install           # install dependencies
vp check --fix       # format + lint + typecheck (with autofixes)
vp test              # run Vitest (generates real V8 logs from fixtures/workloads)
node fixtures/generate.mjs   # regenerate fixture logs by hand for inspection
```

Tests generate real V8 logs at run time by executing the pathological workloads in `fixtures/workloads/` under logging flags — nothing is mocked, so a Node upgrade that changes the log format fails loudly.

## 📣 Acknowledgements

deopt-mcp derives its log-parsing approach from [deoptexplorer-vscode](https://github.com/microsoft/deoptexplorer-vscode) (MIT), which in turn incorporates code from [V8](https://v8.dev)'s tick processor (BSD-3-Clause) and [thlorenz/deoptigate](https://github.com/thlorenz/deoptigate) (MIT). Portions of `src/parser/csv.ts` are derived from V8's `tools/csvparser.mjs`.

## 🥂 License

Released under the [MIT license][license] © [Drake Costa][personal-website].

[viteplus]: https://viteplus.dev/
[bumpy]: https://bumpy.varlock.dev/
[license]: ./LICENSE.md
[personal-website]: https://saeris.gg
