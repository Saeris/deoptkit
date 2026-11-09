---
"deoptkit": patch
---

deoptkit now waits out a brief lock when it opens a V8 log, instead of failing. On Windows another process, usually an antivirus scan, can hold a file for a moment after its writer closes it. The bench teardown, `profile_run` and `deoptkit ci` all read a log right after it is written, and failed then with `EBUSY`; in the bench teardown, that left `findings.json` without any of the log's findings.
