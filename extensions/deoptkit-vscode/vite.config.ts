import { defineConfig } from "vite-plus";

// Two independent bundles. A shared chunk between the entries made the server load
// the extension body (and its `require("vscode")`) outside the extension host.
const shared = {
  format: "cjs" as const,
  platform: "node" as const,
  dts: false,
  outDir: "./dist"
};

export default defineConfig({
  run: {
    tasks: {
      build: {
        command: "vp pack && vp exec vsce package --no-dependencies",
        cache: true
      }
    }
  },
  // The extension host provides `vscode`; everything else must be inside the .vsix.
  pack: [
    {
      ...shared,
      entry: { extension: "src/extension.ts" },
      clean: true,
      deps: { neverBundle: ["vscode"], alwaysBundle: ["vscode-languageclient"] }
    },
    {
      ...shared,
      entry: { server: "src/server.ts" },
      clean: false,
      deps: { alwaysBundle: ["deoptkit"] }
    }
  ]
});
