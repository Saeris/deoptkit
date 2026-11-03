import * as v from "valibot";
import type { MapEntry } from "../model/logModel";
import { defineTool, jsonResult } from "./defineTool";
import { sessionIdSchema, unknownSessionError } from "./shared";

/** Cap transition-chain walks; deep chains indicate churn, not useful ancestry. */
const MAX_CHAIN = 32;

/** Cap sibling listings; `siblingCount` stays exact. */
const MAX_SIBLINGS = 16;

const propertyNames = (entry: MapEntry): string[] | undefined =>
  entry.details?.properties.map(({ name }) => name);

export const getMap = defineTool({
  name: "get_map",
  title: "Hidden class details",
  description:
    "Inspect one V8 object map (hidden class) by address: its parsed shape (properties in order, " +
    "representation, flags), the transition chain that produced it, its sibling shapes from the " +
    "same parent, and the IC sites that observed it. Map addresses appear in list_ics transitions " +
    "(includeTransitions) and get_findings evidence (exampleMaps).",
  annotations: { readOnlyHint: true, idempotentHint: true },
  schema: v.object({
    sessionId: sessionIdSchema,
    address: v.pipe(
      v.string(),
      v.description("Map address, e.g. 0x03a2c272a931")
    )
  }),
  handler: ({ sessionId, address }, ctx) => {
    const session = ctx.sessions.get(sessionId);
    if (!session) return unknownSessionError(sessionId);
    const { entries } = session.model.maps;
    const entry = entries.get(address);
    if (!entry) {
      return jsonResult(
        {
          error: `No map entry for address ${address} in session ${sessionId}.`
        },
        { isError: true }
      );
    }

    const chain: Array<Pick<MapEntry, "address" | "subtype" | "propertyName">> =
      [];
    let current: MapEntry | undefined = entry;
    const seen = new Set<string>();
    while (current && chain.length < MAX_CHAIN && !seen.has(current.address)) {
      seen.add(current.address);
      chain.push({
        address: current.address,
        subtype: current.subtype,
        propertyName: current.propertyName
      });
      current =
        current.parent === undefined ? undefined : entries.get(current.parent);
    }

    // Siblings from one parent are the shapes a constructor diverged into; their property
    // lists show which property was added in which order.
    const siblings =
      entry.parent === undefined
        ? []
        : [...entries.values()].filter(
            (candidate) =>
              candidate.parent === entry.parent &&
              candidate.address !== entry.address
          );

    const referencedByIcSites = session.model.ics
      .filter((site) =>
        site.transitions.some(({ mapAddress }) => mapAddress === address)
      )
      .map(({ type, file, functionName, line, column, key, worstState }) => ({
        type,
        file,
        functionName,
        line,
        column,
        key,
        worstState
      }));

    return jsonResult({
      address: entry.address,
      createdAt: entry.createdAt,
      subtype: entry.subtype,
      propertyName: entry.propertyName,
      parent: entry.parent,
      properties: propertyNames(entry),
      transitionChain: chain,
      siblings: siblings.slice(0, MAX_SIBLINGS).map((sibling) => ({
        address: sibling.address,
        propertyName: sibling.propertyName,
        properties: propertyNames(sibling)
      })),
      siblingCount: siblings.length,
      referencedByIcSites,
      details: entry.details
    });
  }
});
