import { ensureDist } from "../vitest/__tests__/e2eProject";

/**
 * Vitest global setup: build `dist/` once, before any test file runs.
 *
 * Several specs run the built package (the bench, the end-to-end projects). Each used
 * to rebuild it in its own `beforeAll`, but `vp pack` empties `dist/` first, and with
 * test files in parallel one rebuild deleted chunks that another file's child process
 * was loading: `ERR_MODULE_NOT_FOUND` on `dist/parseLog-*.mjs` or `deoptkit/bench`, or a
 * teardown that could not analyze its log and wrote findings without it.
 */
export const setup = ensureDist;
