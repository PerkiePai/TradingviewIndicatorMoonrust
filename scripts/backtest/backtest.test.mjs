import assert from 'node:assert/strict';
import { parseBars, splitSessions } from './data.mjs';
import { simulate, entryAllowedAt } from './simulate.mjs';
import { buildGrid, selectSetup } from './grid.mjs';
import { runFold, runCv, selectFinal, verdict } from './cv.mjs';
import { makeRng, randomRun, randomComparison, indicatorDefault } from './references.mjs';
import { excursionStudy } from './excursion.mjs';
import { ema, rsi, atr, resample, buildFeatures } from './indicators.mjs';
import { renderReport } from './report.mjs';
import { run as runBacktest } from '../backtest.mjs';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

// ---- Task 4: limits, filters, trailing, opposite, ATR TP ----
const LIM = { ...SETUP, entry: { type: 'limit', offset: 1 } };
// Touch requires ask <= limit; on the fill bar only the stop is live; TP hits later
R = run([FLAT, [100, 100, 99, 100], [99.5, 102.5, 98.8, 100], [100, 102.1, 100, 102]], { 0: 1 }, LIM);
assert.equal(R.trades[0].entryIdx, 2); near(R.trades[0].entry, 99);
assert.equal(R.trades[0].exitIdx, 3); assert.equal(R.trades[0].reason, 'tp'); near(R.trades[0].pnl, 3);
// A better open fills at the open
R = run([FLAT, [98, 98.5, 97.9, 98]], { 0: 1 }, LIM);
near(R.trades[0].entry, 98.16);
// Stop is live on the limit fill bar
R = run([FLAT, [99.5, 100, 95.5, 99]], { 0: 1 }, LIM);
assert.equal(R.trades[0].reason, 'stop'); near(R.trades[0].exit, 95.9);
// Short limit fills on bid at signal close + offset
R = run([FLAT, [100.5, 101.2, 100, 101]], { 0: -1 }, LIM);
near(R.trades[0].entry, 101);
// Expires after 5 bars
R = run([FLAT, FLAT, FLAT, FLAT, FLAT, FLAT, [100, 100, 98, 99]], { 0: 1 }, LIM);
assert.equal(R.trades.length, 0);
// Opposite signal cancels and replaces it
R = run([FLAT, FLAT, [100, 101.2, 100, 101]], { 0: 1, 1: -1 }, LIM);
assert.equal(R.trades.length, 1); assert.equal(R.trades[0].dir, -1);
// 21:30 cancels a pending limit
R = run([FLAT, FLAT, FLAT, [100, 100, 98, 99]], { 0: 1 }, LIM, OPT, at(21, 28));
assert.equal(R.trades.length, 0);

// Filters read the signal bar
const fb = mkBars(flatN(4));
const hot = { ...feat(4, { 0: 1 }), rsi: [71, 50, 50, 50] };
assert.equal(simulate(fb, hot, one(fb), { ...SETUP, filter: 'rsi' }, OPT).trades.length, 0);
const ok = { ...feat(4, { 0: 1 }), rsi: [70, 50, 50, 50] };
assert.equal(simulate(fb, ok, one(fb), { ...SETUP, filter: 'rsi' }, OPT).trades.length, 1);
const cold = { ...feat(4, { 0: -1 }), rsi: [29, 50, 50, 50] };
assert.equal(simulate(fb, cold, one(fb), { ...SETUP, filter: 'rsi' }, OPT).trades.length, 0);
const trend = (v) => ({ ...feat(4, { 0: 1 }), trend5m: [v, v, v, v] });
assert.equal(simulate(fb, trend(1), one(fb), { ...SETUP, filter: 'trend5m' }, OPT).trades.length, 1);
assert.equal(simulate(fb, trend(-1), one(fb), { ...SETUP, filter: 'trend5m' }, OPT).trades.length, 0);
assert.equal(simulate(fb, trend(null), one(fb), { ...SETUP, filter: 'trend5m' }, OPT).trades.length, 0);

