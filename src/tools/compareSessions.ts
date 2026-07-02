import * as v from "valibot";
import { compareSessions } from "../analysis/compare";
import { defineTool, jsonResult } from "./defineTool";
import { sessionIdSchema, unknownSessionError } from "./shared";

export const compareSessionsTool = defineTool({
  name: "compare_sessions",
  description:
    "Diff two sessions to verify a fix: findings resolved by the change, regressions it " +
    "introduced, findings persisting (with severity movement), and per-function CPU deltas. " +
    "Profile before the change, apply it, profile again, then compare base vs head.",
  schema: v.object({
    baseSessionId: v.pipe(
      sessionIdSchema,
      v.description("The 'before' session")
    ),
    headSessionId: v.pipe(sessionIdSchema, v.description("The 'after' session"))
  }),
  handler: ({ baseSessionId, headSessionId }, ctx) => {
    const base = ctx.sessions.get(baseSessionId);
    if (!base) return unknownSessionError(baseSessionId);
    const head = ctx.sessions.get(headSessionId);
    if (!head) return unknownSessionError(headSessionId);
    return jsonResult({
      base: {
        sessionId: base.id,
        source: base.source,
        v8Version: base.model.v8Version
      },
      head: {
        sessionId: head.id,
        source: head.source,
        v8Version: head.model.v8Version
      },
      ...compareSessions(base.model, head.model)
    });
  }
});
