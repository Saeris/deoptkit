import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as v from "valibot";
import { jsonResult } from "./defineTool";

export const sessionIdSchema = v.pipe(
  v.string(),
  v.description("Session id returned by load_log (see list_sessions)")
);

export const limitSchema = v.optional(
  v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(100),
    v.description("Maximum items to return (default 20)")
  )
);

export const offsetSchema = v.optional(
  v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.description("Items to skip, for paging")
  )
);

export const fileFilterSchema = v.optional(
  v.pipe(
    v.string(),
    v.description("Only include items whose file path contains this substring")
  )
);

export const unknownSessionError = (sessionId: string): CallToolResult =>
  jsonResult(
    {
      error: `Unknown session "${sessionId}". Load a log with load_log or check list_sessions.`
    },
    { isError: true }
  );

export interface Page<T> {
  totalCount: number;
  offset: number;
  items: T[];
}

export const paginate = <T>(items: T[], limit = 20, offset = 0): Page<T> => ({
  totalCount: items.length,
  offset,
  items: items.slice(offset, offset + limit)
});

export const matchesFile = (
  file: string | undefined,
  filter: string | undefined
): boolean => filter === undefined || (file?.includes(filter) ?? false);
