import * as v from "valibot";
import { defineTool, jsonResult } from "./defineTool";
import {
  fileFilterSchema,
  fromMarkSchema,
  limitSchema,
  matchesFile,
  offsetSchema,
  paginate,
  sessionIdSchema,
  toMarkSchema,
  unknownSessionError,
  windowedModel
} from "./shared";

export const listFunctions = defineTool({
  name: "list_functions",
  title: "CPU profile (flat)",
  description:
    "List functions by CPU profile weight (a flat profile). selfTicks is time at the top of " +
    "the stack; totalTicks counts any presence on the stack. Windows samples at ~15ms granularity.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  schema: v.object({
    sessionId: sessionIdSchema,
    file: fileFilterSchema,
    sortBy: v.optional(
      v.pipe(
        v.picklist(["selfTicks", "totalTicks"]),
        v.description("Sort key (default selfTicks)")
      )
    ),
    fromMark: fromMarkSchema,
    toMark: toMarkSchema,
    limit: limitSchema,
    offset: offsetSchema
  }),
  handler: (
    { sessionId, file, sortBy, fromMark, toMark, limit, offset },
    ctx
  ) => {
    const session = ctx.sessions.get(sessionId);
    if (!session) return unknownSessionError(sessionId);
    const model = windowedModel(session, { fromMark, toMark });
    if ("error" in model) return jsonResult(model, { isError: true });
    const key = sortBy ?? "selfTicks";
    const rows = model.profile.functions
      .filter((row) => matchesFile(row.file, file))
      .toSorted((a, b) => b[key] - a[key]);
    return jsonResult({
      tickCount: model.profile.tickCount,
      vmStates: model.profile.vmStates,
      ...paginate(rows, limit, offset)
    });
  }
});
