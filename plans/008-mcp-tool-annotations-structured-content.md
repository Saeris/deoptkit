# Plan 008: Add MCP tool titles, annotations, and structured content

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md` — unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat b733901..HEAD -- src/tools src/server.ts src/__tests__/server.spec.ts` and `git status --short` on those paths. Compare the excerpts below with the live code; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `b733901`, 2026-11-03

## Why this matters

MCP hosts use tool metadata to decide how to present and gate tools. `annotations.readOnlyHint` lets Claude Code and other hosts auto-approve read-only calls instead of prompting on every `get_findings`; `title` gives a human-readable name in tool pickers; `structuredContent` returns the JSON payload as data so clients can validate and display it without re-parsing text. deoptkit's tools provide none of these: `defineTool` emits `{ name, description, inputSchema }` and every result is `JSON.stringify(payload)` inside a text block. The installed `@modelcontextprotocol/sdk` 1.32.2 types declare `Tool.title`, `Tool.annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), and `CallToolResult.structuredContent`. All eleven tools except `profile_run` are read-only with respect to the user's environment (session state lives inside the server); `profile_run` executes a command.

`outputSchema` is deliberately deferred: once declared, hosts may validate every result against it, including error results, and the tools' error shapes vary.

## Current state

- `src/tools/defineTool.ts` (74 lines):

  ```ts
  // lines 12-20
  export interface ToolDef<Schema extends InputSchema = InputSchema> {
    name: string;
    description: string;
    schema: Schema;
    handler: (
      input: v.InferOutput<Schema>,
      ctx: ToolContext
    ) => Promise<CallToolResult> | CallToolResult;
  }
  ```

  ```ts
  // lines 48-65
  export const defineTool = <Schema extends InputSchema>({
    name,
    description,
    schema,
    handler
  }: ToolDef<Schema>): RegisteredTool => ({
    info: { name, description, inputSchema: toInputSchema(schema) },
    invoke: async (args, ctx): Promise<CallToolResult> => {
      const parsed = v.safeParse(schema, args ?? {});
      if (!parsed.success) {
        return jsonResult(
          {
            error: "Invalid arguments",
            issues: v.flatten(parsed.issues).nested
          },
          { isError: true }
        );
      }
      return handler(parsed.output, ctx);
    }
  });
  ```

  ```ts
  // lines 67-74
  /** JSON text result helper — every tool responds with a single JSON payload. */
  export const jsonResult = (
    payload: unknown,
    options?: { isError: boolean }
  ): CallToolResult => ({
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(options?.isError ? { isError: true } : {})
  });
  ```

- `src/server.ts` — `ListToolsRequestSchema` handler returns `tools.map(({ info }) => info)` (lines 97–99); `CallToolRequestSchema` handler at lines 134–143.
- Tool modules (`src/tools/*.ts`): `listSessions`, `loadLog`, `loadManifest`, `profileRun`, `getFindings`, `listIcs`, `listDeopts`, `listFunctions`, `getMap`, `getFunction`, `compareSessionsTool`, each a `defineTool({ name, description, schema, handler })` call.
- `src/__tests__/server.spec.ts` — `tools/list` test (lines 44–65) pins the tool names and asserts object schemas and non-empty descriptions; `textPayload` helper (lines 20–25) parses the text block.
- SDK types: `node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts` — search `readOnlyHint` (tool annotations) and `structuredContent` (call tool result).

Conventions: Valibot for schemas, `jsonResult` for all responses, low-level `Server` (do not switch to `McpServer`; it is zod-only).

## Commands you will need

| Purpose                   | Command                                | Expected on success |
| ------------------------- | -------------------------------------- | ------------------- |
| Format + lint + typecheck | `vp check --fix`                       | clean               |
| Server tests              | `vp test src/__tests__/server.spec.ts` | pass                |
| All tests                 | `vp test`                              | all pass            |

## Scope

**In scope**:

- `src/tools/defineTool.ts`
- All eleven `src/tools/*.ts` tool modules (add `title` and `annotations` to each definition)
- `src/__tests__/server.spec.ts` (extend)
- `.bumpy/008-tool-metadata.md` (create)

