# MoonRush V2 backtest

Data: `data/XAUUSD_EIGHTCAP_1m.csv`, 5273 one-minute bars in 4 sessions. Grid: 180 setups. Random seed: 20261106.

## Verdict

**no demonstrated edge**

- FAIL: Profit on at least 3 test days (2 of 4 profitable)
- FAIL: No failed test day (1 failed)
- FAIL: Beats 95% of random runs (71.8% of random runs below)
- FAIL: Positive at the $0.32 spread (combined net -$0.59)

## Limits

- Four sessions in one rising market, with few signals. This is a screen, not proof.
- Leave-one-day-out means some folds train on days after the test day.
- Indicators run over the whole file, so when a training session follows a test session, test-day prices still influence its indicators for some hours.
- The random baseline uses market entries whatever entry the chosen setup uses.
- Any candidate goes to a demo account first.

## Assumptions

- Spread $0.16 (reruns at $0.32 and $0.48); stops slip a further $0.10; no commission.
- 0.01 lot: $1 profit or loss per $1 of price move; account $24, failed at $8 equity.
- CSV prices are bid; ask is bid plus spread.

## Test days at the $0.16 spread

| Test day | Chosen setup | Net | Max drawdown | Trades | Win rate | Failed |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-11-02 | `limit2\|rsi\|stop5\|tp1.5` | -$15.30 | $15.53 | 3 | 0.0% | no |
| 2026-11-03 | `limit1\|none\|stop12\|tp1` | $23.90 | $14.40 | 4 | 75.0% | no |
| 2026-11-04 | `market\|rsi\|stop12\|trail` | -$16.26 | $16.26 | 2 | 0.0% | yes |
| 2026-11-05 | `limit1\|none\|stop12\|tp1` | $19.55 | $31.78 | 6 | 66.7% | no |

## Combined result and fold agreement

- Combined test-day net: $11.89
- Profitable test days: 2 of 4; failed test days: 1
- Distinct chosen setups: 3 (`limit2|rsi|stop5|tp1.5`, `limit1|none|stop12|tp1`, `market|rsi|stop12|trail`)

## Spread reruns

| Spread | Combined net | Profitable days | Failed days |
| --- | --- | --- | --- |
| $0.16 | $11.89 | 2 | 1 |
| $0.32 | -$0.59 | 2 | 1 |
| $0.48 | -$1.07 | 2 | 1 |

The $0.48 run is reported but is not part of the verdict.

## Random comparison

1000 runs, seed 20261106, same trade counts and exits as the chosen setups. The strategy's combined net beat 71.8% of them. Random combined net: 5th percentile -$53.04, median -$11.23, 95th percentile $55.13.

## Indicator default

Enter on each cross, take profit at ATR(100) x 0.5 on 15m bars, no stop, reverse on a new cross. Comparison only; it keeps trading past the failure level.

Net $2.29, max drawdown $52.70, 44 trades. It hit the $8 failure level.

## Excursion study (diagnostic only)

57 signals, entered at the next bar's open, measured to the next opposite signal or forced close. It covers all sessions and never feeds selection.

| Move | Median | 75th | 90th | Max |
| --- | --- | --- | --- | --- |
| Adverse | 6.20 | 8.44 | 11.26 | 34.42 |
| Favourable | 5.65 | 14.31 | 23.30 | 101.53 |

| Adverse move reaches | Share of signals |
| --- | --- |
| $3 | 77.2% |
| $5 | 57.9% |
| $8 | 33.3% |
| $12 | 8.8% |
| $16 | 7.0% |

## Final setup

No setup is recommended.
