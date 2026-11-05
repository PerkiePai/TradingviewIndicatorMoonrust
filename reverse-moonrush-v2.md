---
name: reverse-moonrush-v2
description: "Ongoing task + setup to black-box reverse-engineer the protected \"MoonRush V2\" TradingView indicator"
metadata: 
  node_type: memory
  type: project
  originSessionId: f055f89b-7f1d-4a98-bdbf-21ba1cbd5438
---

Goal: reconstruct a *behaves-alike* model of the protected/invite-only "MoonRush V2" TradingView indicator. Source is unrecoverable (protected Pine runs server-side), so the only path is black-box: read its rendered outputs and infer logic.

Setup done on this machine (2026-11-05):
- MCP `tradingview` registered at user scope in `.claude.json` → `node C:/Users/bower/tradingview-mcp/src/server.js` (fork of tradesdontlie/tradingview-mcp, cloned to `C:\Users\bower\tradingview-mcp`, `npm install` done). Drives TradingView Desktop over Chrome DevTools Protocol on port 9222.
- TradingView Desktop is MSIX: `C:\Program Files\WindowsApps\TradingView.Desktop_3.5.0.8375_x64__n534cwy3pjxzj\TradingView.exe`. Launching that exe directly with `--remote-debugging-port=9222` DOES pass the flag (kill existing TradingView.exe first — Electron is single-instance). `tv_launch` can also do this.
- Chart in use: `tradingview.com/chart/RwCzqmx2/`, user logged in.

**How to apply:** after a Claude Code restart (needed to load the `tv_*` tools), if CDP 9222 is still up just call `tv_health_check` → `chart_get_state` → then `data_get_study_values` + `data_get_pine_lines/labels/tables/boxes` with `study_filter: "MoonRush"`. Do NOT call `data_get_indicator` on it — protected indicator inputs are encoded blobs (per repo CLAUDE.md note #5). The indicator must be visible on the chart to be readable. If CDP is down (post-reboot), launch the MSIX exe directly: `Start-Process "C:\Program Files\WindowsApps\TradingView.Desktop_<ver>_x64__n534cwy3pjxzj\TradingView.exe" -ArgumentList "--remote-debugging-port=9222"` (find `<ver>` via `Get-AppxPackage *TradingView*`; `tv_launch` fails because it doesn't know the WindowsApps path), then poll `http://127.0.0.1:9222/json/version`.

## Reconstructed model (observed via MCP; 2 snapshots: NVDA 1m + XAUUSD 1m, 2026-11-05)
The data window NAMES its own plots, so one snapshot exposes most of the architecture.
- **Core signal = double-smoothed EMA crossover.** Plots: `Fast EMA (smoothed)`, `Slow EMA (smoothed)`, bool `Bullish Cross`/`Bearish Cross`. Fast>Slow ⇒ bullish BUY, Fast<Slow ⇒ bearish SELL. Entry = price at cross.
- **3 fixed-step TPs, direction-aware, optional SL.** TP = entry ± step_tp·n (n=1,2,3), + for BUY / − for SELL. `SL: OFF` in both snapshots.
- **S/R bands centered on the Slow EMA** (CORROBORATED: midpoint(S1,R1) ≈ Slow EMA on both symbols). Levels = SlowEMA ± {2,3,4}·step_band. step_band = 8.444 (gold) / 0.785 (NVDA).
- **MTF dashboard table**: Chart/1m/5m/15m/30m/1h/4h/1d rows, each a trend (fast-vs-slow EMA) + RSI value.
- **Event/stats table**: symbol, TF, event, entry+side, SL, TP1-3, Orders/Win/Loss Today, Winrate=round(Win/Orders) [confirmed 4/5=80%, 3/6=50%], DD current/max/avg (in price points).
- **~137 box zones** per symbol, accumulated over history — purpose UNKNOWN (need verbose colors/timestamps).

**Open unknowns (need a time series, not more single snapshots):** EMA lengths + smoothing method; ATR period/multipliers behind step_band and step_tp (both are volatility-based, not fixed %, and scale differently per symbol — band 0.21–0.39% of price, TP 0.11–0.17%); ratio TP:band step ≈ 0.45–0.51 (not constant). Next step to pin lengths: collect the plotted Fast/Slow EMA series across many bars (replay step, or OHLCV + fit).
