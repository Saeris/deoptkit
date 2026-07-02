import * as v from "valibot";
import { applyWindow, resolveWindow } from "../analysis/window";
import { IC_STATES } from "../model/logModel";
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

const IC_TYPES = [
  "LoadIC",
  "StoreIC",
  "KeyedLoadIC",
  "KeyedStoreIC",
  "LoadGlobalIC",
  "StoreGlobalIC",
  "StoreInArrayLiteralIC"
] as const;

export const listIcs = defineTool({
  name: "list_ics",
  description:
    "List inline cache sites, worst state first. Filter by state (megamorphic/polymorphic/...), " +
    "IC type, or file substring. Transitions are omitted unless includeTransitions is set.",
  schema: v.object({
    sessionId: sessionIdSchema,
    states: v.optional(
      v.pipe(
        v.array(v.picklist(IC_STATES)),
        v.description("Only sites whose worst state is one of these")
      )
    ),
    types: v.optional(
      v.pipe(
        v.array(v.picklist(IC_TYPES)),
        v.description("Only these IC kinds")
      )
    ),
    file: fileFilterSchema,
    includeTransitions: v.optional(
      v.pipe(
        v.boolean(),
        v.description("Include each site's full state transition history")
      )
    ),
    fromMark: fromMarkSchema,
    toMark: toMarkSchema,
    limit: limitSchema,
    offset: offsetSchema
  }),
  handler: (
    {
      sessionId,
      states,
      types,
      file,
      includeTransitions,
      fromMark,
      toMark,
      limit,
      offset
    },
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
    const typeSet = types === undefined ? undefined : new Set<string>(types);
    const sites = model.ics.filter(
      (site) =>
        (states === undefined || states.includes(site.worstState)) &&
        (typeSet === undefined || typeSet.has(site.type)) &&
        matchesFile(site.file, file)
    );
    const resolver = resolverFor(session);
    const page = paginate(sites, limit, offset);
    return jsonResult({
      ...page,
      items: page.items.map((site) =>
        withOriginal(resolver, {
          type: site.type,
          file: site.file,
          functionName: site.functionName,
          line: site.line,
          column: site.column,
          key: site.key,
          worstState: site.worstState,
          transitionCount: site.transitions.length,
          ...(includeTransitions === true
            ? { transitions: site.transitions }
            : {})
        })
      )
    });
  }
});
