import * as v from "valibot";
import { defineTool, jsonResult } from "./defineTool";
import {
  fileFilterSchema,
  limitSchema,
  matchesFile,
  offsetSchema,
  paginate,
  sessionIdSchema,
  unknownSessionError
} from "./shared";

export const listFunctions = defineTool({
  name: "list_functions",
  description:
    "List functions by CPU profile weight (a flat profile). selfTicks is time at the top of " +
    "the stack; totalTicks counts any presence on the stack. Windows samples at ~15ms granularity.",
  schema: v.object({
    sessionId: sessionIdSchema,
    file: fileFilterSchema,
    sortBy: v.optional(
      v.pipe(
        v.picklist(["selfTicks", "totalTicks"]),
        v.description("Sort key (default selfTicks)")
      )
    ),
    limit: limitSchema,
    offset: offsetSchema
  }),
  handler: ({ sessionId, file, sortBy, limit, offset }, ctx) => {
    const session = ctx.sessions.get(sessionId);
    if (!session) return unknownSessionError(sessionId);
    const key = sortBy ?? "selfTicks";
    const rows = session.model.profile.functions
      .filter((row) => matchesFile(row.file, file))
      .toSorted((a, b) => b[key] - a[key]);
    return jsonResult({
      tickCount: session.model.profile.tickCount,
      vmStates: session.model.profile.vmStates,
      ...paginate(rows, limit, offset)
    });
  }
});
