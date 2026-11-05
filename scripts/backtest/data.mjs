import { readFileSync } from 'node:fs';

const HEADER = 'time,open,high,low,close,volume';

export function parseBars(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== HEADER) {
    throw new Error(`bad header on line 1: expected "${HEADER}"`);
  }
  const bars = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const n = i + 1;
    const f = lines[i].split(',').map(Number);
    if (f.length !== 6) throw new Error(`bad price row on line ${n}: expected 6 fields`);
    const [t, o, h, l, c, v] = f;
    const prices = [o, h, l, c];
    if (!Number.isFinite(t)) throw new Error(`bad time on line ${n}`);
    if (!Number.isFinite(v)) throw new Error(`bad price row on line ${n}: volume`);
    if (!prices.every((p) => Number.isFinite(p) && p > 0)
      || l > Math.min(o, c) || h < Math.max(o, c)) {
      throw new Error(`bad price on line ${n}`);
    }
    if (bars.length && t <= bars[bars.length - 1].t) {
      throw new Error(`time not strictly increasing on line ${n}`);
    }
    bars.push({ t, o, h, l, c, v });
  }
  return bars;
}

export function loadBars(path) {
  return parseBars(readFileSync(path, 'utf8'));
}

const utcDate = (t) => new Date(t * 1000).toISOString().slice(0, 10);

export function splitSessions(bars, gapSec = 1800) {
  const sessions = [];
  let start = 0;
  for (let i = 1; i <= bars.length; i++) {
    if (i === bars.length || bars[i].t - bars[i - 1].t >= gapSec) {
      sessions.push({ id: utcDate(bars[i - 1].t), start, end: i - 1 });
      start = i;
    }
  }
  return sessions;
}
