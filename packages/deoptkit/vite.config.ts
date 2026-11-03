import { defineConfig } from "vite-plus";
import manifest from "./package.json" with { type: "json" };

export default defineConfig({
  run: {
    tasks: {
      build: { command: "vp pack", cache: true }
    }
  },
  // ── Builds (tsdown) ─────────────────────────────────────────────────
  pack: {
    entry: {
      index: "./src/index.ts",
      main: "./src/main.ts",
      harness: "./src/harness/index.ts",
      vitest: "./src/vitest/index.ts",
      "vitest-global-setup": "./src/vitest/globalSetup.ts",
      bench: "./src/bench/index.ts",
      serve: "./src/serve/index.ts"
    },
    clean: true,
    format: [`esm`],
    dts: true,
    outDir: `./dist`
  },
  // ── Testing (Vitest) ────────────────────────────────────────────────
  test: {
    name: manifest.name,
    globals: true,
    include: ["**/*.{test,spec}.{ts,tsx}"],
    // Claude Code executor worktrees live under .claude/; their copies of the
    // suite must not run as part of this checkout.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**"],
    environment: "node",
    passWithNoTests: true
  }
});
