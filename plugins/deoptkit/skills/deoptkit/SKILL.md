---
name: deoptkit
description: Profile a Node.js workload under V8 logging and fix what makes it slow — megamorphic inline caches, deopt loops, hidden-class churn — using the deoptkit MCP tools. Use when asked to optimize, profile, or explain the performance of JavaScript/TypeScript running on Node, or when a benchmark regressed.
---

# deoptkit

Use the `deopt` MCP server (the `deoptkit` package) to find and fix structural V8 optimization problems: megamorphic inline caches, deopt loops, hidden-class (map) churn, and CPU hot spots in JavaScript/TypeScript running on Node.js.

## When to reach for it

- The question is _why_ code is slow in a structural way (object shapes, unstable types, deoptimization), not _how fast_ it is. It is not a wall-clock micro-benchmark runner.
- You have, or can write, a workload that runs the suspect code thousands of times. V8 only optimizes hot code, so a cold run shows nothing.

## The loop

1. Call `profile_run` with `{ command: ["node", "bench.js"] }`. It runs the workload under V8 logging and returns a `sessionId`.
2. Call `get_findings` with `{ sessionId }`. It returns ranked problems (severity 1-100) with source locations, V8-level explanations, and suggested fixes. Start here: it answers "what should I fix first?".
3. Edit the source at the finding's `original` position when present (that is the `.ts`/`.js` you wrote), otherwise at its file and line. Prefer the smallest change that normalizes object shapes or stabilizes types.
4. Call `profile_run` again, then `compare_sessions` with `{ baseSessionId, headSessionId }` to confirm the finding is in `resolved` and nothing meaningful is in `introduced`. If findings remain above severity 30, repeat from step 2.

When a finding needs more context, drill down: `get_function` (annotated source plus its ICs, deopts, and ticks), `get_map` (a shape's transition chain and the call sites it polluted), and `list_ics`, `list_deopts`, `list_functions`. To analyze an existing `v8.log`, use `load_log`; to load every log from a `deoptkit/vitest` bench run, use `load_manifest`. `list_sessions` shows what is already loaded. To scope findings to one benchmark case, pass `fromMark` and `toMark` (markers from `deoptkit/harness` or `benchObserved`).

## Token discipline

- Start with `get_findings { sessionId, limit: 5 }`, then page with `offset`. Narrow with `severityMin`, `file`, and `kinds` instead of reading everything.
- Call `list_ics` with `includeTransitions` for one site at a time; the transition lists are large.
- When the finding is in built output, prefer `get_function` over reading the file yourself.

## Writing a workload

A workload is a script that exercises the target many times with realistically varied inputs. Homogeneous synthetic data hides exactly the shape bugs this tool hunts. Put one scenario per file under `bench/` and wrap the hot loop in `observed()`, which adds warm-up and window markers:

```js
// bench/parse.bench.mjs
import { observed } from "deoptkit/harness";
import { parseRecord } from "../dist/index.mjs";

const inputs = makeVariedInputs(); // realistic, varied shapes
observed("parse record", (i) => parseRecord(inputs[i % inputs.length]), {
  iterations: 50_000
});
```

Then `profile_run { command: ["node", "bench/parse.bench.mjs"] }` and window with `fromMark: "parse_record_start", toMark: "parse_record_end"`.

- Profile the built output, not the source, for libraries: bundling changes shapes and inlining, and you want what users run.
- Projects already on `vitest bench`: add `deoptKit({ outDir: ".deopt" })` from `deoptkit/vitest` to `test` in the Vitest config and use `benchObserved` from `deoptkit/bench` in each case.
- After `vitest bench`, call `load_manifest { path: ".deopt/manifest.json" }` to load every worker's log as a session.

## Reading findings

- `megamorphic-ic`: an access site saw 5+ object shapes, so V8 uses a generic hash lookup. Normalize shapes (same properties, same order, everywhere) or split the call site. Keyed `obj[key]` sites are often inherent to dynamic dispatch.
- `polymorphic-ic`: a site sees 2-4 shapes and checks each one per access. Align property initialization order if they are one type; otherwise handle each shape separately.
- `deopt-loop`: optimized code for a position was discarded repeatedly. Stabilize types after warm-up: do not mix numbers and strings in one operation or change object shapes late.
- `eager-deopt`: optimized code bailed out on a state its type feedback did not predict. The reason string names the failed assumption; make that value or shape consistent.
- `soft-deopt`: V8 deoptimized on purpose to gather feedback. Usually harmless; act only if the site also has eager deopts or sits in a hot function.
- `map-churn`: one creation site produces many hidden classes, usually from conditional or reordered property assignment. Initialize every property unconditionally in a fixed order (use `undefined` for optional fields), or use a class constructor.

## Verifying

A fix is done when `compare_sessions` shows the finding in `resolved` and nothing meaningful in `introduced`. For a permanent guard, gate CI on new structural findings:

```bash
deoptkit ci bench/parse.bench.mjs             # first run writes .deopt/baselines/…, passes
deoptkit ci bench/parse.bench.mjs             # exit 1 only on NEW structural findings
deoptkit ci --update bench/parse.bench.mjs    # accept current findings as the baseline
```
