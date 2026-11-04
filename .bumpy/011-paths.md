---
"deoptkit": minor
---

Tool responses now report every location as a workspace-relative path (relative to `profile_run`'s `cwd`, `load_log`/`load_manifest`'s new `workspaceRoot`, or the server's working directory) that agents can pass straight to their file tools; files outside the workspace appear as absolute paths. `deoptkit ci` baselines now store identities with paths relative to the working directory, so a committed baseline matches on every machine and CI runner.
