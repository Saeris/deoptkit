---
"deoptkit": minor
---

The deoptkit/vitest preset now writes <outDir>/findings.json after each bench run (findings with source-mapped original positions), so deoptkit lsp shows diagnostics straight from vitest bench runs.
