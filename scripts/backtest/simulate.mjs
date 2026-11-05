// Trade simulator for the MoonRush backtest. Bid is the CSV price; ask = bid + spread.
// Long enters on ask and exits on bid; short enters on bid and exits on ask.
// Bars are iterated only inside the sessions given, so a caller can run a single session.

const MIN = 60;
const LAST_ENTRY = 21 * 3600 + 30 * MIN; // no entry fills after 21:30 UTC
const REOPEN = 22 * 3600;
const FORCE_FROM = 21 * 3600 + 50 * MIN; // forced-close window 21:50-21:59 UTC
const FORCE_TO = 22 * 3600;
const LIMIT_LIFE = 5; // a limit is live on the 5 bars after its signal

const timeOfDay = (t) => ((t % 86400) + 86400) % 86400;
const dirOf = (sig) => (sig > 0 ? 1 : sig < 0 ? -1 : 0); // null, undefined and NaN are no signal

export function entryAllowedAt(t) {
  const tod = timeOfDay(t);
  return tod <= LAST_ENTRY || tod >= REOPEN;
}

function assertSupported(setup) {
  const { entry, filter, exit, stop } = setup;
  if (entry?.type === 'limit') {
    if (!Number.isFinite(entry.offset)) throw new Error('limit entry needs a numeric offset');
  } else if (entry?.type !== 'market') throw new Error(`unsupported entry: ${entry?.type}`);
  if (!['none', 'rsi', 'trend5m'].includes(filter)) throw new Error(`unsupported filter: ${filter}`);
  if (exit?.type === 'tp' || exit?.type === 'trail') {
    if (!(stop > 0)) throw new Error(`${exit.type} exit needs a stop`);
  } else if (exit?.type !== 'opposite' && exit?.type !== 'tpAtr') throw new Error(`unsupported exit: ${exit?.type}`);
  if ((exit.type === 'tp' || exit.type === 'tpAtr') && !(exit.mult > 0)) throw new Error(`${exit.type} exit needs mult`);
}

