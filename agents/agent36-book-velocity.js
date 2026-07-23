#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// agent36-book-velocity — BOOK VELOCITY DETECTOR.
//
// WHAT IT DETECTS
//   Rapid, non-reverting movement of the EXECUTABLE price on the markets we quote
//   or track liquidity rewards on. For a liquidity provider that is adverse
//   selection in progress: resting orders are about to be picked off at a stale
//   price, and the book is the fastest free signal that it is happening.
//
// WHAT IT DOES NOT DO — stated up front so no reader over-reads the alert:
//   • It detects MOVEMENT, never CAUSES. There is no news feed, no sentiment, no
//     inference. The alert says "the price moved this far, this fast, over this
//     much depth" and nothing else.
//   • It CANNOT distinguish informed trading from a large uninformed order. Both
//     look identical in the book, and pretending otherwise would be fabrication.
//
// COST / SAFETY
//   • Read-only. No order path exists in this process. Zero Claude calls.
//   • TWO free keyless HTTP requests per cycle, both already used elsewhere in the
//     tree: POST clob.polymarket.com/books (all Poly tokens in ONE batch) and
//     GET api.elections.kalshi.com/.../markets?tickers= (all Kalshi tickers in ONE
//     batch). No paid endpoint, no new dependency. €0.
//   • SINGLE-WRITER: this agent owns data/book-velocity.jsonl and
//     /tmp/book-velocity-state.json and writes nothing else. It READS agent24's
//     and agent25's outputs and never writes to them.
//
// MATH LIVES IN lib/book-velocity.js — the same pure functions the calibration
// script replays over recorded history, so the shipped detector and the backtest
// cannot drift apart. This file is I/O, scheduling, and alerting only.
// ─────────────────────────────────────────────────────────────────────────────

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const { httpGet } = require('../lib/httpGet');
const bv    = require('../lib/book-velocity');

// ── files ────────────────────────────────────────────────────────────────────
const POLY_REWARDS   = path.join(__dirname, '..', 'data', 'liquidity-rewards.json'); // agent24 — READ ONLY
const KALSHI_REWARDS = path.join(__dirname, '..', 'data', 'kalshi-rewards.json');    // agent25 — READ ONLY
const OUT_FILE       = path.join(__dirname, '..', 'data', 'book-velocity.jsonl');    // WE OWN THIS
const STATE_FILE     = '/tmp/book-velocity-state.json';                              // WE OWN THIS
const HB_FILE        = '/tmp/agent-heartbeats.json';

const CLOB_BOOKS_URL = 'https://clob.polymarket.com/books';
const KALSHI_BASE    = 'https://api.elections.kalshi.com/trade-api/v2';

// ── cadence ──────────────────────────────────────────────────────────────────
// MEASURED HEADROOM (scripts/book-velocity-calibrate.js probe, 2026-07-23):
//   Polymarket POST /books — 120 tokens in ONE request, ~100ms, 473KB; 20
//     back-to-back calls sustained 11.1 req/s with ZERO 429s and no rate-limit
//     headers returned.
//   Kalshi GET /markets?tickers= — 200 tickers in ONE request, ~450ms; 15
//     sequential calls sustained 8.3 req/s with zero errors.
// We poll at 10s = 0.1 req/s per venue, ~1% of the demonstrated ceiling. That is
// deliberate: the detector must never be the reason another agent gets throttled,
// and 10s already gives 6 samples inside the 60s horizon and 18 inside the 180s
// hold window — more resolution than the calibrated thresholds can consume.
const POLL_MS          = 10_000;
const WATCHLIST_MS     = 5 * 60_000;   // re-read agent24/agent25 output for adds/drops
const STARTUP_DELAY_MS = 5_000;

// ── memory bounds ────────────────────────────────────────────────────────────
// We need horizon (60s) + hold (180s) + slack. At 10s that is 24 samples; we keep
// 40 to survive a few missed cycles. Nothing accumulates across cycles beyond this.
const RING = 40;
const MAX_PENDING_PER_MARKET = 4;

const log = (...a) => console.log(new Date().toISOString(), '[agent36]', ...a);

