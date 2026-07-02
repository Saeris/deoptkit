import type { CodeEntry } from "../model/logModel";

/**
 * Address-range index of live code objects, used to resolve an instruction address
 * (e.g. an IC's pc) to the code object containing it. V8 reuses addresses after GC,
 * so inserting an overlapping entry evicts the entries it overlaps — same semantics
 * as V8's tools/codemap, minus move events (slice 1) and the splay tree (an array
 * with binary search is adequate until profiling-scale lookups land).
 */
export class CodeMap {
  /** Entries sorted by `start`, non-overlapping. */
  #entries: CodeEntry[] = [];
  #count = 0;

  get count(): number {
    return this.#count;
  }

  /** Index of the last entry with `start <= address`, or -1. */
  #indexBefore(address: bigint): number {
    let low = 0;
    let high = this.#entries.length - 1;
    let result = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.#entries[mid].start <= address) {
        result = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return result;
  }

  add(entry: CodeEntry): void {
    this.#count += 1;
    const end = entry.start + BigInt(entry.size);
    // Evict entries the new range overlaps: those starting inside [start, end) and
    // one starting before whose range extends into it.
    let from = this.#indexBefore(entry.start);
    if (from >= 0) {
      const before = this.#entries[from];
      if (before.start + BigInt(before.size) <= entry.start) from += 1;
    } else {
      from = 0;
    }
    let to = from;
    while (to < this.#entries.length && this.#entries[to].start < end) to += 1;
    this.#entries.splice(from, to - from, entry);
  }

  /** Find the code object whose range contains `address`. */
  find(address: bigint): CodeEntry | undefined {
    const index = this.#indexBefore(address);
    if (index < 0) return undefined;
    const entry = this.#entries[index];
    return address < entry.start + BigInt(entry.size) ? entry : undefined;
  }
}
