// The fixed 180-setup search grid and the training-set ranking rule.

const ENTRIES = [
  { id: 'market', type: 'market' },
  { id: 'limit1', type: 'limit', offset: 1 },
  { id: 'limit2', type: 'limit', offset: 2 },
];
const FILTERS = ['none', 'rsi', 'trend5m'];
const STOPS = [3, 5, 8, 12];
const EXITS = [
  ...[1, 1.5, 2].map((mult) => ({ id: `tp${mult}`, type: 'tp', mult })),
  { id: 'trail', type: 'trail' },
  { id: 'opposite', type: 'opposite' },
];

// Loop order is entry, filter, stop, exit. This order is the final tie-break.
export function buildGrid() {
  const grid = [];
  for (const { id: eid, ...entry } of ENTRIES) {
    for (const filter of FILTERS) {
      for (const stop of STOPS) {
        for (const { id: xid, ...exit } of EXITS) {
          grid.push({ id: `${eid}|${filter}|stop${stop}|${xid}`, entry, filter, stop, exit });
        }
      }
    }
  }
  return grid;
}

// rows: {setup, result}[] in grid order. Returns the best passing row, or null.
export function selectSetup(rows, minTrades = 10) {
  let best = null;
  let bestScore = -Infinity;
  for (const row of rows) {
    const { net, maxDD, failed, trades } = row.result;
    if (failed || net <= 0 || trades.length < minTrades) continue;
    const score = net / Math.max(maxDD, 1);
    if (best === null || score > bestScore
      || (score === bestScore && trades.length > best.result.trades.length)) {
      best = row;
      bestScore = score;
    }
  }
  return best;
}
