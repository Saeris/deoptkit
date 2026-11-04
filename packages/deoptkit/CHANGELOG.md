# Changelog


## 0.2.0
<sub>2026-11-04</sub>

- [#2](https://github.com/Saeris/deoptkit/pull/2)  *(minor)* Thanks [@Saeris](https://github.com/Saeris)!
  Vitest 5 support: `benchObserved` now wraps the `bench` test-context fixture (`benchObserved(bench, name, fn, options?)`) and the `vitest` peer range is `>=5`. The `deoptkit/vitest` preset passes V8 flags through Vitest's top-level `execArgv` (the previous `poolOptions` key was ignored by Vitest 4+, so workers never produced logs). Toolchain moved to Vite+ 1.4 and dependencies were refreshed.
- [#2](https://github.com/Saeris/deoptkit/pull/2)  *(minor)* Thanks [@Saeris](https://github.com/Saeris)!
  Tools now advertise titles and MCP annotations (read-only hints for every tool except profile_run) and return structuredContent alongside the JSON text.
- [#2](https://github.com/Saeris/deoptkit/pull/2)  *(minor)* Thanks [@Saeris](https://github.com/Saeris)!
  The deoptkit/vitest preset now writes <outDir>/findings.json after each bench run (findings with source-mapped original positions), so deoptkit lsp shows diagnostics straight from vitest bench runs.
- [#2](https://github.com/Saeris/deoptkit/pull/2)  *(minor)* Thanks [@Saeris](https://github.com/Saeris)!
  fromMark/toMark windows now scope profile ticks too, so findings inside a window rank by the window's own heat; list_functions accepts fromMark/toMark; get_findings accepts offset and file.
- [#2](https://github.com/Saeris/deoptkit/pull/2)  *(minor)* Thanks [@Saeris](https://github.com/Saeris)!
  deoptKit({ nativeEsm: true }) runs bench workers on Node's native ESM loader instead of Vite's module runner, so V8 observes exactly the shipped code at exact source positions.
- [#2](https://github.com/Saeris/deoptkit/pull/2)  *(minor)* Thanks [@Saeris](https://github.com/Saeris)!
  Tool responses now report every location as a workspace-relative path (relative to `profile_run`'s `cwd`, `load_log`/`load_manifest`'s new `workspaceRoot`, or the server's working directory) that agents can pass straight to their file tools; files outside the workspace appear as absolute paths. `deoptkit ci` baselines now store identities with paths relative to the working directory, so a committed baseline matches on every machine and CI runner.
- [#2](https://github.com/Saeris/deoptkit/pull/2)  *(minor)* Thanks [@Saeris](https://github.com/Saeris)!
  `get_findings` and `compare_sessions` now return each finding kind's explanation and suggested fix once, under `kinds`, instead of repeating them on every finding (about 40% of the payload); `list_ics` summarizes each site's state history and distinct map count and bounds `includeTransitions` with `maxTransitions`; `profile_run` accepts `compareTo` to re-profile and return the before/after comparison in one call.
- [#2](https://github.com/Saeris/deoptkit/pull/2)  *(minor)* Thanks [@Saeris](https://github.com/Saeris)!
  Added the `deoptkit/lsp` export (the language server as a library entry) and the `deoptkit-vscode` extension, a thin VSCode client that starts `deoptkit lsp` from the workspace's installed deoptkit or from the server bundled with the extension and shows findings as diagnostics.
- [#2](https://github.com/Saeris/deoptkit/pull/2)  *(minor)* Thanks [@Saeris](https://github.com/Saeris)!
  `get_findings` accepts `sessionIds` to rank the findings of several sessions (for example every worker log of a vitest bench run) in one response, merged by identity with the sessions each finding appeared in; `load_manifest` returns the loaded `sessionIds` ready to pass along.
- [#2](https://github.com/Saeris/deoptkit/pull/2)  *(minor)* Thanks [@Saeris](https://github.com/Saeris)!
  The parser now decodes V8's `code-source-info` inlining tables: inline-cache events, profiler ticks, map transitions, and deopts inside inlined code are attributed to the inlined function at its own source position instead of the caller's. Inlined copies of a megamorphic site no longer appear as a second finding in the caller's file, and functions that only ever run inlined now receive their own self ticks.
- [#2](https://github.com/Saeris/deoptkit/pull/2)  *(minor)* Thanks [@Saeris](https://github.com/Saeris)!
  deoptkit ci gained --accumulate for baselines whose findings flicker at a threshold, baseline identities now use the source-mapped original file so rebuilt bundles with hashed chunk names still match, and dependency code logged with Windows paths is no longer reported as user code. bench/parse.bench.mjs lets deoptkit observe its own parser.
- [#2](https://github.com/Saeris/deoptkit/pull/2)  *(minor)* Thanks [@Saeris](https://github.com/Saeris)!
  Keyed inline-cache sites (`obj[key]`) are now one site per code position with the distinct keys as evidence, instead of one site per runtime key, which made the megamorphic finding name a random key and flicker between runs. Deopts V8 reports as "Insufficient type feedback" are classified as soft deopts (warm-up bailouts, not instability) and no longer count toward deopt loops or the CI gate.
- [#2](https://github.com/Saeris/deoptkit/pull/2)  *(minor)* Thanks [@Saeris](https://github.com/Saeris)!
  Functions now report their optimization tiers by name (interpreted, baseline, maglev, turbofan, plus an OSR flag) instead of V8's internal kind numbers. `profile_run`, `load_log`, and `load_manifest` return a `quality` block (user-code ticks, optimized user functions, user IC sites) with warnings for cold runs, runs without profiler ticks, and runs that observed no user code; `get_findings` repeats those warnings so a worthless session is never mistaken for a clean one.
- [#2](https://github.com/Saeris/deoptkit/pull/2)  *(minor)* Thanks [@Saeris](https://github.com/Saeris)!
  New `get_profile` tool: top-down and bottom-up call trees built from the profiler samples (inlining-resolved), filtered to the user's own code by default, pruned by depth, width, and share, and windowed by harness markers like every other tool.
- [#2](https://github.com/Saeris/deoptkit/pull/2)  *(minor)* Thanks [@Saeris](https://github.com/Saeris)!
  `map-details` blocks are parsed at load into structured hidden-class descriptions (type, size, flags, back pointer, constructor, the ordered property descriptors with representation and attributes, and the transitions V8 printed) instead of being kept as raw text. `get_map` returns the parsed shape plus its sibling shapes from the same parent with their property lists, and megamorphic and map-churn findings carry example map addresses so an agent can reach `get_map` directly.
- [#2](https://github.com/Saeris/deoptkit/pull/2)  *(minor)* Thanks [@Saeris](https://github.com/Saeris)!
  Finding identities are now stable across processes: V8's per-process symbol hashes are stripped from IC keys and map property names (printed as Symbol(#name)), map churn is grouped per function by position so anonymous functions and module top-level code no longer merge into one finding, and deopt-loop requires the same optimized tier to deoptimize a position twice (one Maglev plus one TurboFan bailout is warm-up and reports as eager-deopt with per-tier counts). The parser's own tick and map counters and CodeEntry construction are shape-stable.
- [#2](https://github.com/Saeris/deoptkit/pull/2)  *(minor)* Thanks [@Saeris](https://github.com/Saeris)!
  The parser reads V8 15.6's homomorphic inline-cache state (`H`, Node 27) instead of dropping the transition as a bad line, and `list_ics` can filter on it. Map-details parsing accepts the headers Linux prints (`0x` addresses) and the field storage tokens V8 15.6 prints (`in-obj`, `ooo`), so every map on Linux and every data field on Node 27 now parse.
- [#2](https://github.com/Saeris/deoptkit/pull/2)  *(minor)* Thanks [@Saeris](https://github.com/Saeris)!
  The supported Node floor moves from 22 to 24 (`engines.node: >=24`): Node 26 is the active LTS and Node 24 the previous one. CI now runs every lane on Linux, Windows and macOS (Apple silicon) for Node 24, the active LTS and the current release.
- [#2](https://github.com/Saeris/deoptkit/pull/2)  *(patch)* Thanks [@Saeris](https://github.com/Saeris)!
  Removed the `development` export conditions, which pointed at TypeScript sources that are not part of the published package and broke resolution of `deoptkit/bench` and `deoptkit/vitest` under Vitest's native loader.
- [#2](https://github.com/Saeris/deoptkit/pull/2)  *(patch)* Thanks [@Saeris](https://github.com/Saeris)!
  Deopts inside inlined code are now attributed to their innermost source position (one site per position, with the inlining chain kept per event) and carry the deopting function's name.
- [#2](https://github.com/Saeris/deoptkit/pull/2)  *(patch)* Thanks [@Saeris](https://github.com/Saeris)!
  Script URLs are normalized at parse time: loader cache-busting queries such as Vitest's ?vitest=<timestamp> no longer leak into finding identities, baselines, source-map lookups, or LSP diagnostics.
- [#2](https://github.com/Saeris/deoptkit/pull/2)  *(patch)* Thanks [@Saeris](https://github.com/Saeris)!
  The package now lives at `packages/deoptkit` inside a Yarn workspace and declares `repository.directory`; nothing it ships or exports changed.
- [#2](https://github.com/Saeris/deoptkit/pull/2)  *(patch)* Thanks [@Saeris](https://github.com/Saeris)!
  deoptkit lsp accepts the --stdio and --clientProcessId=<pid> flags that vscode-languageclient appends when it starts a module server over stdio, so the VSCode extension's server no longer exits with a usage error on every start.

## 0.1.0
<sub>2026-07-03</sub>

-  *(minor)*
  First release: V8 deoptimization toolkit with an MCP server surface — profile_run, ranked findings with explanations and suggested fixes, IC/deopt/map/profile analysis tools, annotated source snippets, source-map resolution for TypeScript, and compare_sessions for fix verification.
