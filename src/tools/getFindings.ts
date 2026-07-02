import * as v from "valibot";
import { computeFindings } from "../analysis/findings";
import { applyWindow, resolveWindow } from "../analysis/window";
import { resolverFor, withOriginal } from "../sourcemaps/resolver";
import { defineTool, jsonResult } from "./defineTool";
import {
  fromMarkSchema,
  limitSchema,
  paginate,
  sessionIdSchema,
  toMarkSchema,
  unknownSessionError
} from "./shared";

const FINDING_KINDS = [
  "megamorphic-ic",
  "polymorphic-ic",
  "deopt-loop",
  "eager-deopt",
  "soft-deopt",
  "map-churn"
] as const;

export const getFindings = defineTool({
  name: "get_findings",
  description:
    "The primary analysis entry point: everything wrong in a session, ranked worst-first. " +
    "Each finding has a severity (1-100), source location, explanation, and suggested fix. " +
    "Start here, fix the top finding, re-profile, and compare.",
  schema: v.object({
    sessionId: sessionIdSchema,
    kinds: v.optional(
      v.pipe(
        v.array(v.picklist(FINDING_KINDS)),
        v.description("Only include these finding kinds")
      )
    ),
    severityMin: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(100),
        v.description("Only include findings at or above this severity")
      )
    ),
    fromMark: fromMarkSchema,
    toMark: toMarkSchema,
    limit: limitSchema
  }),
  handler: (
    { sessionId, kinds, severityMin, fromMark, toMark, limit },
    ctx
  ) => {
    const session = ctx.sessions.get(sessionId);
    if (!session) return unknownSessionError(sessionId);
    let model = session.model;
    if (fromMark !== undefined || toMark !== undefined) {
      const window = resolveWindow(model, { fromMark, toMark });
      if ("error" in window) return jsonResult(window, { isError: true });
      model = applyWindow(model, window);
    }
    const resolver = resolverFor(session);
    const findings = computeFindings(model)
      .filter(
        (candidate) =>
          (kinds === undefined || kinds.includes(candidate.kind)) &&
          (severityMin === undefined || candidate.severity >= severityMin)
      )
      .map((candidate) => withOriginal(resolver, candidate));
    return jsonResult(paginate(findings, limit));
  }
});