**Out of scope**:

- `src/server.ts` — `info` is already passed through; no change needed unless the SDK type for `Tool` rejects the new fields (then STOP).
- `outputSchema` — deferred, see above.
- Prompt definitions.

## Git workflow

- Branch: `advisor/008-tool-metadata` from `main`.
- Suggested commit: `MCP: advertise tool titles and annotations, return structured content`.
- Bump file `.bumpy/008-tool-metadata.md` with `"deoptkit": minor` and body: `Tools now advertise titles and MCP annotations (read-only hints for every tool except profile_run) and return structuredContent alongside the JSON text.`
- Do NOT push or open a PR unless the operator instructed it. No attribution lines.

## Steps

### Step 1: Extend `defineTool`

- `ToolDef` gains `title: string` and `annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }` (required so no tool is forgotten).
- `info` becomes `{ name, title, description, inputSchema, annotations }`. If the SDK's `Tool` type names the annotations type (search `ToolAnnotations` in `types.d.ts`), import and use it instead of the inline shape.
- `jsonResult`: when `payload` is a non-null object and not an array, also set `structuredContent: payload as Record<string, unknown>`. Keep the text block unchanged so existing clients and tests keep working.

**Verify**: `vp check` → errors only in the tool modules (missing `title`/`annotations`).

### Step 2: Annotate every tool

Add to each definition:

| Tool               | title                | readOnlyHint | other hints                                                      |
| ------------------ | -------------------- | ------------ | ---------------------------------------------------------------- |
| `list_sessions`    | Loaded sessions      | true         | idempotentHint true                                              |
| `load_log`         | Load V8 log          | true         | idempotentHint false                                             |
| `load_manifest`    | Load bench manifest  | true         | idempotentHint false                                             |
| `profile_run`      | Profile a command    | false        | destructiveHint false, idempotentHint false, openWorldHint false |
| `get_findings`     | Ranked findings      | true         | idempotentHint true                                              |
| `list_ics`         | Inline cache sites   | true         | idempotentHint true                                              |
| `list_deopts`      | Deopt sites          | true         | idempotentHint true                                              |
| `list_functions`   | CPU profile (flat)   | true         | idempotentHint true                                              |
| `get_map`          | Hidden class details | true         | idempotentHint true                                              |
| `get_function`     | Function deep dive   | true         | idempotentHint true                                              |
| `compare_sessions` | Compare before/after | true         | idempotentHint true                                              |

Rationale to keep in a one-line comment on `profile_run`: it spawns the user's command, so it must never be auto-approved as read-only.

**Verify**: `vp check --fix` → clean.

### Step 3: Tests

In `src/__tests__/server.spec.ts`:

- Extend the `tools/list` test: every tool has a non-empty `title` and `annotations.readOnlyHint` of type boolean; `profile_run`'s `readOnlyHint` is `false` and every other tool's is `true`. Comment: hosts auto-approve read-only tools; mislabeling `profile_run` would let a host run commands without asking.
- Add a test on `list_sessions`: `result.structuredContent` deep-equals `textPayload(result)`. Comment: clients that consume `structuredContent` must see exactly what text consumers see.

**Verify**: `vp test src/__tests__/server.spec.ts` → passes; `vp test` → all pass.

## Test plan

- Extended `tools/list` assertions; new structured-content equality test.
- Pattern: existing tests in `server.spec.ts`.
- Verification: `vp test` → all pass.

## Done criteria

- [ ] `vp check` exits 0
- [ ] `vp test` exits 0 with the new assertions
- [ ] `grep -L "annotations" src/tools/*.ts` lists only `defineTool.ts` and `shared.ts`
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- The SDK's `Tool` or `CallToolResult` types (1.32.2) reject `title`, `annotations`, or `structuredContent`; report the type error verbatim.
- The in-memory client in the test strips `structuredContent` (check the raw `result` object); report rather than asserting on text only.

## Maintenance notes

- New tools must declare `annotations`; the required field makes omission a type error.
- When `outputSchema` is added later, define Valibot output schemas per tool and convert with `@valibot/to-json-schema` like `toInputSchema`; make error results conform or omit `structuredContent` on `isError`.
