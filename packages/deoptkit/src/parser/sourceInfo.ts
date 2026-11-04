/** Decoded `code-source-info` for one code object. Arrays are parallel, sorted by code offset. */
export interface SourceInfo {
  scriptId: string;
  codeOffsets: Int32Array;
  scriptOffsets: Int32Array;
  /** Inlining id per position, -1 when the position is in the code object's own function. */
  inliningIds: Int32Array;
  /** Index = inlining id. */
  inlining: Array<{
    functionIndex: number | undefined;
    /** Call-site script offset in the parent (the function named by `parent`, or the code object's own). */
    scriptOffset: number;
    parent: number | undefined;
  }>;
  /** Index = `functionIndex`; SharedFunctionInfo addresses as logged (e.g. "0x2fcf93e4c88"). */
  inlinedSfis: string[];
}

/** `C<codeOffset>O<scriptOffset>`, optionally followed by `I<inliningId>`. */
const POSITION_RE = /C(?<code>\d+)O(?<script>\d+)(?:I(?<inlining>\d+))?/gu;

/** `F<functionIndex>O<callSiteOffset>`, optionally followed by `I<parentInliningId>`; F may be empty. */
const INLINING_RE = /F(?<fn>\d*)O(?<callSite>\d+)(?:I(?<parent>\d+))?/gu;

/**
 * Decode the tables `--log-source-code` writes after each code object (V8 log.cc,
 * LogSourceCodeInformation): code offset -> script offset positions tagged with the
 * inlining id they belong to, the inlining tree, and the inlined functions' sfis.
 */
export const decodeSourceInfo = (
  scriptId: string,
  positions: string,
  inlining: string,
  inlinedSfis: string
): SourceInfo => {
  const matches = [...positions.matchAll(POSITION_RE)];
  const codeOffsets = new Int32Array(matches.length);
  const scriptOffsets = new Int32Array(matches.length);
  const inliningIds = new Int32Array(matches.length);
  for (const [index, { groups }] of matches.entries()) {
    codeOffsets[index] = Number(groups?.["code"]);
    scriptOffsets[index] = Number(groups?.["script"]);
    const id = groups?.["inlining"];
    inliningIds[index] = id === undefined ? -1 : Number(id);
  }
  return {
    scriptId,
    codeOffsets,
    scriptOffsets,
    inliningIds,
    inlining: [...inlining.matchAll(INLINING_RE)].map(({ groups }) => {
      const fn = groups?.["fn"];
      const parent = groups?.["parent"];
      return {
        functionIndex: fn === undefined || fn === "" ? undefined : Number(fn),
        scriptOffset: Number(groups?.["callSite"]),
        parent: parent === undefined ? undefined : Number(parent)
      };
    }),
    inlinedSfis: inlinedSfis.split("S").filter((sfi) => sfi !== "")
  };
};

/** Position entry for a code offset: the last entry at or below it, or undefined before the first. */
export const positionAt = (
  info: SourceInfo,
  codeOffset: number
): { scriptOffset: number; inliningId: number } | undefined => {
  let low = 0;
  let high = info.codeOffsets.length - 1;
  let result = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (info.codeOffsets[mid] <= codeOffset) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (result < 0) return undefined;
  return {
    scriptOffset: info.scriptOffsets[result],
    inliningId: info.inliningIds[result]
  };
};

/** Line table for one script source, mapping UTF-16 offsets to 1-based positions. */
export class ScriptPositions {
  /** Offset at which each line starts; index 0 is line 1. */
  readonly #lineStarts: number[] = [0];

  constructor(source: string) {
    for (
      let index = source.indexOf("\n");
      index !== -1;
      index = source.indexOf("\n", index + 1)
    ) {
      this.#lineStarts.push(index + 1);
    }
  }

  /** 1-based line and column of a UTF-16 offset. */
  at(offset: number): { line: number; column: number } {
    let low = 0;
    let high = this.#lineStarts.length - 1;
    let line = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.#lineStarts[mid] <= offset) {
        line = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return { line: line + 1, column: offset - this.#lineStarts[line] + 1 };
  }
}
