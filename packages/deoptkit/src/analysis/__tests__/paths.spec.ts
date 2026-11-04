import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { toWorkspacePath } from "../paths";

// Agents hand these strings straight to Read/Edit, and a CI baseline must not depend on
// where the checkout lives: the same file has to read the same on every machine.
describe("toWorkspacePath", () => {
  const root = join(tmpdir(), "ws");

  it("reports a file inside the workspace as a relative forward-slash path", () => {
    const url = pathToFileURL(join(root, "src", "a.ts")).href;
    expect(toWorkspacePath(url, root)).toBe("src/a.ts");
  });

  it("reports a plain absolute OS path inside the workspace as relative", () => {
    expect(toWorkspacePath(join(root, "src", "a.ts"), root)).toBe("src/a.ts");
  });

  it("reports a file outside the workspace as an absolute forward-slash path", () => {
    const outside = join(tmpdir(), "other", "b.js");
    expect(toWorkspacePath(pathToFileURL(outside).href, root)).toBe(
      outside.replaceAll("\\", "/")
    );
  });

  it("leaves non-file locations unchanged", () => {
    expect(toWorkspacePath("node:internal/x", root)).toBe("node:internal/x");
    expect(toWorkspacePath("evalmachine.<anonymous>", root)).toBe(
      "evalmachine.<anonymous>"
    );
  });
});
