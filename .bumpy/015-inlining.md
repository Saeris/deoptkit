---
"deoptkit": minor
---

The parser now decodes V8's `code-source-info` inlining tables: inline-cache events, profiler ticks, map transitions, and deopts inside inlined code are attributed to the inlined function at its own source position instead of the caller's. Inlined copies of a megamorphic site no longer appear as a second finding in the caller's file, and functions that only ever run inlined now receive their own self ticks.
