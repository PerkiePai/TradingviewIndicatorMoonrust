# MoonRush Backtest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dependency-free Node backtester that cross-validates 180 order and take-profit setups on MoonRush signals for a $24 account, and reports either a demo candidate or "no demonstrated edge".

**Architecture:** Pure modules pass plain objects along one pipeline: load bars, split sessions, build features, simulate setups, select per fold, compare with references, render the report. `simulate` is the only place fills happen, so the CV, random-entry and indicator-default runs all share the same fill rules. Indicators are computed once over the full file; a run reads only the sessions it is given.

**Tech Stack:** Node 22 ESM (`.mjs`), `node:fs`, `node:path`, `node:url`, `node:assert/strict`. No npm packages, no CDP.

**Spec:** `docs/superpowers/specs/2026-11-06-moonrush-backtest-design.md`. Read it first: it holds the rules this plan does not repeat.

## Global Constraints

- Work on branch `docs/moonrush-backtest-design`. Stage only the files each task names. Never stage `data/` or `scripts/pull_tv_ohlcv.mjs`.
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- No npm packages, no `package.json`, and no import from `tradingview-mcp`.
- 0.01 lot at $1 per $1 of price, one position at a time, start equity $24, failure at equity ≤ $8.
- Spreads $0.16 (base), $0.32, $0.48. Stop slippage $0.10. Limit and TP orders have no slippage.
- CSV prices are bid; `ask = bid + spread`.
- Warm-up 300 bars. Last entry fill 21:30 UTC. Forced close at the close of the 21:50 UTC bar.
- All tests live in `scripts/backtest/backtest.test.mjs`, as top-level `node:assert/strict` checks, and end by printing `all tests passed`. Each task adds its imports at the top of the file and its checks above that final print, reusing helpers and fixtures from earlier tasks.
- Test command for every task: `node scripts/backtest/backtest.test.mjs`.

## Review Focus

1. A CSV with CRLF line endings or a trailing blank line must load normally, not produce a bad bar or a false error.
2. Every fold ending in "no trade" must render a "no demonstrated edge" report with $0 figures and no `NaN` or `Infinity`.
3. A chosen setup making zero trades on its test day must count as $0 and not as a profitable fold, and its random comparison must also contribute $0.
4. Running from another directory, or with no `reports/` folder, must still write the reports to the repo's `reports/` and find the default CSV.
5. A session with no bar at exactly 21:50 UTC (data gap) must close at the first bar at or after 21:50, or at the session's last bar, never carrying a position into the next session.

---

### Task 1: CSV loading and sessions

**Files:**
- Create: `scripts/backtest/data.mjs`
- Test: `scripts/backtest/backtest.test.mjs`

**Interfaces:**
- Produces:
  - `Bar = {t, o, h, l, c, v}`, with `t` in Unix seconds.
  - `Session = {id: string, start: number, end: number}`. `start` and `end` are inclusive bar indexes. `id` is the UTC date of the session's last bar.
  - `parseBars(text: string) -> Bar[]`, which throws on a bad file.
  - `loadBars(path: string) -> Bar[]`
  - `splitSessions(bars: Bar[], gapSec = 1800) -> Session[]`

- [ ] **Step 1: Write the failing tests**

```js
import assert from 'node:assert/strict';
import { parseBars, splitSessions } from './data.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);
const HEADER = 'time,open,high,low,close,volume';

// CRLF and trailing blank lines load normally (Review Focus 1)
const parsed = parseBars(`${HEADER}\r\n100,1,2,0.5,1.5,7\r\n160,1.5,2,1,1.2,0\r\n\r\n`);
assert.equal(parsed.length, 2);
assert.deepEqual(parsed[0], { t: 100, o: 1, h: 2, l: 0.5, c: 1.5, v: 7 });

assert.throws(() => parseBars('a,b\n1,2\n'), /header/i);
assert.throws(() => parseBars(`${HEADER}\n160,1,2,0,1,0\n100,1,2,0,1,0\n`), /increasing/i);
assert.throws(() => parseBars(`${HEADER}\n100,1,0.5,2,1,0\n`), /price/i); // high < low
assert.throws(() => parseBars(`${HEADER}\n100,x,2,0,1,0\n`), /price/i);

// 63-minute gap splits; 6-minute gap does not; id is the last bar's UTC date
const d = (s) => Date.UTC(2026, 10, 1, 0, 0) / 1000 + s * 60;
const sb = [d(1381), d(1382), d(2758), d(2821), d(2827)].map((t) => ({ t, o: 1, h: 1, l: 1, c: 1, v: 0 }));
assert.deepEqual(splitSessions(sb), [
  { id: '2026-11-02', start: 0, end: 2 },
  { id: '2026-11-02', start: 3, end: 4 },
]);

console.log('all tests passed');
```

