import * as v from "valibot";
import { resolverFor, withOriginal } from "../sourcemaps/resolver";
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

export const listDeopts = defineTool({
  name: "list_deopts",
  description:
    "List deoptimization sites, most frequent first, with V8's bailout reasons. " +
    "Eager deopts mean optimized code hit an unexpected type; repeated eager deopts at one site are a deopt loop.",
  schema: v.object({
    sessionId: sessionIdSchema,
    kinds: v.optional(
      v.pipe(
        v.array(v.picklist(["eager", "lazy", "soft", "unknown"])),
        v.description("Only these deopt kinds")
      )
    ),
    file: fileFilterSchema,
    minCount: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.description("Only sites with at least this many deopts")
      )
    ),
    limit: limitSchema,
    offset: offsetSchema
  }),
  handler: ({ sessionId, kinds, file, minCount, limit, offset }, ctx) => {
    const session = ctx.sessions.get(sessionId);
    if (!session) return unknownSessionError(sessionId);
    const resolver = resolverFor(session);
    const sites = session.model.deopts
      .filter(
        (site) =>
          (kinds === undefined || kinds.includes(site.kind)) &&
          (minCount === undefined || site.count >= minCount) &&
          matchesFile(site.file, file)
      )
      .map((site) => withOriginal(resolver, site));
    return jsonResult(paginate(sites, limit, offset));
  }
});
