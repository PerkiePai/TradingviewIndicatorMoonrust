// Leave-one-session-out selection and the demo-candidate verdict.
import { simulate } from './simulate.mjs';
import { buildGrid, selectSetup } from './grid.mjs';

const choose = (bars, features, sessions, opts) => {
  const grid = opts.grid ?? buildGrid();
  const rows = grid.map((setup) => ({ setup, result: simulate(bars, features, sessions, setup, opts) }));
  return selectSetup(rows);
};

export function runFold(bars, features, sessions, testIdx, opts) {
  const train = sessions.filter((_, i) => i !== testIdx);
  const testSession = sessions[testIdx];
  const pick = choose(bars, features, train, opts);
  if (!pick) return { testSession, chosen: null, test: null };
  return {
    testSession,
    chosen: { setup: pick.setup, train: pick.result },
    test: simulate(bars, features, [testSession], pick.setup, opts),
  };
}

export function runCv(bars, features, sessions, opts) {
  const folds = sessions.map((_, i) => runFold(bars, features, sessions, i, opts));
  return {
    spread: opts.spread,
    folds,
    combinedNet: folds.reduce((sum, x) => sum + (x.test ? x.test.net : 0), 0),
    profitableFolds: folds.filter((x) => x.test && x.test.net > 0).length,
    failedFolds: folds.filter((x) => x.test && x.test.failed).length,
  };
}

// In-sample selection over every session; the caller labels it as such.
export function selectFinal(bars, features, sessions, opts) {
  return choose(bars, features, sessions, opts);
}

const usd = (x) => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;

export function verdict({ base, stress, randomPctBelow }) {
  const checks = [
    { name: 'Profit on at least 3 test days', passed: base.profitableFolds >= 3, detail: `${base.profitableFolds} of ${base.folds.length} profitable` },
    { name: 'No failed test day', passed: base.failedFolds === 0, detail: `${base.failedFolds} failed` },
    { name: 'Beats 95% of random runs', passed: randomPctBelow >= 95, detail: `${randomPctBelow}% of random runs below` },
    { name: 'Positive at the $0.32 spread', passed: stress.combinedNet > 0, detail: `combined net ${usd(stress.combinedNet)}` },
  ];
  return { label: checks.every((c) => c.passed) ? 'demo candidate' : 'no demonstrated edge', checks };
}
