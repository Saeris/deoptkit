---
"deoptkit": minor
---

Functions now report their optimization tiers by name (interpreted, baseline, maglev, turbofan, plus an OSR flag) instead of V8's internal kind numbers. `profile_run`, `load_log`, and `load_manifest` return a `quality` block (user-code ticks, optimized user functions, user IC sites) with warnings for cold runs, runs without profiler ticks, and runs that observed no user code; `get_findings` repeats those warnings so a worthless session is never mistaken for a clean one.
