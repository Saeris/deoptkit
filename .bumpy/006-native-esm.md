---
"deoptkit": minor
---

deoptKit({ nativeEsm: true }) runs bench workers on Node's native ESM loader instead of Vite's module runner, so V8 observes exactly the shipped code at exact source positions.
