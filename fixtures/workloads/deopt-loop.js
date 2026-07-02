// Fixture workload: a deliberate deopt loop.
// `add` warms up on numbers so TurboFan optimizes it for integer addition, then a
// string sneaks in and invalidates that assumption (eager deopt). Repeating the
// warm-up/poison cycle forces V8 to optimize and throw the code away repeatedly —
// the "deopt loop" pathology the findings engine must rank above one-off deopts.

function add(a, b) {
  return a + b;
}

let out = 0;
let text = "";
for (let cycle = 0; cycle < 6; cycle++) {
  for (let i = 0; i < 2e5; i++) {
    out += add(i, cycle);
  }
  text = add(`cycle`, cycle);
}
if (out < 0 || text === "") throw new Error("unreachable");
