---
"deoptkit": minor
---

`vitest bench` profiles can now run each case a fixed number of times. Set `deoptKit({ iterations })` and select deoptkit's benchmark provider with `benchmark: { provider: "deoptkit/vitest/provider" }`: each case then runs exactly that many times, or fewer when a bench asks for fewer, with no time budget and no warm-up. The logs stay bounded with every category on, and the findings repeat from run to run. `deoptkit ci --manifest .deopt/manifest.json` gates such a run against a baseline, the same way it gates a script. The manifest a run writes now lists only that run's logs, not every log left in the output directory by earlier runs.