- [ ] **Step 2: Run the tests and confirm they fail**

Expected: `Cannot find module` for `data.mjs`.

- [ ] **Step 3: Implement `parseBars`, `loadBars` and `splitSessions` in `scripts/backtest/data.mjs`**

The exact header is `time,open,high,low,close,volume`. Error messages must contain `header`, `increasing` or `price`, and include the line number where one applies. Valid prices are finite, positive, and satisfy `l <= min(o, c)` and `h >= max(o, c)`.

- [ ] **Step 4: Run the tests and confirm they pass**

Expected: `all tests passed`.

- [ ] **Step 5: Commit**

```bash
git add scripts/backtest/data.mjs scripts/backtest/backtest.test.mjs
git commit -m "feat(backtest): load CSV bars and split sessions"
```

---

### Task 2: Indicators and features

**Files:**
- Create: `scripts/backtest/indicators.mjs`
- Modify: `scripts/backtest/backtest.test.mjs`

**Interfaces:**
- Consumes: `Bar` from Task 1.
- Produces:
  - `ema(values: (number|null)[], n) -> (number|null)[]`. Leading nulls are skipped, and the first value is the SMA of the first `n` non-null values.
  - `rsi(closes: number[], n) -> (number|null)[]`, using Wilder's RMA.
  - `atr(bars: Bar[], n) -> (number|null)[]`. The first TR is `h - l`, and RMA is seeded with the SMA of the first `n` TRs.
  - `resample(bars: Bar[], minutes) -> Bar[]`, clock-aligned, with `t` as the bucket start.
  - `buildFeatures(bars: Bar[]) -> Features`, where `Features = {signal: (-1|0|1)[], rsi: (number|null)[], trend5m: (-1|1|null)[], atr15m: (number|null)[]}`, all with the same length as `bars`.

- [ ] **Step 1: Write the failing tests**

Add these above the final `console.log`, and add the import at the top.

```js
import { ema, rsi, atr, resample, buildFeatures } from './indicators.mjs';

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
```

- [ ] **Step 2: Run the tests and confirm they fail**

Expected: `Cannot find module` for `indicators.mjs`.

- [ ] **Step 3: Implement `scripts/backtest/indicators.mjs`**

`buildFeatures` details:
- `fast = ema(ema(close, 38), 10)`, `slow = ema(ema(close, 62), 10)`.
- `signal[i]` is `1` when `fast[i] > slow[i] && fast[i-1] <= slow[i-1]`, `-1` for the mirror case, and `0` otherwise, including while either value is null or `i < 300`.
- A 1m bar at time `t` closes at `t + 60`. A higher-timeframe bucket starting at `T` is visible to it only when `T + minutes*60 <= t + 60`. Map each 1m bar to the latest visible bucket using one forward-moving pointer.
- `trend5m` is `1` when the 5m double EMA has fast > slow, `-1` otherwise, and `null` until it exists.
- `atr15m` is `atr(resample(bars, 15), 100)` read the same way.

- [ ] **Step 4: Run the tests and confirm they pass**

Expected: `all tests passed`.

- [ ] **Step 5: Commit**

```bash
git add scripts/backtest/indicators.mjs scripts/backtest/backtest.test.mjs
git commit -m "feat(backtest): add Pine-style indicators and features"
```