// Trailing: uses the bar's extreme from the next bar, and never moves backward
const TR = { ...SETUP, exit: { type: 'trail' } };
R = run([FLAT, [100, 100.5, 99.5, 100], [100, 105, 101, 104], [104, 104.5, 102.5, 103], [103, 103.5, 101.9, 102]], { 0: 1 }, TR);
assert.equal(R.trades[0].exitIdx, 4); assert.equal(R.trades[0].reason, 'trail');
near(R.trades[0].exit, 101.9); near(R.trades[0].pnl, 1.74);
// Short trail uses ask lows
R = run([FLAT, [100, 100.5, 99.5, 100], [100, 100, 95, 96], [96, 98.2, 96, 98]], { 0: -1 }, TR);
assert.equal(R.trades[0].exitIdx, 3);
near(R.trades[0].exit, 98.26); near(R.trades[0].pnl, 100 - 98.26);

// Opposite: exits at next open on bid, and reverses at the same open on bid
const OPP = { ...SETUP, exit: { type: 'opposite' } };
R = run([FLAT, FLAT, FLAT, [101, 101, 101, 101], [101, 101, 101, 101]], { 0: 1, 2: -1 }, OPP);
assert.equal(R.trades[0].reason, 'opposite'); assert.equal(R.trades[0].exitIdx, 3); near(R.trades[0].exit, 101);
assert.equal(R.trades[1].dir, -1); assert.equal(R.trades[1].entryIdx, 3); near(R.trades[1].entry, 101);
// A filter that blocks the reverse still exits
const blocked = { ...feat(5, { 0: 1, 2: -1 }), rsi: [50, 50, 29, 50, 50] };
const ob = mkBars(flatN(5));
R = simulate(ob, blocked, one(ob), { ...OPP, filter: 'rsi' }, OPT);
assert.equal(R.trades.length, 1); assert.equal(R.trades[0].reason, 'opposite');
// The stop stays live, and other exits ignore opposite signals
R = run([FLAT, [100, 100, 96, 97], FLAT], { 0: 1 }, OPP);
assert.equal(R.trades[0].reason, 'stop');
R = run([FLAT, FLAT, FLAT, FLAT], { 0: 1, 1: -1 }, SETUP);
assert.equal(R.trades.length, 1); assert.equal(R.trades[0].dir, 1);
// exitSignal drives opposite exits when given, while signal drives entries
const es = { ...feat(4, { 0: 1 }), exitSignal: [0, -1, 0, 0] };
const eb = mkBars(flatN(4));
R = simulate(eb, es, one(eb), OPP, OPT);
assert.equal(R.trades.length, 1); assert.equal(R.trades[0].exitIdx, 2); assert.equal(R.trades[0].reason, 'opposite');

// Indicator default: ATR TP, no stop, reverse on cross, blocked until ATR exists
const DEF = { id: 'default', entry: { type: 'market' }, filter: 'none', stop: null, exit: { type: 'tpAtr', mult: 0.5 } };
const db = mkBars([FLAT, [100, 102.2, 100, 102], FLAT, FLAT]);
const df = { ...feat(4, { 0: 1 }), atr15m: [4, 4, 4, 4] };
R = simulate(db, df, one(db), DEF, OPT);
near(R.trades[0].exit, 102.16); assert.equal(R.trades[0].reason, 'tp');
assert.equal(simulate(db, feat(4, { 0: 1 }), one(db), DEF, OPT).trades.length, 0);
// haltOnFail false keeps trading and still records the failure
const lossy = mkBars([FLAT, [100, 100, 80, 80], [80, 80, 80, 80], FLAT, FLAT]);
const lf = { ...feat(5, { 0: 1, 2: -1 }), atr15m: Array(5).fill(4) };
R = simulate(lossy, lf, one(lossy), DEF, { ...OPT, haltOnFail: false });
assert.equal(R.failed, true); assert.equal(R.firstFailIdx, 1); assert.equal(R.trades[0].reason, 'opposite');

// Post-close equity of an opposite exit enters the peak before the reverse trade's worst price.
// Long 100 -> exit 106 (+6, equity 30, peak 30); short 106 stopped at 109.1 (-3.1, equity 26.9): maxDD 3.1
R = run([FLAT, FLAT, [104, 104, 104, 104], [106, 109.2, 106, 109]], { 0: 1, 2: -1 }, OPP, { spread: 0 });
assert.equal(R.trades.length, 2);
assert.equal(R.trades[0].reason, 'opposite'); assert.equal(R.trades[1].reason, 'stop');
near(R.net, 2.9); near(R.maxDD, 3.1);
// A failing opposite close halts the run before the reversal opens (long 100 -> 80 = -20, equity 4)
const OPPW = { ...OPP, stop: 30 };
R = run([FLAT, FLAT, [95, 95, 95, 95], [80, 80, 80, 80], FLAT], { 0: 1, 2: -1 }, OPPW, { spread: 0 });
assert.equal(R.failed, true); assert.equal(R.firstFailIdx, 3);
assert.equal(R.trades.length, 1); assert.equal(R.trades[0].reason, 'opposite');
near(R.net, -20); near(R.maxDD, 20);

