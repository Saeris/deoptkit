import type {
  CallToolResult,
  Tool,
  ToolAnnotations
} from "@modelcontextprotocol/sdk/types.js";
import { toJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";
import type { SessionStore } from "../sessions";

export interface ToolContext {
  sessions: SessionStore;
}

type InputSchema = v.ObjectSchema<v.ObjectEntries, undefined>;

export interface ToolDef<Schema extends InputSchema = InputSchema> {
  name: string;
  title: string;
  description: string;
  /** Hosts use these hints to decide what to auto-approve, so every tool must state its own. */
  annotations: ToolAnnotations & { readOnlyHint: boolean };
  schema: Schema;
  handler: (
    input: v.InferOutput<Schema>,
    ctx: ToolContext
  ) => Promise<CallToolResult> | CallToolResult;
}

/** A tool with its schema type erased: ready to list over the wire and invoke with raw args. */
export interface RegisteredTool {
  info: Tool;
  invoke: (args: unknown, ctx: ToolContext) => Promise<CallToolResult>;
}

/** Rebuild the converter's output as the SDK's `inputSchema` shape without a narrowing cast. */
const toInputSchema = (schema: InputSchema): Tool["inputSchema"] => {
  const json = toJsonSchema(schema);
  const properties = Object.fromEntries(
    Object.entries(json.properties ?? {}).filter(
      (entry): entry is [string, object] => typeof entry[1] === "object"
    )
  );
  return {
    type: "object",
    properties,
    ...(json.required ? { required: json.required } : {})
  };
};

/**
 * Bind a Valibot schema to a handler. Argument validation happens inside `invoke`,
 * so the registry only ever deals with `unknown` args and heterogeneous tools can
 * share one array without variance casts.
 */
export const defineTool = <Schema extends InputSchema>({
  name,
  title,
  description,
  annotations,
  schema,
  handler
}: ToolDef<Schema>): RegisteredTool => ({
  info: {
    name,
    title,
    description,
    inputSchema: toInputSchema(schema),
    annotations
  },
  invoke: async (args, ctx): Promise<CallToolResult> => {
    const parsed = v.safeParse(schema, args ?? {});
    if (!parsed.success) {
      return jsonResult(
        { error: "Invalid arguments", issues: v.flatten(parsed.issues).nested },
        { isError: true }
      );
    }
    return handler(parsed.output, ctx);
  }
});

/** `structuredContent` must be a JSON object, so arrays and primitives stay text-only. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * JSON result helper — every tool responds with a single JSON payload. Object payloads
 * are also returned as `structuredContent` so clients can consume the data without
 * re-parsing the text block, which stays for clients that only read text.
 */
export const jsonResult = (
  payload: unknown,
  options?: { isError: boolean }
): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  ...(isRecord(payload) ? { structuredContent: payload } : {}),
  ...(options?.isError ? { isError: true } : {})
});