---

### Task 3: Simulator core — market entries, stops, TPs, sessions, failure

**Files:**
- Create: `scripts/backtest/simulate.mjs`
- Modify: `scripts/backtest/backtest.test.mjs`

**Interfaces:**
- Consumes: `Bar`, `Session`, `Features`.
- Produces:
  - `Setup = {id: string, entry: {type:'market'} | {type:'limit', offset:number}, filter:'none'|'rsi'|'trend5m', stop:number|null, exit:{type:'tp', mult} | {type:'trail'} | {type:'opposite'} | {type:'tpAtr', mult}}`
  - `simulate(bars, features, sessions, setup, opts) -> Result`
  - `opts = {spread, slippage = 0.10, startEquity = 24, failEquity = 8, haltOnFail = true}`
  - `Result = {trades: Trade[], net, maxDD, failed: boolean, firstFailIdx: number|null}`
  - `Trade = {dir, entryIdx, exitIdx, entry, exit, pnl, reason}`, where `reason` is one of `'stop'|'tp'|'trail'|'opposite'|'forced'|'session-end'|'fail'`.
  - `entryAllowedAt(t: number) -> boolean`: true when the UTC time of day is ≤ 21:30 or ≥ 22:00.
  - `features.exitSignal` is optional. When present, `{type:'opposite'}` exits read it instead of `features.signal`.

- [ ] **Step 1: Write the failing tests**

```js
import { simulate, entryAllowedAt } from './simulate.mjs';

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

// Zero costs: sum of trade P&L equals net on real-looking data
const acc = simulate(sy, f, splitSessions(sy), SETUP, { spread: 0, slippage: 0 });
near(acc.trades.reduce((s, t) => s + t.pnl, 0), acc.net, 1e-6);
assert.ok(Number.isFinite(acc.maxDD));

// Leakage: changing bars after a cut leaves earlier fills unchanged
const before = simulate(sy, f, splitSessions(sy), SETUP, OPT).trades.filter((t) => t.exitIdx <= cut);
const after = simulate(changed, g, splitSessions(changed), SETUP, OPT).trades.filter((t) => t.exitIdx <= cut);
assert.deepEqual(after, before);
```

- [ ] **Step 2: Run the tests and confirm they fail**

Expected: `Cannot find module` for `simulate.mjs`.

- [ ] **Step 3: Implement `simulate` in `scripts/backtest/simulate.mjs`, handling `market` entries, the `none` filter and `tp` exits**

Process each bar `i` of each given session in this order:
1. **At the open:** apply any pending market entry, unless `entryAllowedAt(bars[i].t)` is false. Long fills at `o + spread`, short at `o`.
2. **Stop, then TP:** long triggers on bid, short on ask (`price + spread`). A stop gapped at the open fills at the open ∓ slippage.
3. **Forced close at this bar's close:** the first bar with UTC time from 21:50 to 21:59 (`'forced'`), or the session's last bar (`'session-end'`). Both pay normal spread.
4. **Equity:** `startEquity + realised + worst price of the open trade on this bar`. On a bar where the trade closed, use `realised` after that close, and also check the adverse extreme reached before a TP or forced close. If equity ≤ `failEquity`, record `firstFailIdx`. When `haltOnFail`, close at that worst price with reason `'fail'` and stop the run. Update peak and `maxDD` from this series.
5. **Signals at the close:** apply `setup.filter` and set the pending order for the next bar. Clear pending orders at each session's end.

- [ ] **Step 4: Run the tests and confirm they pass**

Expected: `all tests passed`.

- [ ] **Step 5: Commit**

```bash
git add scripts/backtest/simulate.mjs scripts/backtest/backtest.test.mjs
git commit -m "feat(backtest): simulate market entries, stops, TPs and failure"
```

---

### Task 4: Simulator — limits, filters, trailing, opposite, ATR TP

**Files:**
- Modify: `scripts/backtest/simulate.mjs`
- Modify: `scripts/backtest/backtest.test.mjs`

