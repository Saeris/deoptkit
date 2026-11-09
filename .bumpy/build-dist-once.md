---
"deoptkit": patch
---

The `deoptkit/vitest` teardown now waits for each bench worker to exit before it reads that worker's V8 log. Vitest runs global teardowns before it waits for its workers, and V8 writes the end of a log as the process exits, so `findings.json` could miss findings that were in the log, most often on Windows.
