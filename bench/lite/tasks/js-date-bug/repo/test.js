const assert = require('assert');
const { parseDuration, formatDuration } = require('./durations');

assert.strictEqual(parseDuration('1h30m'), 5400);
assert.strictEqual(parseDuration('2d 4h'), 187200);
assert.strictEqual(parseDuration('abc'), null);
assert.strictEqual(parseDuration('5x'), null);
assert.strictEqual(formatDuration(5400), '1h30m');
console.log('ok');