// An open already beyond the stop fills as a stop with slippage, even when an opposite signal is pending
R = run([FLAT, FLAT, FLAT, [96, 97, 95, 96], FLAT], { 0: 1, 2: -1 }, OPP);
assert.equal(R.trades[0].reason, 'stop'); assert.equal(R.trades[0].exitIdx, 3);
near(R.trades[0].exit, 95.9); near(R.trades[0].pnl, -4.26);
R = run([FLAT, FLAT, FLAT, [104, 104.5, 103.5, 104], FLAT], { 0: -1, 2: 1 }, OPP);
assert.equal(R.trades[0].reason, 'stop'); assert.equal(R.trades[0].exitIdx, 3);
near(R.trades[0].exit, 104.26); near(R.trades[0].pnl, -4.26);

// Null, undefined and NaN mean no signal (not a short)
const nb = mkBars(flatN(4));
const nanSig = { ...feat(4), signal: [NaN, null, undefined, NaN] };
assert.equal(simulate(nb, nanSig, one(nb), SETUP, OPT).trades.length, 0);
const nanExit = { ...feat(4, { 0: 1 }), exitSignal: [null, NaN, undefined, 0] };
R = simulate(nb, nanExit, one(nb), OPP, OPT);
assert.equal(R.trades.length, 1); assert.equal(R.trades[0].reason, 'session-end');

// Task 5: grid, fold selection and verdict
const grid = buildGrid();
assert.equal(grid.length, 180);
assert.equal(new Set(grid.map((s) => s.id)).size, 180);
assert.deepEqual([...new Set(grid.map((s) => s.stop))], [3, 5, 8, 12]);
assert.ok(grid.every((s) => s.stop !== null && s.exit.type !== 'tpAtr'));

const row = (id, net, maxDD, n, failed = false) => ({
  setup: { id }, result: { net, maxDD, failed, trades: Array(n).fill({}) },
});
assert.equal(selectSetup([row('a', 10, 5, 10), row('b', 12, 3, 10)]).setup.id, 'b');
assert.equal(selectSetup([row('a', 10, 5, 10, true)]), null);            // failed
assert.equal(selectSetup([row('a', 0, 5, 10)]), null);                   // no profit
assert.equal(selectSetup([row('a', 10, 5, 9)]), null);                   // too few trades
assert.equal(selectSetup([row('a', 4, 0, 10), row('b', 3, 0.5, 10)]).setup.id, 'a'); // DD floor $1
assert.equal(selectSetup([row('a', 6, 2, 10), row('b', 6, 2, 12)]).setup.id, 'b');   // more trades
assert.equal(selectSetup([row('a', 6, 2, 10), row('b', 6, 2, 10)]).setup.id, 'a');   // grid order

// Fold isolation, with indicators held fixed
const SMALL = { spread: 0.16, grid: buildGrid().slice(0, 40) };
const ss = splitSessions(sy);
const base1 = runFold(sy, f, ss, 1, SMALL);
const scrambled = sy.map((b, i) => (i >= ss[1].start && i <= ss[1].end
  ? { ...b, o: b.o + 200, h: b.h + 300, l: b.l - 300, c: b.c + 100 } : b));
assert.equal(runFold(scrambled, f, ss, 1, SMALL).chosen?.setup.id, base1.chosen?.setup.id);
assert.deepEqual(runFold(scrambled, f, ss, 1, SMALL).chosen?.train, base1.chosen?.train);

// The last-session fold also holds with indicators recomputed
const lastChanged = sy.map((b, i) => (i >= ss[3].start ? { ...b, c: b.c + 100, h: b.h + 200 } : b));
assert.equal(
  runFold(lastChanged, buildFeatures(lastChanged), ss, 3, SMALL).chosen?.setup.id,
  runFold(sy, f, ss, 3, SMALL).chosen?.setup.id,
);

