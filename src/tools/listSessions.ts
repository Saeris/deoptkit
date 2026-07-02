import * as v from "valibot";
import { defineTool, jsonResult } from "./defineTool";

export const listSessions = defineTool({
  name: "list_sessions",
  description:
    "List the V8 log sessions currently loaded in this server. " +
    "Each session represents one parsed v8.log; use its id with the analysis tools.",
  schema: v.object({}),
  handler: (_input, ctx) => jsonResult({ sessions: ctx.sessions.list() })
});
