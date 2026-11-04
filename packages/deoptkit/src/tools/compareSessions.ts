import * as v from "valibot";
import type { SessionComparison } from "../analysis/compare";
import { compareSessions } from "../analysis/compare";
import type { Finding } from "../analysis/findings";
import { toWorkspacePath } from "../analysis/paths";
import type { Session } from "../sessions";
import type { OriginalPosition } from "../sourcemaps/resolver";
import { defineTool, jsonResult } from "./defineTool";
import {
  kindsLegend,
  presentLocation,
  sessionIdSchema,
  slimFinding,
  unknownSessionError
} from "./shared";
import type { SlimFinding } from "./shared";

/** The before/after comparison compare_sessions returns; profile_run embeds it as `comparison`. */
export interface ComparisonPayload extends Omit<
  SessionComparison,
  "resolved" | "introduced"
> {
  base: { sessionId: string; source: string; v8Version: string };
  head: { sessionId: string; source: string; v8Version: string };
  resolved: Array<SlimFinding<Finding & { original?: OriginalPosition }>>;
  introduced: Array<SlimFinding<Finding & { original?: OriginalPosition }>>;
  kinds: ReturnType<typeof kindsLegend>;
}

export const comparisonPayload = (
  base: Session,
  head: Session
): ComparisonPayload => {
  const comparison = compareSessions(base.model, head.model);
  return {
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
      slimFinding(presentLocation(base, found))
    ),
    introduced: comparison.introduced.map((found) =>
      slimFinding(presentLocation(head, found))
    ),
    kinds: kindsLegend([...comparison.resolved, ...comparison.introduced]),
    persisting: comparison.persisting.map((row) => ({
      ...row,
      file: toWorkspacePath(row.file, head.workspaceRoot)
    })),
    functionDeltas: comparison.functionDeltas.map((row) => ({
      ...row,
      file: toWorkspacePath(row.file, head.workspaceRoot)
    }))
  };
};

export const compareSessionsTool = defineTool({
  name: "compare_sessions",
  title: "Compare before/after",
  description:
    "Diff two sessions to verify a fix: findings resolved by the change, regressions it " +
    "introduced, findings persisting (with severity movement), and per-function CPU deltas. " +
    "Each finding kind's explanation and suggested fix are returned once under `kinds`. " +
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
    return jsonResult(comparisonPayload(base, head));
  }
});
