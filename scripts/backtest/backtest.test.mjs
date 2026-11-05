import assert from 'node:assert/strict';
import { parseBars, splitSessions } from './data.mjs';
import { simulate, entryAllowedAt } from './simulate.mjs';
import { ema, rsi, atr, resample, buildFeatures } from './indicators.mjs';

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

assert.deepEqual(ema([1, 2, 3, 4], 3), [null, null, 2, 3]);
const seeded = ema([null, null, 1, 3, 5], 2);
assert.deepEqual(seeded.slice(0, 3), [null, null, null]);
near(seeded[3], 2); near(seeded[4], 4);

// Wilder RSI, n=2: changes +1, +1, -1 -> seed gain 1, loss 0 -> 100; then gain .5, loss .5 -> 50
const r = rsi([1, 2, 3, 2], 2);
assert.deepEqual(r.slice(0, 2), [null, null]);
near(r[2], 100); near(r[3], 50);

const ab = [
  { t: 0, o: 1, h: 3, l: 1, c: 2, v: 0 },   // TR 2
  { t: 60, o: 2, h: 5, l: 2, c: 4, v: 0 },  // TR 3
  { t: 120, o: 4, h: 5, l: 3, c: 4, v: 0 }, // TR 2
];
const a = atr(ab, 2);
assert.equal(a[0], null); near(a[1], 2.5); near(a[2], 2.25);

// Buckets are clock aligned, and a bucket with a gap still aggregates its bars
const rb = resample([
  { t: 300, o: 1, h: 2, l: 1, c: 1.5, v: 1 },
  { t: 360, o: 1.5, h: 4, l: 1, c: 3, v: 2 },
  { t: 600, o: 3, h: 3, l: 2, c: 2, v: 3 },
], 5);
assert.deepEqual(rb[0], { t: 300, o: 1, h: 4, l: 1, c: 3, v: 3 });
assert.equal(rb[1].t, 600);

// Synthetic series: 4 sessions shaped like the real file (used again by later tasks)
function synthBars() {
  const out = []; let t = Date.UTC(2026, 10, 1, 23, 1) / 1000; let i = 0;
  for (let s = 0; s < 4; s++) {
    for (let m = 0; m < 1378; m++, i++, t += 60) {
      const c = 4000 + 25 * Math.sin(i / 37) + 9 * Math.sin(i / 5.3);
      out.push({ t, o: c - 0.3, h: c + 1.2, l: c - 1.4, c, v: 100 });
    }
    t += 62 * 60;
  }
  return out;
}
const sy = synthBars();
const f = buildFeatures(sy);
assert.equal(f.signal.length, sy.length);
assert.ok(f.signal.slice(0, 300).every((v) => v === 0));   // warm-up
assert.ok(f.signal.filter((v) => v === 1).length > 0);
assert.ok(f.signal.filter((v) => v === -1).length > 0);
assert.equal(f.trend5m[0], null);
assert.equal(f.atr15m[0], null);
assert.ok(f.atr15m.at(-1) > 0);

// Leakage: changing future bars leaves all earlier features unchanged
const cut = 3000;
const changed = sy.map((b, i) => (i > cut ? { ...b, o: b.o + 50, h: b.h + 90, l: b.l - 90, c: b.c - 40 } : b));
const g = buildFeatures(changed);
for (const key of ['signal', 'rsi', 'trend5m', 'atr15m']) {
  assert.deepEqual(g[key].slice(0, cut + 1), f[key].slice(0, cut + 1), key);
}

// trend5m and atr15m use completed buckets only: test cuts at every position in a 15m bucket
for (let c = 3001; c <= 3015; c++) {
  const later = sy.map((b, i) => (i > c ? { ...b, h: b.h + 90, l: b.l - 90, c: b.c - 40 } : b));
  const lf15 = buildFeatures(later);
  assert.deepEqual(lf15.trend5m.slice(0, c + 1), f.trend5m.slice(0, c + 1));
  assert.deepEqual(lf15.atr15m.slice(0, c + 1), f.atr15m.slice(0, c + 1));
}

const T10 = Date.UTC(2026, 10, 2, 10, 0) / 1000;
// rows: [o, h, l, c], or a full bar with its own t
const mkBars = (rows, t0 = T10) => rows.map(([o, h, l, c], i) => ({ t: t0 + i * 60, o, h, l, c, v: 0 }));
const feat = (n, signals = {}) => ({
  signal: Array.from({ length: n }, (_, i) => signals[i] ?? 0),
  rsi: Array(n).fill(50), trend5m: Array(n).fill(null), atr15m: Array(n).fill(null),
});
const one = (bars) => [{ id: 's', start: 0, end: bars.length - 1 }];
const SETUP = { id: 't', entry: { type: 'market' }, filter: 'none', stop: 3, exit: { type: 'tp', mult: 1 } };
const OPT = { spread: 0.16 };
const FLAT = [100, 100, 100, 100];
const run = (rows, sig, setup = SETUP, opt = OPT, t0) => {
  const b = mkBars(rows, t0);
  return simulate(b, feat(b.length, sig), one(b), setup, opt);
};

// Long: enters on ask, TP hit on bid
let R = run([FLAT, [100, 101, 99.5, 100.5], [100.5, 103.2, 100, 103]], { 0: 1 });
assert.equal(R.trades.length, 1);
near(R.trades[0].entry, 100.16); near(R.trades[0].exit, 103.16); near(R.trades[0].pnl, 3);
assert.equal(R.trades[0].reason, 'tp');

