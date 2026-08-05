'use strict';
// lib/reward-layered-enrich.js — SERVER-SIDE: attach per-market `layeredDepth` (per-level depth + source)
// to a served rewards board so the client can recompute layered scoring reactively. History-preferred
// (agent34's persisted per-level medians, ONE cached tail read for the whole board) with a live-ladder
// fallback for anything not in history. The client already has mid / maxSpread / tick, so we add ONLY the
// depth — never the geometry (that stays the shared lib/reward-layers, computed identically client-side).
const fs = require('fs');
const { readLayeredDepthHistoryBatch, readLayeredDepthLive } = require('./reward-layered-history');

const LIVE_BOOKS = '/tmp/clob-live-books.json';
const MID_DIR = require('./safety/store').DATA_DIR;

// Cache the batch history read across requests — it is a ~4MB tail parse, and the board is fetched every
// ~60s. Invalidate on the newest journal's size (append-only, so size strictly grows as data lands).
let _cache = { key: null, batch: null, at: 0 };
function newestMidStat() {
  try {
    const f = fs.readdirSync(MID_DIR).filter((x) => /^mid-history-\d{4}-\d{2}-\d{2}\.jsonl$/.test(x)).sort().slice(-1)[0];
    if (!f) return null;
    const st = fs.statSync(require('path').join(MID_DIR, f));
    return `${f}:${st.size}`;
  } catch { return null; }
}

function batchHistory(ids, opts) {
  const key = newestMidStat();
  if (_cache.batch && _cache.key === key) return _cache.batch;
  const batch = readLayeredDepthHistoryBatch(ids, opts || {});
  _cache = { key, batch, at: Date.now() };
  return batch;
}

/** True when a value is a usable positive number. */
function pos(x) { return typeof x === 'number' && Number.isFinite(x) && x > 0; }

/**
 * @param {Array} markets served rewards board (each: marketId, venue, tickSize, rewardScore{mid,maxSpreadCents,minSize})
 * @returns {Array} same markets, each with `layeredDepth: { source, perLevel } | null` added (non-mutating copy)
 */
function enrichLayeredDepth(markets, opts = {}) {
  if (!Array.isArray(markets)) return markets;
  const ids = markets.filter((m) => m && m.venue === 'polymarket' && m.marketId).map((m) => m.marketId);
  const hist = batchHistory(ids, opts);
  let live = null; // read the live ladder at most once, lazily, for the fallback path
  const getLive = () => { if (live === null) { try { live = JSON.parse(fs.readFileSync(opts.liveBooksFile || LIVE_BOOKS, 'utf8')); } catch { live = false; } } return live || null; };

  return markets.map((m) => {
    const rs = m && m.rewardScore;
    if (!m || m.venue !== 'polymarket' || !rs || !pos(rs.mid) || !pos(rs.maxSpreadCents) || !pos(m.tickSize)) {
      return { ...m, layeredDepth: null };
    }
    const h = hist.get(m.marketId);
    if (h && h.rows > 0) return { ...m, layeredDepth: { source: h.source, perLevel: h.perLevel } };
    // Live fallback: derive band from mid ± maxSpread/2, read the ladder once.
    const r = rs.maxSpreadCents / 200; // cents→price half-width
    const doc = getLive();
    const entry = doc && doc.markets ? doc.markets[m.marketId] : null;
    const yes = entry && entry.yes;
    if (!yes || !yes.levels) return { ...m, layeredDepth: null };
    const liveRead = readLayeredDepthLive(m.marketId, rs.mid - r, rs.mid + r, m.tickSize, rs.minSize, { liveBooksFile: opts.liveBooksFile });
    return { ...m, layeredDepth: liveRead ? { source: liveRead.source, perLevel: liveRead.perLevel } : null };
  });
}

module.exports = { enrichLayeredDepth };
