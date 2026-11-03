---
"deoptkit": minor
---

Finding identities are now stable across processes: V8's per-process symbol hashes are stripped from IC keys and map property names (printed as Symbol(#name)), map churn is grouped per function by position so anonymous functions and module top-level code no longer merge into one finding, and deopt-loop requires the same optimized tier to deoptimize a position twice (one Maglev plus one TurboFan bailout is warm-up and reports as eager-deopt with per-tier counts). The parser's own tick and map counters and CodeEntry construction are shape-stable.
