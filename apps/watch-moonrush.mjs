import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const __dir = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = resolve(__dir, 'last-signal.json');
const CAPTURE_SCRIPT = resolve(__dir, 'capture-chart.mjs');

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

export function extractDirection(rows) {
  for (const r of rows) {
    if (/\b(buy|long)\b/i.test(r)) return 'BULL';
    if (/\b(sell|short)\b/i.test(r)) return 'BEAR';
  }
  return null;
}

export function isNewSignal(rows, lastDir) {
  const dir = extractDirection(rows);
  return dir !== null && dir !== lastDir;
}

// Pull numbers out of the signal rows. Handles "Entry: 4056.66 (BUY)" (live) and "Buy @ 2340.50".
export function parseSignal(rows) {
  const text = rows.join('\n');
  const num = m => (m ? Number(m[1].replace(/,/g, '')) : null);
  const entry = num(text.match(/entry\s*:?\s*([\d,]+(?:\.\d+)?)/i)) ?? num(text.match(/\b(?:buy|sell|long|short)\s*@\s*([\d,]+(?:\.\d+)?)/i));
  const sl = num(text.match(/\bSL\s*:?\s*([\d,]+(?:\.\d+)?)/i));
  const tps = [1, 2, 3].map(n => num(text.match(new RegExp(`\\bTP${n}\\s*:?\\s*([\\d,]+(?:\\.\\d+)?)`, 'i'))));
  return { direction: extractDirection(rows), entry, sl, tps };
}

// MTF dashboard rows ("5m | Bullish | 68.48") → { chartRsi, trends: [{tf, bull}] }
export function parseMtf(studies) {
  const rows = studies.flatMap(s => s.tables.flatMap(t => t.rows));
  const trends = [];
  let chartRsi = null;
  for (const r of rows) {
    const m = r.match(/^\s*(Chart|\d+[mhdw])\s*\|\s*(Bullish|Bearish)\s*\|\s*([\d.]+)/i);
    if (!m) continue;
    if (/^chart$/i.test(m[1])) chartRsi = Number(m[3]);
    else trends.push({ tf: m[1], bull: /bullish/i.test(m[2]) });
  }
  return { chartRsi, trends };
}

const BULL_GREEN = 0x2ecc71, BEAR_RED = 0xe74c3c;
const fmt = n => (n == null ? '—' : String(n));

export function resolutionLabel(res) {
  const s = String(res ?? '');
  if (/^\d+$/.test(s)) { const m = Number(s); return m % 60 === 0 ? `${m / 60}h` : `${m}m`; }
  return s || '?';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Local wall-clock "DD Mon HH:MM:SS" (time the notification is sent).
export function formatLocalDateTime(d) {
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())} ${MONTHS[d.getMonth()]} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Discord embed object. `image` true → embed references attachment://chart.png.
export function buildEmbed({ signal, chart, mtf, rows, label, image = false, now = new Date() }) {
  const bull = signal.direction === 'BULL';
  const side = bull ? 'BUY' : 'SELL';
  const symbol = chart?.symbol?.split(':').pop() ?? label;
  const sign = bull ? 1 : -1;
  const delta = v => (v == null || signal.entry == null ? '' : ` (${(sign * (v - signal.entry)) >= 0 ? '+' : ''}${(sign * (v - signal.entry)).toFixed(2)})`);
  const embed = {
    title: `${bull ? '🟢' : '🔴'} ${side} ${symbol} · ${resolutionLabel(chart?.resolution)} · ${formatLocalDateTime(now)}`,
    color: bull ? BULL_GREEN : BEAR_RED,
    footer: { text: 'MoonRush V2' },
    timestamp: (chart?.barTime ? new Date(chart.barTime * 1000) : now).toISOString(),
    fields: [],
  };
  if (signal.entry == null) {
    embed.description = '```\n' + rows.join('\n').slice(0, 1800) + '\n```'; // unparseable → raw rows, never drop a signal
  } else {
    embed.fields.push({ name: 'Entry', value: fmt(signal.entry), inline: true });
    embed.fields.push({ name: 'SL', value: signal.sl == null ? 'off' : `${signal.sl}${delta(signal.sl)}`, inline: true });
    embed.fields.push({ name: '​', value: '​', inline: true });
    signal.tps.forEach((tp, i) => { if (tp != null) embed.fields.push({ name: `TP${i + 1}`, value: `${tp}${delta(tp)}`, inline: true }); });
  }
  if (mtf?.trends?.length) {
    embed.fields.push({ name: 'MTF', value: mtf.trends.map(t => `${t.tf} ${t.bull ? '🟢' : '🔴'}`).join('  '), inline: false });
  }
  if (mtf?.chartRsi != null) embed.fields.push({ name: 'RSI', value: String(mtf.chartRsi), inline: true });
  if (image) embed.image = { url: 'attachment://chart.png' };
  return embed;
}

