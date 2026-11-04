# Plan 023: `deoptkit lsp` must accept the flags `vscode-languageclient` appends

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md` — unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**, from the repository root: `grep -c 'Unknown flag' packages/deoptkit/src/lsp/server.ts` → 1; `grep -c 'export const parseLspArgs' packages/deoptkit/src/lsp/server.ts` → 1; `grep -c 'TransportKind.stdio' extensions/deoptkit-vscode/src/extension.ts` → 2; `grep -c "clientProcessId" node_modules/vscode-languageclient/lib/node/main.js` ≥ 2 (run `vp install` first if `node_modules` is missing). On any mismatch, STOP.

## Status

- **Priority**: P0
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/009-vscode-extension-spike.md
- **Category**: correctness
- **Planned at**: commit `106f06f`, 2026-11-03

## Why this matters

The VSCode extension from plan 009 crashes on every activation. The maintainer installed the built `.vsix` and immediately got a wall of error notifications. Reproduced headlessly: `vscode-languageclient` starts a `module` server with `TransportKind.stdio` by spawning the extension host's Node with the module path, the configured `args`, then `--stdio`, then `--clientProcessId=<pid>` (`node_modules/vscode-languageclient/lib/node/main.js`, the `args.push` calls near lines 340 and 346). `parseLspArgs` in `packages/deoptkit/src/lsp/server.ts` rejects any flag it does not know, so the server prints `Unknown flag: --stdio` and exits with code 2 before reading a byte; the client restarts it until it gives up ("The deoptkit server crashed 5 times in the last 3 minutes") and every restart raises a notification.

Replay, from `packages/deoptkit` after a build, piping a framed `initialize` request on stdin:

- `node dist/main.mjs lsp --findings <path> --stdio` → exit code 2, stderr `Unknown flag: --stdio`.
- `node dist/main.mjs lsp --findings <path>` → stays up, answers `{"serverInfo":{"name":"deoptkit","version":"0.1.0"}}`.

Plan 009's smoke test sent `initialize` without the client's flags, which is why it passed.

## Current state

`packages/deoptkit/src/lsp/server.ts`, lines 104–118:

```ts
export const parseLspArgs = (
  args: string[]
): { findingsPath: string } | { error: string } => {
  let findingsPath = join(".deopt", "findings.json");
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--findings") {
      const value = args.at(++index);
      if (value === undefined) return { error: "--findings requires a value" };
      findingsPath = value;
    } else {
      return { error: `Unknown flag: ${arg}` };
    }
  }
  return { findingsPath };
};
```

`runLsp(args, streams?)` calls it, writes the error to stderr and returns 2. The server only ever speaks stdio (`Connection(process.stdin, process.stdout)`).

`packages/deoptkit/src/lsp/__tests__/lsp.spec.ts` has describes for `jsonrpc framing`, `toDiagnostics` and `runLsp end-to-end over in-process streams`; it imports `runLsp, toDiagnostics` from `../server`. No test covers `parseLspArgs`.

`extensions/deoptkit-vscode/src/extension.ts` `serverFor` returns `{ module, transport: TransportKind.stdio, args: ["lsp", "--findings", findings] }` for the workspace's installed `dist/main.mjs`, or `{ module: dist/server.cjs, transport: TransportKind.stdio, args: ["--findings", findings] }` for the bundled server. The client is correct; the flags it appends are the standard LSP transport convention. Do not change it.

`docs/VSCODE_EXTENSION.md` has a "## Smoke test" section (line 139 onward) that records the headless `initialize` replay against `dist/server.cjs` and leaves the in-editor check to the maintainer.

Conventions: 2-space indent, double quotes, `const` arrows, explicit return types on exported functions, comments explain why, tests carry a why-comment. Soft-wrapped markdown. No attribution lines in commits.

## Commands you will need

| Purpose         | Command (repository root)                                    | Expected on success                 |
| --------------- | ------------------------------------------------------------ | ----------------------------------- |
| Install         | `vp install`                                                 | exit 0                              |
| Format and lint | `vp check --fix`                                             | no lint or type errors              |
| LSP spec        | `vp -C packages/deoptkit test src/lsp/__tests__/lsp.spec.ts` | all pass                            |
| All tests       | `vp test`                                                    | all pass, none skipped              |
| Build engine    | `vp -C packages/deoptkit pack`                               | `Build complete`                    |
| Build extension | `vp -C extensions/deoptkit-vscode run build`                 | writes `deoptkit-vscode-0.0.0.vsix` |

## Scope

**In scope**: `packages/deoptkit/src/lsp/server.ts`, `packages/deoptkit/src/lsp/__tests__/lsp.spec.ts`, `docs/VSCODE_EXTENSION.md` (smoke-test section only), `.bumpy/023-lsp-transport-flags.md` (create).

**Out of scope**: `extensions/deoptkit-vscode/**`, `packages/deoptkit/src/main.ts`, any other flag handling, exiting when the client process dies (a later improvement; today the client sends `shutdown`/`exit`).

## Git workflow

- Branch: `exec/plan-023` in a dedicated worktree; stay there.
- One commit: `LSP: accept the --stdio and --clientProcessId flags vscode-languageclient appends`.
- Bump file `.bumpy/023-lsp-transport-flags.md` with `"deoptkit": patch` and body: `deoptkit lsp accepts the --stdio and --clientProcessId=<pid> flags that vscode-languageclient appends when it starts a module server over stdio, so the VSCode extension's server no longer exits with a usage error on every start.`
- Do NOT push or open a PR. No attribution lines.

## Steps

### Step 1: Accept the client's transport flags

In `parseLspArgs`, before the `Unknown flag` branch, accept `--stdio` and any argument starting with `--clientProcessId=` as no-ops, with this comment above the branch: `vscode-languageclient appends --stdio and --clientProcessId=<pid> when it starts a module server over stdio; stdio is the only transport this server has, and the pid is not used yet.` Keep every other unknown flag an error.

Add a `describe("parseLspArgs")` to `lsp.spec.ts` (import `parseLspArgs` from `../server`) with:

- `["--stdio", "--clientProcessId=4242"]` → `{ findingsPath: join(".deopt", "findings.json") }`.
- `["--findings", "x.json", "--stdio"]` → `{ findingsPath: "x.json" }`.
- `["--bogus"]` → an object whose `error` is `"Unknown flag: --bogus"`.

The why-comment above the describe: the VSCode client always appends these two flags, so rejecting them made the bundled server exit with a usage error on every start and the editor report the server as crashed.

**Verify**: `vp check --fix` clean; `vp -C packages/deoptkit test src/lsp/__tests__/lsp.spec.ts` → all pass.

### Step 2: Replay the real spawn against both entry points

Build the engine and the extension (`vp -C packages/deoptkit pack`, `vp -C extensions/deoptkit-vscode run build`). Write a scratch script (outside the repository, under `C:\Users\drake\AppData\Local\Temp\claude\c--GitHub--saeris-deopt-mcp\00648906-f002-4121-a769-708ffa0c984a\scratchpad\p023\`) that spawns `node <entry> <args> --stdio --clientProcessId=4242`, writes one framed `initialize` request (`Content-Length: <bytes>\r\n\r\n{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":null,"rootUri":null,"capabilities":{}}}`), waits two seconds, kills the child, and prints the exit code and the first 300 bytes of stdout and stderr. Run it for:

- `packages/deoptkit/dist/main.mjs lsp --findings <any path>`
- `extensions/deoptkit-vscode/dist/server.cjs --findings <any path>`

Both must answer with `"serverInfo":{"name":"deoptkit"` on stdout and must not exit on their own before the kill.

**Verify**: paste both outputs in NOTES.

### Step 3: Record it

In `docs/VSCODE_EXTENSION.md`, in the "## Smoke test" section, add a bullet: the client appends `--stdio` and `--clientProcessId=<pid>` to the module server's arguments; the replay in Step 2 includes them, and the 0.0.0 build installed before this fix crashed on every activation because the server rejected them.

Create the bump file. Run `vp check --fix` and `vp test`. Commit.

**Verify**: `git show --stat HEAD` lists exactly `server.ts`, `lsp.spec.ts`, `docs/VSCODE_EXTENSION.md`, and the bump file; `git status --short` clean (the `.vsix` is git-ignored).

## Done criteria

- [ ] `parseLspArgs` accepts `--stdio` and `--clientProcessId=<pid>`, still rejects other unknown flags, and the spec proves all three
- [ ] Both entry points answer `initialize` when spawned with the client's flags (Step 2 output in NOTES)
- [ ] `vp check` and `vp test` exit 0; bump file present; one commit
- [ ] `plans/README.md` status row updated (skip if your reviewer maintains the index)

## STOP conditions

- The drift check fails.
- After Step 1, either entry point in Step 2 still exits before the kill or answers nothing; report the exact stderr.

## Maintenance notes

- If the extension ever switches to `TransportKind.ipc` or `pipe`, the client appends `--node-ipc` or `--pipe=<name>` instead and the server must learn that transport, not just the flag.
- The in-editor check after this fix is the maintainer's: rebuild the `.vsix`, reinstall it, open a TypeScript file in a workspace with `.deopt/findings.json`, and confirm the Problems panel shows deoptkit diagnostics and no crash notification.
