import assert from 'node:assert/strict';
import { extractSignalRows, computeSignature, isNewSignal } from './watch-moonrush.mjs';

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

assert.ok(isNewSignal(signal, 'old-hash'),  'new signal when sig differs');
assert.ok(!isNewSignal(signal, sig),        'no new signal when sig matches');
assert.ok(!isNewSignal([], 'any-hash'),     'empty rows never fires');

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

console.log('All tests passed.');
