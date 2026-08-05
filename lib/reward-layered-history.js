'use strict';
// lib/reward-layered-history.js — SERVER-SIDE depth resolver for layered scoring. Prefers the persisted
// per-level history agent34 writes (data/mid-history-*.jsonl) for the markets it subscribes to; falls back
// to ONE live per-level read from /tmp/clob-live-books.json for everything else. Returns depth aligned to
// layer index (nearest-mid first) plus a disclosed source, so the row can say "stima da storico Nh" vs
// "stima da lettura live" — never present the two identically. Reads files → server only (API + scripts).
const fs = require('fs');
const path = require('path');
const { levelsInBand } = require('./reward-layers');

const { DATA_DIR } = require('./safety/store');
const LIVE_BOOKS = '/tmp/clob-live-books.json';
// WINDOW: 30 min. At the 75s sampler that is ~24 samples. We take the per-index MEDIAN over the window,
// not the most recent single sample: a single snapshot of resting size is noisy (limit orders flicker in
// and out between 75s samples), while the reward accrues continuously over the epoch — so a short trailing
// median is a more faithful estimate of the depth you actually compete against, and it resists one
// anomalous snapshot (a momentary whale order) far better than a mean would.
const DEFAULT_WINDOW_MS = 30 * 60 * 1000;

function median(nums) {
  const a = nums.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function dailyMidFiles() {
  let files;
  try { files = fs.readdirSync(DATA_DIR); } catch { return []; }
  return files.filter((f) => /^mid-history-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().map((f) => path.join(DATA_DIR, f));
}

/**
 * History path: per-index median depth for a market over the trailing window.
 * @returns {{ source:{kind:'storico',hours:number}, perLevel:Array<{index,bidSizeAtLevel,askSizeAtLevel,samples}>, rows:number } | null}
 *   null when the market has NO persisted rows in the window (not subscribed) → caller falls back to live.
 */
function readLayeredDepthHistory(marketId, opts = {}) {
  const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : DEFAULT_WINDOW_MS;
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : null; // injectable for deterministic tests
  // Read the two newest daily files (window never spans more), newest rows for this market.
  const files = dailyMidFiles().slice(-2);
  const perIndexBid = new Map(); // index → [sizes]
  const perIndexAsk = new Map();
  let rows = 0;
  let latestTs = null;
  // First pass to find the latest ts for this market (so the window is relative to real data, not wall clock).
  const marketRows = [];
  for (const f of files) {
    let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of txt.split('\n')) {
      if (!line || line.indexOf(marketId) < 0) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.marketId !== marketId || !Array.isArray(o.levels)) continue;
      const t = Date.parse(o.ts);
      if (!Number.isFinite(t)) continue;
      marketRows.push({ t, levels: o.levels });
      if (latestTs == null || t > latestTs) latestTs = t;
    }
  }
  if (!marketRows.length) return null;
  const anchor = nowMs != null ? nowMs : latestTs;
  const from = anchor - windowMs;
  for (const r of marketRows) {
    if (r.t < from) continue;
    rows++;
    for (const lv of r.levels) {
      if (lv.bidSizeAtLevel != null) { if (!perIndexBid.has(lv.index)) perIndexBid.set(lv.index, []); perIndexBid.get(lv.index).push(lv.bidSizeAtLevel); }
      if (lv.askSizeAtLevel != null) { if (!perIndexAsk.has(lv.index)) perIndexAsk.set(lv.index, []); perIndexAsk.get(lv.index).push(lv.askSizeAtLevel); }
    }
  }
  if (!rows) return null;
  const maxIndex = Math.max(0, ...[...perIndexBid.keys(), ...perIndexAsk.keys()]);
  const perLevel = [];
  for (let idx = 1; idx <= maxIndex; idx++) {
    const b = perIndexBid.get(idx) || [];
    const a = perIndexAsk.get(idx) || [];
    perLevel.push({
      index: idx,
      bidSizeAtLevel: b.length ? median(b) : null, // null preserved: a level never seen readable stays "—"
      askSizeAtLevel: a.length ? median(a) : null,
      samples: Math.max(b.length, a.length),
    });
  }
  const hours = Math.round((windowMs / 3_600_000) * 10) / 10;
  return { source: { kind: 'storico', hours }, perLevel, rows };
}

/**
 * Live path: ONE per-level read from the live-book ladder for a market not in agent34's subscribed set.
 * @returns {{ source:{kind:'live'}, perLevel } | null}
 */
