// The "after" of the map-churn fix-verify pair: every record gets the full property
// set in a fixed order, so all records share one hidden class and readId's inline
// cache stays monomorphic. compare_sessions tests profile map-churn.js and this file
// from the same temp path to simulate an agent editing the file in place.

function makeRecord(i) {
  return {
    id: i,
    even: i % 2 === 0,
    third: i % 3 === 0 ? i / 3 : null,
    fifth: i % 5 === 0 ? `${i}` : null,
    seventh: i % 7 === 0 ? [i] : null
  };
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