**Interfaces:**
- Consumes and produces: the same `simulate` from Task 3, now supporting all `Setup` values.
- Rule for `tpAtr`: stop is `null`, TP distance is `atr15m[signalIdx] * mult`, entries are blocked while that value is null, and a new cross closes and reverses at the next open with reason `'opposite'`.

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run the tests and confirm the new ones fail**

Expected: the first `LIM` assertion fails.

- [ ] **Step 3: Extend `simulate` to pass the tests**

Limit rules:
- A buy limit sits at `signalClose - offset` and fills when `l + spread <= limit`, at `min(limit, o + spread)`.
- A sell limit sits at `signalClose + offset` and fills when `h >= limit`, at `max(limit, o)`.
- A limit is live on the 5 bars after the signal.

Filter rules:
- `rsi` blocks buys when RSI > 70 and sells when RSI < 30. A null RSI blocks.
- `trend5m` requires `trend5m[i] === dir`.

Trail updates happen at the end of each bar, and a stop hit on a `trail` setup has reason `'trail'`. Opposite exits run at step 1 of the bar, before the reverse entry.

- [ ] **Step 4: Run the tests and confirm they pass**

Expected: `all tests passed`.

- [ ] **Step 5: Commit**

```bash
git add scripts/backtest/simulate.mjs scripts/backtest/backtest.test.mjs
git commit -m "feat(backtest): add limit entries, filters and remaining exits"
```

---

### Task 5: Grid, fold selection and verdict

**Files:**
- Create: `scripts/backtest/grid.mjs`
- Create: `scripts/backtest/cv.mjs`
- Modify: `scripts/backtest/backtest.test.mjs`

**Interfaces:**
- Consumes: `simulate`, `Setup`, `Result`.
- Produces:
  - `buildGrid() -> Setup[]`, 180 setups in the spec's order. Ids look like `market|none|stop3|tp1`.
  - `selectSetup(rows: {setup, result}[], minTrades = 10) -> {setup, result} | null`
  - `runFold(bars, features, sessions, testIdx, opts) -> Fold`, where `Fold = {testSession, chosen: {setup, train: Result}|null, test: Result|null}`. `opts = {spread, grid?}`.
  - `runCv(bars, features, sessions, opts) -> Cv`, where `Cv = {spread, folds: Fold[], combinedNet, profitableFolds, failedFolds}`.
  - `selectFinal(bars, features, sessions, opts) -> {setup, result} | null`
  - `verdict({base: Cv, stress: Cv, randomPctBelow: number}) -> {label: 'demo candidate'|'no demonstrated edge', checks: {name, passed, detail}[]}`

- [ ] **Step 1: Write the failing tests**

```js
import { buildGrid, selectSetup } from './grid.mjs';
import { runFold, runCv, selectFinal, verdict } from './cv.mjs';

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
```

- [ ] **Step 2: Run the tests and confirm they fail**

Expected: `Cannot find module` for `grid.mjs`.

- [ ] **Step 3: Implement `grid.mjs` and `cv.mjs`**

- Grid loop order: entry, filter, stop, exit, using the spec's values. Limit offsets are 1 and 2. TP multipliers are 1, 1.5 and 2.
- Rank by `net / max(maxDD, 1)`, then more trades, then input order.
- `runFold` simulates each setup on the sessions other than `testIdx`, then scores the chosen setup on `[sessions[testIdx]]` alone.
- `combinedNet` sums `test.net`, with no-trade folds as 0.
- Verdict check 3 passes when `randomPctBelow >= 95`, and check 4 when `stress.combinedNet > 0`.

- [ ] **Step 4: Run the tests and confirm they pass**

Expected: `all tests passed`, in under a minute.

- [ ] **Step 5: Commit**

```bash
git add scripts/backtest/grid.mjs scripts/backtest/cv.mjs scripts/backtest/backtest.test.mjs
git commit -m "feat(backtest): add setup grid, fold selection and verdict"
```

---

### Task 6: Random entries, indicator default and excursion study