function readLayeredDepthLive(marketId, bandLow, bandHigh, tick, minSize, opts = {}) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(opts.liveBooksFile || LIVE_BOOKS, 'utf8')); } catch { return null; }
  const mk = doc.markets || {};
  const entry = mk[marketId];
  const yes = entry && entry.yes;
  if (!yes || !yes.levels) return null;
  const levels = levelsInBand(yes.levels.bids, yes.levels.asks, bandLow, bandHigh, tick, minSize);
  return { source: { kind: 'live' }, perLevel: levels };
}

/** Resolve depth for a market: history first (subscribed), live fallback (not subscribed). null if neither. */
function resolveLayeredDepth(marketId, geom = {}, opts = {}) {
  const hist = readLayeredDepthHistory(marketId, opts);
  if (hist && hist.rows > 0) return hist;
  return readLayeredDepthLive(marketId, geom.bandLow, geom.bandHigh, geom.tick, geom.minSize, opts);
}

/** Read the last `maxBytes` of a file as UTF-8 (whole file if smaller). Cheap tail — the 30-min window
 *  is a small slice of the day's ~40MB journal, so we never parse the whole file per request. */
function tailBytes(file, maxBytes) {
  let fd = null;
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    fd = fs.openSync(file, 'r');
    const len = st.size - start;
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } catch { return ''; } finally { if (fd != null) { try { fs.closeSync(fd); } catch {} } }
}

/**
 * BATCH history read for many markets in ONE pass over the newest journal's tail — the API path. Builds
 * a marketId → { source, perLevel, rows } map so a board of ~60 subscribed markets costs one ~4MB tail
 * read, not 60 whole-file reads.
 * @param {Set<string>|Array<string>} marketIds  restrict to these (the served board); omit for all
 * @returns {Map<string, {source:{kind:'storico',hours:number}, perLevel:Array, rows:number}>}
 */
function readLayeredDepthHistoryBatch(marketIds, opts = {}) {
  const want = marketIds ? new Set(marketIds) : null;
  const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : DEFAULT_WINDOW_MS;
  // ~4MB tail comfortably covers a 30-min window at the current row size + cadence, with margin.
  const tailMaxBytes = Number.isFinite(opts.tailMaxBytes) ? opts.tailMaxBytes : 4 * 1024 * 1024;
  const files = dailyMidFiles().slice(-1); // newest day only; the window never spans days
  const out = new Map();
  if (!files.length) return out;
  const text = tailBytes(files[0], tailMaxBytes);
  if (!text) return out;
  const lines = text.split('\n');
  // Drop a possibly-truncated first line from the byte tail.
  const rowsByMkt = new Map();
  let globalLatest = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o || !o.marketId || !Array.isArray(o.levels)) continue;
    if (want && !want.has(o.marketId)) continue;
    const t = Date.parse(o.ts);
    if (!Number.isFinite(t)) continue;
    if (!rowsByMkt.has(o.marketId)) rowsByMkt.set(o.marketId, []);
    rowsByMkt.get(o.marketId).push({ t, levels: o.levels });
    if (globalLatest == null || t > globalLatest) globalLatest = t;
  }
  const hours = Math.round((windowMs / 3_600_000) * 10) / 10;
  for (const [mid, rows] of rowsByMkt) {
    const latest = rows.reduce((m, r) => (r.t > m ? r.t : m), 0);
    const from = latest - windowMs;
    const perIndexBid = new Map(), perIndexAsk = new Map();
    let n = 0;
    for (const r of rows) {
      if (r.t < from) continue;
      n++;
      for (const lv of r.levels) {
        if (lv.bidSizeAtLevel != null) { if (!perIndexBid.has(lv.index)) perIndexBid.set(lv.index, []); perIndexBid.get(lv.index).push(lv.bidSizeAtLevel); }
        if (lv.askSizeAtLevel != null) { if (!perIndexAsk.has(lv.index)) perIndexAsk.set(lv.index, []); perIndexAsk.get(lv.index).push(lv.askSizeAtLevel); }
      }
    }
    if (!n) continue;
    const maxIndex = Math.max(0, ...[...perIndexBid.keys(), ...perIndexAsk.keys()]);
    const perLevel = [];
    for (let idx = 1; idx <= maxIndex; idx++) {
      const b = perIndexBid.get(idx) || [], a = perIndexAsk.get(idx) || [];
      perLevel.push({ index: idx, bidSizeAtLevel: b.length ? median(b) : null, askSizeAtLevel: a.length ? median(a) : null, samples: Math.max(b.length, a.length) });
    }
    out.set(mid, { source: { kind: 'storico', hours }, perLevel, rows: n });
  }
  return out;
}

module.exports = { readLayeredDepthHistory, readLayeredDepthHistoryBatch, readLayeredDepthLive, resolveLayeredDepth, median, tailBytes, DEFAULT_WINDOW_MS };
