---
"deoptkit": patch
---

Script URLs are normalized at parse time: loader cache-busting queries such as Vitest's ?vitest=<timestamp> no longer leak into finding identities, baselines, source-map lookups, or LSP diagnostics.
