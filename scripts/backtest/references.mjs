// Reference runs the strategy is compared against: random entries and the indicator's own default.
import { simulate, entryAllowedAt } from './simulate.mjs';

// The indicator's own behaviour: enter on each cross, TP at ATR(100)*0.5 on 15m bars, no stop.
export const DEFAULT_SETUP = { id: 'default', entry: { type: 'market' }, filter: 'none', stop: null, exit: { type: 'tpAtr', mult: 0.5 } };

const WARMUP = 300;

// mulberry32: small seeded generator, values in [0, 1).
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Market entries on random eligible bars in random directions, using the setup's stop and exit.
// Picks accumulate until the run makes k trades or the session has no bars left to pick; a pick
// that lands in an open position makes no trade, and one pick adds at most one trade.
export function randomRun(bars, features, session, setup, k, rng, opts = { spread: 0.16 }) {
  const pool = [];
  for (let i = Math.max(session.start, WARMUP); i < session.end; i++) {
    if (entryAllowedAt(bars[i + 1].t)) pool.push(i);
  }
  const signal = new Int8Array(bars.length);
  const randomSetup = { ...setup, entry: { type: 'market' }, filter: 'none' };
  const sim = { ...opts, haltOnFail: true };
  const feats = { ...features, signal, exitSignal: features.signal };
  let result = simulate(bars, feats, [session], randomSetup, sim);
  while (result.trades.length < k && pool.length > 0) {
    const j = Math.floor(rng() * pool.length);
    const i = pool[j];
    pool[j] = pool[pool.length - 1];
    pool.pop();
    signal[i] = rng() < 0.5 ? 1 : -1;
    result = simulate(bars, feats, [session], randomSetup, sim);
  }
  return result;
}

const quantile = (sorted, p) => sorted[Math.floor(p * (sorted.length - 1))];

export function randomComparison(bars, features, sessions, cv, { runs = 1000, seed = 20261106 } = {}) {
  const rng = makeRng(seed);
  const nets = [];
  for (let r = 0; r < runs; r++) {
    let total = 0;
    for (const fold of cv.folds) {
      const k = fold.test ? fold.test.trades.length : 0;
      if (k > 0) total += randomRun(bars, features, fold.testSession, fold.chosen.setup, k, rng, { spread: cv.spread }).net;
    }
    nets.push(total);
  }
  const below = nets.filter((x) => x < cv.combinedNet).length;
  nets.sort((a, b) => a - b);
  return {
    runs, seed,
    pctBelow: (below / runs) * 100,
    p5: quantile(nets, 0.05), p50: quantile(nets, 0.5), p95: quantile(nets, 0.95),
  };
}

// Comparison only, never selected: it keeps trading past the $8 failure level.
export function indicatorDefault(bars, features, sessions, { spread }) {
  return simulate(bars, features, sessions, DEFAULT_SETUP, { spread, haltOnFail: false });
}
