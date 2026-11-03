---
"deoptkit": minor
---

Vitest 5 support: `benchObserved` now wraps the `bench` test-context fixture (`benchObserved(bench, name, fn, options?)`) and the `vitest` peer range is `>=5`. The `deoptkit/vitest` preset passes V8 flags through Vitest's top-level `execArgv` (the previous `poolOptions` key was ignored by Vitest 4+, so workers never produced logs). Toolchain moved to Vite+ 1.4 and dependencies were refreshed.
