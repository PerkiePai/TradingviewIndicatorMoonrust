import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const __dir = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = resolve(__dir, 'last-signal.json');

// --- Pure functions ---

export function extractSignalRows(studies) {
  const rows = studies.flatMap(s => s.tables.flatMap(t => t.rows));
  return rows
    .filter(r =>  /entry|tp\d?|sl|buy|sell|long|short/i.test(r))
    .filter(r => !/win|loss|order|drawdown|\bdd\b|rate|hits/i.test(r));
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

// --- CDP helpers ---

// HTTP endpoint — works without taking the WebSocket debugger slot held by the MCP server.
async function isCdpAlive() {
  try {
    const r = await fetch('http://localhost:9222/json/version');
    return r.ok;
  } catch { return false; }
}

// Spawn a subprocess per tick so each call gets a fresh CDP connection slot.
// shortcut: one subprocess per tick; fine at 20s interval, adds ~200ms latency
function fetchPineTables(corePath, studyFilter) {
  return new Promise((resolve, reject) => {
    const script = `
const { data } = await import(${JSON.stringify(corePath)});
const r = await data.getPineTables({ study_filter: ${JSON.stringify(studyFilter)} });
process.stdout.write(JSON.stringify(r), () => process.exit(0));
`;
    const child = spawn('node', ['--input-type=module', '--eval', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    });
    let out = '';
    child.stdout.on('data', d => out += d);
    child.on('close', (code) => {
      if (code === 0) { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } }
      else reject(new Error(`getPineTables subprocess exit ${code}`));
    });
    child.on('error', reject);
  });
}

// --- Poll tick ---

async function tick(corePath, webhookUrl, studyFilter, symbolLabel) {
  const ok = await isCdpAlive();
  if (!ok) { console.log('[watcher] CDP not reachable — skipping tick'); return; }

  const { studies } = await fetchPineTables(corePath, studyFilter);
  if (!studies.length) { console.warn('[watcher] indicator not visible — skipping tick'); return; }

  const rows = extractSignalRows(studies);
  const lastSig = await loadSignature();

  if (lastSig === null) {
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

  const run = () => tick(TV_MCP_CORE, DISCORD_WEBHOOK_URL, STUDY_FILTER, SYMBOL_LABEL)
    .catch(e => console.error('[watcher]', e.message));

  console.log(`[watcher] starting — symbol=${SYMBOL_LABEL} filter=${STUDY_FILTER} interval=${INTERVAL_MS}ms`);
  await run();
  setInterval(run, Number(INTERVAL_MS));
}
