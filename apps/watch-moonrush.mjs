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
