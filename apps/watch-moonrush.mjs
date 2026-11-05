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