**Files:**
- Create: `scripts/backtest/references.mjs`
- Create: `scripts/backtest/excursion.mjs`
- Modify: `scripts/backtest/backtest.test.mjs`

**Interfaces:**
- Consumes: `simulate`, `entryAllowedAt`, `Cv`.
- Produces:
  - `makeRng(seed: number) -> () => number`, mulberry32, returning values in [0, 1).
  - `randomRun(bars, features, session: Session, setup: Setup, k: number, rng, opts = {spread: 0.16}) -> Result`
  - `randomComparison(bars, features, sessions, cv: Cv, {runs = 1000, seed = 20261106}) -> {runs, seed, pctBelow, p5, p50, p95}`, which uses `cv.spread` for its runs
  - `indicatorDefault(bars, features, sessions, {spread}) -> Result`
  - `excursionStudy(bars, features, sessions, {spread}) -> {count, adverse: Stats, favourable: Stats, adverseReach: {level, share}[]}`, where `Stats = {median, p75, p90, max}`, or all null when `count` is 0, and levels are 3, 5, 8, 12 and 16.

- [ ] **Step 1: Write the failing tests**

```js
import { makeRng, randomRun, randomComparison, indicatorDefault } from './references.mjs';
import { excursionStudy } from './excursion.mjs';

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
```

- [ ] **Step 2: Run the tests and confirm they fail**

Expected: `Cannot find module` for `references.mjs`.

- [ ] **Step 3: Implement both modules**

`randomComparison` calls `randomRun` for each run and each fold with `test.trades.length = k > 0`. `randomRun` works like this:
1. Eligible signal bars are in the test session, have `i >= 300` and `i < session.end`, and have `entryAllowedAt(bars[i+1].t)` true.
2. Add one random bar with a random direction to a synthetic `signal` array.
3. Simulate with `{entry: market, filter: 'none'}`, the chosen `stop` and `exit`, and `exitSignal` set to the real `features.signal`.
4. Repeat from step 2 until the run makes `k` trades or no eligible bars are left. Unused picks do no harm, since adding a pick adds at most one trade.

A comparison run's value is the sum of its fold nets. `pctBelow` is the share of runs strictly below `cv.combinedNet`, times 100.

`indicatorDefault` uses the `DEF` setup from Task 4, with `haltOnFail: false`.

`excursionStudy` enters each signal at the next bar's open within its session. It measures up to and including the bar of the next opposite signal, or the forced-close bar. It uses ask for buys and bid for sells at entry, and the opposite side during the trade.

- [ ] **Step 4: Run the tests and confirm they pass**

Expected: `all tests passed`.

- [ ] **Step 5: Commit**

```bash
git add scripts/backtest/references.mjs scripts/backtest/excursion.mjs scripts/backtest/backtest.test.mjs
git commit -m "feat(backtest): add random entries, indicator default and excursion study"
```

---

### Task 7: Report, CLI, real run and docs

**Files:**
- Create: `scripts/backtest/report.mjs`
- Create: `scripts/backtest.mjs`
- Create: `reports/moonrush-backtest.md`, `reports/moonrush-backtest.json` (generated)
- Modify: `scripts/backtest/backtest.test.mjs`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `renderReport(results) -> string`
  - `run(csvPath?: string) -> {results, mdPath, jsonPath}`, exported from `scripts/backtest.mjs`. It runs as a CLI only when invoked directly.
  - `results = {meta: {csv, bars, sessions, seed, gridSize}, excursion, cv: {'0.16': Cv, '0.32': Cv, '0.48': Cv}, random, indicatorDefault, final, verdict}`

- [ ] **Step 1: Write the failing tests**

