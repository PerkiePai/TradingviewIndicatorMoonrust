// Pine-style indicators and per-bar features. Dependency-free.

export function ema(values, n) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (n + 1);
  let count = 0, sum = 0, prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null) continue;
    if (prev === null) {
      sum += v;
      if (++count === n) { prev = sum / n; out[i] = prev; }
    } else {
      prev += (v - prev) * k;
      out[i] = prev;
    }
  }
  return out;
}

// Wilder RMA seeded with the SMA of the first n values of `vals` (starting at index `from`).
function rma(vals, n, from) {
  const out = new Array(vals.length).fill(null);
  let sum = 0, prev = null;
  for (let i = from; i < vals.length; i++) {
    if (prev === null) {
      sum += vals[i];
      if (i - from + 1 === n) { prev = sum / n; out[i] = prev; }
    } else {
      prev = (prev * (n - 1) + vals[i]) / n;
      out[i] = prev;
    }
  }
  return out;
}

export function rsi(closes, n) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= n) return out;
  const gain = [0], loss = [0];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain.push(Math.max(d, 0));
    loss.push(Math.max(-d, 0));
  }
  const ag = rma(gain, n, 1), al = rma(loss, n, 1);
  for (let i = 0; i < closes.length; i++) {
    if (ag[i] === null) continue;
    out[i] = al[i] === 0 ? 100 : 100 - 100 / (1 + ag[i] / al[i]);
  }
  return out;
}

export function atr(bars, n) {
  const tr = bars.map((b, i) => (i === 0
    ? b.h - b.l
    : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c))));
  return rma(tr, n, 0);
}

export function resample(bars, minutes) {
  const size = minutes * 60;
  const out = [];
  for (const b of bars) {
    const T = Math.floor(b.t / size) * size;
    const last = out[out.length - 1];
    if (last && last.t === T) {
      last.h = Math.max(last.h, b.h);
      last.l = Math.min(last.l, b.l);
      last.c = b.c;
      last.v += b.v;
    } else {
      out.push({ t: T, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    }
  }
  return out;
}

// Map each 1m bar to the latest higher-timeframe value whose bucket has completed by that bar's close.
function mapVisible(bars, buckets, minutes, values) {
  const out = new Array(bars.length).fill(null);
  const size = minutes * 60;
  let p = -1;
  for (let i = 0; i < bars.length; i++) {
    while (p + 1 < buckets.length && buckets[p + 1].t + size <= bars[i].t + 60) p++;
    out[i] = p >= 0 ? values[p] : null;
  }
  return out;
}

const doubleEma = (closes, a, b) => ema(ema(closes, a), b);

export function buildFeatures(bars) {
  const closes = bars.map((b) => b.c);
  const fast = doubleEma(closes, 38, 10);
  const slow = doubleEma(closes, 62, 10);
  const signal = new Array(bars.length).fill(0);
  for (let i = 300; i < bars.length; i++) {
    if (fast[i] === null || slow[i] === null || fast[i - 1] === null || slow[i - 1] === null) continue;
    if (fast[i] > slow[i] && fast[i - 1] <= slow[i - 1]) signal[i] = 1;
    else if (fast[i] < slow[i] && fast[i - 1] >= slow[i - 1]) signal[i] = -1;
  }

  const b5 = resample(bars, 5);
  const c5 = b5.map((b) => b.c);
  const f5 = doubleEma(c5, 38, 10), s5 = doubleEma(c5, 62, 10);
  const trend = f5.map((v, i) => (v === null || s5[i] === null ? null : v > s5[i] ? 1 : -1));

  const b15 = resample(bars, 15);
  return {
    signal,
    rsi: rsi(closes, 14),
    trend5m: mapVisible(bars, b5, 5, trend),
    atr15m: mapVisible(bars, b15, 15, atr(b15, 100)),
  };
}
