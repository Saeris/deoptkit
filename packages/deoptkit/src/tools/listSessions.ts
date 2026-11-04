import * as v from "valibot";
import { defineTool, jsonResult } from "./defineTool";

export const listSessions = defineTool({
  name: "list_sessions",
  title: "Loaded sessions",
  description:
    "List the V8 log sessions currently loaded in this server. " +
    "Each session represents one parsed v8.log; use its id with the analysis tools.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  schema: v.object({}),
  handler: (_input, ctx) => jsonResult({ sessions: ctx.sessions.list() })
});
