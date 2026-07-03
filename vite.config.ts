import { defineConfig } from "vite-plus";
import { lint, fmt } from "@saeris/configs";
import manifest from "./package.json" with { type: "json" };

export default defineConfig({
  lint,
  fmt,
  // ── Builds (tsdown) ─────────────────────────────────────────────────
  pack: {
    entry: {
      index: manifest.exports["."].import.development,
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
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
    passWithNoTests: true
  }
});
