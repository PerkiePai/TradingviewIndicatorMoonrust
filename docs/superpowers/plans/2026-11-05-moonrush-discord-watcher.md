# MoonRush V2 Discord Signal Watcher — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single Node ESM script that polls the MoonRush V2 TradingView indicator every 20 s and posts a Discord message when a new entry signal appears.

**Architecture:** `apps/watch-moonrush.mjs` exports pure filter/hash functions and guards the poll loop behind an `import.meta.url` check so a sibling test file can import and test those functions without starting TradingView. State is persisted in `apps/last-signal.json`; the Discord POST only triggers after a confirmed signal change.

**Tech Stack:** Node 22+ ESM, `--env-file` (built-in), `node:crypto` (SHA-256), `node:fs/promises`, `node:url`.

---

## File Map

| File | Role |
|------|------|
| `apps/watch-moonrush.mjs` | Main script — pure functions (exported) + poll loop (guarded) |
| `apps/watch-moonrush.test.mjs` | Assert-based tests for pure functions; runs without TradingView |
| `.env.example` | Committed template documenting required env vars (project root) |
| `.env` | Real secrets — already git-ignored |
| `apps/last-signal.json` | Runtime state — covered by existing `last-signal.json` gitignore rule |

---

## Task 1: Write the failing tests

**Files:**
- Create: `apps/watch-moonrush.test.mjs`

- [ ] **Step 1: Create the `apps/` directory and write the test file**

```js
// apps/watch-moonrush.test.mjs
import assert from 'node:assert/strict';
import { extractSignalRows, computeSignature, isNewSignal } from './watch-moonrush.mjs';

const STUDIES = [{
  name: 'MoonRush V2',
  tables: [{
    rows: [
      'XAUUSD | 1m | Long Entry | Buy @ 2340.50',
      'SL: 2335.20',
      'TP1: 2345.80 | TP2: 2348.40 | TP3: 2352.00',
      'Orders | 42',
      'Win | 28',
      'Loss | 14',
      'Winrate | 66.67%',
      'DD | 1.2% / 3.4% / 0.8%',
    ]
  }]
}];

const signal = extractSignalRows(STUDIES);

assert.ok(signal.some(r => /entry|buy/i.test(r)),  'entry row kept');
assert.ok(signal.some(r => /\bsl\b/i.test(r)),     'SL row kept');
assert.ok(signal.some(r => /tp/i.test(r)),          'TP row kept');
assert.ok(!signal.some(r => /orders/i.test(r)),     'Orders row dropped');
assert.ok(!signal.some(r => /\bwin\b/i.test(r)),    'Win row dropped');
assert.ok(!signal.some(r => /\bloss\b/i.test(r)),   'Loss row dropped');
assert.ok(!signal.some(r => /winrate/i.test(r)),    'Winrate row dropped');
assert.ok(!signal.some(r => /\bdd\b/i.test(r)),     'DD row dropped');

const sig = computeSignature(signal);
assert.equal(sig, computeSignature(signal), 'signature is deterministic');

assert.ok(isNewSignal(signal, 'old-hash'),  'new signal when sig differs');
assert.ok(!isNewSignal(signal, sig),        'no new signal when sig matches');
assert.ok(!isNewSignal([], 'any-hash'),     'empty rows never fires');

// Critical: stats change must NOT alter the signature
const STUDIES_STATS_CHANGED = [{
  name: 'MoonRush V2',
  tables: [{
    rows: [
      'XAUUSD | 1m | Long Entry | Buy @ 2340.50',   // unchanged
      'SL: 2335.20',
      'TP1: 2345.80 | TP2: 2348.40 | TP3: 2352.00',
      'Orders | 43',        // changed
      'Win | 29',           // changed
      'Loss | 14',
      'Winrate | 67.44%',   // changed
      'DD | 1.3% / 3.4% / 0.9%', // changed
    ]
  }]
}];
const sigAfterStats = computeSignature(extractSignalRows(STUDIES_STATS_CHANGED));
assert.equal(sigAfterStats, sig, 'stats-only change leaves signature unchanged');

console.log('All tests passed.');
```

- [ ] **Step 2: Run the tests — expect failure (no module yet)**

