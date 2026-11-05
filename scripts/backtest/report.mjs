// Markdown report from a results object. Pure: no clock, no file access.

const SPREADS = ['0.16', '0.32', '0.48'];

const n2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : 'n/a');
const money = (x) => (Number.isFinite(x) ? `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}` : 'n/a');
const pct = (x) => (Number.isFinite(x) ? `${x.toFixed(1)}%` : 'n/a');
const table = (head, rows) => [
  `| ${head.join(' | ')} |`,
  `| ${head.map(() => '---').join(' | ')} |`,
  ...rows.map((r) => `| ${r.join(' | ')} |`),
].join('\n');

function foldRow(fold) {
  const day = fold.testSession.id;
  if (!fold.test) return [day, 'no trade', '$0.00', '$0.00', '0', '0.0%', 'no'];
  const trades = fold.test.trades;
  const wins = trades.filter((t) => t.pnl > 0).length;
  const winRate = trades.length ? (wins / trades.length) * 100 : 0;
  return [day, `\`${fold.chosen.setup.id.replaceAll('|', '\\|')}\``, money(fold.test.net), money(fold.test.maxDD),
    String(trades.length), pct(winRate), fold.test.failed ? 'yes' : 'no'];
}

export function renderReport(r) {
  const base = r.cv['0.16'];
  const out = [];
  const isCandidate = r.verdict.label === 'demo candidate';

  out.push('# MoonRush V2 backtest', '');
  out.push(`Data: \`${r.meta.csv}\`, ${r.meta.bars} one-minute bars in ${r.meta.sessions} sessions. `
    + `Grid: ${r.meta.gridSize} setups. Random seed: ${r.meta.seed}.`, '');

  out.push('## Verdict', '', `**${r.verdict.label}**`, '');
  out.push(...r.verdict.checks.map((c) => `- ${c.passed ? 'PASS' : 'FAIL'}: ${c.name} (${c.detail})`), '');

  out.push('## Limits', '');
  out.push('- Four sessions in one rising market, with few signals. This is a screen, not proof.');
  out.push('- Leave-one-day-out means some folds train on days after the test day.');
  out.push('- Indicators run over the whole file, so when a training session follows a test session, '
    + 'test-day prices still influence its indicators for some hours.');
  out.push('- The random baseline uses market entries whatever entry the chosen setup uses.');
  const testTrades = base.folds.reduce((sum, f) => sum + (f.test ? f.test.trades.length : 0), 0);
  out.push(`- With about ${testTrades} test trades, this test had little power to detect a real edge. `
    + "'No demonstrated edge' means unproven: it does not mean the method is proven bad, and it does not mean it is safe.");
  out.push('- Any candidate goes to a demo account first.', '');

  out.push('## Assumptions', '');
  out.push('- Spread $0.16 (reruns at $0.32 and $0.48); stops slip a further $0.10; no commission.');
  out.push('- 0.01 lot: $1 profit or loss per $1 of price move; account $24, failed at $8 equity.');
  out.push('- CSV prices are bid; ask is bid plus spread.', '');

  out.push('## Test days at the $0.16 spread', '');
  out.push(table(['Test day', 'Chosen setup', 'Net', 'Max drawdown', 'Trades', 'Win rate', 'Failed'],
    base.folds.map(foldRow)), '');
  out.push('Max drawdown is the largest fall from the equity high within that run, including within a trade. '
    + 'It can exceed the $24 start if equity first rose.', '');

  const ids = [...new Set(base.folds.filter((f) => f.chosen).map((f) => f.chosen.setup.id))];
  out.push('## Combined result and fold agreement', '');
  out.push(`- Combined test-day net: ${money(base.combinedNet)}`);
  const stressNet = r.cv['0.32'].combinedNet;
  if (base.combinedNet > 0 && stressNet <= 0) {
    out.push(`- This positive figure is not evidence of an edge: it disappears at double the spread ($0.32 gives ${money(stressNet)}).`);
  }
  out.push(`- Profitable test days: ${base.profitableFolds} of ${base.folds.length}; failed test days: ${base.failedFolds}`);
  out.push(`- Distinct chosen setups: ${ids.length}${ids.length ? ` (${ids.map((i) => `\`${i}\``).join(', ')})` : ''}`, '');

  out.push('## Spread reruns', '');
  out.push(table(['Spread', 'Combined net', 'Profitable days', 'Failed days'],
    SPREADS.map((s) => [`$${s}`, money(r.cv[s].combinedNet), String(r.cv[s].profitableFolds), String(r.cv[s].failedFolds)])), '');
  out.push('The $0.48 run is reported but is not part of the verdict.', '');

  out.push('## Random comparison', '');
  out.push(`${r.random.runs} runs, seed ${r.random.seed}, same trade counts and exits as the chosen setups. `
    + `The strategy's combined net beat ${pct(r.random.pctBelow)} of them. `
    + `Random combined net: 5th percentile ${money(r.random.p5)}, median ${money(r.random.p50)}, 95th percentile ${money(r.random.p95)}.`, '');

  const d = r.indicatorDefault;
  out.push('## Indicator default', '');
  out.push('Enter on each cross, take profit at ATR(100) x 0.5 on 15m bars, no stop, reverse on a new cross. '
    + 'Comparison only; it keeps trading past the failure level.', '');
  out.push(`Net ${money(d.net)}, max drawdown ${money(d.maxDD)}, ${d.trades.length} trades. `
    + `${d.failed ? 'It hit the $8 failure level.' : 'It did not hit the $8 failure level.'}`, '');

  const e = r.excursion;
  out.push('## Excursion study (diagnostic only)', '');
  out.push(`${e.count} signals, entered at the next bar's open, measured to the next opposite signal or forced close. `
    + 'It covers all sessions and never feeds selection.', '');
  out.push(table(['Move', 'Median', '75th', '90th', 'Max'], [
    ['Adverse', ...['median', 'p75', 'p90', 'max'].map((k) => n2(e.adverse[k]))],
    ['Favourable', ...['median', 'p75', 'p90', 'max'].map((k) => n2(e.favourable[k]))],
  ]), '');
  if (e.adverseReach.length) {
    out.push(table(['Adverse move reaches', 'Share of signals'], e.adverseReach.map((a) => [`$${a.level}`, pct(a.share * 100)])), '');
  }

  out.push('## Final setup', '');
  if (isCandidate && r.final) {
    out.push(`\`${r.final.setup.id}\` is the setup for demo testing only. It is in-sample: selected on all four sessions, `
      + `so its own result (net ${money(r.final.result.net)}, max drawdown ${money(r.final.result.maxDD)}) is not evidence.`);
  } else {
    out.push('No setup is recommended.');
  }
  out.push('');
  return out.join('\n');
}
