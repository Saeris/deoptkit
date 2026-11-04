import { defineConfig } from "vite-plus";
import { lint, fmt } from "@saeris/configs";

export default defineConfig({
  lint,
  fmt,
  run: {
    tasks: {
      build: { command: "vp run -r build", cache: true }
    }
  },
  // Each workspace package carries its own Vitest settings; the root only lists them.
  test: {
    projects: ["packages/*"]
  }
});
