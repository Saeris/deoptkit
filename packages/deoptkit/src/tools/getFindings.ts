import * as v from "valibot";
import { computeFindings } from "../analysis/findings";
import { defineTool, jsonResult } from "./defineTool";
import {
  fileFilterSchema,
  fromMarkSchema,
  limitSchema,
  matchesFile,
  offsetSchema,
  paginate,
  presentLocation,
  sessionIdSchema,
  toMarkSchema,
  unknownSessionError,
  windowedModel
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
  title: "Ranked findings",
  description:
    "The primary analysis entry point: everything wrong in a session, ranked worst-first. " +
    "Each finding has a severity (1-100), source location, explanation, and suggested fix. " +
    "Start here, fix the top finding, re-profile, and compare.",
  annotations: { readOnlyHint: true, idempotentHint: true },
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
    file: fileFilterSchema,
    fromMark: fromMarkSchema,
    toMark: toMarkSchema,
    limit: limitSchema,
    offset: offsetSchema
  }),
  handler: (
    { sessionId, kinds, severityMin, file, fromMark, toMark, limit, offset },
    ctx
  ) => {
    const session = ctx.sessions.get(sessionId);
    if (!session) return unknownSessionError(sessionId);
    const model = windowedModel(session, { fromMark, toMark });
    if ("error" in model) return jsonResult(model, { isError: true });
    const findings = computeFindings(model)
      .filter(
        (candidate) =>
          (kinds === undefined || kinds.includes(candidate.kind)) &&
          (severityMin === undefined || candidate.severity >= severityMin) &&
          matchesFile(candidate.file, file)
      )
      .map((candidate) => presentLocation(session, candidate));
    return jsonResult(paginate(findings, limit, offset));
  }
});
