# deoptkit for VSCode

Shows V8 deoptimization findings from [deoptkit](../../packages/deoptkit) (megamorphic inline caches, deopt loops, hidden-class churn) as inline diagnostics: squiggles in the editor and entries in the Problems panel, with the explanation and suggested fix in the hover.

This extension is a thin client. It holds no analysis logic: it starts the `deoptkit lsp` language server and lets VSCode render the diagnostics the server publishes.

## Getting findings

The extension displays whatever is in `.deopt/findings.json` in your workspace folder. Produce that file with either of:

- `deoptkit ci <script>` (see [CI regression gating](../../packages/deoptkit/README.md#ci-regression-gating))
- the `deoptkit/vitest` preset, for example `vitest bench --watch`, which rewrites the file on every run so the squiggles update live

Severity follows the finding score (error at 60 and above, warning at 25 and above, information below). Findings older than the file they annotate are downgraded to information with a re-run hint.

## Settings

| Setting                  | Default                | Description                                                                                                                                                     |
| ------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deoptkit.findingsPath`  | `.deopt/findings.json` | The findings interchange, relative to the workspace folder.                                                                                                     |
| `deoptkit.serverCommand` | `[]`                   | Command that starts the language server, for example `["npx", "deoptkit", "lsp"]`. Leave empty to use the workspace's installed deoptkit or the bundled server. |

## Which server runs

In order of preference:

1. `deoptkit.serverCommand`, when set.
2. The workspace's own `node_modules/deoptkit` (`dist/main.mjs`), so the server is the same version that wrote `findings.json`.
3. The server bundled with this extension, so installing the extension alone is enough.

The bundled and installed servers run on the editor's own Node runtime; nothing depends on your `PATH`.

## Limitations

- Only the first workspace folder gets a language server (multi-root workspaces are not supported yet).
- There are no commands, decorations, or CodeLens; the extension only shows diagnostics.

See the [deoptkit README](../../packages/deoptkit/README.md#inline-editor-diagnostics-lsp) for the other editors the server works with.
