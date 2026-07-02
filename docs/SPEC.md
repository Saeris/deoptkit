# deopt-mcp — Implementation Spec

An MCP server that gives AI agents visibility into V8's optimization behavior —
inline cache (IC) states, deoptimizations, function optimization states, object
map churn, and CPU profile data — for JavaScript/TypeScript running on Node.js.

It is a rebuild of Microsoft's [Deopt Explorer](https://github.com/microsoft/deoptexplorer-vscode)
VSCode extension (and its `dexnode` companion CLI), re-targeted at AI agents
instead of humans, and updated for modern V8.

- Announcement article: <https://devblogs.microsoft.com/typescript/introducing-deopt-explorer/>
- Source extension: `microsoft/deoptexplorer-vscode` (MIT, with BSD-licensed V8-derived code)

---

## 1. Background: what Deopt Explorer does

V8 makes JS fast through speculative optimization keyed on object shapes
("maps"). Three signals reveal where that speculation fails:

| Signal        | Meaning                                                                                                                  | Perf impact                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| **IC state**  | Property/call site feedback: monomorphic (1 shape) → polymorphic (2–4) → megamorphic (5+)                                | Megamorphic sites fall back to hash lookups; the TS team got 8–10% compiler speedup fixing these |
| **Deopts**    | Optimized code bails out (eager = wrong assumption mid-execution, lazy = code invalidated, soft = insufficient feedback) | Repeated deopt/reopt cycles ("deopt loops") burn time and can permanently disable optimization   |
| **Map churn** | Many maps for conceptually one object type (conditional property init, differing init order)                             | Root cause of polymorphism; 30 maps for TS's `Symbol` objects was their headline fix             |

Data comes from V8's own logging (no instrumentation of user code):

```
node --logfile=v8.log --no-logfile-per-isolate \
     --log-deopt --log-ic --log-maps --log-maps-details \
     --log-code --log-source-code \
     --prof --log-internal-timer-events --detailed-line-info \
     script.js
```

The extension parses the resulting `v8.log` (a CSV-ish event stream: `code-creation`,
`ic`/`LoadIC`/`StoreIC`, `deopt`, `map`, `map-details`, `tick`, `v8-version`, …)
into a model of functions, ICs, deopts, and maps, then renders tree views,
editor decorations, and hovers.

## 2. Why an MCP server, and how agents change the design

The VSCode extension is built for human browsing: trees to expand, decorations
to eyeball, hovers to read. Agents need the opposite: **ranked answers, compact
structured data, stable IDs for drill-down, and a fix-verify loop.** Design
principles for every tool:

1. **Triage first.** The server ranks findings (megamorphic IC weighted by CPU
   ticks at that site, deopt loops, map churn) so an agent's first call answers
   "what should I fix first?" — no browsing required.
2. **Token-budgeted responses.** Every list tool paginates (small defaults),
   returns `totalCount`, and supports filters (file glob, state, kind, min
   severity). Deep data (map transition trees, source snippets) is opt-in per
   item, never returned in bulk.
3. **Stable IDs.** Every entity gets an ID (`fn:42`, `ic:17`, `map:0x3a2f…:3`)
   valid for the session, so follow-up calls don't re-send locations.
4. **Original-source locations.** Positions are source-mapped back to TS where
   maps are available, reported as workspace-relative `file:line:column`
   (1-based) — directly usable in Read/Edit tool calls.
