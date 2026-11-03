---
"deoptkit": patch
---

Removed the `development` export conditions, which pointed at TypeScript sources that are not part of the published package and broke resolution of `deoptkit/bench` and `deoptkit/vitest` under Vitest's native loader.
