// Fixture workload: a genuine deopt loop via phased shape introduction.
// Each phase warms `hot` on the shapes seen so far, letting TurboFan optimize with
// map checks for exactly those shapes — then the next phase introduces a NEW shape,
// failing the embedded check with an eager "wrong map" deopt at the same position.
// Re-optimize, repeat: the same site deopts once per phase, which is the deopt-loop
// pathology (repeated optimize/discard cycles), unlike one-shot type flips whose
// feedback generalizes after a single bailout.

function getX(obj) {
  return obj.x;
}

function hot(shape) {
  let sum = 0;
  for (let i = 0; i < 2e5; i++) {
    sum += getX(shape);
  }
  return sum;
}

const makers = [
  () => ({ x: 1 }),
  () => ({ a: 1, x: 2 }),
  () => ({ a: 1, b: 2, x: 3 }),
  () => ({ a: 1, b: 2, c: 3, x: 4 }),
  () => ({ a: 1, b: 2, c: 3, d: 4, x: 5 }),
  () => ({ a: 1, b: 2, c: 3, d: 4, e: 5, x: 6 })
];

let out = 0;
for (const make of makers) {
  out += hot(make());
}
if (out < 0) throw new Error("unreachable");
