# Recipes

Practical patterns for putting code under deoptkit's observation. Background and rationale live in [BENCHMARKING.md](./BENCHMARKING.md); this page is the copy-paste layer.

## Library bench scripts (`profile_run`)

The zero-integration pattern: standalone scripts under `bench/`, one scenario per file, importing the **built** package (bundling changes shapes and inlining; profile what users run). Wrap the hot loop in `observed()` so warm-up and window markers come free, and let inputs vary — homogeneous synthetic data hides exactly the shape bugs this tool hunts.

```js
// bench/parse.bench.mjs
import { observed } from "deoptkit/harness";
import { parseRecord } from "../dist/index.mjs";

const inputs = makeVariedInputs(); // see the Valimock recipe below

observed("parse record", (i) => parseRecord(inputs[i % inputs.length]), {
  iterations: 50_000
});
```

Agent loop: `profile_run { command: ["node", "bench/parse.bench.mjs"] }` → `get_findings { sessionId, fromMark: "parse_record_start", toMark: "parse_record_end" }` → fix → re-run → `compare_sessions`.

## Schema-driven inputs (Valibot + Valimock)

A Valibot schema with optional fields is a shape generator: it encodes exactly which structural variations exist in your domain, and [Valimock](https://github.com/Saeris/valimock) manufactures them. **Seed the RNG** — reproducible inputs keep findings stable across runs and CI baselines meaningful.

```js
import { faker } from "@faker-js/faker";
import { Valimock } from "valimock";
import { RecordSchema } from "../dist/schemas.mjs";

faker.seed(1234);
const mock = new Valimock();
const inputs = Array.from({ length: 256 }, () => mock.mock(RecordSchema));
```

Caveat: schema-level variety can overstate what one call site sees in production. Treat findings from mocked stress as strong hypotheses; `get_map` shows which shapes actually hit the site.

## Vitest bench mode (`deoptkit/vitest`)

For projects already using `vitest bench`. The preset forks workers under V8 logging (one log per worker) and writes a manifest on teardown; `benchObserved` gives each case its own window markers.

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
import { benchObserved } from "deoptkit/bench";
import { parseRecord } from "../parse";

benchObserved("parse record", () => parseRecord(next()));
```

Then: run `vitest bench`, call `load_manifest { path: ".deopt/manifest.json" }`, and query each session windowed to a case (`fromMark: "parse_record_start"`, `toMark: "parse_record_end"`). Coverage must be off — the preset refuses to run otherwise, because instrumented code has different optimization behavior than the code you ship.

## Analyzing a log you already have

Any `v8.log` works, wherever it came from:

```
node --logfile=v8.log --no-logfile-per-isolate --log-deopt --log-ic \
     --log-maps --log-maps-details --log-code --log-source-code \
     --prof --log-internal-timer-events --detailed-line-info app.js
```

→ `load_log { path: "v8.log" }`. TypeScript projects get positions mapped back to `.ts` sources automatically when source maps are discoverable (inline or `.map` beside the built file).