```
node apps/watch-moonrush.test.mjs
```

Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module './watch-moonrush.mjs'`

---

## Task 2: Implement pure functions to make tests pass

**Files:**
- Create: `apps/watch-moonrush.mjs`

- [ ] **Step 1: Write `apps/watch-moonrush.mjs` with the pure functions exported**

```js
// apps/watch-moonrush.mjs
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = resolve(__dir, 'last-signal.json');

// --- Pure functions ---

export function extractSignalRows(studies) {
  const rows = studies.flatMap(s => s.tables.flatMap(t => t.rows));
  return rows
    .filter(r =>  /entry|tp\d?|sl|buy|sell|long|short/i.test(r))
    .filter(r => !/win|loss|order|drawdown|\bdd\b|rate/i.test(r));
}

export function computeSignature(rows) {
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}

export function isNewSignal(rows, lastSig) {
  return rows.length > 0 && computeSignature(rows) !== lastSig;
}
```

- [ ] **Step 2: Run the tests — expect pass**

```
node apps/watch-moonrush.test.mjs
```

Expected: `All tests passed.`

- [ ] **Step 3: Commit**

```
git add apps/watch-moonrush.mjs apps/watch-moonrush.test.mjs
git commit -m "feat: add MoonRush watcher pure functions with tests"
```

---

## Task 3: Complete the script — state, Discord, poll loop, env validation

**Files:**
- Modify: `apps/watch-moonrush.mjs` (replace with full version below)
- Create: `.env.example` (project root)

- [ ] **Step 1: Replace `apps/watch-moonrush.mjs` with the complete script**

```js
// apps/watch-moonrush.mjs
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = resolve(__dir, 'last-signal.json');

// --- Pure functions ---

export function extractSignalRows(studies) {
  const rows = studies.flatMap(s => s.tables.flatMap(t => t.rows));
  return rows
    .filter(r =>  /entry|tp\d?|sl|buy|sell|long|short/i.test(r))
    .filter(r => !/win|loss|order|drawdown|\bdd\b|rate/i.test(r));
}

export function computeSignature(rows) {
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}

export function isNewSignal(rows, lastSig) {
  return rows.length > 0 && computeSignature(rows) !== lastSig;
}

// --- State ---

async function loadSignature() {
  try {
    const s = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    return s.signature ?? null;
  } catch { return null; }
}

async function saveSignature(sig) {
  await writeFile(STATE_FILE, JSON.stringify({ signature: sig }));
}

// --- Discord ---

async function postDiscord(webhookUrl, label, rows) {
  const content = `🚀 MoonRush V2 — ${label}\n${rows.join('\n')}`;
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`Discord POST ${res.status}`);
}

// --- Poll tick ---

async function tick(deps) {
  const { data, health, webhookUrl, studyFilter, symbolLabel } = deps;

  const ok = await health.healthCheck().catch(() => false);
  if (!ok) { console.log('[watcher] CDP not healthy — skipping tick'); return; }

  const { studies } = await data.getPineTables({ study_filter: studyFilter });
  if (!studies.length) { console.warn('[watcher] indicator not visible — skipping tick'); return; }

  const rows = extractSignalRows(studies);
  const lastSig = await loadSignature();

  if (lastSig === null) {
    // First run: establish baseline silently so the next change fires.
    if (rows.length) await saveSignature(computeSignature(rows));
    console.log('[watcher] baseline recorded');
    return;
  }

  if (isNewSignal(rows, lastSig)) {
    await postDiscord(webhookUrl, symbolLabel, rows); // throw = Discord down → don't persist
    await saveSignature(computeSignature(rows));
    console.log('[watcher] signal posted:', rows[0]);
  }
}

// --- Entry point (only when run directly) ---

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {
    TV_MCP_CORE,
    DISCORD_WEBHOOK_URL,
    INTERVAL_MS  = '20000',
    STUDY_FILTER = 'MoonRush',
    SYMBOL_LABEL = 'XAUUSD',
  } = process.env;

  if (!TV_MCP_CORE)         { console.error('TV_MCP_CORE is required');         process.exit(1); }
  if (!DISCORD_WEBHOOK_URL) { console.error('DISCORD_WEBHOOK_URL is required'); process.exit(1); }

  const { data, health } = await import(TV_MCP_CORE);
  const deps = { data, health, webhookUrl: DISCORD_WEBHOOK_URL, studyFilter: STUDY_FILTER, symbolLabel: SYMBOL_LABEL };

  console.log(`[watcher] starting — symbol=${SYMBOL_LABEL} filter=${STUDY_FILTER} interval=${INTERVAL_MS}ms`);
  await tick(deps);
  setInterval(() => tick(deps).catch(e => console.error('[watcher]', e.message)), Number(INTERVAL_MS));
}
```

- [ ] **Step 2: Create `.env.example` in the project root**

```
# Discord watcher config — copy to .env and fill in real values
# Run from project root: node --env-file=.env apps/watch-moonrush.mjs

DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN
TV_MCP_CORE=file:///C:/Users/bower/tradingview-mcp/src/core/index.js
INTERVAL_MS=20000
STUDY_FILTER=MoonRush
SYMBOL_LABEL=XAUUSD
```

- [ ] **Step 3: Verify tests still pass**

```
node apps/watch-moonrush.test.mjs
```

Expected: `All tests passed.`

- [ ] **Step 4: Verify env-validation fast-fail**

```
node apps/watch-moonrush.mjs
```

Expected: `TV_MCP_CORE is required` and exit code 1.

- [ ] **Step 5: Commit**

```
git add apps/watch-moonrush.mjs .env.example
git commit -m "feat: complete Discord watcher — poll loop, state, Discord POST"
```

---

## Task 4: Live calibration — verify row filters against real data

> This task requires TradingView Desktop running with EIGHTCAP:XAUUSD and MoonRush V2 visible.
> See `reverse-moonrush-v2.md` for the `--remote-debugging-port=9222` launch steps.

- [ ] **Step 1: Probe the live table (run from project root, one-liner)**

```
node --env-file=.env --input-type=module <<'EOF'
const { data } = await import(process.env.TV_MCP_CORE);
const r = await data.getPineTables({ study_filter: process.env.STUDY_FILTER });
console.log(JSON.stringify(r, null, 2));
EOF
```

- [ ] **Step 2: Inspect the output**

Look at every row string in `studies[*].tables[*].rows`. Confirm:

- Signal rows (entry/side, SL, TP1-3) all match `/entry|tp\d?|sl|buy|sell|long|short/i`
- Stats rows (Orders/Win/Loss/Winrate/DD) all match `/win|loss|order|drawdown|\bdd\b|rate/i`
- No signal row accidentally matches the stats exclude regex (or vice versa)

- [ ] **Step 3: Adjust regexes if needed**

If any row mislabels, update the two filter lines in `extractSignalRows` in `apps/watch-moonrush.mjs`, update the sample row strings in `apps/watch-moonrush.test.mjs` to match real data, re-run tests.

- [ ] **Step 4: Commit if regexes changed**

```
git add apps/watch-moonrush.mjs apps/watch-moonrush.test.mjs
git commit -m "fix: calibrate row-filter regexes to live MoonRush V2 table layout"
```

---

## Task 5: Smoke-test the full watcher

> Requires TradingView + a real Discord webhook. Set up `.env` from `.env.example`.

- [ ] **Step 1: Start the watcher**

```
node --env-file=.env apps/watch-moonrush.mjs
```

Expected output on first run:
```
[watcher] starting — symbol=XAUUSD filter=MoonRush interval=20000ms
[watcher] baseline recorded
```

Then every 20 s: silence (no new signal) or `[watcher] signal posted: ...` if one fires.

- [ ] **Step 2: Verify Discord message format when a signal posts**

Expected Discord message:
```
🚀 MoonRush V2 — XAUUSD
<signal row 1>
<SL row>
<TP1/TP2/TP3 row>
```

- [ ] **Step 3: Verify no-crash on CDP down**

Stop TradingView. Within two poll cycles the log should show `[watcher] CDP not healthy — skipping tick` without crashing. Restart TradingView — should resume automatically.

---

## Skipped / risks

- No process manager, restart-on-crash, or NSSM wrapper — out of scope per spec.
- `healthCheck()` return value assumed truthy-when-healthy; verify against `C:\Users\bower\tradingview-mcp\src\core\index.js` if ticks keep skipping unexpectedly.
- Row format is assumed from spec description — Task 4 calibration is the only way to confirm the regexes are correct before relying on the watcher in production.
