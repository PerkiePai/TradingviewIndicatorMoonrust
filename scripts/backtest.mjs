// CLI: node scripts/backtest.mjs [csv]. Runs every comparison and writes reports/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { relative, resolve } from 'node:path';
import { loadBars, splitSessions } from './backtest/data.mjs';
import { buildFeatures } from './backtest/indicators.mjs';
import { buildGrid } from './backtest/grid.mjs';
import { runCv, selectFinal, verdict } from './backtest/cv.mjs';
import { randomComparison, indicatorDefault } from './backtest/references.mjs';
import { excursionStudy } from './backtest/excursion.mjs';
import { renderReport } from './backtest/report.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SEED = 20261106;
const SPREADS = ['0.16', '0.32', '0.48'];

// Per-run training trades make the JSON unreadable; per-fold test trades stay.
const slim = (cv) => ({
  ...cv,
  folds: cv.folds.map((f) => {
    if (!f.chosen) return f;
    const { trades, ...train } = f.chosen.train;
    return { ...f, chosen: { setup: f.chosen.setup, train } };
  }),
});

function assertClean(v, path = 'results') {
  if (v === undefined) throw new Error(`${path} is undefined`);
  if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`${path} is not finite`);
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) assertClean(x, `${path}.${k}`);
}

export function run(csvPath) {
  const csv = csvPath ? resolve(csvPath) : resolve(ROOT, 'data/XAUUSD_EIGHTCAP_1m.csv');
  const bars = loadBars(csv);
  const sessions = splitSessions(bars);
  if (sessions.length < 4) throw new Error(`need at least 4 sessions, found ${sessions.length}`);
  const features = buildFeatures(bars);

  const cvs = {};
  for (const s of SPREADS) cvs[s] = runCv(bars, features, sessions, { spread: Number(s) });
  const base = cvs['0.16'];
  const random = randomComparison(bars, features, sessions, base, { seed: SEED });
  const final = selectFinal(bars, features, sessions, { spread: 0.16 });

  const results = {
    meta: { csv: relative(ROOT, csv).replaceAll('\\', '/'), bars: bars.length, sessions: sessions.length, seed: SEED, gridSize: buildGrid().length },
    excursion: excursionStudy(bars, features, sessions, { spread: 0.16 }),
    cv: Object.fromEntries(SPREADS.map((s) => [s, slim(cvs[s])])),
    random,
    indicatorDefault: indicatorDefault(bars, features, sessions, { spread: 0.16 }),
    final: final ? { setup: final.setup, result: final.result } : null,
    verdict: verdict({ base, stress: cvs['0.32'], randomPctBelow: random.pctBelow }),
  };
  assertClean(results);

  const dir = resolve(ROOT, 'reports');
  mkdirSync(dir, { recursive: true });
  const mdPath = resolve(dir, 'moonrush-backtest.md');
  const jsonPath = resolve(dir, 'moonrush-backtest.json');
  writeFileSync(mdPath, renderReport(results));
  writeFileSync(jsonPath, `${JSON.stringify(results, null, 2)}\n`);
  return { results, mdPath, jsonPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { results, mdPath, jsonPath } = run(process.argv[2]);
    console.log(`verdict: ${results.verdict.label}`);
    console.log(mdPath);
    console.log(jsonPath);
  } catch (err) {
    console.log(`error: ${err.message}`);
    process.exit(1);
  }
}
