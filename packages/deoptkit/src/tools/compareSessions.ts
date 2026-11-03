import * as v from "valibot";
import { compareSessions } from "../analysis/compare";
import { toWorkspacePath } from "../analysis/paths";
import { defineTool, jsonResult } from "./defineTool";
import {
  presentLocation,
  sessionIdSchema,
  unknownSessionError
} from "./shared";

export const compareSessionsTool = defineTool({
  name: "compare_sessions",
  title: "Compare before/after",
  description:
    "Diff two sessions to verify a fix: findings resolved by the change, regressions it " +
    "introduced, findings persisting (with severity movement), and per-function CPU deltas. " +
    "Profile before the change, apply it, profile again, then compare base vs head.",
  annotations: { readOnlyHint: true, idempotentHint: true },
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
    const comparison = compareSessions(base.model, head.model);
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
      ...comparison,
      resolved: comparison.resolved.map((found) =>
        presentLocation(base, found)
      ),
      introduced: comparison.introduced.map((found) =>
        presentLocation(head, found)
      ),
      persisting: comparison.persisting.map((row) => ({
        ...row,
        file: toWorkspacePath(row.file, head.workspaceRoot)
      })),
      functionDeltas: comparison.functionDeltas.map((row) => ({
        ...row,
        file: toWorkspacePath(row.file, head.workspaceRoot)
      }))
    });
  }
});
