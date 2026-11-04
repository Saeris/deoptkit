---
"deoptkit": minor
---

The parser reads V8 15.6's homomorphic inline-cache state (`H`, Node 27) instead of dropping the transition as a bad line, and `list_ics` can filter on it. Map-details parsing accepts the headers Linux prints (`0x` addresses) and the field storage tokens V8 15.6 prints (`in-obj`, `ooo`), so every map on Linux and every data field on Node 27 now parse.
