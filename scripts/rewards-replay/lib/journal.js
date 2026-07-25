'use strict';
// scripts/rewards-replay/lib/journal.js — read agent34's mid-history journal (data/mid-history-*.jsonl).
// Confirms the schema against the ACTUAL rows (not the task description), groups by market, sorted by ts.
// OFFLINE, read-only. A row missing a field a computation needs is EXCLUDED and counted, never defaulted.
//
// SCHEMA (confirmed from the writer agent34-clob-ws.sampleMidHistory and the live rows):
//   ts, marketId, tokenIdYes, adjMid, plainMid, bestBid, bestAsk, bidDepthInBand, askDepthInBand,
//   bandLow, bandHigh, tick, src ("ws" | "stale")
// CADENCE: sampled every ~45s (env MID_HISTORY_INTERVAL_MS; the task's "15s" is stale — the file wins).

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');
const REQUIRED_KEYS = ['ts', 'marketId', 'tokenIdYes', 'adjMid', 'plainMid', 'bestBid', 'bestAsk',
  'bidDepthInBand', 'askDepthInBand', 'bandLow', 'bandHigh', 'tick', 'src'];

function listJournalFiles() {
  let files = [];
  try { files = fs.readdirSync(DATA_DIR); } catch { return []; }
  return files.filter((f) => /^mid-history-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().map((f) => path.join(DATA_DIR, f));
}

// Load the journal, optionally windowed to [fromMs, toMs]. Returns rows grouped by market (ts-sorted),
// the observation window, the ws/stale split, and a schema report. Never throws on a short/partial file.
function loadJournal({ fromMs = -Infinity, toMs = Infinity } = {}) {
  const files = listJournalFiles();
  const byMarket = new Map();
  let rows = 0, ws = 0, stale = 0, malformed = 0;
  let minTs = Infinity, maxTs = -Infinity;
  let schemaConfirmed = null, schemaMismatch = null;

  for (const file of files) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { malformed++; continue; }
      if (schemaConfirmed == null) {
        const missing = REQUIRED_KEYS.filter((k) => !(k in r));
        schemaConfirmed = missing.length === 0;
        if (!schemaConfirmed) schemaMismatch = missing;
      }
      const t = Date.parse(r.ts);
      if (!Number.isFinite(t) || t < fromMs || t > toMs) continue;
      rows++;
      if (t < minTs) minTs = t;
      if (t > maxTs) maxTs = t;
      if (r.src === 'stale') stale++; else if (r.src === 'ws') ws++;
      if (!byMarket.has(r.marketId)) byMarket.set(r.marketId, []);
      byMarket.get(r.marketId).push({ ...r, tsMs: t });
    }
  }
  for (const arr of byMarket.values()) arr.sort((a, b) => a.tsMs - b.tsMs);

  const windowHours = (Number.isFinite(minTs) && Number.isFinite(maxTs)) ? (maxTs - minTs) / 3_600_000 : 0;
  return {
    files: files.map((f) => path.basename(f)),
    rows, ws, stale, malformed,
    staleFrac: (ws + stale) > 0 ? stale / (ws + stale) : 0,
    window: { fromMs: Number.isFinite(minTs) ? minTs : null, toMs: Number.isFinite(maxTs) ? maxTs : null, hours: windowHours },
    byMarket,
    schemaConfirmed: !!schemaConfirmed,
    schemaMismatch,
    requiredKeys: REQUIRED_KEYS,
  };
}

// Nearest journal row for a market at target time, within ±toleranceMs (default half a 45s interval).
// Returns null when no sample is close enough (e.g., the horizon is beyond the collected window) — the
// caller EXCLUDES that horizon and counts it. Never interpolates/fabricates a value.
function rowNear(marketRows, targetMs, toleranceMs = 30_000) {
  let best = null, bestDelta = Infinity;
  // marketRows is ts-sorted; a linear scan is fine at this data size.
  for (const r of marketRows) {
    const d = Math.abs(r.tsMs - targetMs);
    if (d < bestDelta) { bestDelta = d; best = r; }
    if (r.tsMs > targetMs + toleranceMs) break;
  }
  return bestDelta <= toleranceMs ? best : null;
}

module.exports = { loadJournal, rowNear, listJournalFiles, DATA_DIR, REQUIRED_KEYS };
