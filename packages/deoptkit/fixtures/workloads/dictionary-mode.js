// Fixture workload: objects that leave fast-properties mode, plus the two kinds of
// polymorphism that are not object shapes.
//
// `buildRecord` stores 20 properties one keyed store at a time. V8 keeps an object fast
// through its first 12 out-of-object fields and then normalizes it to dictionary mode
// (reason `TooManyFastProperties`); the NormalizedMapCache hands every later record the
// same dictionary map, so the store site logs a `NormalizeCached` map event per object.
// That is a `dictionary-mode` finding, not map churn.
//
// `endsWithX` sees strings in every representation V8 has (one-byte, two-byte, cons,
// sliced, internalized or not), five and more maps, so its LoadIC goes megamorphic
// over string maps that no property order can fix. `pushOne` sees arrays that differ
// only by elements kind (packed or holey; smi, double, tagged), six maps: polymorphism
// the user fixes by keeping element types uniform. Both go megamorphic rather than
// polymorphic because a polymorphic finding needs self ticks in the function, and a
// workload this builtin-heavy may sample none in user code.

function buildRecord(i) {
  const record = {};
  for (let field = 0; field < 20; field++) record[`field${field}`] = i + field;
  return record;
}

const strings = [
  "plain ascii",
  "two byte あい",
  "cons ".repeat(10) + "string ".repeat(10),
  "あ".repeat(10) + "x".repeat(10),
  "sliced string long enough to slice".slice(3, 30),
  "fresh sequential".toUpperCase(),
  "internalized"
];
function endsWithX(s) {
  return s.endsWith("x");
}

function pushOne(arr) {
  arr.push(1);
  return arr.length;
}

let sum = 0;
for (let i = 0; i < 2e5; i++) {
  if (i % 100 === 0) sum += Object.keys(buildRecord(i)).length;
  sum += endsWithX(strings[i % strings.length]) ? 1 : 0;
  // Holey variants: a store past the end leaves holes before the new element.
  const holeySmi = [1];
  holeySmi[3] = 1;
  const holeyDouble = [1.5];
  holeyDouble[3] = 1.5;
  const holeyTagged = ["s"];
  holeyTagged[3] = "s";
  const arrays = [[], [1.5], ["s"], holeySmi, holeyDouble, holeyTagged];
  sum += pushOne(arrays[i % arrays.length]);
}
if (sum < 0) throw new Error("unreachable");
