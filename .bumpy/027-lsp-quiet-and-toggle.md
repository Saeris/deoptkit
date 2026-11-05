---
"deoptkit": minor
"deoptkit-vscode": minor
---

Findings carry `heat`, the share of profile self ticks their severity was scored with, and `deoptkit ci` marks the findings its baseline accepts with `baselined` in `.deopt/findings.json`. `deoptkit lsp` publishes baselined and cold (never sampled) findings as hints, which editors keep out of the Problems panel, so the panel lists only findings that are new and actually ran. The VSCode extension gains a `deoptkit.enable` setting and a **deoptkit: Toggle Enable/Disable** command that stops or starts the language server for the workspace.