// --- State ---

// Direction is stored per "symbol|resolution" so switching chart/timeframe never looks like a flip.
export function stateKey(chart) {
  return chart ? `${chart.symbol ?? '?'}|${chart.resolution ?? '?'}` : 'unknown';
}

async function readState() {
  try {
    const s = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    return s.directions && typeof s.directions === 'object' ? s.directions : {};
  } catch { return {}; }
}

async function loadDirection(key) {
  return (await readState())[key] ?? null;
}

async function saveDirection(key, dir) {
  const directions = await readState();
  directions[key] = dir;
  await writeFile(STATE_FILE, JSON.stringify({ directions }));
}

// --- Discord ---

// embed + optional PNG buffer (attached as chart.png and shown inside the embed).
async function postDiscord(webhookUrl, embed, png) {
  let res;
  if (png) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ embeds: [embed] }));
    form.append('files[0]', new Blob([png], { type: 'image/png' }), 'chart.png');
    res = await fetch(webhookUrl, { method: 'POST', body: form });
  } else {
    res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
  }
  if (!res.ok) throw new Error(`Discord POST ${res.status}`);
}

// Zoom chart to latest bars + screenshot in a subprocess. Never throws: null = post without image.
function captureChartPng(corePath, bars) {
  return new Promise(resolve => {
    const connUrl = corePath.replace(/core\/index\.js$/, 'connection.js');
    const child = spawn('node', [CAPTURE_SCRIPT, connUrl, String(bars)], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('close', code => {
      if (code === 0 && out) resolve(Buffer.from(out, 'base64'));
      else { console.warn(`[watcher] screenshot failed (exit ${code}): ${err.trim().slice(0, 200)}`); resolve(null); }
    });
    child.on('error', e => { console.warn('[watcher] screenshot error:', e.message); resolve(null); });
  });
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
try {
  const o = await data.getOhlcv({ count: 1 });
  const { evaluate } = await import(${JSON.stringify(corePath.replace(/core\/index\.js$/, 'connection.js'))});
  const res = await evaluate('window.TradingViewApi._activeChartWidgetWV.value().resolution()');
  r.chart = { symbol: await evaluate('window.TradingViewApi._activeChartWidgetWV.value().symbol()'), barTime: o.bars[o.bars.length - 1].time, resolution: String(res) };
} catch {}
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

// --- TradingView-time scheduling ---

// Resolution string → seconds. Only plain-minute resolutions ("5", "60") are supported.
export function resolutionToSec(res) {
  return /^\d+$/.test(String(res)) ? Number(res) * 60 : null;
}

// ms until startSec after the next bar close, derived from the chart's own last-bar
// timestamp (epoch, so independent of local timezone/offset), not the local wall clock.
export function msUntilBarClose(lastBarTimeSec, intervalSec, startSec, nowMs = Date.now()) {
  const step = intervalSec * 1000;
  let next = lastBarTimeSec * 1000 + step + startSec * 1000;
  if (next <= nowMs) next += Math.ceil((nowMs - next + 1) / step) * step;
  return next - nowMs;
}

// --- Poll tick ---

let lastChart = null; // { barTime, resolution } from the TradingView chart

// Build embed (+ optional zoomed chart PNG) for the current signal.
async function buildNotification({ corePath, studies, chart, rows, label, screenshot, bars }) {
  const png = screenshot ? await captureChartPng(corePath, bars) : null;
  const embed = buildEmbed({ signal: parseSignal(rows), chart, mtf: parseMtf(studies), rows, label, image: !!png });
  return { embed, png };
}

// webhookUrl set (--send-test) → also post once to Discord; saved direction state is never touched.
async function dryRun(corePath, studyFilter, label, screenshot, bars, webhookUrl = null) {
  const { studies, chart } = await fetchPineTables(corePath, studyFilter);
  const rows = extractSignalRows(studies);
  if (!rows.length) { console.error('[dry-run] no signal rows — is MoonRush visible?'); process.exit(1); }
  const { embed, png } = await buildNotification({ corePath, studies, chart, rows, label, screenshot, bars });
  console.log(JSON.stringify({ embeds: [embed] }, null, 2));
  if (png) { await writeFile(resolve(__dir, '..', 'data', 'dry-run-chart.png'), png); console.log(`[dry-run] chart.png ${png.length} bytes → data/dry-run-chart.png`); }
  else if (screenshot) console.log('[dry-run] no screenshot captured');
  if (webhookUrl) { await postDiscord(webhookUrl, embed, png); console.log('[send-test] posted to Discord'); }
  process.exit(0);
}

async function tick(corePath, webhookUrl, studyFilter, symbolLabel, screenshot, bars) {
  const ok = await isCdpAlive();
  if (!ok) { console.log('[watcher] CDP not reachable — skipping tick'); return; }

  const { studies, chart } = await fetchPineTables(corePath, studyFilter);
  if (chart) lastChart = chart;
  if (!studies.length) { console.warn('[watcher] indicator not visible — skipping tick'); return; }

  const rows = extractSignalRows(studies);
  const key = stateKey(chart);
  const lastDir = await loadDirection(key);

  if (lastDir === null) {
    if (rows.length) await saveDirection(key, extractDirection(rows));
    console.log(`[watcher] baseline recorded for ${key}`);
    return;
  }

  if (isNewSignal(rows, lastDir)) {
    const { embed, png } = await buildNotification({ corePath, studies, chart, rows, label: symbolLabel, screenshot, bars });
    await postDiscord(webhookUrl, embed, png); // throw = Discord down → don't persist
    await saveDirection(key, extractDirection(rows));
    console.log(`[watcher] signal posted (${key}):`, rows[0]);
  } else {
    console.log(`[watcher] ${new Date().toLocaleTimeString()} alive ${key} — dir=${extractDirection(rows) ?? '?'}`);
  }
}

// Fallback (local clock) when chart time is unavailable. Returns ms until the :05 second of the next N-minute boundary (e.g. :00:05, :05:05, :10:05).
function msUntilNext(intervalMin, startSec) {
  const now = new Date();
  const target = new Date(now);
  const nextM = Math.ceil(now.getMinutes() / intervalMin) * intervalMin;
  target.setMinutes(nextM, startSec, 0);
  if (target <= now) target.setMinutes(target.getMinutes() + intervalMin);
  return target - now;
}

// --- Entry point (only when run directly) ---

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {
    TV_MCP_CORE,
    DISCORD_WEBHOOK_URL,
    INTERVAL_MIN = '5',
    START_SEC    = '5',
    STUDY_FILTER = 'MoonRush',
    SYMBOL_LABEL = 'XAUUSD',
    SCREENSHOT   = '1',
    CHART_BARS   = '80',
  } = process.env;

  if (!TV_MCP_CORE)         { console.error('TV_MCP_CORE is required');         process.exit(1); }
  const screenshot = SCREENSHOT !== '0';
  const bars = Number(CHART_BARS);
  const sendTest = process.argv.includes('--send-test');
  if (sendTest && !DISCORD_WEBHOOK_URL) { console.error('DISCORD_WEBHOOK_URL is required for --send-test'); process.exit(1); }
  if (sendTest || process.argv.includes('--dry-run')) await dryRun(TV_MCP_CORE, STUDY_FILTER, SYMBOL_LABEL, screenshot, bars, sendTest ? DISCORD_WEBHOOK_URL : null);
  if (!DISCORD_WEBHOOK_URL) { console.error('DISCORD_WEBHOOK_URL is required'); process.exit(1); }

  const intervalMin = Number(INTERVAL_MIN);
  const startSec    = Number(START_SEC);
  const run = () => tick(TV_MCP_CORE, DISCORD_WEBHOOK_URL, STUDY_FILTER, SYMBOL_LABEL, screenshot, bars)
    .catch(e => console.error('[watcher]', e.message));

  const nextDelay = () => {
    const sec = lastChart && resolutionToSec(lastChart.resolution);
    return sec ? msUntilBarClose(lastChart.barTime, sec, startSec) : msUntilNext(intervalMin, startSec);
  };
  const loop = async () => { await run(); setTimeout(loop, nextDelay()); };
  await run(); // prime chart time so the first tick is already aligned to TradingView
  const delay = nextDelay();
  console.log(`[watcher] starting — symbol=${SYMBOL_LABEL} filter=${STUDY_FILTER} interval=${intervalMin}min @:${String(startSec).padStart(2,'0')}, first tick in ${Math.round(delay / 1000)}s`);
  setTimeout(loop, delay);
}
