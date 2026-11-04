---
"deoptkit": minor
---

deoptkit ci gained --accumulate for baselines whose findings flicker at a threshold, baseline identities now use the source-mapped original file so rebuilt bundles with hashed chunk names still match, and dependency code logged with Windows paths is no longer reported as user code. bench/parse.bench.mjs lets deoptkit observe its own parser.
