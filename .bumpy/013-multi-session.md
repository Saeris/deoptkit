---
"deoptkit": minor
---

`get_findings` accepts `sessionIds` to rank the findings of several sessions (for example every worker log of a vitest bench run) in one response, merged by identity with the sessions each finding appeared in; `load_manifest` returns the loaded `sessionIds` ready to pass along.