// ── small helpers ────────────────────────────────────────────────────────────
function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function atomicWrite(file, obj) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}
function heartbeat() {
  const hb = readJsonSafe(HB_FILE) || {};
  hb['agent36-book-velocity'] = Date.now();
  try { atomicWrite(HB_FILE, hb); } catch { /* heartbeat is best-effort */ }
}
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

function httpPostJson(url, body, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const b = JSON.stringify(body);
    const req = https.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) },
    }, r => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(new Error(`bad JSON from ${url}: ${e.message}`)); }
      });
      r.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.write(b); req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// WATCHLIST — read agent24 + agent25 output. We never modify those files.
//
// THIN BOOK: taken straight from the flags agent24/agent25 already computed and
// that lib/reward-gating.ts gates on (isSanePolymarketLevel checks the per-level
// flags array; isSaneKalshiMarket checks flags.THIN_CAP). This agent is a plain
// Node script and cannot import the .ts gate, so it consumes the SAME flag the
// gate consumes rather than re-deriving the 2%/day rule anywhere.
// ─────────────────────────────────────────────────────────────────────────────
function buildWatchlist() {
  const poly = [], kalshi = [];

  const lr = readJsonSafe(POLY_REWARDS);
  for (const m of (lr && lr.markets) || []) {
    if (!m.tokenId || !(m.rewardsMinSize > 0)) continue;   // unknown qualifying size → no signal
    const levels = m.levels || {};
    const thinBook = Object.values(levels).some(lv => lv && lv.thinBookFlag === true);
    poly.push({
      venue: 'polymarket',
      id: String(m.conditionId),
      tokenId: String(m.tokenId),
      title: m.question || m.groupItemTitle || m.marketSlug || String(m.conditionId),
      minSize: m.rewardsMinSize,
      thinBook,
    });
  }

  const kr = readJsonSafe(KALSHI_REWARDS);
  for (const m of (kr && kr.markets) || []) {
    if (!m.ticker || !(m.min_size > 0)) continue;
    kalshi.push({
      venue: 'kalshi',
      id: String(m.ticker),
      title: m.question || String(m.ticker),
      minSize: m.min_size,
      thinBook: !!(m.flags && m.flags.THIN_CAP),
    });
  }
  return { poly, kalshi };
}

// ─────────────────────────────────────────────────────────────────────────────
// POLLING — one batched request per venue.
// Returns snapshots keyed venue::id. A market missing from a response, or with an
// unreadable book, simply produces NO snapshot: it is a hole in the series, never
// a carried-forward or zero-filled value.
// ─────────────────────────────────────────────────────────────────────────────
function bestFromLadder(book) {
  const bids = (book.bids || []).map(o => [num(o.price), num(o.size)]).filter(x => x[0] != null && x[1] != null);
  const asks = (book.asks || []).map(o => [num(o.price), num(o.size)]).filter(x => x[0] != null && x[1] != null);
  if (!bids.length || !asks.length) return null;
  bids.sort((a, b) => b[0] - a[0]);      // best bid = highest
  asks.sort((a, b) => a[0] - b[0]);      // best ask = lowest
  return { bid: bids[0][0], bidSz: bids[0][1], ask: asks[0][0], askSz: asks[0][1] };
}

async function pollPolymarket(list, t) {
  if (!list.length) return [];
  const byToken = new Map(list.map(m => [m.tokenId, m]));
  const books = await httpPostJson(CLOB_BOOKS_URL, list.map(m => ({ token_id: m.tokenId })));
  const out = [];
  for (const b of Array.isArray(books) ? books : []) {
    const m = byToken.get(String(b.asset_id));
    if (!m) continue;
    const best = bestFromLadder(b);
    if (!best) continue;                               // unreadable book → no signal
    out.push({ m, snap: { t, ...best } });
  }
  return out;
}