// Each test day starts from $24, with its own session only
const cv = runCv(sy, f, ss, SMALL);
assert.equal(cv.folds.length, 4);
for (const fold of cv.folds) {
  if (!fold.test) continue;
  const s = ss.find((x) => x.id === fold.testSession.id && x.start === fold.testSession.start);
  assert.ok(fold.test.trades.every((t) => t.entryIdx >= s.start && t.exitIdx <= s.end));
}

// A session count other than 4 still gives one fold per session
assert.equal(runCv(sy, f, ss.slice(0, 3), SMALL).folds.length, 3);

// Nothing passes: all folds are no trade (Review Focus 2)
const none = runCv(sy, f, ss, { spread: 0.16, grid: [], });
assert.equal(none.combinedNet, 0); assert.equal(none.profitableFolds, 0);
assert.ok(none.folds.every((x) => x.chosen === null && x.test === null));
assert.equal(selectFinal(sy, f, ss, { spread: 0.16, grid: [] }), null);

// Zero trades on the test day is not a profitable fold (Review Focus 3)
const fakeFold = (net, n, failed = false) => ({ test: { net, failed, trades: Array(n).fill({}) } });
const mkCv = (folds, combinedNet) => ({
  folds, combinedNet,
  profitableFolds: folds.filter((x) => x.test && x.test.net > 0).length,
  failedFolds: folds.filter((x) => x.test && x.test.failed).length,
});
const pass = verdict({ base: mkCv([fakeFold(1, 3), fakeFold(1, 3), fakeFold(1, 3), fakeFold(-1, 3)], 2), stress: mkCv([], 0.5), randomPctBelow: 95 });
assert.equal(pass.label, 'demo candidate');
assert.equal(pass.checks.length, 4);
const nope = (over) => verdict({ base: mkCv([fakeFold(1, 3), fakeFold(1, 3), fakeFold(1, 3), fakeFold(-1, 3)], 2), stress: mkCv([], 0.5), randomPctBelow: 95, ...over }).label;
assert.equal(nope({ randomPctBelow: 94.9 }), 'no demonstrated edge');
assert.equal(nope({ stress: mkCv([], 0) }), 'no demonstrated edge');
assert.equal(nope({ base: mkCv([fakeFold(1, 3), fakeFold(1, 3), fakeFold(0, 0), fakeFold(-1, 3)], 2) }), 'no demonstrated edge');
assert.equal(nope({ base: mkCv([fakeFold(1, 3), fakeFold(1, 3), fakeFold(1, 3), fakeFold(-9, 3, true)], 2) }), 'no demonstrated edge');


assert.deepEqual([makeRng(7)(), makeRng(7)()], [makeRng(7)(), makeRng(7)()]);
assert.notEqual(makeRng(7)(), makeRng(8)());

const rc = randomComparison(sy, f, ss, cv, { runs: 25, seed: 11 });
assert.deepEqual(randomComparison(sy, f, ss, cv, { runs: 25, seed: 11 }), rc);  // repeatable
assert.equal(rc.runs, 25);
assert.ok(rc.pctBelow >= 0 && rc.pctBelow <= 100);
assert.ok(rc.p5 <= rc.p50 && rc.p50 <= rc.p95);

// A fold with no trades contributes $0 (Review Focus 2 and 3)
const rz = randomComparison(sy, f, ss, none, { runs: 5, seed: 1 });
assert.deepEqual([rz.p5, rz.p50, rz.p95], [0, 0, 0]);
assert.equal(rz.pctBelow, 0);  // strictly below: $0 vs $0 counts as not beating

// A random run makes the requested number of trades when there is room
const rr = randomRun(sy, f, ss[3], buildGrid()[0], 5, makeRng(2));
assert.equal(rr.trades.length, 5);
assert.ok(rr.trades.every((t) => t.entryIdx >= ss[3].start && t.exitIdx <= ss[3].end));

