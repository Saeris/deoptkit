// Fixture workload: a deliberately megamorphic property access.
// `getX` sees 8 different object shapes at the same load site, driving its
// inline cache monomorphic -> polymorphic (2-4) -> megamorphic (5+).
// The parser tests assert this site shows up as a megamorphic LoadIC.

function getX(obj) {
  return obj.x;
}

// Eight constructors producing eight distinct maps with `x` at different offsets.
const shapes = [
  { x: 1 },
  { a: 1, x: 2 },
  { a: 1, b: 2, x: 3 },
  { a: 1, b: 2, c: 3, x: 4 },
  { a: 1, b: 2, c: 3, d: 4, x: 5 },
  { a: 1, b: 2, c: 3, d: 4, e: 5, x: 6 },
  { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, x: 7 },
  { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, x: 8 }
];

// Enough iterations (~1s) for the profiler to record dozens of ticks even on Windows,
// where timer granularity caps --prof sampling at roughly 15ms per sample.
let sum = 0;
for (let i = 0; i < 2e8; i++) {
  sum += getX(shapes[i % shapes.length]);
}
// Observable sink so the loop cannot be dead-code eliminated (never throws).
if (sum < 0) throw new Error(`unreachable: ${sum}`);
