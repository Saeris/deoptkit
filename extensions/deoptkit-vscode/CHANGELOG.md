# Changelog


## 0.2.0
<sub>2026-11-05</sub>

- [#6](https://github.com/Saeris/deoptkit/pull/6)  *(minor)* Thanks [@Saeris](https://github.com/Saeris)!
  Findings carry `heat`, the share of profile self ticks their severity was scored with, and `deoptkit ci` marks the findings its baseline accepts with `baselined` in `.deopt/findings.json`. `deoptkit lsp` publishes baselined and cold (never sampled) findings as hints, which editors keep out of the Problems panel, so the panel lists only findings that are new and actually ran. The VSCode extension gains a `deoptkit.enable` setting and a **deoptkit: Toggle Enable/Disable** command that stops or starts the language server for the workspace.

## 0.1.0
<sub>2026-11-04</sub>

- [#2](https://github.com/Saeris/deoptkit/pull/2)  *(minor)* Thanks [@Saeris](https://github.com/Saeris)!
  Added the `deoptkit/lsp` export (the language server as a library entry) and the `deoptkit-vscode` extension, a thin VSCode client that starts `deoptkit lsp` from the workspace's installed deoptkit or from the server bundled with the extension and shows findings as diagnostics.
