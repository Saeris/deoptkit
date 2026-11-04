---
"deoptkit": minor
---

`get_findings` and `compare_sessions` now return each finding kind's explanation and suggested fix once, under `kinds`, instead of repeating them on every finding (about 40% of the payload); `list_ics` summarizes each site's state history and distinct map count and bounds `includeTransitions` with `maxTransitions`; `profile_run` accepts `compareTo` to re-profile and return the before/after comparison in one call.
