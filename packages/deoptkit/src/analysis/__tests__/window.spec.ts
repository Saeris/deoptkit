import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { FunctionTicks, LogModel } from "../../model/logModel";
import { parseLog } from "../../parser/parseLog";
import { generateWorkloadLog } from "../../parser/__tests__/helpers";
import { applyWindow } from "../window";

/** The parser's function key, rebuilt from a row (undefined parts print as `undefined`). */
const keyOf = (row: FunctionTicks): string =>
  `${row.functionName}|${row.file}|${row.line}|${row.column}`;

describe("applyWindow on a tick-bearing V8 log", () => {
  let fixtureDir: string;
  let model: LogModel;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "deoptkit-window-"));
    model = await parseLog(generateWorkloadLog("megamorphic", fixtureDir));
  }, 60_000);

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  // Windows recount heat from retained samples; a dropped tick is heat no window can see.
  it("retains one sample per tick", () => {
    expect(model.profile.samples).toHaveLength(model.profile.tickCount);
    expect(model.profile.tickCount).toBeGreaterThan(5);
    expect(model.profile.samples.some(({ self }) => self !== undefined)).toBe(
      true
    );
  });

  // A key that fails to round-trip silently zeroes a function's heat in every window.
  it("an unbounded window reproduces the parser's profile exactly", () => {
    expect(
      applyWindow(model, { fromTime: -Infinity, toTime: Infinity }).profile
    ).toEqual(model.profile);
  });

  // Heat inside a window drives severity, so it must come only from the kept samples.
  it("a partial window recounts ticks from the samples it keeps", () => {
    const { samples } = model.profile;
    const fromTime = samples[Math.floor(samples.length / 2)]?.time ?? 0;
    const kept = samples.filter(({ time }) => time >= fromTime);
    const { profile } = applyWindow(model, { fromTime, toTime: Infinity });

    expect(profile.tickCount).toBe(kept.length);
    for (const row of profile.functions) {
      expect(row.selfTicks).toBe(
        kept.filter(({ self }) => self === keyOf(row)).length
      );
    }
    expect(
      Object.values(profile.vmStates).reduce((sum, count) => sum + count, 0)
    ).toBe(profile.tickCount);
  });
});
