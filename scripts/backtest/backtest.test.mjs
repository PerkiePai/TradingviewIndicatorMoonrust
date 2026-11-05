import assert from 'node:assert/strict';
import { parseBars, splitSessions } from './data.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);
const HEADER = 'time,open,high,low,close,volume';

// CRLF and trailing blank lines load normally (Review Focus 1)
const parsed = parseBars(`${HEADER}\r\n100,1,2,0.5,1.5,7\r\n160,1.5,2,1,1.2,0\r\n\r\n`);
assert.equal(parsed.length, 2);
assert.deepEqual(parsed[0], { t: 100, o: 1, h: 2, l: 0.5, c: 1.5, v: 7 });

assert.throws(() => parseBars('a,b\n1,2\n'), /header/i);
assert.throws(() => parseBars(`${HEADER}\n160,1,2,0.5,1,0\n100,1,2,0.5,1,0\n`), /increasing/i);
assert.throws(() => parseBars(`${HEADER}\n100,1,0.5,2,1,0\n`), /price/i); // high < low
assert.throws(() => parseBars(`${HEADER}\n100,x,2,0,1,0\n`), /price/i);

// 63-minute gap splits; 6-minute gap does not; id is the last bar's UTC date
const d = (s) => Date.UTC(2026, 10, 1, 0, 0) / 1000 + s * 60;
const sb = [d(1439), d(1445), d(1446), d(1509), d(1510)].map((t) => ({ t, o: 1, h: 1, l: 1, c: 1, v: 0 }));
assert.deepEqual(splitSessions(sb), [
  { id: '2026-11-02', start: 0, end: 2 },
  { id: '2026-11-02', start: 3, end: 4 },
]);

console.log('all tests passed');
