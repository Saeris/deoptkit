// Fixture workload: map churn from conditional property initialization.
// `makeRecord` adds different properties in different orders depending on its input,
// so conceptually-identical records get many distinct hidden classes (maps). This is
// the pathology behind the TypeScript team's 30-maps-for-Symbol fix.

function makeRecord(i) {
  const record = { id: i };
  if (i % 2 === 0) record.even = true;
  if (i % 3 === 0) record.third = i / 3;
  if (i % 5 === 0) record.fifth = `${i}`;
  if (i % 7 === 0) record.seventh = [i];
  return record;
}

function readId(record) {
  return record.id;
}

let sum = 0;
const records = [];
for (let i = 0; i < 1e5; i++) {
  records.push(makeRecord(i));
  if (records.length > 64) records.shift();
  sum += readId(records[0]);
}
if (sum < 0) throw new Error("unreachable");
