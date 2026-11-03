import { describe, expect, it } from "vitest";
import type { ProfileModel } from "../../model/logModel";
import type { ProfileNode, ProfileTreeOptions } from "../profile";
import { buildProfileTree } from "../profile";

const key = (name: string, file = `file:///app/${name}.js`): string =>
  `${name}|${file}|1|1`;
const a = key("a");
const b = key("b");
const c = key("c");
const x = key("x", "node:internal/x");

/** Samples are frame lists innermost first, as the parser retains them. */
const profileOf = (...samples: string[][]): ProfileModel => ({
  tickCount: samples.length,
  vmStates: {},
  functions: [],
  samples: samples.map((frames, index) => ({
    time: index,
    vmState: "js",
    self: frames[0],
    onStack: [...new Set(frames)],
    frames
  }))
});

const options = (
  overrides: Partial<ProfileTreeOptions> = {}
): ProfileTreeOptions => ({
  view: "top-down",
  justMyCode: true,
  maxDepth: 8,
  limit: 10,
  minPercent: 0,
  ...overrides
});

const shape = ({
  functionName,
  totalTicks,
  selfTicks,
  children
}: ProfileNode): unknown => [
  functionName,
  totalTicks,
  selfTicks,
  children.map(shape)
];

// a calls b calls c; one sample sits in node internals called from b.
const samples = [[c, b, a], [c, b, a], [b, a], [a], [x, b, a]];

describe("buildProfileTree", () => {
  // The tree answers "who calls the hot function"; a wrong root or a lost sample sends
  // an agent to the wrong caller.
  it("roots the top-down tree at the outermost caller and counts every sample under it", () => {
    const tree = buildProfileTree(profileOf(...samples), options());

    expect(tree.attributedTicks).toBe(5);
    expect(tree.roots.map(shape)).toEqual([
      [
        "a",
        5,
        1,
        [
          // b is the executing function for itself and the folded builtin sample.
          ["b", 4, 2, [["c", 2, 2, []]]]
        ]
      ]
    ]);
  });

  // Bottom-up answers "who calls the hot function"; rooting it at the callers instead
  // would hide the hot function behind the cold ones.
  it("roots the bottom-up tree at the executing function with its callers beneath", () => {
    const tree = buildProfileTree(
      profileOf(...samples),
      options({ view: "bottom-up" })
    );

    // c and b tie on total ticks; the first-seen root (c) stays first.
    expect(tree.roots.map(shape)).toEqual([
      ["c", 2, 2, [["b", 2, 0, [["a", 2, 0, []]]]]],
      ["b", 2, 2, [["a", 2, 0, []]]],
      ["a", 1, 1, []]
    ]);
    expect(tree.roots.reduce((sum, { selfTicks }) => sum + selfTicks, 0)).toBe(
      tree.attributedTicks
    );
  });

  // Builtin time under user code belongs to the user line that invoked it; dropping
  // the sample would understate the cost of that call.
  it("keeps internals as leaves when just-my-code is off", () => {
    const tree = buildProfileTree(
      profileOf(...samples),
      options({ justMyCode: false })
    );

    const [root] = tree.roots;
    const bNode = root?.children.find(
      ({ functionName }) => functionName === "b"
    );
    expect(bNode?.selfTicks).toBe(1);
    expect(
      bNode?.children.map(({ functionName }) => functionName).toSorted()
    ).toEqual(["c", "x"]);
  });

  it("skips samples without any user frame instead of rooting them under internals", () => {
    const tree = buildProfileTree(profileOf([x], [x, a], [a]), options());

    expect(tree.tickCount).toBe(3);
    expect(tree.attributedTicks).toBe(2);
  });

  // Recursion must not make a function look hotter than the samples it appears in.
  it("counts a recursive function once per node per sample", () => {
    const tree = buildProfileTree(profileOf([a, a, a]), options());

    expect(tree.roots.map(shape)).toEqual([
      ["a", 1, 0, [["a", 1, 0, [["a", 1, 1, []]]]]]
    ]);
  });

  it("prunes children below minPercent of the attributed ticks", () => {
    const tree = buildProfileTree(
      profileOf(...samples),
      options({ minPercent: 50 })
    );

    const [root] = tree.roots;
    expect(root?.children.map(({ functionName }) => functionName)).toEqual([
      "b"
    ]);
    // c holds 2 of 5 attributed ticks (40%), below the 50% cut.
    expect(root?.children[0]?.children).toEqual([]);
  });

  it("keeps only the heaviest children up to limit", () => {
    const tree = buildProfileTree(
      profileOf([b, a], [b, a], [c, a]),
      options({ limit: 1 })
    );

    expect(
      tree.roots[0]?.children.map(({ functionName }) => functionName)
    ).toEqual(["b"]);
  });

  it("stops descending at maxDepth", () => {
    const tree = buildProfileTree(
      profileOf(...samples),
      options({ maxDepth: 2 })
    );

    expect(tree.roots[0]?.children[0]?.functionName).toBe("b");
    expect(tree.roots[0]?.children[0]?.children).toEqual([]);
  });
});
