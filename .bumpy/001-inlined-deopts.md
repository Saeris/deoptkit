---
"deoptkit": patch
---

Deopts inside inlined code are now attributed to their innermost source position (one site per position, with the inlining chain kept per event) and carry the deopting function's name.
