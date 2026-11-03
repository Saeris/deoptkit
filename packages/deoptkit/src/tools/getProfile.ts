import * as v from "valibot";
import type { ProfileNode } from "../analysis/profile";
import { buildProfileTree } from "../analysis/profile";
import type { Session } from "../sessions";
import { defineTool, jsonResult } from "./defineTool";
import {
  fromMarkSchema,
  presentFile,
  sessionIdSchema,
  toMarkSchema,
  unknownSessionError,
  windowedModel
} from "./shared";

const presentNode = (session: Session, node: ProfileNode): ProfileNode => ({
  ...presentFile(session, node),
  children: node.children.map((child) => presentNode(session, child))
});

export const getProfile = defineTool({
  name: "get_profile",
  title: "CPU call tree",
  description:
    "Call tree from the profiler samples: top-down (who calls what, from the roots) or bottom-up (hot functions and their callers). " +
    "Defaults to the user's own code with builtins and dependencies folded into their nearest user caller; " +
    "pruned by maxDepth, limit (children per node), and minPercent (share of attributed ticks). " +
    "Window with fromMark/toMark like get_findings.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  schema: v.object({
    sessionId: sessionIdSchema,
    view: v.optional(
      v.pipe(
        v.picklist(["top-down", "bottom-up"]),
        v.description(
          "top-down roots the tree at outermost callers; bottom-up roots it at the functions that ran, with their callers beneath (default top-down)"
        )
      )
    ),
    justMyCode: v.optional(
      v.pipe(
        v.boolean(),
        v.description(
          "Only show the user's own code; time in builtins and node_modules counts toward the nearest user caller (default true)"
        )
      )
    ),
    maxDepth: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(32),
        v.description("Maximum tree depth (default 8)")
      )
    ),
    limit: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(50),
        v.description(
          "Maximum children kept per node, heaviest first (default 10)"
        )
      )
    ),
    minPercent: v.optional(
      v.pipe(
        v.number(),
        v.minValue(0),
        v.maxValue(100),
        v.description(
          "Drop nodes below this percentage of the attributed ticks (default 1)"
        )
      )
    ),
    fromMark: fromMarkSchema,
    toMark: toMarkSchema
  }),
  handler: (
    {
      sessionId,
      view = "top-down",
      justMyCode = true,
      maxDepth = 8,
      limit = 10,
      minPercent = 1,
      fromMark,
      toMark
    },
    ctx
  ) => {
    const session = ctx.sessions.get(sessionId);
    if (!session) return unknownSessionError(sessionId);
    const model = windowedModel(session, { fromMark, toMark });
    if ("error" in model) return jsonResult(model, { isError: true });
    const tree = buildProfileTree(model.profile, {
      view,
      justMyCode,
      maxDepth,
      limit,
      minPercent
    });
    return jsonResult({
      view,
      tickCount: tree.tickCount,
      attributedTicks: tree.attributedTicks,
      roots: tree.roots.map((root) => presentNode(session, root))
    });
  }
});
