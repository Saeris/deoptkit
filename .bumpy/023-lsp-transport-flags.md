---
"deoptkit": patch
---

deoptkit lsp accepts the --stdio and --clientProcessId=<pid> flags that vscode-languageclient appends when it starts a module server over stdio, so the VSCode extension's server no longer exits with a usage error on every start.
