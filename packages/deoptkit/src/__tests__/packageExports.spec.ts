import { describe, expect, it } from "vitest";
import manifest from "../../package.json" with { type: "json" };

const targets = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : Object.values(value as Record<string, unknown>).flatMap(targets);

describe("package exports", () => {
  // The published tarball contains only dist/, so any export target outside it is
  // unresolvable for consumers. This test exists because a `development` condition
  // pointing at src/ once broke `deoptkit/bench` for Vitest users.
  it("only points at files that ship in the published package", () => {
    const unshipped = targets(manifest.exports).filter(
      (target) => target !== "./package.json" && !target.startsWith("./dist/")
    );
    expect(unshipped).toEqual([]);
  });
});
