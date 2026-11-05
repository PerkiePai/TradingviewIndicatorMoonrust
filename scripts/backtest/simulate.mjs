// Trade simulator for the MoonRush backtest. Bid is the CSV price; ask = bid + spread.
// Long enters on ask and exits on bid; short enters on bid and exits on ask.
// Bars are iterated only inside the sessions given, so a caller can run a single session.

const MIN = 60;
const LAST_ENTRY = 21 * 3600 + 30 * MIN; // no entry fills after 21:30 UTC
const REOPEN = 22 * 3600;
const FORCE_FROM = 21 * 3600 + 50 * MIN; // forced-close window 21:50-21:59 UTC
const FORCE_TO = 22 * 3600;

const timeOfDay = (t) => ((t % 86400) + 86400) % 86400;

export function entryAllowedAt(t) {
  const tod = timeOfDay(t);
  return tod <= LAST_ENTRY || tod >= REOPEN;
}

function assertSupported(setup) {
  if (setup.entry?.type !== 'market') throw new Error(`unsupported entry: ${setup.entry?.type}`);
  if (setup.filter !== 'none') throw new Error(`unsupported filter: ${setup.filter}`);
  if (setup.exit?.type !== 'tp') throw new Error(`unsupported exit: ${setup.exit?.type}`);
}

export function simulate(bars, features, sessions, setup, opts) {
  assertSupported(setup);
  const { spread, slippage = 0.10, startEquity = 24, failEquity = 8, haltOnFail = true } = opts;
  const tpDist = setup.stop == null ? null : setup.exit.mult * setup.stop;

  const trades = [];
  let realised = 0;
  let peak = startEquity;
  let maxDD = 0;
  let firstFailIdx = null;

  const track = (equity) => {
    if (equity > peak) peak = equity;
    if (peak - equity > maxDD) maxDD = peak - equity;
  };
  const result = () => ({ trades, net: realised, maxDD, failed: firstFailIdx !== null, firstFailIdx });

  for (const { start, end } of sessions) {
    let pos = null;
    let pending = null; // {dir} market order for the next bar

    for (let i = start; i <= end; i++) {
      const b = bars[i];

      // 1. Open: apply pending market entry.
      if (pending && !pos && entryAllowedAt(b.t)) {
        pos = { dir: pending.dir, entryIdx: i, entry: pending.dir > 0 ? b.o + spread : b.o };
      }
      pending = null;

      if (pos) {
        const long = pos.dir > 0;
        const sl = setup.stop == null ? null : (long ? pos.entry - setup.stop : pos.entry + setup.stop);
        const tp = tpDist == null ? null : (long ? pos.entry + tpDist : pos.entry - tpDist);
        // Prices the position trades at: long on bid, short on ask.
        const open = long ? b.o : b.o + spread;
        const low = long ? b.l : b.l + spread;
        const high = long ? b.h : b.h + spread;
        const close = long ? b.c : b.c + spread;

        // 2. Stop first, then TP.
        let exit = null;
        if (sl != null) {
          if (long) {
            if (open <= sl) exit = { price: open - slippage, reason: 'stop' };
            else if (low <= sl) exit = { price: sl - slippage, reason: 'stop' };
          } else if (open >= sl) exit = { price: open + slippage, reason: 'stop' };
          else if (high >= sl) exit = { price: sl + slippage, reason: 'stop' };
        }
        if (!exit && tp != null) {
          if (long ? high >= tp : low <= tp) exit = { price: tp, reason: 'tp' };
        }
        // 3. Forced close at this bar's close.
        if (!exit) {
          const tod = timeOfDay(b.t);
          if (tod >= FORCE_FROM && tod < FORCE_TO) exit = { price: close, reason: 'forced' };
          else if (i === end) exit = { price: close, reason: 'session-end' };
        }

        // 4. Equity at the worst price the trade reached on this bar.
        const worst = exit?.reason === 'stop' ? exit.price : (long ? low : high);
        const eq = startEquity + realised + pos.dir * (worst - pos.entry);
        if (eq <= failEquity) {
          if (firstFailIdx === null) firstFailIdx = i;
          if (haltOnFail) exit = { price: worst, reason: 'fail' };
        }

        if (exit) {
          const pnl = pos.dir * (exit.price - pos.entry);
          trades.push({ dir: pos.dir, entryIdx: pos.entryIdx, exitIdx: i, entry: pos.entry, exit: exit.price, pnl, reason: exit.reason });
          realised += pnl;
          pos = null;
          // Worst point first, then the post-close equity, so a same-bar re-entry still sees the new peak.
          track(eq);
          track(startEquity + realised);
        } else track(eq);
        if (exit?.reason === 'fail') return result();
      } else {
        track(startEquity + realised);
      }

      // 5. Signal at the close: pending order for the next bar of this session.
      if (!pos && i < end) {
        const sig = features.signal[i];
        if (sig !== 0) pending = { dir: sig > 0 ? 1 : -1 };
      }
    }
  }
  return result();
}
