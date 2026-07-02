import * as v from "valibot";
import { applyWindow, resolveWindow } from "../analysis/window";
import { resolverFor, withOriginal } from "../sourcemaps/resolver";
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
    fromMark: fromMarkSchema,
    toMark: toMarkSchema,
    limit: limitSchema,
    offset: offsetSchema
  }),
  handler: (
    { sessionId, kinds, file, minCount, fromMark, toMark, limit, offset },
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
    const sites = model.deopts
      .filter(
        (site) =>
          (kinds === undefined || kinds.includes(site.kind)) &&
          (minCount === undefined || site.count >= minCount) &&
          matchesFile(site.file, file)
      )
      // Per-event arrays exist for windowing, not for tool payloads.
      .map(({ events: _events, ...site }) => withOriginal(resolver, site));
    return jsonResult(paginate(sites, limit, offset));
  }
});
