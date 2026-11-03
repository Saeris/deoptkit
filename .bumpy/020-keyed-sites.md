---
"deoptkit": minor
---

Keyed inline-cache sites (`obj[key]`) are now one site per code position with the distinct keys as evidence, instead of one site per runtime key, which made the megamorphic finding name a random key and flicker between runs. Deopts V8 reports as "Insufficient type feedback" are classified as soft deopts (warm-up bailouts, not instability) and no longer count toward deopt loops or the CI gate.
