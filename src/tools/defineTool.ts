import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { toJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";
import type { SessionStore } from "../sessions";

export interface ToolContext {
  sessions: SessionStore;
}

type InputSchema = v.ObjectSchema<v.ObjectEntries, undefined>;

export interface ToolDef<Schema extends InputSchema = InputSchema> {
  name: string;
  description: string;
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
  description,
  schema,
  handler
}: ToolDef<Schema>): RegisteredTool => ({
  info: { name, description, inputSchema: toInputSchema(schema) },
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

/** JSON text result helper — every tool responds with a single JSON payload. */
export const jsonResult = (
  payload: unknown,
  options?: { isError: boolean }
): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  ...(options?.isError ? { isError: true } : {})
});
