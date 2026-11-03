import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as v from "valibot";
import type { Finding, FindingKind } from "../analysis/findings";
import { FINDING_EXPLANATIONS } from "../analysis/findings";
import { toWorkspacePath } from "../analysis/paths";
import type { MarkWindow } from "../analysis/window";
import { applyWindow, resolveWindow } from "../analysis/window";
import type { LogModel } from "../model/logModel";
import type { Session } from "../sessions";
import type { OriginalPosition } from "../sourcemaps/resolver";
import { resolverFor, withOriginal } from "../sourcemaps/resolver";
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

/**
 * How every tool reports a location: the source-mapped `original` attached when a map
 * resolves it, and both `file`s rewritten as workspace-relative paths (see
 * `toWorkspacePath`). The model itself keeps V8's URLs.
 */
export const presentLocation = <
  T extends { file?: string | undefined; line: number; column: number }
>(
  session: Session,
  item: T
): T & { original?: OriginalPosition } => {
  const located = withOriginal(resolverFor(session), item);
  const root = session.workspaceRoot;
  return {
    ...located,
    ...(located.file === undefined
      ? {}
      : { file: toWorkspacePath(located.file, root) }),
    ...(located.original === undefined
      ? {}
      : {
          original: {
            ...located.original,
            file: toWorkspacePath(located.original.file, root)
          }
        })
  };
};

/** `presentLocation` for rows whose position is optional (profile rows). */
export const presentFile = <T extends { file?: string | undefined }>(
  session: Session,
  item: T
): T =>
  item.file === undefined
    ? item
    : { ...item, file: toWorkspacePath(item.file, session.workspaceRoot) };

/** A finding as tools report it: the per-kind text lives in the response's `kinds` legend. */
export type SlimFinding<T extends Finding = Finding> = Omit<
  T,
  "explanation" | "suggestedFix"
>;

export const slimFinding = <T extends Finding>({
  explanation: _explanation,
  suggestedFix: _suggestedFix,
  ...rest
}: T): SlimFinding<T> => rest;

/**
 * Explanation and suggested fix for every kind present in `findings`, once each.
 * Measured 37-42% of a get_findings payload before this legend existed.
 */
export const kindsLegend = (
  findings: ReadonlyArray<Pick<Finding, "kind">>
): Partial<
  Record<FindingKind, { explanation: string; suggestedFix: string }>
> =>
  Object.fromEntries(
    [...new Set(findings.map(({ kind }) => kind))].map((kind) => [
      kind,
      FINDING_EXPLANATIONS[kind]
    ])
  );
