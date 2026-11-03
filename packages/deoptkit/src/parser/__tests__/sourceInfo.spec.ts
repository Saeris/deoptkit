import { describe, expect, it } from "vitest";
import { decodeSourceInfo, positionAt, ScriptPositions } from "../sourceInfo";

// V8 writes these tables and nothing else tells inlined code apart from its caller:
// every event logged from inlined code carries the caller's code address, so a
// mis-decoded table silently charges the inlined function's ICs and ticks to the caller.
describe("decodeSourceInfo", () => {
  const info = decodeSourceInfo(
    "39",
    "C21O3048C42O3234I0C454O2103I1",
    "F0O664F0O621I0",
    "S0x2fcf93e4c88S0x15f6acd85e0"
  );

  it("decodes the position table into parallel arrays tagged by inlining id", () => {
    expect(info.scriptId).toBe("39");
    expect([...info.codeOffsets]).toEqual([21, 42, 454]);
    expect([...info.scriptOffsets]).toEqual([3048, 3234, 2103]);
    // -1 is the code object's own function; 0 and 1 index the inlining table.
    expect([...info.inliningIds]).toEqual([-1, 0, 1]);
  });

  // The parent link is what lets nested inlining walk back out to the code object's
  // own function; losing it would resolve a doubly-inlined callee's caller wrongly.
  it("decodes the inlining tree with call-site offsets and parent links", () => {
    expect(info.inlining).toEqual([
      { functionIndex: 0, scriptOffset: 664, parent: undefined },
      { functionIndex: 0, scriptOffset: 621, parent: 0 }
    ]);
    expect(info.inlinedSfis).toEqual(["0x2fcf93e4c88", "0x15f6acd85e0"]);
  });

  // V8 logs an empty function index when it cannot name the inlined function; that
  // must stay distinguishable from index 0, which names a real sfi.
  it("keeps an unknown inlined function as undefined rather than index 0", () => {
    expect(decodeSourceInfo("1", "", "FO12", "").inlining).toEqual([
      { functionIndex: undefined, scriptOffset: 12, parent: undefined }
    ]);
  });
});

describe("positionAt", () => {
  const info = decodeSourceInfo(
    "39",
    "C21O3048C42O3234I0C454O2103I1",
    "F0O664F0O621I0",
    "S0x2fcf93e4c88S0x15f6acd85e0"
  );

  // An entry covers every code offset up to the next one, so a pc between two
  // entries belongs to the earlier; picking the later would cross an inlining boundary.
  it("returns the entry at an exact offset and the previous entry between offsets", () => {
    expect(positionAt(info, 42)).toEqual({ scriptOffset: 3234, inliningId: 0 });
    expect(positionAt(info, 100)).toEqual({
      scriptOffset: 3234,
      inliningId: 0
    });
    expect(positionAt(info, 10_000)).toEqual({
      scriptOffset: 2103,
      inliningId: 1
    });
  });

  it("returns undefined below the first entry", () => {
    expect(positionAt(info, 20)).toBeUndefined();
  });
});

describe("scriptPositions", () => {
  // IC and deopt positions are 1-based line/column; an off-by-one here moves every
  // inlined finding to the wrong character.
  it("maps UTF-16 offsets to 1-based line and column", () => {
    const positions = new ScriptPositions("ab\ncd\n");
    expect(positions.at(0)).toEqual({ line: 1, column: 1 });
    expect(positions.at(3)).toEqual({ line: 2, column: 1 });
    expect(positions.at(4)).toEqual({ line: 2, column: 2 });
  });
});
