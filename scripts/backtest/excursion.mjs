// Diagnostic only: how far each signal's trade moves against and in favour before the next
// opposite signal or forced close. Covers all sessions, so it must never feed selection.
import { entryAllowedAt } from './simulate.mjs';

const LEVELS = [3, 5, 8, 12, 16];
const FORCE_FROM = 21 * 3600 + 50 * 60;
const FORCE_TO = 22 * 3600;

const inForceWindow = (t) => {
  const tod = ((t % 86400) + 86400) % 86400;
  return tod >= FORCE_FROM && tod < FORCE_TO;
};

const quantile = (sorted, p) => {
  const x = p * (sorted.length - 1);
  const lo = Math.floor(x);
  const hi = Math.ceil(x);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (x - lo);
};

const stats = (values) => {
  if (values.length === 0) return { median: null, p75: null, p90: null, max: null };
  const s = [...values].sort((a, b) => a - b);
  return { median: quantile(s, 0.5), p75: quantile(s, 0.75), p90: quantile(s, 0.9), max: s[s.length - 1] };
};

export function excursionStudy(bars, features, sessions, { spread }) {
  const adverse = [];
  const favourable = [];
  for (const { start, end } of sessions) {
    for (let i = start; i < end; i++) {
      const dir = Math.sign(features.signal[i] ?? 0);
      if (!dir || !entryAllowedAt(bars[i + 1].t)) continue;
      const entry = dir > 0 ? bars[i + 1].o + spread : bars[i + 1].o;
      let adv = 0;
      let fav = 0;
      for (let j = i + 1; j <= end; j++) {
        const b = bars[j];
        // Long marks to bid, short to ask.
        const low = dir > 0 ? b.l : b.l + spread;
        const high = dir > 0 ? b.h : b.h + spread;
        adv = Math.max(adv, dir > 0 ? entry - low : high - entry);
        fav = Math.max(fav, dir > 0 ? high - entry : entry - low);
        if (Math.sign(features.signal[j] ?? 0) === -dir || inForceWindow(b.t)) break;
      }
      adverse.push(adv);
      favourable.push(fav);
    }
  }
  return {
    count: adverse.length,
    adverse: stats(adverse),
    favourable: stats(favourable),
    adverseReach: LEVELS.map((level) => ({
      level,
      share: adverse.length ? adverse.filter((x) => x >= level).length / adverse.length : 0,
    })),
  };
}
