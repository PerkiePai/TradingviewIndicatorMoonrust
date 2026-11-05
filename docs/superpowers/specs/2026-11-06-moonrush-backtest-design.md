# MoonRush V2 → Order & Take-Profit Backtest — Design

**Date:** 2026-11-06
**Status:** Design agreed in conversation; written spec awaiting user review

## Goal

Find out whether any order-placement and take-profit setup built on MoonRush V2
EMA-cross signals can trade `EIGHTCAP:XAUUSD` 1m profitably **without destroying
a $24 account**, using cross-validated, out-of-sample results.

"No demonstrated edge" is a valid and expected outcome. The tool must report it
plainly rather than name a winner.

## Non-goals (explicitly out of scope)

- Writing the EA/bot, or placing any live or demo order.
- Fitting the MoonRush parameters (EMA 38/62/10 are fixed).
- Long-only or short-only setups: the file rises about $215, so a one-sided
  setup would look good because of the rally.
- Partial exits (0.01 lot is treated as the minimum, so it cannot be split).
- Position sizing, pyramiding, or more than one open position.
- Large optimisers (Optuna, genetic search): about 58 trades cannot support them.
- Downloading more history. The engine accepts any CSV in the same format, so
  this can be a later step.

## Context and constraints

| Item | Value | Source |
|---|---|---|
| Account | $24 | User |
| Margin per order | About $8 at 0.01 lot | User confirmed it is margin |
| Risk tolerance | Very low | User |
| Execution | Automated bot/EA | User |
| Spread | "Around 16" platform points, read as $0.16 in price | User; interpretation is an assumption |
| Commission | None | Assumption; user to confirm |
| Value of 0.01 lot | $1 profit/loss per $1 of price move | Assumption; check Eightcap contract specs |
| CSV prices | Bid | Assumption |

All distances in this spec are **dollars of price move**. At 0.01 lot, that
equals dollars of profit or loss.

**Data:** `data/XAUUSD_EIGHTCAP_1m.csv`, 5,273 bars, 2026-11-01 23:01 UTC to
2026-11-05 18:08 UTC.

| Session | Bars | EMA crosses after warm-up | Open to close |
|---|---|---|---|
| Nov 2 | 1,378 | 11 | +63.8 |
| Nov 3 | 1,378 | 14 | −18.4 |
| Nov 4 | 1,378 | 21 | +129.5 |
| Nov 5 (partial) | 1,139 | 12 | +34.8 |

The cross counts come from an exploratory script that seeded its EMAs with the
first close. Pine-style seeding may change them slightly.

**Known limits of this evidence:**

- Four sessions in one rising market, with about 58 signals in total.
- Leave-one-day-out means some folds train on days after the test day. The rules
  do not adapt over time and each session ends flat, but this is still weaker
  than forward testing.
- Results are a screen, not proof. Any candidate goes to a demo account first.

## Signals and indicators

All are computed once over the full file. They use only past bars.

- **Signal:** `fast = ema(ema(close, 38), 10)`, `slow = ema(ema(close, 62), 10)`.
  Crossover is a buy; crossunder is a sell. Confirmed at bar close.
- **EMA seeding:** matches Pine's `ta.ema`, using an SMA of the first `n` values.
- **Warm-up:** no signals are acted on in the first 300 bars.
- **RSI(14):** Pine-style, using Wilder's RMA on close.
- **5-minute trend:** the same double EMA on clock-aligned 5m bars built from 1m
  bars. A 1m bar sees only the latest *completed* 5m bar. Bullish means
  fast > slow. Before the value exists, the filter blocks entries.
- **Sessions:** a new session starts after a gap of 30 minutes or more. The 5-
  and 6-minute gaps on Nov 5 do not split a session.

## Trade simulation

**General**

- Fixed 0.01 lot, with one position at a time.
- Base spread is $0.16. Stops slip by a further $0.10. Limit and TP orders have
  no slippage.
