import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as v from "valibot";
import type { MarkWindow } from "../analysis/window";
import { applyWindow, resolveWindow } from "../analysis/window";
import type { LogModel } from "../model/logModel";
import type { Session } from "../sessions";
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

export const fromMarkSchema = v.optional(
  v.pipe(
    v.string(),
    v.description(
      "Window start: the first occurrence of this harness marker label (from deoptkit/harness mark/observed)"
    )
  )
);

export const toMarkSchema = v.optional(
  v.pipe(
    v.string(),
    v.description(
      "Window end: the last occurrence of this harness marker label"
    )
  )
);

/**
 * The session's model scoped to a marker window, or the whole model when neither mark
 * is given. Every session-scoped tool that accepts fromMark/toMark goes through this.
 */
export const windowedModel = (
  session: Session,
  window: MarkWindow
): LogModel | { error: string } => {
  if (window.fromMark === undefined && window.toMark === undefined)
    return session.model;
  const resolved = resolveWindow(session.model, window);
  return "error" in resolved ? resolved : applyWindow(session.model, resolved);
};

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
