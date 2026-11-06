import assert from 'node:assert/strict';
import { extractSignalRows, computeSignature, extractDirection, isNewSignal, stateKey, parseSignal, parseMtf, buildEmbed, resolutionLabel, formatLocalDateTime } from './watch-moonrush.mjs';

const STUDIES = [{
  name: 'MoonRush V2',
  tables: [{
    rows: [
      'XAUUSD | 1m | Long Entry | Buy @ 2340.50',
      'SL: 2335.20',
      'TP1: 2345.80 | TP2: 2348.40 | TP3: 2352.00',
      'Orders | 42',
      'Win | 28',
      'Loss | 14',
      'Winrate | 66.67%',
      'DD | 1.2% / 3.4% / 0.8%',
      '🎯TP1 Hits: 23',
      '🎯TP2 Hits: 14',
      '🎯TP3 Hits: 0',
    ]
  }]
}];

const signal = extractSignalRows(STUDIES);

assert.ok(signal.some(r => /entry|buy/i.test(r)),  'entry row kept');
assert.ok(signal.some(r => /\bsl\b/i.test(r)),     'SL row kept');
assert.ok(signal.some(r => /tp/i.test(r)),          'TP row kept');
assert.ok(!signal.some(r => /orders/i.test(r)),     'Orders row dropped');
assert.ok(!signal.some(r => /\bwin\b/i.test(r)),    'Win row dropped');
assert.ok(!signal.some(r => /\bloss\b/i.test(r)),   'Loss row dropped');
assert.ok(!signal.some(r => /winrate/i.test(r)),    'Winrate row dropped');
assert.ok(!signal.some(r => /\bdd\b/i.test(r)),     'DD row dropped');
assert.ok(!signal.some(r => /hits/i.test(r)),        'TP Hits row dropped');

const sig = computeSignature(signal);
assert.equal(sig, computeSignature(signal), 'signature is deterministic');

assert.equal(extractDirection(signal), 'BULL', 'buy row → BULL');
assert.equal(extractDirection([]), null, 'empty rows → null');

assert.ok(isNewSignal(signal, 'BEAR'),  'direction change fires');
assert.ok(!isNewSignal(signal, 'BULL'), 'same direction does not fire');
assert.ok(!isNewSignal([], 'BULL'),     'empty rows never fires');

// Critical: stats change must NOT alter the signature
const STUDIES_STATS_CHANGED = [{
  name: 'MoonRush V2',
  tables: [{
    rows: [
      'XAUUSD | 1m | Long Entry | Buy @ 2340.50',
      'SL: 2335.20',
      'TP1: 2345.80 | TP2: 2348.40 | TP3: 2352.00',
      'Orders | 43',
      'Win | 29',
      'Loss | 14',
      'Winrate | 67.44%',
      'DD | 1.3% / 3.4% / 0.9%',
      '🎯TP1 Hits: 24',
      '🎯TP2 Hits: 14',
      '🎯TP3 Hits: 0',
    ]
  }]
}];
const sigAfterStats = computeSignature(extractSignalRows(STUDIES_STATS_CHANGED));
assert.equal(sigAfterStats, sig, 'stats-only change leaves signature unchanged');

assert.notEqual(stateKey({symbol:'XAUUSD',resolution:'1'}), stateKey({symbol:'XAUUSD',resolution:'15'}), 'timeframe changes state key');
assert.notEqual(stateKey({symbol:'A',resolution:'1'}), stateKey({symbol:'B',resolution:'1'}), 'symbol changes state key');
assert.equal(stateKey(null), 'unknown');

// --- parseSignal / buildEmbed ---
const LIVE = ['🎯Entry: 4056.66 (BUY)', '🛑SL: 4053.23', '💵TP1: 4060.09', '💵TP2: 4063.52', '💵TP3: 4066.95'];
const p = parseSignal(LIVE);
assert.equal(p.direction, 'BULL');
assert.equal(p.entry, 4056.66);
assert.equal(p.sl, 4053.23);
assert.deepEqual(p.tps, [4060.09, 4063.52, 4066.95], 'live-format TPs');

const old = parseSignal(signal);
assert.equal(old.entry, 2340.5, 'fixture "Buy @" entry');
assert.deepEqual(old.tps, [2345.8, 2348.4, 2352], 'fixture TPs on one row');

assert.equal(parseSignal(['🎯Entry: 4056.66 (BUY)']).sl, null, 'missing SL → null');

const mtf = parseMtf([{ tables: [{ rows: ['TF | Trend | RSI', 'Chart | Bullish | 52.56', '5m | Bullish | 68.48', '15m | Bearish | 65.09'] }] }]);
assert.equal(mtf.chartRsi, 52.56);
assert.deepEqual(mtf.trends, [{ tf: '5m', bull: true }, { tf: '15m', bull: false }]);

const chart = { symbol: 'OANDA:XAUUSD', resolution: '5', barTime: 1762400000 };
const NOW = new Date(2026, 10, 6, 16, 31, 5); // local time
assert.equal(formatLocalDateTime(NOW), '06 Nov 16:31:05');
const e = buildEmbed({ signal: p, chart, mtf, rows: LIVE, label: 'X', image: true, now: NOW });
assert.equal(e.title, '🟢 BUY XAUUSD · 5m · 06 Nov 16:31:05');
assert.equal(e.color, 0x2ecc71);
assert.equal(e.image.url, 'attachment://chart.png');
assert.ok(e.fields.find(f => f.name === 'TP1').value.includes('(+3.43)'), 'TP delta from entry');
assert.ok(e.fields.find(f => f.name === 'SL').value.includes('(-3.43)'), 'SL delta is negative for long');
assert.equal(e.timestamp, new Date(1762400000 * 1000).toISOString(), 'timestamp = bar time');

const sell = buildEmbed({ signal: parseSignal(['Entry: 100 (SELL)', 'SL: 102', 'TP1: 98']), chart, mtf: null, rows: [], label: 'X', now: NOW });
assert.equal(sell.title, '🔴 SELL XAUUSD · 5m · 06 Nov 16:31:05');
assert.ok(sell.fields.find(f => f.name === 'TP1').value.includes('(+2.00)'), 'short TP delta positive');
assert.ok(!sell.image, 'no image when none attached');

const raw = buildEmbed({ signal: parseSignal(['Sell something']), chart, mtf: null, rows: ['Sell something'], label: 'X' });
assert.ok(raw.description.includes('Sell something'), 'unparseable → raw rows fallback');

assert.equal(resolutionLabel('60'), '1h');
assert.equal(resolutionLabel('15'), '15m');
assert.equal(resolutionLabel('D'), 'D');

console.log('All tests passed.');
