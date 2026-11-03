import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** The package directory: what a consumer installs as `deoptkit` (package.json + dist). */
const PACKAGE = join(import.meta.dirname, "..", "..", "..");
/** Hoisted workspace dependencies resolve from this file like any import would. */
const VITEST_DIR = dirname(require.resolve("vitest/package.json"));
const VP_BIN = join(
  dirname(require.resolve("vite-plus/package.json")),
  "bin",
  "vp"
);

const LIB = `export interface Shape { x: number; [k: string]: number }
export const getX = (obj: Shape): number => obj.x;
export const shapes: Shape[] = [
  { x: 1 }, { a: 1, x: 2 }, { a: 1, b: 2, x: 3 }, { a: 1, b: 2, c: 3, x: 4 },
  { a: 1, b: 2, c: 3, d: 4, x: 5 }, { a: 1, b: 2, c: 3, d: 4, e: 5, x: 6 },
  { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, x: 7 }, { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, x: 8 }
];
`;

const PROBE = `import { test } from "vitest";
import { benchObserved } from "deoptkit/bench";
import { getX, shapes } from "./lib.ts";

test("get x", async ({ bench }) => {
  await benchObserved(bench, "get x", () => {
    let sum = 0;
    for (let i = 0; i < 20_000; i++) sum += getX(shapes[i % shapes.length]!);
    return sum;
  }).run();
});
`;

const configFor = (outDir: string, presetOptions: string | undefined): string =>
  `import { defineConfig } from "vitest/config";
import { deoptKit } from "deoptkit/vitest";
export default defineConfig({
  test: {
    ...deoptKit({ outDir: ${JSON.stringify(outDir)}${presetOptions === undefined ? "" : `, ${presetOptions}`} }),
    benchmark: { include: ["**/*.bench.ts"] }
  }
});
`;

/**
 * The tests resolve `deoptkit/*` through the package's real `exports` map, which
 * points at `dist/`. Always rebuild: a `dist/` left over from before the current
 * source changes would make the project run stale code and pass or fail for the
 * wrong reasons. `vp pack` takes about a second.
 */
export const ensureDist = (): void => {
  const result = spawnSync(process.execPath, [VP_BIN, "pack"], {
    cwd: PACKAGE,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(
      `vp pack failed (status ${String(result.status)}):\n${result.stdout}\n${result.stderr}`
    );
  }
};

export interface E2eProject {
  /** Temp project root holding the probe, its config, and the linked node_modules. */
  dir: string;
  /** Where the preset writes V8 logs and the manifest (absolute). */
  outDir: string;
  configPath: string;
  /** Run `vitest bench --run` in the project and capture its output. */
  run: () => SpawnSyncReturns<string>;
  cleanup: () => Promise<void>;
}

export interface E2eProjectOptions {
  /** Distinguishes concurrent projects in the temp directory listing. */
  name: string;
  /** Extra `deoptKit({ outDir, … })` properties, spliced in verbatim. */
  presetOptions?: string;
}

/**
 * A throwaway consumer project: a megamorphic probe benchmark plus a Vitest config
 * using the built `deoptkit/vitest` preset. `node_modules` holds links to the
 * repository's own `vitest` and to the package directory as `deoptkit`, so the project
 * resolves the package exactly as an npm consumer would.
 */
export const createE2eProject = async (
  options: E2eProjectOptions
): Promise<E2eProject> => {
  const dir = await mkdtemp(join(tmpdir(), `deoptkit-e2e-${options.name}-`));
  // Forward slashes keep the path valid inside a JS string literal on Windows.
  const outDir = join(dir, ".deopt").replaceAll("\\", "/");
  const configPath = join(dir, "vitest.config.mts");

  writeFileSync(join(dir, "lib.ts"), LIB);
  writeFileSync(join(dir, "probe.bench.ts"), PROBE);
  writeFileSync(configPath, configFor(outDir, options.presetOptions));

  const links = [
    [join(dir, "node_modules", "vitest"), VITEST_DIR],
    [join(dir, "node_modules", "deoptkit"), PACKAGE]
  ] as const;
  mkdirSync(join(dir, "node_modules"));
  // Junctions need no elevated privileges on Windows and behave as symlinks elsewhere.
  for (const [path, target] of links) symlinkSync(target, path, "junction");

  return {
    dir,
    outDir,
    configPath,
    run: () =>
      spawnSync(
        process.execPath,
        [
          join(VITEST_DIR, "vitest.mjs"),
          "bench",
          "--run",
          "--config",
          configPath
        ],
        { cwd: dir, encoding: "utf8" }
      ),
    cleanup: async () => {
      // Unlink the links first: a recursive remove must never follow them into the
      // repository's own node_modules.
      for (const [path] of links) unlinkSync(path);
      await rm(dir, { recursive: true, force: true });
      if (
        !existsSync(join(VITEST_DIR, "package.json")) ||
        !existsSync(join(PACKAGE, "package.json"))
      ) {
        throw new Error(
          "e2e cleanup removed repository files through a node_modules link"
        );
      }
    }
  };
};