5. **Self-contained findings.** Each finding carries a one-line `explanation`
   and `suggestedFix` category (e.g. "initialize all properties in constructor,
   same order") so agents can act without re-deriving V8 lore.
6. **Fix-verify loop.** First-class before/after comparison of two sessions —
   the missing piece in the original, and the way agents actually work.
7. **Zero flag knowledge required.** The server runs the workload itself with
   correct version-specific V8 flags (absorbing `dexnode`).

## 3. Architecture

Single package (this repo), ESM, Node ≥ 22. Ships both a CLI entry (stdio MCP
server) and a programmatic API.

```
src/
  index.ts          # library exports (parse/analyze API, no MCP dependency)
  main.ts           # bin entry: starts stdio MCP server
  server.ts         # McpServer construction, tool registration
  tools/            # one module per MCP tool: zod schema + handler
  session/          # in-memory session store (parsed logs keyed by id, LRU)
  collect/          # workload runner: V8 version detection, flag prep, spawn,
                    #   logfile management, cleanup (port of dexnode)
  parser/           # V8 log parsing engine
    logReader.ts    #   line dispatch (port of v8 tools/logreader)
    versioned.ts    #   semver-ranged dispatch tables per V8 version
    codeMap.ts      #   address → code entry mapping (splay-tree based)
    profile.ts      #   tick processing → call tree (port of v8 tools/profile)
    mapParser.ts    #   map events + map-details text block parsing
    entries/        #   FunctionEntry / IcEntry / DeoptEntry / MapEntry builders
  model/            # vscode-free domain model + LogModel (the parsed session)
  analysis/         # findings engine (severity scoring), session compare
  sourcemaps/       # source map resolution of generated → original positions
docs/
  SPEC.md           # this document
THIRD_PARTY_NOTICES # V8 (BSD-3), deoptigate (MIT) attribution
```

Dependencies (runtime): `@modelcontextprotocol/sdk`, `zod`, `semver`,
`source-map-js` (or `@jridgewell/trace-mapping`). Notably **dropped** from the
original: all of `@esfx/*` (replaced by plain Map/Set + a ported splay tree),
`ffi-napi`/`ref-*` (native symbol resolution — cut, see §8), and everything
VSCode.

### Porting strategy

The extension's engine (~15k lines) ports in dependency order, tests first:

1. `logreader.ts` + CSV parser + splay tree — self-contained, mechanical port.
2. `codeentry/codemap/profile/profile_view` — tick processor; strip
   `CppEntriesProvider` (native symbols).
3. deoptigate-derived `FunctionEntry`/`IcEntry`/`DeoptEntry` — small.
4. `logProcessor.ts` — the orchestrator; largest piece, rewritten around plain
   types (`vscode.Uri` → path strings, `Position/Location` → `{file, line, column}`).
5. Map-details text parser (the gnarly regexes) — port with fixture coverage.

Derived files keep license headers; `LICENSE.v8` / `LICENSE.deoptigate` come
along into `THIRD_PARTY_NOTICES`.

### V8 version strategy (the central risk)

The extension supports V8 8–9 (Node 14–16) and last shipped May 2023. Node 20 /
22 / 24 ship V8 11.3 / 12.4 / 13.6 — log format details have drifted (field
additions to `code-creation`, IC event arity changes, map-details text changes).

Mitigations, in priority order:

- Keep the `VersionedLogReader` design: dispatch tables keyed by semver range on
  the log's `v8-version` line. **Modern ranges (≥ 11) are written first**; the
  extension's 8–9 tables are ported only if cheap, else dropped (documented).
- Unknown/unparseable lines are **counted and skipped, never fatal**; every tool
  response includes `parserWarnings` counts so agents know when data is partial.
- Fixture matrix in CI: tiny workload scripts with deliberate pathologies run
  under Node 20/22/24 to regenerate logs; golden-model snapshot tests catch
  drift the day a new Node lands in CI.

## 4. MCP surface

### Tools

Session lifecycle:

| Tool            | Purpose                                                         | Key inputs → outputs                                                                                                                         |
| --------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `profile_run`   | Run a command under V8 logging and load the result as a session | `command[]`, `cwd`, `env?`, `timeoutMs?`, `categories?` (ics/deopts/maps/profile) → `sessionId`, exit info, summary counts, `parserWarnings` |
| `load_log`      | Parse an existing `v8.log`                                      | `path`, `workspaceRoot?` → same shape as above                                                                                               |
| `list_sessions` | Enumerate loaded sessions                                       | → id, source, timestamps, counts                                                                                                             |

Analysis (all take `sessionId`; all lists paginate and filter by `file` glob):

| Tool               | Purpose                                                                                                                                          | Notable params                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `get_findings`     | **Primary entry point.** Ranked, deduplicated findings with severity, explanation, suggested-fix category                                        | `severityMin?`, `kinds?`, `limit?`                                                        |
| `list_ics`         | IC sites                                                                                                                                         | `states?` (mono/poly/mega/…), `types?` (Load/Store/KeyedLoad/…), sort by worst-state/hits |
| `list_deopts`      | Deopt sites grouped by location                                                                                                                  | `kinds?` (eager/lazy/soft), `minCount?`, sort by count                                    |
| `list_functions`   | Functions with optimization state history                                                                                                        | `states?`, sort by self-ticks/deopt-count/reopt-count                                     |
| `get_function`     | Deep dive on one function: state timeline, its ICs/deopts, line ticks, optional annotated source snippet                                         | `functionId`, `includeSource?`                                                            |
| `get_map`          | Map details: properties, transition path back to root, IC sites referencing it, sibling-map diff ("these 12 maps differ only in property order") | `mapId`                                                                                   |
| `get_profile`      | CPU profile: `flat`, `top-down`, or `bottom-up`; just-my-code filtering                                                                          | `view`, `justMyCode?` (default true), `maxDepth?`, `limit?`                               |
| `compare_sessions` | Before/after diff: resolved & new findings, per-function tick/state deltas, IC state transitions, map count deltas                               | `baseSessionId`, `headSessionId`                                                          |

Severity model for `get_findings` (v1, tunable): megamorphic IC on a line with
profile ticks > eager-deopt loop (≥2 deopts same site) > megamorphic IC without
ticks > high map churn per constructor > polymorphic IC in hot function > soft
deopts. Score combines signal weight × CPU ticks attributed to the enclosing
function × hit count.

### Resources & prompts (later phase)

- `deopt://session/{id}/summary` resource mirroring `get_findings` for hosts
  that surface resources.
- One prompt, `analyze-performance`, encoding the recommended loop:
  profile → findings → fix top finding → re-profile → compare.

## 5. Data collection (`collect/`, port of dexnode)

- Detect V8 version via `node -p process.versions.v8` on the target executable.
- Prepare version-appropriate flags (modern: `--log-deopt --log-ic --log-maps
--log-maps-details --log-code --log-source-code --prof
--log-internal-timer-events --detailed-line-info --logfile=<tmp>
--no-logfile-per-isolate`), honoring category toggles.
- Spawn with inherited stdio captured (tail returned in tool result), enforce
  timeout, clean up temp `--redirect-code-traces` artifacts.
- Hosts: **Node.js only in v1.** The host abstraction (from dexnode) stays so
  Deno/Electron/Chrome can be added later; they are explicitly out of scope now.
- Logs can be huge (100MB+ for real workloads): parse via streaming line reader;
  never buffer the whole file.

## 6. Phases & success criteria

Each phase lands as a reviewable unit with green `vp check` + `vp test`.

**Phase 0 — Skeleton.** MCP stdio server with `list_sessions` + stub `load_log`;
bin entry wired in package.json; MCP Inspector can connect and list tools.
✔ Done when: inspector handshake succeeds; CI green.

**Phase 1 — Parser core (the long pole).** Port log reader, tick processor,
entry builders, map parser; versioned dispatch for V8 ≥ 11; fixture logs from
Node 20/22/24 checked in with golden-model tests.
✔ Done when: fixtures parse with zero errors and expected entity counts
(known megamorphic IC, known eager deopt, known map churn all present in model).

**Phase 2 — Query tools.** Session store, `load_log` for real, all `list_*`/`get_*`
tools, findings engine with severity ranking.
✔ Done when: on the fixture workload, `get_findings[0]` is the deliberately
megamorphic hot site; every listed location resolves to the correct fixture
source line.

**Phase 3 — Collector.** `profile_run` end-to-end on Windows + POSIX, temp file
hygiene, timeout handling.
✔ Done when: `profile_run` on a fixture script → `get_findings` works with no
manual steps, on both CI OSes.

**Phase 4 — Fix-verify loop & polish.** `compare_sessions`, `get_function`
annotated snippets, source map support, README + prompt, npm publish dry-run.
✔ Done when: fixture pair (bug / fixed) shows the finding as `resolved` in
`compare_sessions`; README documents an agent transcript of the full loop.

## 7. Testing

- **Fixture-first:** `fixtures/workloads/*.js` are tiny scripts with named
  pathologies (shape-polymorphic property access, deopt loop via changing
  types, constructor with conditional properties). A script regenerates
  `fixtures/logs/<node-version>/*.log` per Node version; CI matrix (20/22/24,
  ubuntu + windows) regenerates and diffs models, catching V8 drift early.
- **Golden snapshots** of the parsed `LogModel` (counts, states, locations) per
  fixture — Wallaby-friendly, fail loudly on format drift.
- **Unit tests** per line-parser and for severity scoring (encode _why_: "a
  megamorphic site with ticks must outrank a tickless one").
- **Contract tests** for tools via in-memory MCP client from the SDK.

## 8. Non-goals (v1)

- **Native/C++ symbol resolution** (`dumpbin`/`nm`, `ffi-napi`) — native deps
  are unmaintained and the payoff for JS/TS work is marginal. `parserWarnings`
  will note unresolved native frames.
- Chrome / Edge / Deno / Electron hosts (abstraction preserved for later).
- Any UI: webviews, HTML reports, decorations, the `.v8-map` language.
- Live/watch mode (re-run `profile_run` instead).
- V8 < 11 log formats unless the ported tables cover them for free.
- HTTP transport (stdio only; the SDK makes adding it later trivial).

## 9. Risks

| Risk                                 | Mitigation                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| V8 log drift across Node versions    | Versioned dispatch, skip-don't-crash, CI fixture matrix (§3)                                         |
| Port size/fidelity of `logProcessor` | Port in dependency order behind golden tests; keep upstream file mapping in headers                  |
| Positions off in TS projects         | Source map layer + tests against a `tsc`-built fixture; report both generated and original locations |
| Huge logs / memory                   | Streaming parse; lazy profile-view construction; per-session memory cap with LRU eviction            |
| Windows path/URI mismatches          | Normalize to forward-slash workspace-relative paths at the model boundary; CI on Windows             |
