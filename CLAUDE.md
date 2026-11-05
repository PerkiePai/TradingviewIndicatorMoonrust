# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Black-box reverse-engineering of the **protected "MoonRush V2" TradingView indicator**. The Pine source runs server-side and is unrecoverable, so the only signal is the indicator's *rendered output* read live from a running TradingView Desktop chart over the Chrome DevTools Protocol (CDP). The repo contains the extraction tooling, the recovered model, Pine reconstructions, and a design for a Discord signal watcher.

**`reverse-moonrush-v2.md` is the source of truth** — read it first. It holds the recovered parameter catalog, the confirmed EMA formulas, the setup state, and the "how to apply" procedure. Keep it updated as findings change.

## Layout

- `scripts/*.mjs` — Node ESM tools that read live MoonRush state over CDP and brute-force-fit its parameters (`fit`, `probe`, `verify`, `mr_inputs`, `mr_finalize`, `mr_signal`).
- `apps/` — long-running services (not one-shot scripts): `watch-moonrush.mjs` (Discord signal watcher) + its sibling test.
- `pines/` — Pine v5 reconstructions: `MoonRushV2_replica.pine` (full behaves-alike, the main deliverable), `MoonRushV2_reconstruction.pine` (annotated spec version), `MoonRushV2_strategy.pine`.
- `docs/superpowers/specs/` — approved designs not yet built (Discord watcher).
- `reverse-moonrush-v2.md` — recovered model + setup + procedure.

## Critical external dependency

Every script imports from a **separate repo outside this tree**:
```js
import { evaluate } from 'file:///C:/Users/bower/tradingview-mcp/src/connection.js';
```
That `tradingview-mcp` repo owns all CDP code and its `node_modules` (`chrome-remote-interface`). This project has **no `package.json`, no `node_modules`, no build/lint/test tooling**. Node resolves the dependency from the MCP repo's own `node_modules`, so cross-drive imports just work — but if `tradingview-mcp` moves, every script's import path must be updated.

## Running anything — preconditions

1. TradingView Desktop must be running with `--remote-debugging-port=9222`. It's an MSIX install; `tv_launch` can't find the path — launch the exe directly, then confirm `http://127.0.0.1:9222/json/version` responds:
   ```powershell
   taskkill /F /IM TradingView.exe 2>$null; & "C:\Program Files\WindowsApps\TradingView.Desktop_3.5.0.8375_x64__n534cwy3pjxzj\TradingView.exe" --remote-debugging-port=9222
   ```
2. **MoonRush V2 must be visible on the chart** — the scripts read *rendered* study output; a hidden or unapplied study returns nothing.
3. Run from repo root: `node scripts/fit.mjs` (etc.). There is no test runner; each script prints its own analysis to stdout.

## How the extraction works (the method)

The scripts drive one CDP primitive — `evaluate(jsExpression)` runs JS in the TradingView page — against the study's internal model:
- `study.metaInfo().inputs` → input **ids + names + defaults**. This was the key unlock: it exposes the whole parameter set in the clear.
- `study.dataWindowView().items()` → current values of **named plots** (`Fast EMA (smoothed)`, `S1`..`R3`, etc.).
- The Pine graphics collections → labels / lines / tables / boxes (entry, TPs, the event + MTF tables).

Values are then fit in Node: candidate MA types/lengths/smoothing, ATR length×multiplier, and RSI length are brute-forced against the observed plot values, cross-checked across symbols.

**Gotchas that cost time:**
- `study.getInputValues()` throws / returns `undefined` — you **cannot read user-overridden inputs**; treat `metaInfo` defaults as the active spec.
- A single snapshot under-constrains a double-EMA fit (many `(len,smooth)` pairs tie). The input metadata resolves it; prefer that over snapshot fitting.
- `ATR(800)` can't be numerically confirmed — it needs far more history than TradingView keeps loaded (~1300 bars) to converge.

## Confirmed MoonRush V2 model (verified exact unless noted)

- **Fast EMA** = `ta.ema(ta.ema(close, 38), 10)`; **Slow EMA** = `ta.ema(ta.ema(close, 62), 10)` (Δ0.000 vs live plots).
- **Signal** = EMA cross (bull = crossover → BUY, bear = crossunder → SELL).
- **ATR bands** S1-3/R1-3 = basis ± `ATR(800)·{6,9,12}`.
- **TP** = 3 equal steps of `ATR(100)·0.5`, stepped ±{1,2,3}; **SL** off by default (`useSL=false`), else `ATR(100)·1.5` opposite side.
- **RSI** 14 (close); MTF trend+RSI dashboard; daily event/stats table.
- *Inferred, not byte-confirmed:* band basis EMA identity (≈Slow), literal ATR length 800, and the TP ATR reference timeframe (~15m via `request.security`).

## Pine / TradingView workflow notes

- The TradingView Basic plan caps **1 saved script** — saving a second Pine file triggers an upgrade modal. Use the editor's **Add to chart** (no save needed) to run an unsaved script; it won't persist as a named script.
- The Pine editor's CDP hook can get stuck ("Could not open Pine Editor") after modal/panel churn. A full TradingView reload is **not** needed — just reload the Pine editor itself (close/reopen the editor panel, or re-run the script's editor reload) to clear it.
- `pines/` holds the canonical Pine files. The replica uses `barcolor` (not `plotcandle`) to recolor candles — `plotcandle` draws a *duplicate* candle series.
