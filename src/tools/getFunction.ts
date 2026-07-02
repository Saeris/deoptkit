import * as v from "valibot";
import { resolverFor } from "../sourcemaps/resolver";
import { defineTool, jsonResult } from "./defineTool";
import { limitSchema, sessionIdSchema, unknownSessionError } from "./shared";

const DEFAULT_CONTEXT_LINES = 30;

export const getFunction = defineTool({
  name: "get_function",
  description:
    "Deep-dive one function: an annotated source snippet (from the sources embedded in the " +
    "log) plus every IC site, deopt, and profile tick attributed to it. Identify the function " +
    "by file substring plus functionName, or file plus a line number.",
  schema: v.object({
    sessionId: sessionIdSchema,
    file: v.pipe(
      v.string(),
      v.description("Substring of the script path/URL, e.g. src/hot.js")
    ),
    functionName: v.optional(
      v.pipe(v.string(), v.description("Function to anchor the snippet on"))
    ),
    line: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.description(
          "1-based line to anchor on when functionName is not given"
        )
      )
    ),
    contextLines: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(5),
        v.maxValue(200),
        v.description(
          `Lines of source to include (default ${DEFAULT_CONTEXT_LINES})`
        )
      )
    ),
    limit: limitSchema
  }),
  handler: ({ sessionId, file, functionName, line, contextLines }, ctx) => {
    const session = ctx.sessions.get(sessionId);
    if (!session) return unknownSessionError(sessionId);
    const { model } = session;

    const candidates = [...model.scripts.keys()].filter((url) =>
      url.includes(file)
    );
    const url =
      candidates.find((candidate) => candidate.endsWith(file)) ??
      candidates.at(0);
    if (url === undefined) {
      const known = [...model.scripts.keys()]
        .filter((candidate) => candidate.startsWith("file:"))
        .slice(0, 20);
      return jsonResult(
        {
          error: `No script matching "${file}" in this session.`,
          knownScripts: known
        },
        { isError: true }
      );
    }

    const fn =
      functionName === undefined
        ? undefined
        : (model.functionIndex.find(
            (info) => info.file === url && info.functionName === functionName
          ) ??
          model.functionIndex.find(
            (info) =>
              info.file === url && info.functionName.includes(functionName)
          ));
    const anchor = fn?.line ?? line;
    if (anchor === undefined) {
      const names = model.functionIndex
        .filter((info) => info.file === url)
        .map((info) => info.functionName)
        .filter((name) => name !== "")
        .slice(0, 30);
      return jsonResult(
        {
          error:
            functionName === undefined
              ? "Provide functionName or line to anchor the snippet."
              : `No function named "${functionName}" in ${url}.`,
          knownFunctions: names
        },
        { isError: true }
      );
    }

    const source = model.scripts.get(url) ?? "";
    const lines = source.split("\n");
    const startLine = Math.max(1, anchor - 2);
    const endLine = Math.min(
      lines.length,
      startLine + (contextLines ?? DEFAULT_CONTEXT_LINES) - 1
    );

    const inWindow = (candidate: {
      file?: string | undefined;
      line: number;
    }): boolean =>
      candidate.file === url &&
      candidate.line >= startLine &&
      candidate.line <= endLine;
    const icSites = model.ics.filter((site) => inWindow(site));
    const deoptSites = model.deopts.filter((site) => inWindow(site));

    const annotations = [
      ...icSites.map((site) => ({
        line: site.line,
        column: site.column,
        note: `${site.type} "${site.key}" reached ${site.worstState} (${site.transitions.length} transitions)`
      })),
      ...deoptSites.map((site) => ({
        line: site.line,
        column: site.column,
        note: `${site.kind} deopt x${site.count}: ${site.reasons.join("; ")}`
      }))
    ].sort((a, b) => a.line - b.line || a.column - b.column);

    const flagged = new Set(
      annotations.map(({ line: annotated }) => annotated)
    );
    const width = String(endLine).length;
    const text = lines
      .slice(startLine - 1, endLine)
      .map((content, index) => {
        const lineNo = startLine + index;
        return `${flagged.has(lineNo) ? "!" : " "} ${String(lineNo).padStart(width)} | ${content}`;
      })
      .join("\n");

    const ticks = model.profile.functions
      .filter(
        (row) =>
          row.file === url &&
          (fn === undefined || row.functionName === fn.functionName)
      )
      .reduce(
        (sum, row) => ({
          selfTicks: sum.selfTicks + row.selfTicks,
          totalTicks: sum.totalTicks + row.totalTicks
        }),
        { selfTicks: 0, totalTicks: 0 }
      );

    return jsonResult({
      file: url,
      functionName: fn?.functionName ?? functionName,
      anchorLine: anchor,
      original: resolverFor(session).resolve(url, anchor, fn?.column ?? 1),
      optimizationTiers: fn?.tiers,
      codeCreations: fn?.codeCreations,
      ticks,
      snippet: { startLine, endLine, text },
      annotations,
      icSites: icSites.map(
        ({ type, line: siteLine, column, key, worstState, transitions }) => ({
          type,
          line: siteLine,
          column,
          key,
          worstState,
          transitionCount: transitions.length
        })
      ),
      deoptSites: deoptSites.map(({ events: _events, ...site }) => site)
    });
  }
});
