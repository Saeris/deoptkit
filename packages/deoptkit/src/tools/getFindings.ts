import * as v from "valibot";
import { findingIdentity } from "../analysis/compare";
import type { Finding } from "../analysis/findings";
import { computeFindings } from "../analysis/findings";
import { sessionQuality } from "../analysis/quality";
import type { Session } from "../sessions";
import { defineTool, jsonResult } from "./defineTool";
import {
  fileFilterSchema,
  fromMarkSchema,
  limitSchema,
  matchesFile,
  offsetSchema,
  kindsLegend,
  paginate,
  presentLocation,
  sessionIdSchema,
  sessionIdsSchema,
  slimFinding,
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

type Located = ReturnType<typeof presentLocation<Finding>>;

interface IdentifiedFinding {
  sessionId: string;
  /** `findingIdentity` of the finding as the model reports it, before locations are made workspace-relative. */
  identity: string;
  item: Located;
}

/**
 * Identical findings (same identity) collapse into the instance with the highest
 * severity, listing the sessions they appeared in. `rows` arrive in session input order.
 */
const mergeByIdentity = (
  rows: IdentifiedFinding[]
): Array<Located & { sessions: string[] }> => {
  const byIdentity = new Map<string, { item: Located; sessions: string[] }>();
  for (const { sessionId, identity, item } of rows) {
    const seen = byIdentity.get(identity);
    if (seen === undefined) {
      byIdentity.set(identity, { item, sessions: [sessionId] });
      continue;
    }
    if (!seen.sessions.includes(sessionId)) seen.sessions.push(sessionId);
    if (item.severity > seen.item.severity) seen.item = item;
  }
  return [...byIdentity.values()]
    .map(({ item, sessions }) => ({ ...item, sessions }))
    .toSorted(
      (a, b) =>
        b.severity - a.severity ||
        a.file.localeCompare(b.file) ||
        a.line - b.line
    );
};

export const getFindings = defineTool({
  name: "get_findings",
  title: "Ranked findings",
  description:
    "The primary analysis entry point: everything wrong in a session, ranked worst-first. " +
    "Each finding has a severity (1-100), source location, and evidence; the explanation and suggested fix for each kind present are returned once under `kinds`. " +
    "Start here, fix the top finding, re-profile, and compare. " +
    "Pass sessionIds instead of sessionId to rank the findings of several sessions (every worker log of a vitest bench run) together; " +
    "identical findings merge and list the sessions they appeared in.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  schema: v.object({
    sessionId: v.optional(sessionIdSchema),
    sessionIds: sessionIdsSchema,
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
    {
      sessionId,
      sessionIds,
      kinds,
      severityMin,
      file,
      fromMark,
      toMark,
      limit,
      offset
    },
    ctx
  ) => {
    const ids = sessionIds ?? (sessionId === undefined ? [] : [sessionId]);
    if (ids.length === 0) {
      return jsonResult(
        { error: "Provide sessionId or sessionIds." },
        { isError: true }
      );
    }
    const sessions: Session[] = [];
    for (const id of ids) {
      const session = ctx.sessions.get(id);
      if (!session) return unknownSessionError(id);
      sessions.push(session);
    }
    // One bench suite is N worker logs; the agent needs one ranked answer, not N
    // get_findings calls whose duplicates it has to merge by hand.
    const rows: IdentifiedFinding[] = [];
    for (const session of sessions) {
      const model = windowedModel(session, { fromMark, toMark });
      if ("error" in model) {
        return jsonResult(
          sessions.length === 1
            ? model
            : { error: `${session.id}: ${model.error}` },
          { isError: true }
        );
      }
      for (const candidate of computeFindings(model)) {
        if (
          (kinds === undefined || kinds.includes(candidate.kind)) &&
          (severityMin === undefined || candidate.severity >= severityMin) &&
          matchesFile(candidate.file, file)
        ) {
          rows.push({
            sessionId: session.id,
            identity: findingIdentity(candidate),
            item: presentLocation(session, candidate)
          });
        }
      }
    }
    // Quality is judged on the whole session: a mark window can legitimately hold no ticks.
    const qualityWarnings = sessions.flatMap((session) =>
      sessionQuality(session.model).warnings.map(({ code, message }) => ({
        sessionId: session.id,
        code,
        message
      }))
    );
    const page = paginate(
      sessions.length === 1
        ? rows.map(({ item }) => item)
        : mergeByIdentity(rows),
      limit,
      offset
    );
    return jsonResult({
      ...page,
      items: page.items.map(slimFinding),
      kinds: kindsLegend(page.items),
      ...(qualityWarnings.length > 0 ? { qualityWarnings } : {})
    });
  }
});
