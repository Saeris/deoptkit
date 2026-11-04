import type { ProfileModel } from "../model/logModel";
import { isUserCode } from "./findings";
import { rowFromKey } from "./window";

export interface ProfileNode {
  functionName: string;
  file: string | undefined;
  line: number | undefined;
  column: number | undefined;
  selfTicks: number;
  totalTicks: number;
  children: ProfileNode[];
}

export interface ProfileTreeOptions {
  view: "top-down" | "bottom-up";
  /** Drop frames outside user code (node: internals, node_modules); default true. */
  justMyCode: boolean;
  maxDepth: number;
  /** Children kept per node, by totalTicks. */
  limit: number;
  /** Children below this share of the attributed ticks are dropped. */
  minPercent: number;
}

export interface ProfileTree {
  tickCount: number;
  /** Samples that contributed a path (with justMyCode: samples with at least one user frame). */
  attributedTicks: number;
  roots: ProfileNode[];
}

interface TrieNode {
  node: ProfileNode;
  children: Map<string, TrieNode>;
}

const newTrieNode = (key: string): TrieNode => ({
  node: { ...rowFromKey(key), children: [] },
  children: new Map()
});

/**
 * Fold the samples' frame lists into one call tree. Each sample is a single path;
 * every function on it gains a total tick once, however often it recurs, and the
 * path's last function gains the self tick (top-down: the function that was
 * executing; bottom-up: the root, which is that same function seen from its callers).
 *
 * With `justMyCode`, frames outside user code are dropped, so a builtin or dependency
 * called from user code counts as time of the nearest user frame: what an agent
 * editing that code needs, since it cannot change the builtin.
 */
export const buildProfileTree = (
  profile: ProfileModel,
  options: ProfileTreeOptions
): ProfileTree => {
  const rootTries = new Map<string, TrieNode>();
  let attributedTicks = 0;

  for (const { frames } of profile.samples) {
    const kept = options.justMyCode
      ? frames.filter((key) => isUserCode(rowFromKey(key).file))
      : frames;
    if (kept.length === 0) continue;
    attributedTicks += 1;

    // Frames arrive innermost first, which is already the bottom-up path.
    const path = options.view === "top-down" ? kept.toReversed() : kept;
    let level = rootTries;
    let first: TrieNode | undefined;
    let last: TrieNode | undefined;
    for (const key of path) {
      let trie = level.get(key);
      if (trie === undefined) {
        trie = newTrieNode(key);
        level.set(key, trie);
      }
      // Trie nodes are per position, so a recursive function is a chain of distinct
      // nodes and each is counted once per sample: no node is hit twice by one path.
      trie.node.totalTicks += 1;
      first ??= trie;
      last = trie;
      level = trie.children;
    }
    // The executing function is the path's end top-down and its root bottom-up.
    const executing = options.view === "top-down" ? last : first;
    if (executing !== undefined) executing.node.selfTicks += 1;
  }

  const threshold = (options.minPercent / 100) * attributedTicks;
  const prune = (
    level: Map<string, TrieNode>,
    depth: number
  ): ProfileNode[] => {
    if (depth > options.maxDepth) return [];
    return [...level.values()]
      .filter(({ node }) => node.totalTicks >= threshold)
      .toSorted((a, b) => b.node.totalTicks - a.node.totalTicks)
      .slice(0, options.limit)
      .map(({ node, children }) => ({
        ...node,
        children: prune(children, depth + 1)
      }));
  };

  return {
    tickCount: profile.tickCount,
    attributedTicks,
    roots: prune(rootTries, 1)
  };
};