// randomRun hits exactly k trades for any seed when failure is off, and failure never steers the picks
const NOFAIL = { spread: 0.16, failEquity: -1e9 };
const tpSetup = buildGrid().find((x) => x.exit.type === 'tp');
const oppSetup = buildGrid().find((x) => x.exit.type === 'opposite');
for (const setup of [tpSetup, oppSetup]) {
  for (let seed = 1; seed <= 20; seed++) {
    assert.equal(randomRun(sy, f, ss[3], setup, 5, makeRng(seed), NOFAIL).trades.length, 5);
  }
}
let sawFail = 0;
for (let seed = 1; seed <= 20; seed++) {
  const free = randomRun(sy, f, ss[3], tpSetup, 5, makeRng(seed), NOFAIL);
  const hard = randomRun(sy, f, ss[3], tpSetup, 5, makeRng(seed), { spread: 0.16, failEquity: 23.9 });
  if (hard.failed) sawFail++;
  assert.deepEqual(hard.trades.map((x) => x.entryIdx), free.trades.map((x) => x.entryIdx).slice(0, hard.trades.length));
}
assert.ok(sawFail > 0);
const tiny = { id: 's', start: 299, end: 302 };
assert.ok(randomRun(sy, f, tiny, tpSetup, 50, makeRng(3), NOFAIL).trades.length <= 2);

// Indicator default: no entries before the ATR exists, and it trades later
const dr = indicatorDefault(sy, f, ss, { spread: 0.16 });
assert.ok(dr.trades.length > 0);
assert.ok(dr.trades.every((t) => f.atr15m[t.entryIdx - 1] !== null));

// Excursion: long from ask 100.16 runs to bid 104 and 98, until the opposite signal
const xb = mkBars([FLAT, [100, 104, 98, 101], [101, 101, 101, 101], [101, 110, 90, 101]]);
const xs = excursionStudy(xb, feat(4, { 0: 1, 2: -1 }), one(xb), { spread: 0.16 });
assert.equal(xs.count, 2);
assert.ok(xs.adverseReach.map((x) => x.level).join() === '3,5,8,12,16');
const x1 = excursionStudy(mkBars([FLAT, [100, 104, 98, 101]]), feat(2, { 0: 1 }), one(mkBars([FLAT, FLAT])), { spread: 0.16 });
near(x1.adverse.max, 2.16); near(x1.favourable.max, 3.84);
assert.equal(x1.adverseReach[0].share, 0);
const x0 = excursionStudy(xb, feat(4), one(xb), { spread: 0.16 });
assert.equal(x0.count, 0); assert.equal(x0.adverse.median, null);

const stats0 = { median: null, p75: null, p90: null, max: null };
const noEdge = {
  meta: { csv: 'x.csv', bars: 10, sessions: 4, seed: 1, gridSize: 180 },
  excursion: { count: 0, adverse: stats0, favourable: stats0, adverseReach: [] },
  cv: { '0.16': none, '0.32': none, '0.48': none },
  random: { runs: 5, seed: 1, pctBelow: 0, p5: 0, p50: 0, p95: 0 },
  indicatorDefault: { net: -20, maxDD: 30, failed: true, firstFailIdx: 5, trades: [] },
  final: { setup: { id: 'looks-good' }, result: { net: 9, maxDD: 2, failed: false, trades: [] } },
  verdict: { label: 'no demonstrated edge', checks: [{ name: 'c', passed: false, detail: 'd' }] },
};
const md = renderReport(noEdge);
assert.match(md, /no demonstrated edge/i);
assert.match(md, /no setup is recommended/i);
assert.doesNotMatch(md, /looks-good/);
assert.doesNotMatch(md, /NaN|Infinity|undefined/);
assert.match(md, /no trade/i);
for (const s of [/in-sample|screen/i, /training session follows/i, /demo/i]) assert.match(md, s);

const goodMd = renderReport({ ...noEdge, verdict: { label: 'demo candidate', checks: [] } });
assert.match(goodMd, /looks-good/);
assert.match(goodMd, /in-sample/i);

// Full run on the real file, if present, from another directory
const repoCsv = fileURLToPath(new URL('../../data/XAUUSD_EIGHTCAP_1m.csv', import.meta.url));
if (existsSync(repoCsv)) {
  process.chdir(process.env.TEMP ?? '/');
  const out = runBacktest();
  assert.equal(out.results.meta.bars, 5273);
  assert.equal(out.results.meta.sessions, 4);
  assert.equal(out.results.meta.gridSize, 180);
  assert.ok(Math.abs(out.results.excursion.count - 58) <= 5, `signals ${out.results.excursion.count}`);
  assert.ok(existsSync(out.mdPath) && existsSync(out.jsonPath));
  assert.deepEqual(runBacktest().results, out.results);
}


console.log('all tests passed');
