# MoonRush V2 → Discord Signal Watcher — Design

**Date:** 2026-11-05
**Status:** Approved design, pre-implementation

## Goal

A standalone, always-on Node script that watches the protected "MoonRush V2"
TradingView indicator on the live `EIGHTCAP:XAUUSD` chart and posts a Discord
notification whenever a **new entry signal** appears (a fresh Bullish/Bearish
cross, which produces a new entry+side / SL / TP1-3 row in the indicator's
event/stats table).

Scope is deliberately narrow: one symbol, one trigger type (new entry only),
plain-text Discord messages.

## Non-goals (explicitly out of scope)

- Multiple symbols / watchlist scanning.
- Alerting on SL or TP *level changes* of an already-active signal (volatility
  recomputation would spam).
- Rich Discord embeds / parsed-and-labeled fields.
- A process manager. The operator runs `node --env-file=.env watch-moonrush.mjs`
  in a terminal or via a startup `.bat`.
- TradingView native alert → webhook path (MoonRush V2 exposes no alert
  conditions, confirmed with the user — polling is the only route).

## Context / existing assets reused

- MCP server repo at `C:\Users\bower\tradingview-mcp` exposes a clean core API:
  `import { data, health } from '<repo>/src/core/index.js'`.
- `connection.js` auto-connects to Chrome DevTools Protocol on port 9222 and
  auto-finds the TradingView chart target. No new CDP code is written.
- `data.getPineTables({ study_filter })` returns `{ studies: [{ name, tables:
  [{ rows: ["col | col | col", ...] }] }] }` — the indicator's rendered tables
  as formatted row strings.
- `health.healthCheck()` reports whether TradingView/CDP is reachable.
- Node resolves the core module's own dependency (`chrome-remote-interface`)
  from the MCP repo's `node_modules`, so importing core from this project
  (a different drive) works without any linking.

## Architecture

One file, `apps/watch-moonrush.mjs`, in `D:\code\project\ReaMoonrushV2`. ~80 lines.

### Config — `.env` (Node built-in `--env-file`, no dependency)

Run: `node --env-file=.env apps/watch-moonrush.mjs`

`.env` keys (a committed `.env.example` documents them; real `.env` is
git-ignored):

```
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
TV_MCP_CORE=file:///C:/Users/bower/tradingview-mcp/src/core/index.js
INTERVAL_MS=20000
STUDY_FILTER=MoonRush
SYMBOL_LABEL=XAUUSD
```

Both the secret (webhook) and the machine-specific core path live in `.env`.
On a new machine, only `.env` changes; the script is untouched.

Consequence: core is imported dynamically —
`const { data, health } = await import(process.env.TV_MCP_CORE)` — which
fails fast with a clear message if `TV_MCP_CORE` is unset or wrong.

### Poll loop

Every `INTERVAL_MS` (default 20s; the signal lives on a 1m chart, so 20s is
ample):

1. `await health.healthCheck()` — if not healthy, log and skip this tick.
2. `await data.getPineTables({ study_filter: STUDY_FILTER })`.
3. If `study_count === 0` (indicator not visible on chart), log a warning and
   skip this tick.
4. `extractSignalRows(studies)` → the signal block.
5. `computeSignature(rows)` → compare to `last-signal.json`.
6. First run ever (no state file): record baseline silently, no notification.
7. Signature changed **and** non-empty → POST to Discord, then persist.

### `extractSignalRows(studies)` — the core logic

The event/stats table mixes two kinds of rows:

- **Signal rows**: symbol, TF, event, entry+side, SL, TP1-3.
- **Live stats rows**: Orders / Win / Loss / Winrate / DD (current/max/avg).

We keep **only signal rows**: include rows matching
`/entry|tp\d?|sl|buy|sell|long|short/i`, drop rows matching
`/win|loss|order|drawdown|\bdd\b|rate/i`.

This separation is critical: hashing the whole table would false-trigger on
every stat tick (DD and winrate update continuously).

### `computeSignature(rows)` + `isNewSignal(rows, lastSig)`

Signature = a hash (or plain join) of the signal rows. `isNewSignal` returns
true when the signature differs from the stored one and the rows are non-empty.
Both are pure functions — unit-testable without TradingView.

### Discord notification

Plain text POST to `DISCORD_WEBHOOK_URL`:

```
🚀 MoonRush V2 — XAUUSD
<signal rows, verbatim, one per line>
```

Levels are forwarded verbatim (no column parsing), robust to layout shifts.

## State

`last-signal.json` next to the script: `{ "signature": "<hash>" }`.
Persisted only after a successful Discord POST (see error handling).

## Error handling (no missed, no dropped signals)

- CDP down / TradingView closed → `healthCheck` fails → log, skip tick, retry
  next loop. Never crash.
- Indicator not visible (`study_count === 0`) → log warning, skip tick.
- **Discord POST fails → do NOT update `last-signal.json`.** The same signal
  retries on the next tick, so a transient Discord/network outage never drops a
  signal.
- Missing/invalid `TV_MCP_CORE` or `DISCORD_WEBHOOK_URL` → fail fast at startup
  with a clear message.

## Testing

One assert-based self-check (a `--test` flag branch, or a sibling
`watch-moonrush.test.mjs`) covering the pure functions `extractSignalRows` and
`isNewSignal` with sample table data — including a case proving a changing
stats row (DD/winrate) does **not** produce a new signature. Runs without
TradingView up.

## The one build-time calibration step

The row-filter keywords must be verified against the **live** table layout:
with TradingView up and XAUUSD + MoonRush V2 visible, read the real
`getPineTables` output once and confirm the signal rows separate cleanly from
the stats rows. Adjust the include/exclude regexes to the actual column text if
needed. This is the only step that requires the live chart.

## Operational notes

- Requires TradingView Desktop running with the EIGHTCAP:XAUUSD chart and
  MoonRush V2 visible, launched with `--remote-debugging-port=9222`
  (see `reverse-moonrush-v2.md` for launch details).
- Start: `node --env-file=.env watch-moonrush.mjs`.
