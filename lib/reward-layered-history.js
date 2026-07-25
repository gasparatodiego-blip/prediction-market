'use strict';
// lib/reward-layered-history.js — SERVER-SIDE depth resolver for layered scoring. Prefers the persisted
// per-level history agent34 writes (data/mid-history-*.jsonl) for the markets it subscribes to; falls back
// to ONE live per-level read from /tmp/clob-live-books.json for everything else. Returns depth aligned to
// layer index (nearest-mid first) plus a disclosed source, so the row can say "stima da storico Nh" vs
// "stima da lettura live" — never present the two identically. Reads files → server only (API + scripts).
const fs = require('fs');
const path = require('path');
const { levelsInBand } = require('./reward-layers');

const DATA_DIR = path.join(__dirname, '..', 'data');
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

module.exports = { readLayeredDepthHistory, readLayeredDepthLive, resolveLayeredDepth, median, DEFAULT_WINDOW_MS };