- Each order uses ask to buy and bid to sell, where bid is the CSV price and
  `ask = bid + spread`.
  - **Long:** enter on ask, exit on bid.
  - **Short:** enter on bid, exit on ask.

**Entries**

- **Market:** fills at the open of the bar after the signal.
- **Limit pullback:** rests at the signal close, moved $1 or $2 in the trade's
  favour. Fills when the correct side of the price touches it, at the limit or
  at the bar's open if that is better. Expires after 5 bars.
- An opposite signal cancels a pending limit and replaces it with the new
  signal's order, if the filter allows it.
- No new entries after 21:30 UTC. Pending limits are cancelled at that time.

**Stops, TPs and exits**

- The stop and TP are measured from the actual entry fill.
- On each bar, the stop is checked before the TP. If both are touched on the
  same bar, the stop counts as hit.
- If the bar opens beyond the stop, it fills at that open plus slippage.
- **Entry bar:** after a market fill, the stop and TP are both live. After a
  limit fill, only the stop is live until the next bar, because the bar's order
  of events is unknown.
- **Trailing stop:** distance equals the stop size. It moves only in the trade's
  favour, using the bar's extreme, and takes effect from the next bar.
- **Close on opposite signal:** exits at the next bar's open. The same open may
  start the reverse trade, if the filter allows it. The stop remains live.
- For other exit types, signals are ignored while a position is open.
- **Forced close:** any open position closes at the close of the 21:50 UTC bar.
  At end of file, it closes at the last bar's close. Both pay normal spread.
  This time is a constant, so it can be changed for daylight-saving shifts.

**Account failure**

- Each training run starts at $24 and plays its three sessions in date order.
  Each test day starts again at $24.
- Equity is checked on every bar at the bar's worst price for the open trade. On
  a bar where a stop is hit, the worst price is the stop fill.
- If equity is $8 or less, the run has **failed** and takes no more trades.
- Drawdown is peak-to-trough on that same equity series.
- Broker stop-out is not modelled, and neither are swap fees because no trade is
  held through the daily break.

## Excursion study (diagnostic only)

For each signal, enter at the next bar's open and measure the furthest move
against and in favour of the trade until the next opposite signal or forced close.

Report the median, 75th percentile, 90th percentile and maximum of each, plus
the share of signals whose adverse move reaches $3, $5, $8, $12 and $16.

This study covers all sessions, so it **must not** feed into the grid or the
selection. It only helps explain the results.

## Search grid (180 setups, 3 × 3 × 4 × 5)

| Setting | Options |
|---|---|
| Entry | Next-bar market; limit $1 pullback; limit $2 pullback |
| Filter | None; RSI (no buys above 70, no sells below 30); 5-minute trend agrees |
| Stop | $3, $5, $8, $12 |
| Exit | TP at 1×, 1.5× or 2× the stop; trailing stop; close on opposite signal |

The grid is fixed in advance. It must not be changed after seeing test results
without saying so in the report.

## Cross-validation

Four folds, leave-one-session-out. Each session is the test day once.

In each fold, using only the three training sessions:

1. Reject setups that fail the $8 rule, have net profit ≤ 0, or take fewer than
   10 trades.
2. Rank the rest by `net profit / max(max drawdown, $1)`.
3. Break ties by more trades, then by grid order, so results are repeatable.
4. Score only the top setup on the test session. If nothing passes, the fold is
   recorded as **no trade**, with $0 profit.

The whole procedure is repeated at spreads of $0.16, $0.32 and $0.48, including
reselection.

## Reference comparisons

**Random entries**

- 1,000 runs with a fixed seed.
- In each fold, take the chosen setup's exit and stop, and the same number of
  trades it made on the test day.
- Entries are market orders on random eligible bars, in a random direction. A
  pick that lands while a position is open is redrawn until the count is met or
  the session runs out of bars.
- The same failure rule applies. A no-trade fold contributes $0.
- Compare each run's combined test-day profit with the strategy's.

