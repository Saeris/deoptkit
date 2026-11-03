import * as v from "valibot";
import type { IcTransition } from "../model/logModel";
import { IC_STATES } from "../model/logModel";
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

const IC_TYPES = [
  "LoadIC",
  "StoreIC",
  "KeyedLoadIC",
  "KeyedStoreIC",
  "LoadGlobalIC",
  "StoreGlobalIC",
  "StoreInArrayLiteralIC"
] as const;

const DEFAULT_MAX_TRANSITIONS = 20;
const MAX_MAP_ADDRESSES = 8;

/** The site's `newState` sequence with consecutive repeats collapsed. */
const stateHistory = (transitions: IcTransition[]): string =>
  transitions
    .map(({ newState }) => newState)
    .filter((state, index, states) => state !== states[index - 1])
    .join("→");

/** Distinct maps at the site, most recent first: the input to get_map. */
const recentMapAddresses = (transitions: IcTransition[]): string[] =>
  [...new Set(transitions.map(({ mapAddress }) => mapAddress).reverse())].slice(
    0,
    MAX_MAP_ADDRESSES
  );

export const listIcs = defineTool({
  name: "list_ics",
  title: "Inline cache sites",
  description:
    "List inline cache sites, worst state first. Filter by state (megamorphic/polymorphic/...), " +
    "IC type, or file substring. Transitions are omitted unless includeTransitions is set, and then bounded by maxTransitions.",
  annotations: { readOnlyHint: true, idempotentHint: true },
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
        v.description(
          "Include each site's recent state transitions (see maxTransitions)"
        )
      )
    ),
    maxTransitions: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(200),
        v.description(
          "With includeTransitions: at most this many of the most recent transitions per site (default 20)"
        )
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
      maxTransitions,
      fromMark,
      toMark,
      limit,
      offset
    },
    ctx
  ) => {
    const session = ctx.sessions.get(sessionId);
    if (!session) return unknownSessionError(sessionId);
    const model = windowedModel(session, { fromMark, toMark });
    if ("error" in model) return jsonResult(model, { isError: true });
    const typeSet = types === undefined ? undefined : new Set<string>(types);
    const sites = model.ics.filter(
      (site) =>
        (states === undefined || states.includes(site.worstState)) &&
        (typeSet === undefined || typeSet.has(site.type)) &&
        matchesFile(site.file, file)
    );
    const page = paginate(sites, limit, offset);
    return jsonResult({
      ...page,
      items: page.items.map((site) => {
        const recent = site.transitions.slice(
          -(maxTransitions ?? DEFAULT_MAX_TRANSITIONS)
        );
        return presentLocation(session, {
          type: site.type,
          file: site.file,
          functionName: site.functionName,
          line: site.line,
          column: site.column,
          key: site.key,
          worstState: site.worstState,
          transitionCount: site.transitions.length,
          // How many shapes hit the site tells an agent whether to normalize shapes or
          // split the call site; the history shows how fast it escalated.
          stateHistory: stateHistory(site.transitions),
          distinctMaps: new Set(
            site.transitions.map(({ mapAddress }) => mapAddress)
          ).size,
          ...(includeTransitions === true
            ? {
                transitions: recent,
                transitionsOmitted: site.transitions.length - recent.length,
                mapAddresses: recentMapAddresses(site.transitions)
              }
            : {})
        });
      })
    });
  }
});