```js
import { renderReport } from './report.mjs';
import { run } from '../backtest.mjs';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
assert.doesNotMatch(md, /NaN|Infinity|undefined/);                 // Review Focus 2
assert.match(md, /no trade/i);
for (const s of [/in-sample|screen/i, /training session follows/i, /demo/i]) assert.match(md, s);

const goodMd = renderReport({ ...noEdge, verdict: { label: 'demo candidate', checks: [] } });
assert.match(goodMd, /looks-good/);
assert.match(goodMd, /in-sample/i);

// Full run on the real file, if present, from another directory (Review Focus 4)
const repoCsv = fileURLToPath(new URL('../../data/XAUUSD_EIGHTCAP_1m.csv', import.meta.url));
if (existsSync(repoCsv)) {
  process.chdir(process.env.TEMP ?? '/');
  const out = run();
  assert.equal(out.results.meta.bars, 5273);
  assert.equal(out.results.meta.sessions, 4);
  assert.equal(out.results.meta.gridSize, 180);
  assert.ok(Math.abs(out.results.excursion.count - 58) <= 5, `signals ${out.results.excursion.count}`);
  assert.ok(existsSync(out.mdPath) && existsSync(out.jsonPath));
  assert.deepEqual(run().results, out.results);                    // same seed, same output
}
```

- [ ] **Step 2: Run the tests and confirm they fail**

Expected: `Cannot find module` for `report.mjs`.

- [ ] **Step 3: Implement `renderReport` in `scripts/backtest/report.mjs`**

Sections, in order:
1. Verdict and its checks.
2. Limits: four sessions in one rising market; a screen, not proof; some folds train on later days; a training session following a test session carries indicator influence; any candidate goes to demo first.
3. Assumptions: spread, commission, lot value, bid prices.
4. Per-fold table at $0.16: chosen setup, net, drawdown, trades, win rate, failed, showing "no trade" where applicable. Win rate is 0 for no trades, never `NaN`.
5. Combined result and fold agreement (distinct chosen setups).
6. Spread reruns.
7. Random comparison.
8. Indicator default, stating whether it hit the failure level.
9. Excursion study, labelled diagnostic only.
10. Final setup. Name it, labelled in-sample, only for `demo candidate`. Otherwise write exactly "No setup is recommended."

- [ ] **Step 4: Implement `run` and the CLI in `scripts/backtest.mjs`**

- Resolve the default CSV and the `reports/` folder from `import.meta.url`. Create `reports/` if missing. An explicit CSV path resolves against the current directory.
- Run: `excursionStudy` at $0.16; `runCv` at all three spreads, with `verdict` using 0.16 as base and 0.32 as stress; `randomComparison` on the base; `indicatorDefault` at 0.16; and `selectFinal` at 0.16.
- Throw if there are fewer than 4 sessions. As a CLI, catch errors, print `error: <message>` and exit 1. On success, print the verdict and both report paths.
- Keep the output free of timestamps, so repeated runs are identical. Use the CSV's path relative to the repo root in `meta.csv`.

- [ ] **Step 5: Run the tests and confirm they pass**

Expected: `all tests passed`, with the two report files written. If this takes more than 2 minutes, stop and report it.

- [ ] **Step 6: Check the CLI's error handling**

Run: `node scripts/backtest.mjs data/does-not-exist.csv; echo "exit=$?"` in Bash.
Expected: a line beginning `error:` and `exit=1`.

- [ ] **Step 7: Run the real backtest and read the report**

Run: `node scripts/backtest.mjs`
Expected: it prints a verdict. Read `reports/moonrush-backtest.md` from top to bottom. Check that the excursion count, per-fold trades and random-run figures are plausible. Report any mismatch instead of tuning the grid or rules.

- [ ] **Step 8: Update the Layout section of `CLAUDE.md`**

Add one bullet for `scripts/backtest.mjs` + `scripts/backtest/`: an offline backtester with no CDP dependency, run with `node scripts/backtest.mjs [csv]`, tested with `node scripts/backtest/backtest.test.mjs`. Add one bullet for `reports/`: generated backtest results.

- [ ] **Step 9: Commit**

```bash
git add scripts/backtest.mjs scripts/backtest/report.mjs scripts/backtest/backtest.test.mjs reports/moonrush-backtest.md reports/moonrush-backtest.json CLAUDE.md
git commit -m "feat(backtest): add report, CLI and first results"
```