**Indicator default**

- Enter at the next bar's open on each cross. TP at `ATR(100)·0.5` on 15m bars,
  with no stop. A new cross closes and reverses the trade. Forced close applies.
- Only trades after the ATR warm-up count, which is about 25 hours of bars.
- For comparison only, never selected. It reports whether it would have hit the
  $8 failure level, and it keeps trading past that point so the full result is
  visible.

## Verdict

The result is **demo candidate** only if all of these hold at the $0.16 spread:

1. Test-day profit on at least 3 of the 4 folds. A no-trade fold does not count
   as profit.
2. No failed test day.
3. Combined test-day profit is above at least 95% of the random runs.
4. Combined test-day profit stays positive when the procedure is rerun at the
   $0.32 spread.

Otherwise, the result is **no demonstrated edge**.

The $0.48 run is reported but is not part of the verdict. Agreement between the
folds' chosen setups is also reported but is not part of the verdict.

**Final setup:** selection is rerun on all four sessions and clearly labelled
in-sample. It is named as the setup for demo testing only if the verdict is demo
candidate. Otherwise the report says that no setup is recommended.

## Code layout

No TradingView or CDP dependency, and no npm packages. It needs only Node 22 and
the CSV.

```
scripts/backtest.mjs              CLI: parse args, run everything, write outputs
scripts/backtest/data.mjs         Load CSV, split sessions
scripts/backtest/indicators.mjs   Pine-style EMA, RSI, ATR; signals; 5m and 15m bars
scripts/backtest/simulate.mjs     Run one setup over sessions; returns trades and equity
scripts/backtest/grid.mjs         The 180 setups and selection ranking
scripts/backtest/cv.mjs           Folds, selection, spread reruns, verdict
scripts/backtest/references.mjs   Random entries and indicator default
scripts/backtest/excursion.mjs    Excursion study
scripts/backtest/report.mjs       Markdown report from a results object
scripts/backtest/backtest.test.mjs  Plain node:assert tests, like the watcher's
```

**Usage:**

```powershell
node scripts/backtest.mjs [data/XAUUSD_EIGHTCAP_1m.csv]
node scripts/backtest/backtest.test.mjs
```

**Outputs:** `reports/moonrush-backtest.md` and `reports/moonrush-backtest.json`.
Results include the CSV path and row count, spreads, seed and grid size.

**Errors:** the CLI exits with a clear message for a missing file, an unexpected
header, non-increasing timestamps or invalid prices. It also exits if there are
fewer than four sessions.

## Testing

**Unit tests with small hand-made bars:**

- EMA and RSI match hand-calculated values, including seeding.
- Long and short fills apply spread correctly at entry and exit.
- Stop beats TP on the same bar.
- A gap past the stop fills at the open plus slippage.
- A limit fills correctly, expires after 5 bars, and has no TP on its fill bar.
- A trailing stop never moves backward and takes effect from the next bar.
- Forced close, end-of-file close and the 21:30 entry cut-off work as specified.
- The $8 failure rule stops trading, including on an intrabar drawdown.
- Ranking handles zero drawdown and ties repeatably.

**Leakage tests:**

- Changing future bars does not change earlier signals, filters or fills.
- Changing a fold's test session does not change that fold's chosen setup.

**Run-level checks:**

- The same seed gives identical output.
- The real file produces 4 sessions, 5,273 bars and close to 58 signals.
- With zero spread and zero slippage, the sum of trade profits matches the
  equity change.

**Optional manual check:** compare a sample of signal times with MoonRush on the
live chart, if TradingView is running.

## Details added while writing, for user review

These were not discussed directly:

- No new entries after 21:30 UTC.
- A limit fill's TP does not become live until the next bar.
- Close-on-opposite can immediately reverse into a new trade.
- The indicator default keeps trading after hitting the failure level, for
  comparison only.
- Random-entry runs use market entries, whichever entry the chosen setup uses.