async function pollKalshi(list, t) {
  if (!list.length) return [];
  const byTicker = new Map(list.map(m => [m.id, m]));
  const out = [];
  for (let i = 0; i < list.length; i += 200) {
    const batch = list.slice(i, i + 200).map(m => m.id);
    const r = await httpGet(`${KALSHI_BASE}/markets?limit=1000&tickers=${batch.join(',')}`, { timeoutMs: 25_000 });
    for (const k of (r.data && r.data.markets) || []) {
      const m = byTicker.get(k.ticker);
      if (!m) continue;
      const bid = num(k.yes_bid_dollars), ask = num(k.yes_ask_dollars);
      const bidSz = num(k.yes_bid_size_fp), askSz = num(k.yes_ask_size_fp);
      if (bid == null || ask == null || bidSz == null || askSz == null) continue;
      out.push({ m, snap: { t, bid, bidSz, ask, askSz } });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN LOOP
// ─────────────────────────────────────────────────────────────────────────────
const series  = new Map();   // key -> [{t,bid,ask,bidSz,askSz}] ring, ascending
const pending = new Map();   // key -> [{pair, market}] awaiting the hold window
let watchlist = { poly: [], kalshi: [] };
let stats = { cycles: 0, detections: 0, persistent: 0, reverting: 0, unknown: 0, errors: 0 };

function loadState() { /* no persistent state yet — stats are in-memory only */ }
function saveState() {
  try { atomicWrite(STATE_FILE, { updatedAt: Date.now(), stats }); } catch { /* best effort */ }
}

function appendRow(row) {
  try { fs.appendFileSync(OUT_FILE, JSON.stringify(row) + '\n'); }
  catch (e) { log('append failed:', e.message); }
}

function push(key, snap) {
  let arr = series.get(key);
  if (!arr) { arr = []; series.set(key, arr); }
  arr.push(snap);
  if (arr.length > RING) arr.splice(0, arr.length - RING);
  return arr;
}

/** Pick the sample closest to exactly `horizonMs` before `now` from the ring. */
function anchorFor(arr, nowT) {
  const H = bv.DEFAULTS.horizonMs;
  let best = null, bestErr = Infinity;
  for (let i = 0; i < arr.length - 1; i++) {
    const gap = nowT - arr[i].t;
    if (gap <= 0) continue;
    const err = Math.abs(gap - H);
    if (err < bestErr) { bestErr = err; best = arr[i]; }
  }
  return best;
}

/**
 * Turn one resolved detection into an append-only log row.
 *
 * Every detection is recorded regardless of how it classified — the log is the
 * complete record of what the detector saw, not a filtered highlight reel.
 *
 * @param {{market:object,key:string,pair:object,cls:object,now:number,
 *          deps?:{append?:Function,stats?:object}}} ctx
 */
async function resolveDetection(ctx) {
  const { market: m, pair, cls, now } = ctx;
  const d = ctx.deps || {};
  const append = d.append || appendRow;
  const st     = d.stats  || stats;

  const row = {
    ts: now,
    venue: m.venue,
    marketId: m.id,
    title: m.title,
    minSize: m.minSize,
    thinBook: !!m.thinBook,
    t0: pair.t0, t1: pair.t1, elapsedMs: pair.elapsedMs,
    bid0: pair.bid0, ask0: pair.ask0, bid1: pair.bid1, ask1: pair.ask1,
    bidSz0: pair.bidSz0, askSz0: pair.askSz0, bidSz1: pair.bidSz1, askSz1: pair.askSz1,
    depthUsd0: pair.depthUsd0, depthUsd1: pair.depthUsd1,
    moveCents: pair.moveCents, direction: pair.direction,
    depthWeight: pair.depthWeight, nv: pair.nv,
    state: cls.state, retention: cls.retention, pxHold: cls.pxHold, holdElapsedMs: cls.holdElapsedMs,
  };

  // Only a PERSISTENT move is adverse selection. A move that snapped back is noise
  // a maker profits from — still recorded, and marked as such.
  if (cls.state === 'PERSISTENT') st.persistent++;
  else if (cls.state === 'REVERTING') st.reverting++;
  else st.unknown++;

  append(row);
  return row;
}

async function cycle() {
  const t = Date.now();
  let snaps = [];
  const [pRes, kRes] = await Promise.allSettled([
    pollPolymarket(watchlist.poly, t),
    pollKalshi(watchlist.kalshi, t),
  ]);
  if (pRes.status === 'fulfilled') snaps = snaps.concat(pRes.value); else { stats.errors++; log('poly poll failed:', pRes.reason.message); }
  if (kRes.status === 'fulfilled') snaps = snaps.concat(kRes.value); else { stats.errors++; log('kalshi poll failed:', kRes.reason.message); }

  for (const { m, snap } of snaps) {
    const key = `${m.venue}::${m.id}`;
    const arr = push(key, snap);

    // ── 1. resolve any pending detection whose hold window has now elapsed ────
    const pend = pending.get(key);
    if (pend && pend.length) {
      const still = [];
      for (const p of pend) {
        const cls = bv.classifyHold(p.pair, snap);
        if (cls.state === 'UNKNOWN' && (snap.t - p.pair.t1) < bv.DEFAULTS.holdMs * 3) { still.push(p); continue; }
        await resolveDetection({ market: m, key, pair: p.pair, cls, now: snap.t });
      }
      if (still.length) pending.set(key, still); else pending.delete(key);
    }

    // ── 2. look for a new detection at the calibrated horizon ────────────────
    const anchor = anchorFor(arr, snap.t);
    if (!anchor) continue;
    const pair = bv.velocityPair(anchor, snap, { minSizeUsd: m.minSize });
    if (!pair || !bv.isDetection(pair)) continue;

    const list = pending.get(key) || [];
    // Don't stack overlapping detections on the same move — one pending per
    // horizon window is enough, and the queue stays bounded.
    if (list.some(p => Math.abs(p.pair.t1 - pair.t1) < bv.DEFAULTS.horizonMs)) continue;
    if (list.length >= MAX_PENDING_PER_MARKET) continue;
    list.push({ pair, market: m });
    pending.set(key, list);
    stats.detections++;
  }

  // Drop series for markets that left the watchlist, so nothing accumulates.
  const live = new Set([...watchlist.poly, ...watchlist.kalshi].map(m => `${m.venue}::${m.id}`));
  for (const k of series.keys()) if (!live.has(k)) { series.delete(k); pending.delete(k); }

  stats.cycles++;
  heartbeat();
  if (stats.cycles % 30 === 0) {
    saveState();
    const mem = process.memoryUsage();
    log(`cycles=${stats.cycles} markets=${series.size} detections=${stats.detections} ` +
        `persistent=${stats.persistent} reverting=${stats.reverting} ` +
        `unknown=${stats.unknown} errors=${stats.errors} rss=${(mem.rss / 1048576).toFixed(0)}MB`);
  }
}

async function main() {
  log('starting — read-only book velocity detector; 2 free keyless requests per cycle; zero Claude calls');
  log(`thresholds: horizon=${bv.DEFAULTS.horizonMs / 1000}s hold=${bv.DEFAULTS.holdMs / 1000}s ` +
      `nv>=${bv.DEFAULTS.nvThreshold} minMove=${bv.DEFAULTS.minMoveCents}c retentionMin=${bv.DEFAULTS.retentionMin}`);
  loadState();
  await new Promise(r => setTimeout(r, STARTUP_DELAY_MS));

  watchlist = buildWatchlist();
  log(`watchlist: ${watchlist.poly.length} polymarket + ${watchlist.kalshi.length} kalshi reward markets`);
  setInterval(() => {
    const w = buildWatchlist();
    if (w.poly.length || w.kalshi.length) watchlist = w;
  }, WATCHLIST_MS);

  for (;;) {
    const t0 = Date.now();
    try { await cycle(); } catch (e) { stats.errors++; log('cycle error:', e.message); }
    const wait = POLL_MS - (Date.now() - t0);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }
}

process.on('SIGTERM', () => { saveState(); process.exit(0); });
process.on('SIGINT',  () => { saveState(); process.exit(0); });

if (require.main === module) main().catch(e => { log('fatal:', e.stack || e.message); process.exit(1); });

module.exports = { buildWatchlist, bestFromLadder, resolveDetection };