export function simulate(bars, features, sessions, setup, opts) {
  assertSupported(setup);
  const { spread, slippage = 0.10, startEquity = 24, failEquity = 8, haltOnFail = true } = opts;
  const exitType = setup.exit.type;
  const stopDist = setup.stop ?? null;
  const exitSignal = features.exitSignal ?? features.signal;
  const closesOnOpposite = exitType === 'opposite' || exitType === 'tpAtr';
  const stopReason = exitType === 'trail' ? 'trail' : 'stop';

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

  // The order a signal on bar idx would place, or null when a filter or a missing ATR blocks it.
  const orderFor = (idx) => {
    const dir = dirOf(features.signal[idx]);
    if (!dir) return null;
    if (setup.filter === 'rsi') {
      const r = features.rsi[idx];
      if (r == null || (dir > 0 ? r > 70 : r < 30)) return null;
    } else if (setup.filter === 'trend5m' && features.trend5m[idx] !== dir) return null;
    let tpDist = exitType === 'tp' ? setup.exit.mult * stopDist : null;
    if (exitType === 'tpAtr') {
      const a = features.atr15m?.[idx];
      if (!(a > 0)) return null;
      tpDist = a * setup.exit.mult;
    }
    const limit = setup.entry.type === 'limit' ? bars[idx].c - dir * setup.entry.offset : null;
    return { dir, expires: idx + LIMIT_LIFE, tpDist, limit };
  };

  for (const { start, end } of sessions) {
    let pos = null;
    let pending = null; // market order for the next bar, or a resting limit

    const openPos = (order, i, price) => {
      pos = {
        dir: order.dir, entryIdx: i, entry: price, viaLimit: order.limit != null,
        sl: stopDist == null ? null : price - order.dir * stopDist,
        tp: order.tpDist == null ? null : price + order.dir * order.tpDist,
        closeNext: false,
      };
    };
    const closePos = (i, price, reason) => {
      const pnl = pos.dir * (price - pos.entry);
      trades.push({ dir: pos.dir, entryIdx: pos.entryIdx, exitIdx: i, entry: pos.entry, exit: price, pnl, reason });
      realised += pnl;
      pos = null;
    };

    for (let i = start; i <= end; i++) {
      const b = bars[i];

      // 1a. Open: close on an opposite signal, at the open on the position's exit side.
      if (pos?.closeNext) {
        const px = pos.dir > 0 ? b.o : b.o + spread;
        // The stop stays live: an open already beyond it fills as a stop, with slippage.
        const gapped = pos.sl != null && (pos.dir > 0 ? px <= pos.sl : px >= pos.sl);
        if (gapped) closePos(i, px - pos.dir * slippage, stopReason);
        else closePos(i, px, 'opposite');
        const eq = startEquity + realised;
        track(eq);
        if (eq <= failEquity) {
          if (firstFailIdx === null) firstFailIdx = i;
          if (haltOnFail) return result(); // no reversal opens after a failing close
        }
      }

      // 1b. Apply the pending order.
      if (pending && !pos) {
        if (!entryAllowedAt(b.t) || i > pending.expires) pending = null;
        else if (pending.limit == null) {
          openPos(pending, i, pending.dir > 0 ? b.o + spread : b.o);
          pending = null;
        } else if (pending.dir > 0 ? b.l + spread <= pending.limit : b.h >= pending.limit) {
          openPos(pending, i, pending.dir > 0 ? Math.min(pending.limit, b.o + spread) : Math.max(pending.limit, b.o));
          pending = null;
        }
      }

      if (pos) {
        const long = pos.dir > 0;
        const limitFillBar = pos.viaLimit && pos.entryIdx === i;
        // Prices the position trades at: long on bid, short on ask.
        const open = long ? b.o : b.o + spread;
        const low = long ? b.l : b.l + spread;
        const high = long ? b.h : b.h + spread;
        const close = long ? b.c : b.c + spread;

        // 2. Stop first, then TP. On a limit fill bar only the stop is live.
        let exit = null;
        if (pos.sl != null) {
          if (long) {
            if (open <= pos.sl) exit = { price: open - slippage, reason: stopReason };
            else if (low <= pos.sl) exit = { price: pos.sl - slippage, reason: stopReason };
          } else if (open >= pos.sl) exit = { price: open + slippage, reason: stopReason };
          else if (high >= pos.sl) exit = { price: pos.sl + slippage, reason: stopReason };
        }
        if (!exit && pos.tp != null && !limitFillBar) {
          if (long ? high >= pos.tp : low <= pos.tp) exit = { price: pos.tp, reason: 'tp' };
        }
        // 3. Forced close at this bar's close.
        if (!exit) {
          const tod = timeOfDay(b.t);
          if (tod >= FORCE_FROM && tod < FORCE_TO) exit = { price: close, reason: 'forced' };
          else if (i === end) exit = { price: close, reason: 'session-end' };
        }

        // 4. Equity at the worst price the trade reached on this bar.
        const stopped = exit?.reason === 'stop' || exit?.reason === 'trail';
        const worst = stopped ? exit.price : (long ? low : high);
        const eq = startEquity + realised + pos.dir * (worst - pos.entry);
        if (eq <= failEquity) {
          if (firstFailIdx === null) firstFailIdx = i;
          if (haltOnFail) exit = { price: worst, reason: 'fail' };
        }

        if (exit) {
          closePos(i, exit.price, exit.reason);
          // Worst point first, then the post-close equity, so a same-bar re-entry still sees the new peak.
          track(eq);
          track(startEquity + realised);
        } else {
          track(eq);
          // Trail: ratchet on the bar's extreme, effective from the next bar. Skipped on a limit
          // fill bar, where the extreme may have come before the fill.
          if (exitType === 'trail' && !limitFillBar) {
            pos.sl = long ? Math.max(pos.sl, high - stopDist) : Math.min(pos.sl, low + stopDist);
          }
        }
        if (exit?.reason === 'fail') return result();
      } else {
        track(startEquity + realised);
      }

      // 5. Signals at the close. A new signal cancels a resting order and replaces it if allowed.
      if (i < end) {
        if (pos) {
          if (closesOnOpposite && dirOf(exitSignal[i]) === -pos.dir) {
            pos.closeNext = true;
            pending = orderFor(i); // the reverse, placed at the same open
          }
        } else if (dirOf(features.signal[i])) {
          pending = orderFor(i);
        }
      }
    }
  }
  return result();
}