// Short: enters on bid, TP checked on ask
R = run([FLAT, [100, 100.5, 99.5, 100], [100, 102, 96.8, 97]], { 0: -1 });
near(R.trades[0].entry, 100); near(R.trades[0].exit, 97); near(R.trades[0].pnl, 3);

// Short: ask reaching the stop triggers it, even when bid stays below
R = run([FLAT, [100, 100.5, 99.5, 100], [100, 102.9, 99, 100]], { 0: -1 });
assert.equal(R.trades[0].reason, 'stop');
near(R.trades[0].exit, 103.1); near(R.trades[0].pnl, -3.1);

// Stop beats TP on the same bar
R = run([FLAT, [100, 104, 97, 100]], { 0: 1 });
assert.equal(R.trades[0].reason, 'stop'); near(R.trades[0].pnl, -3.1);

// A gap past the stop fills at open minus slippage
R = run([FLAT, [100, 100.5, 99.5, 100], [96, 97, 95, 96]], { 0: 1 });
near(R.trades[0].exit, 95.9); near(R.trades[0].pnl, -4.26);

// Entry-time rules
assert.equal(entryAllowedAt(Date.UTC(2026, 10, 2, 21, 30) / 1000), true);
assert.equal(entryAllowedAt(Date.UTC(2026, 10, 2, 21, 31) / 1000), false);
assert.equal(entryAllowedAt(Date.UTC(2026, 10, 1, 23, 1) / 1000), true);

const at = (h, m) => Date.UTC(2026, 10, 2, h, m) / 1000;
const flatN = (n) => Array(n).fill(FLAT);
assert.equal(run(flatN(5), { 0: 1 }, SETUP, OPT, at(21, 29)).trades.length, 1);  // fills 21:30
assert.equal(run(flatN(5), { 0: 1 }, SETUP, OPT, at(21, 30)).trades.length, 0);  // would fill 21:31

// Forced close at the 21:50 bar's close
R = run(flatN(25), { 0: 1 }, SETUP, OPT, at(21, 29));
assert.equal(R.trades[0].reason, 'forced');
assert.equal(R.trades[0].exitIdx, 21);
near(R.trades[0].exit, 100);

// No 21:50 bar: closes at the first bar after it (Review Focus 5)
const gapBars = mkBars(flatN(4), at(21, 29));
gapBars[2].t = at(21, 45); gapBars[3].t = at(21, 55);
R = simulate(gapBars, feat(4, { 0: 1 }), one(gapBars), SETUP, OPT);
assert.equal(R.trades[0].reason, 'forced'); assert.equal(R.trades[0].exitIdx, 3);

// Session's last bar closes the trade, and nothing carries into the next session
const two = mkBars(flatN(6));
R = simulate(two, feat(6, { 1: 1, 2: 0 }), [{ id: 'a', start: 0, end: 2 }, { id: 'b', start: 3, end: 5 }], SETUP, OPT);
assert.equal(R.trades.length, 1);
assert.equal(R.trades[0].reason, 'session-end'); assert.equal(R.trades[0].exitIdx, 2);
// A signal on a session's last bar is dropped
R = simulate(two, feat(6, { 2: 1 }), [{ id: 'a', start: 0, end: 2 }, { id: 'b', start: 3, end: 5 }], SETUP, OPT);
assert.equal(R.trades.length, 0);

// Failure: intrabar equity <= $8 ends the run at the worst price, with no further trades
const WIDE = { ...SETUP, stop: 20, exit: { type: 'tp', mult: 5 } };
R = run([FLAT, [100, 100, 84, 100], FLAT, FLAT, FLAT], { 0: 1, 2: 1 }, WIDE);
assert.equal(R.failed, true); assert.equal(R.firstFailIdx, 1);
assert.equal(R.trades.length, 1); assert.equal(R.trades[0].reason, 'fail');
near(R.net, -16.16); near(R.maxDD, 16.16);
// Exactly $8 fails: entry 100 (zero spread), low 84
R = run([FLAT, [100, 100, 84, 100], FLAT], { 0: 1 }, WIDE, { spread: 0 });
assert.equal(R.failed, true);
// Just above does not
R = run([FLAT, [100, 100, 84.01, 100], FLAT], { 0: 1 }, WIDE, { spread: 0 });
assert.equal(R.failed, false);

// Post-close equity raises the peak even when a new trade opens on the next bar:
// TP +3, immediate re-entry stopped at -3.1 -> net -0.1, maxDD 3.1
R = run([FLAT, [100, 100.5, 99.5, 100], [100, 103, 100, 103], [103, 103, 99, 100]], { 0: 1, 2: 1 }, SETUP, { spread: 0 });
assert.equal(R.trades.length, 2);
near(R.net, -0.1); near(R.maxDD, 3.1);

// Zero costs: sum of trade P&L equals net on real-looking data
const acc = simulate(sy, f, splitSessions(sy), SETUP, { spread: 0, slippage: 0 });
near(acc.trades.reduce((s, t) => s + t.pnl, 0), acc.net, 1e-6);
assert.ok(Number.isFinite(acc.maxDD));

// Leakage: changing bars after a cut leaves earlier fills unchanged
const before = simulate(sy, f, splitSessions(sy), SETUP, OPT).trades.filter((t) => t.exitIdx <= cut);
const after = simulate(changed, g, splitSessions(changed), SETUP, OPT).trades.filter((t) => t.exitIdx <= cut);
assert.deepEqual(after, before);

console.log('all tests passed');
