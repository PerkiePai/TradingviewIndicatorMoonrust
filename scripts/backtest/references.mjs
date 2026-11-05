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
// Phase 1 picks bars ignoring the failure rule: a candidate is accepted only if simulating all
// accepted picks plus it gives exactly one trade per pick, each entering on its pick's next bar;
// otherwise it is redrawn (a pick inside an open position, or one that shifts an earlier pick).
// Phase 2 simulates the accepted picks once with the caller's opts, so a run that fails stops
// at its failure with fewer trades and nothing is retried.
export function randomRun(bars, features, session, setup, k, rng, opts = { spread: 0.16 }) {
  const pool = [];
  for (let i = Math.max(session.start, WARMUP); i < session.end; i++) {
    if (entryAllowedAt(bars[i + 1].t)) pool.push(i);
  }
  const signal = new Int8Array(bars.length);
  const randomSetup = { ...setup, entry: { type: 'market' }, filter: 'none' };
  const feats = { ...features, signal, exitSignal: features.signal };
  const picking = { ...opts, haltOnFail: false };
  const picks = []; // accepted bar indexes
  while (picks.length < k && pool.length > 0) {
    const j = Math.floor(rng() * pool.length);
    const i = pool[j];
    pool[j] = pool[pool.length - 1];
    pool.pop();
    signal[i] = rng() < 0.5 ? 1 : -1;
    const { trades } = simulate(bars, feats, [session], randomSetup, picking);
    const want = [...picks, i].sort((x, y) => x - y);
    if (trades.length === want.length && trades.every((t, m) => t.entryIdx === want[m] + 1)) picks.push(i);
    else signal[i] = 0;
  }
  return simulate(bars, feats, [session], randomSetup, opts);
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
