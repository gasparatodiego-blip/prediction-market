#!/usr/bin/env node
// agent20-leaderboard.js  — Polymarket Top Traders leaderboard by category
// READ-ONLY · Zero Claude API · No wallet · No orders
// Sources: gamma-api (events+categories+outcomePrices), data-api (trades)
// Rate limit: 2 req/sec  ·  Output: /tmp/leaderboard.json

'use strict';

const fs = require('fs');
const https = require('https');
const { rlGet } = require('../lib/rateLimitedFetch');  // per-host limiter — ALL new Polymarket calls route through this
const { fetchOpenPositions } = require('../lib/open-positions-fetch');  // complete OPEN set (default /positions under-counts)
const { chain }        = require('stream-chain');
const { parser }       = require('stream-json');
const { streamObject } = require('stream-json/streamers/stream-object.js');
const { once }         = require('events');

// ── Crash-proof boot ─────────────────────────────────────────────────────────
// Turn a hard unhandled death (which can leave pm2 with "Process not found")
// into a clean exit(1) that pm2 reliably auto-restarts. Log first so the cause
// is never swallowed. Ops-only: does not touch any displayed number.
process.on('unhandledRejection', (err) => {
  console.error('[LB] FATAL unhandledRejection:', (err && err.stack) || err);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('[LB] FATAL uncaughtException:', (err && err.stack) || err);
  process.exit(1);
});

const LEADERBOARD_FILE  = '/tmp/leaderboard.json';
const CACHE_FILE        = '/tmp/leaderboard-cache.json';
const HB_FILE           = '/tmp/agent-heartbeats.json';

const SCAN_INTERVAL_MS  = 30 * 60_000;   // 30-min cadence
const MAX_RPS           = 2.0;            // 2 req/sec (no other agent hitting Polymarket)
const MIN_MARKET_VOL    = 500;            // skip markets under $500 volume
const MIN_MARKETS_RANK     = 20;  // raised from 5 — 5 binary markets is statistically meaningless
const LOW_SAMPLE_THRESHOLD = 30;  // below this show a warning even if above the floor
const TOP_N_PER_CAT        = 25;
// A resolved market counts as a "win" only if realized P&L ≥ MIN_WIN_PNL ($). A +$0.01 MM/HFT
// scrape is NOT a directional win — this kills the "100% · 300-0" wall by recomputing win rate
// from stored per-market P&L (real recompute, never fabricated). Tunable.
const MIN_WIN_PNL = 1.00;
// The 300-market STORAGE cap (memory bound) stays; skill ranking uses resolvedTotal (true
// uncapped resolution count) + realized P&L as tie-breakers so perfect records don't all
// saturate the Wilson ceiling and tie.
const MAX_TRADES_PER_MKT = 400;           // 8 pages of 50
const MAX_CIDS_CACHED   = 1500;          // memory bound
const MAX_WALLETS_CACHED = 5000;         // memory bound — mirrors MAX_CIDS_CACHED
const WINDOW_DAYS       = 730;           // 2-year window (covers 2024 election, 2025 sports)
const MM_THRESHOLD_PCT  = 50;            // ≥50% two-sided markets → MM / NEUTRAL
const CLASSIFY_TOP_N    = 300;           // wallet-centric classification for top-N by volume
const CLASSIFY_STALE_DAYS = 7;          // re-classify wallet every 7 days

// ── Top Traders enrichment (additive per-trader dataset, schemaVersion 2) ──────
// Powers the Top Traders dashboard (leaderboard + profile + bots/HFT). Every field
// is real API-derived; actorType is a clearly-labeled heuristic (never a hard fact).
const LB_WINDOWS          = ['1d', '7d', '30d', 'all']; // lb-api leaderboard windows (confirmed public)
// lb-api HARD-CAPS at 50 rows — `limit`>50 and `offset` are both ignored (verified). So
// per-wallet `windows` populate ONLY for Polymarket's global top-50 by $ profit/volume in
// that window; every other (skill-ranked, smaller-$) trader is honestly null, never inferred.
const LB_WINDOW_LIMIT     = 50;
const MAX_ENRICH_WALLETS  = 200;    // cap per-wallet API fan-out per scan (rate-limit + €50/mo budget discipline)
const MAX_POSITIONS_OPEN  = 50;     // memory bound per trader
const MAX_TRADES_CLOSED    = 100;   // memory bound per trader (spec: last ~100)
const MAX_ACTIVITY_RECENT  = 20;    // spec: last ~20 raw trades
const ACTIVITY_FETCH_LIMIT = 500;   // deep enough to cover 24h ops counts for active wallets
const MAX_TITLE_CACHE      = 6000;  // opportunistic conditionId→title cache bound

// actorType heuristic thresholds — INFERENCE ONLY, never certainty. Per Diego's Top
// Traders spec; output is always { type, confidence, hft, signals[] }. A "bot" label
// is a confidence score + the observable signals that fired, never a bare fact.
const ACTOR_MIN_TRADES   = 10;    // below this: too little data → human / confidence 0
const ACTOR_TPH_AVG      = 10;    // trades/hour avg → high-frequency signal
const ACTOR_TPH_PEAK     = 30;    // trades in busiest hour → burst signal
const ACTOR_SUBMIN_SHARE = 0.30;  // share of <60s inter-trade gaps → machine-timing signal
const ACTOR_ACTIVE_HOURS = 20;    // distinct active UTC hours (of 24) → 24/7 / no-sleep signal
const ACTOR_SHORT_SHARE  = 0.50;  // share of trades in ≤15min markets → short-market focus / HFT
const ACTOR_BOT_CONF_MIN = 50;    // confidence ≥ this → labeled 'bot' (still with signals)

// Honest "win": realized P&L on a resolved market must clear MIN_WIN_PNL. Recomputed from the
// stored per-market pnl at build time (never fabricated) — near-zero MM/HFT scrapes and losses
// both fail, so win rate reflects real directional edge, not spread capture.
const isWin = (m) => (m.pnl || 0) >= MIN_WIN_PNL;

// Wilson 95% lower bound for binary win rate — penalizes small samples so
// a 16W/2L wallet outranks a 5W/0L one.  z=1.96 → 95% CI.
function wilsonLower(wins, n) {
  if (n === 0) return 0;
  const z   = 1.96;
  const z2  = z * z;
  const p   = wins / n;
  const den = 1 + z2 / n;
  const ctr = p + z2 / (2 * n);
  const mar = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
  return Math.max(0, (ctr - mar) / den);
}

// ── One-time migration: backfill twoSided for CIDs cached before this feature ─
// Re-fetches trades for every processedCid without twoSidedChecked flag.
// Rate-limited via the same queue; writes progress every 100 CIDs.
async function migrateAddTwoSided() {
  const toMigrate = Object.entries(processedCids)
    .filter(([, info]) => !info.twoSidedChecked)
    .sort((a, b) => (b[1].vol || 0) - (a[1].vol || 0)); // highest-volume first

  if (toMigrate.length === 0) { console.log('[LB] Migration: twoSided already up to date'); return; }
  console.log(`[LB] Migration: backfilling twoSided for ${toMigrate.length} cached CIDs`);

  let done = 0;
  for (const [cid, info] of toMigrate) {
    if (!info.winner) { processedCids[cid].twoSidedChecked = true; continue; }
    const trades = await fetchTrades(cid);
    if (trades.length > 0) {
      const pnls = computePnL(trades, info.winner);
      for (const [addr, d] of Object.entries(pnls)) {
        if (!wallets[addr]) wallets[addr] = { name: d.name, markets: [] };
        if (d.name && !wallets[addr].name) wallets[addr].name = d.name;
        const beforeLen1 = wallets[addr].markets.length;
        wallets[addr].markets = wallets[addr].markets.filter(m => m.cid !== cid);
        const isNewCid1 = wallets[addr].markets.length === beforeLen1;  // filter removed nothing → new resolution
        const rec = { cid, category: info.category, pnl: d.pnl, vol: d.vol, won: d.won, ts: d.lastTs };
        if (info.durationMin != null) rec.durationMin = info.durationMin;
        if (d.twoSided) rec.twoSided = true;
        wallets[addr].markets.push(rec);
        // resolvedTotal: true uncapped count of distinct resolved markets — survives the 300-cap
        // so a wallet with 4000 real resolutions tie-breaks above one with exactly 300.
        if (isNewCid1) wallets[addr].resolvedTotal = (wallets[addr].resolvedTotal || 0) + 1;
        wallets[addr].lastSeen = Date.now();
      }
    }
    processedCids[cid].twoSidedChecked = true;
    done++;
    if (done % 100 === 0) { await saveCache(); writeOutput(); console.log(`[LB] Migration: ${done}/${toMigrate.length}`); }
  }
  await saveCache();
  writeOutput();
  console.log(`[LB] Migration complete: ${done} CIDs re-processed`);
}

// ── Rate-limited HTTP ─────────────────────────────────────────────────────────
const queue = [];
let busy = false;

function get(url, ms = 12000) {
  return new Promise((res, rej) => {
    queue.push({ url, ms, res, rej });
    drain();
  });
}

async function drain() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const { url, ms, res, rej } = queue.shift();
    const t0 = Date.now();
    try { res(await rawGet(url, ms)); } catch (e) { rej(e); }
    const wait = 1000 / MAX_RPS - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
  }
  busy = false;
  if (queue.length) drain();
}

function rawGet(url, ms) {
  return new Promise((res, rej) => {
    // Hard wall-clock deadline: destroys the request after ms regardless of
    // socket activity (socket-inactivity timeout doesn't catch slow chunked responses).
    let settled = false;
    function settle(fn, val) { if (!settled) { settled = true; clearTimeout(deadline); fn(val); } }
    const req = https.get(url, r => {
      const bufs = [];
      r.on('data', b => bufs.push(b));
      r.on('end', () => {
        try { settle(res, JSON.parse(Buffer.concat(bufs).toString())); }
        catch (e) { settle(rej, new Error('JSON parse: ' + e.message)); }
      });
    });
    const deadline = setTimeout(() => { req.destroy(); settle(rej, new Error('deadline: ' + url.slice(0, 60))); }, ms);
    req.on('error', e => settle(rej, e));
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Atomic write ──────────────────────────────────────────────────────────────
function atomicWrite(path, data) {
  const tmp = path + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, path);
}

// Bounded atomic write for the large (~187MB) leaderboard cache. The old
// JSON.stringify(data, null, 2) built a ~370MB transient string on top of the
// ~440MB+ resident working set every saveCache() (every N markets mid-scan),
// spiking RSS to ~950MB and triggering a kernel global-OOM SIGKILL. A whole-object
// stream-json disassembler was no better — fed one giant object it emits all tokens
// at once with no effective backpressure, buffering ~as much as the string.
//
// Instead serialize the object ONE map-entry at a time: each value is JSON.stringify'd
// individually (a single wallet is small, ≤300 markets) and written with real drain
// backpressure, so write-time transient RSS is a few KB regardless of cache size.
// Output is byte-valid JSON, identical values — only whitespace differs (minified),
// which no consumer relies on. Async: every saveCache() call site awaits it.
let _writeSeq = 0;
async function writeJsonMap(ws, mapObj) {
  let first = true;
  for (const k of Object.keys(mapObj)) {
    const chunk = (first ? '' : ',') + JSON.stringify(k) + ':' + JSON.stringify(mapObj[k]);
    first = false;
    if (!ws.write(chunk)) await once(ws, 'drain');
  }
}
async function atomicWriteStreamed(path, data) {
  const tmp = `${path}.tmp.${process.pid}.${_writeSeq++}`;
  const ws  = fs.createWriteStream(tmp);
  const w   = async (s) => { if (!ws.write(s)) await once(ws, 'drain'); };
  try {
    await w('{"processedCids":{');
    await writeJsonMap(ws, data.processedCids || {});
    await w('},"wallets":{');
    await writeJsonMap(ws, data.wallets || {});
    await w('},"profiles":{');
    await writeJsonMap(ws, data.profiles || {});
    await w('},"cidTitles":{');
    await writeJsonMap(ws, data.cidTitles || {});
    await w('},"savedAt":' + JSON.stringify(data.savedAt) + '}');
    await new Promise((res, rej) => ws.end(err => err ? rej(err) : res()));
    fs.renameSync(tmp, path);
  } catch (e) {
    try { ws.destroy(); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────
function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb['agent20-leaderboard'] = Date.now();
  try { fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2)); } catch {}
}

// ── Category inference from REAL Polymarket event tags ────────────────────────
// Shared taxonomy (single source of truth) lives in ../lib/category.js so the
// leaderboard and the copy-watcher/paper engine never drift. Prefers real
// Polymarket tags; open positions (no tags) reuse the same keyword logic over
// their real title/slug; unmatched text → 'other', never a guess.
const { inferCategory, categoryFromText } = require('../lib/category');

// ── Winner from outcomePrices ─────────────────────────────────────────────────
function getWinner(market) {
  if (!market.outcomePrices || !market.outcomes) return null;
  try {
    const prices   = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
    const outcomes = typeof market.outcomes      === 'string' ? JSON.parse(market.outcomes)      : market.outcomes;
    const idx      = prices.findIndex(p => parseFloat(p) > 0.9);
    return idx >= 0 ? outcomes[idx] : null;
  } catch { return null; }
}

// ── Fetch all trades for a market (paginated) ─────────────────────────────────
async function fetchTrades(cid) {
  const all = [];
  let offset = 0;
  while (all.length < MAX_TRADES_PER_MKT) {
    let page;
    try {
      page = await get(`https://data-api.polymarket.com/trades?market=${cid}&limit=50&offset=${offset}`);
    } catch (e) { console.error(`[LB] trade fetch err ${cid.slice(0,10)}: ${e.message}`); break; }
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < 50) break;
    offset += 50;
  }
  return all;
}

// ── Compute per-wallet P&L for a resolved market ──────────────────────────────
function computePnL(trades, winner) {
  const wallets = {};
  for (const t of trades) {
    const w = t.proxyWallet;
    if (!w) continue;
    if (!wallets[w]) wallets[w] = {
      name:      t.pseudonym || t.name || null,
      positions: {},   // outcome → { cost, tokens, proceeds }
      totalBuyUsdc: 0,
      lastTs: 0,
    };
    const wd = wallets[w];
    const outcome = t.outcome || 'Unknown';
    if (!wd.positions[outcome]) wd.positions[outcome] = { cost: 0, tokens: 0, proceeds: 0 };

    const price = parseFloat(t.price) || 0;
    const size  = parseFloat(t.size)  || 0;
    if (price <= 0 || size <= 0) continue;

    const tokens = size / price;
    if (t.side === 'BUY') {
      wd.positions[outcome].cost   += size;
      wd.positions[outcome].tokens += tokens;
      wd.totalBuyUsdc += size;
    } else {
      wd.positions[outcome].proceeds += size;
      wd.positions[outcome].tokens   -= tokens;
    }
    if (t.timestamp > wd.lastTs) wd.lastTs = t.timestamp;
  }

  const result = {};
  for (const [w, wd] of Object.entries(wallets)) {
    if (wd.totalBuyUsdc === 0) continue;
    let pnl = 0;
    for (const [outcome, pos] of Object.entries(wd.positions)) {
      const isWinner     = outcome === winner;
      const terminalToks = Math.max(0, pos.tokens);
      const terminalVal  = isWinner ? terminalToks * 1.0 : 0;
      pnl += pos.proceeds + terminalVal - pos.cost;
    }
    // Detect two-sided: wallet bought tokens on ≥2 distinct outcomes within this market
    const twoSided = Object.values(wd.positions).filter(pos => pos.cost > 0).length >= 2;
    result[w] = {
      name:    wd.name,
      pnl:     Math.round(pnl * 100) / 100,
      vol:     Math.round(wd.totalBuyUsdc * 100) / 100,
      won:     pnl > 0,
      lastTs:  wd.lastTs,
      twoSided,
    };
  }
  return result;
}

// ── State (persisted to cache) ────────────────────────────────────────────────
// processedCids: { cid → { category, winner, processedAt } }
// wallets: { address → { name, markets: [{ cid, category, pnl, vol, won, ts }] } }
let processedCids = {};
let wallets       = {};
// Top Traders enrichment state (persisted in cache, bounded)
let profiles      = {};    // addr → { windows, categories, positionsOpen, tradesClosed, activityRecent, actorType, opsCounts, enrichedAt }
let cidTitles     = {};    // conditionId → market title (opportunistically filled from /positions + /activity)
let lbWindowMaps  = null;  // window → { profit:{addr→{amount,rank}}, volume:{addr→{amount,rank}} } — refreshed per scan

// A wallet can only ever appear on the leaderboard once it has at least
// MIN_MARKETS_RANK resolved markets inside the WINDOW_DAYS window — this is
// the same gate buildLeaderboard() applies (see the `recent.length <
// MIN_MARKETS_RANK` check below). Anything under that can be evicted for
// free: it was never going to rank. (LOW_SAMPLE_THRESHOLD is not a gate —
// it only flags low-confidence entries that already rank — so it's not used
// here; using it as an eviction cutoff would change who qualifies.)
function isAboveFloor(w) {
  const cutoff = Date.now() / 1000 - WINDOW_DAYS * 86400;
  const recentCount = (w.markets || []).filter(m => !m.ts || m.ts > cutoff).length;
  return recentCount >= MIN_MARKETS_RANK;
}

function walletLastSeen(w) {
  if (w.lastSeen) return w.lastSeen;
  const maxTs = (w.markets || []).reduce((mx, m) => (m.ts ? Math.max(mx, m.ts) : mx), 0);
  return maxTs ? maxTs * 1000 : 0;
}

// Bound the wallets cache to MAX_WALLETS_CACHED. Never evicts a wallet
// currently in the computed top-N output (categories or mmCategories), so
// this cannot change today's leaderboard. Among the rest, evicts
// below-floor wallets first (can never rank), then least-recently-seen.
function evictWallets() {
  const total = Object.keys(wallets).length;
  if (total <= MAX_WALLETS_CACHED) return 0;

  const { categories, mmCategories, bots } = buildLeaderboard();
  const protectedAddrs = new Set();
  for (const list of [...Object.values(categories), ...Object.values(mmCategories), bots]) {
    for (const e of list) protectedAddrs.add(e.wallet);
  }

  const evictable  = Object.keys(wallets).filter(a => !protectedAddrs.has(a));
  const belowFloor = evictable.filter(a => !isAboveFloor(wallets[a]))
    .sort((a, b) => walletLastSeen(wallets[a]) - walletLastSeen(wallets[b]));
  const aboveFloor = evictable.filter(a => isAboveFloor(wallets[a]))
    .sort((a, b) => walletLastSeen(wallets[a]) - walletLastSeen(wallets[b]));

  const toEvict = [...belowFloor, ...aboveFloor];
  const overBy  = total - MAX_WALLETS_CACHED;
  let evicted   = 0;
  for (let i = 0; i < overBy && i < toEvict.length; i++) {
    delete wallets[toEvict[i]];
    evicted++;
  }
  return evicted;
}

// Streaming cache load. The cache grew to ~187MB; the old one-shot
// JSON.parse(readFileSync(..,'utf8')) held a ~374MB UTF-16 string AND the
// parsed object simultaneously (~750MB transient) — this global-OOM-killed the
// process at the exact peak. Streaming the top-level object emits each property
// (processedCids/wallets/profiles/cidTitles) fully assembled with no giant
// intermediate string and no double-hold, roughly halving peak RSS. Produces
// byte-identical in-memory data — no displayed number changes.
function loadCache() {
  return new Promise((resolve) => {
    if (!fs.existsSync(CACHE_FILE)) {
      processedCids = {};
      wallets       = {};
      console.log('[LB] No cache — cold start');
      return resolve();
    }

    const loaded = { processedCids: {}, wallets: {}, profiles: {}, cidTitles: {} };
    const pipeline = chain([
      fs.createReadStream(CACHE_FILE),
      parser(),
      streamObject(),   // emits { key, value } per top-level property
    ]);

    pipeline.on('data', ({ key, value }) => {
      if (key in loaded) loaded[key] = value || {};
      // savedAt and any unknown keys are ignored
    });
    pipeline.on('error', (e) => {
      console.log('[LB] Cache stream parse error — cold start:', e.message);
      processedCids = {};
      wallets       = {};
      resolve();
    });
    pipeline.on('end', async () => {
      processedCids = loaded.processedCids;
      wallets       = loaded.wallets;
      profiles      = loaded.profiles;
      cidTitles     = loaded.cidTitles;
      console.log(`[LB] Cache: ${Object.keys(processedCids).length} cids, ${Object.keys(wallets).length} wallets, ${Object.keys(profiles).length} profiles`);

      const before = Object.keys(wallets).length;
      if (before > MAX_WALLETS_CACHED) {
        evictWallets();
        const after = Object.keys(wallets).length;
        console.log(`[LB] wallets cache trimmed ${before} -> ${after} on load`);
        await saveCache();
      }
      resolve();
    });
  });
}

async function saveCache() {
  // Trim old entries
  const cutoff = Date.now() / 1000 - WINDOW_DAYS * 86400;
  for (const [addr, w] of Object.entries(wallets)) {
    w.markets = (w.markets || []).filter(m => !m.ts || m.ts > cutoff);
    if (w.markets.length > 300) w.markets = w.markets.slice(-300);
  }
  // Trim processedCids to MAX_CIDS_CACHED by processedAt (keep newest)
  const cidEntries = Object.entries(processedCids).sort((a, b) => (b[1].processedAt || 0) - (a[1].processedAt || 0));
  if (cidEntries.length > MAX_CIDS_CACHED) {
    processedCids = Object.fromEntries(cidEntries.slice(0, MAX_CIDS_CACHED));
  }
  // Trim wallets to MAX_WALLETS_CACHED (below-floor first, then LRU) — memory bound
  const walletsEvicted = evictWallets();
  if (walletsEvicted > 0) {
    console.log(`[LB] wallets cache trimmed -${walletsEvicted} (${Object.keys(wallets).length} remain)`);
  }
  // Bound the opportunistic title cache (string keys keep insertion order → keep newest)
  const tKeys = Object.keys(cidTitles);
  if (tKeys.length > MAX_TITLE_CACHE) cidTitles = Object.fromEntries(tKeys.slice(-Math.floor(MAX_TITLE_CACHE * 2 / 3)).map(k => [k, cidTitles[k]]));
  // Drop profiles for wallets evicted from the cache (memory bound)
  for (const a of Object.keys(profiles)) if (!wallets[a]) delete profiles[a];
  await atomicWriteStreamed(CACHE_FILE, { processedCids, wallets, profiles, cidTitles, savedAt: new Date().toISOString() });
}

// ── Wallet-centric MM classification for top-N by volume ─────────────────────
// Fetches personal trade history for each of the top CLASSIFY_TOP_N wallets
// (by total volume) and detects two-sided behavior across conditionIds.
// This is the same logic as the per-wallet detail panel, giving accurate MM tags
// without needing per-market two-sided data. Stores results at the wallet level
// so buildLeaderboard() can use them in preference to per-market inference.
async function classifyTopWallets() {
  const staleMs = CLASSIFY_STALE_DAYS * 86400_000;
  const now     = Date.now();

  const candidates = Object.entries(wallets)
    .filter(([, w]) => (w.markets || []).length >= MIN_MARKETS_RANK)
    .map(([addr, w]) => ({
      addr,
      vol:          (w.markets || []).reduce((s, m) => s + (m.vol || 0), 0),
      classifiedAt: w.classifiedAt || 0,
    }))
    .sort((a, b) => b.vol - a.vol)
    .slice(0, CLASSIFY_TOP_N)
    .filter(c => now - c.classifiedAt > staleMs);

  if (candidates.length === 0) { console.log('[LB] Wallet classification: all up to date'); return; }
  console.log(`[LB] Classifying ${candidates.length} top-volume wallets for MM/DIRECTIONAL`);

  let done = 0;
  for (const { addr } of candidates) {
    let trades;
    try { trades = await get(`https://data-api.polymarket.com/trades?user=${addr}&limit=200`); }
    catch { continue; }
    if (!Array.isArray(trades) || trades.length === 0) { wallets[addr].classifiedAt = now; continue; }

    const byCondId = {};
    for (const t of trades) {
      if (!t.conditionId || !t.outcome) continue;
      if (!byCondId[t.conditionId]) byCondId[t.conditionId] = new Set();
      byCondId[t.conditionId].add(t.outcome);
    }
    const total     = Object.keys(byCondId).length;
    const twoSided  = Object.values(byCondId).filter(s => s.size >= 2).length;
    const pct       = total > 0 ? Math.round(twoSided / total * 1000) / 10 : 0;

    wallets[addr].classifiedAt = now;
    wallets[addr].twoSidedPct  = pct;
    wallets[addr].walletType   = pct >= MM_THRESHOLD_PCT ? 'MM' : 'DIRECTIONAL';
    done++;
  }

  if (done > 0) { await saveCache(); writeOutput(); }
  console.log(`[LB] Wallet classification done: ${done} classified`);
}

// ── Rank wallets per category ─────────────────────────────────────────────────
function buildLeaderboard() {
  const cutoff = Date.now() / 1000 - WINDOW_DAYS * 86400;
  const CATS  = ['All', 'Politics', 'Sports', 'Esports', 'Crypto', 'Pop Culture', 'World', 'Geopolitics', 'Weather', 'Mentions'];
  const DCATS = ['Ultra-fast ≤5 min', 'Fast 5–15 min'];
  const ALL   = [...CATS, ...DCATS];
  const categorized = Object.fromEntries(ALL.map(c => [c, []]));

  for (const [addr, w] of Object.entries(wallets)) {
    const recent = (w.markets || []).filter(m => !m.ts || m.ts > cutoff);
    if (recent.length < MIN_MARKETS_RANK) continue;

    const wins       = recent.filter(isWin).length;
    const totalPnl   = recent.reduce((s, m) => s + m.pnl, 0);
    const totalVol   = recent.reduce((s, m) => s + m.vol, 0);
    const lastActive = Math.max(...recent.map(m => m.ts || 0));
    // Tenure floor ("since"): earliest resolved-market timestamp we've tracked for this
    // wallet, from the SAME `recent` set as lastActive (zero extra fetch, free data). It is
    // a LOWER BOUND on first activity — bounded by the 2-yr window — not a guaranteed
    // account-inception date; the UI labels it as "earliest tracked", never fabricates one.
    const firstTs    = recent.map(m => m.ts).filter(t => t && t > 0);
    const firstActive = firstTs.length ? Math.min(...firstTs) : null;

    // MM classification: prefer wallet-level (from classifyTopWallets) if available;
    // fall back to per-market twoSided count which underestimates MM activity.
    const twoSidedMkts = recent.filter(m => m.twoSided).length;
    const twoSidedPct  = w.twoSidedPct !== undefined
      ? w.twoSidedPct
      : Math.round(twoSidedMkts / recent.length * 1000) / 10;
    const walletType   = w.walletType !== undefined
      ? w.walletType
      : (twoSidedPct >= MM_THRESHOLD_PCT ? 'MM' : 'DIRECTIONAL');

    const entry = {
      wallet:     addr,
      name:       w.name || (addr.slice(0, 6) + '…' + addr.slice(-4)),
      pnlUsdc:    Math.round(totalPnl * 100) / 100,
      winRate:    Math.round(wins / recent.length * 1000) / 10,
      wilsonScore: Math.round(wilsonLower(wins, recent.length) * 10000) / 10000,
      lowSample:   recent.length < LOW_SAMPLE_THRESHOLD,
      resolvedMarkets: recent.length,
      // True uncapped resolution count (survives the 300-store cap); null for wallets seen
      // only before this counter existed — tie-break falls back to resolvedMarkets then.
      resolvedTotal: w.resolvedTotal ?? null,
      volumeUsdc: Math.round(totalVol * 100) / 100,
      lastActive,
      firstActive,   // earliest tracked trade ts (tenure floor, ≤2-yr window); null if none
      wins,
      losses:     recent.length - wins,
      twoSidedMkts,
      twoSidedPct,
      walletType,
    };

    categorized['All'].push(entry);

    // Topic-category entries
    for (const cat of CATS.slice(1)) {
      const catMarkets = recent.filter(m => m.category === cat);
      if (catMarkets.length < MIN_MARKETS_RANK) continue;
      const cWins     = catMarkets.filter(isWin).length;
      const cPnl      = catMarkets.reduce((s, m) => s + m.pnl, 0);
      const cVol      = catMarkets.reduce((s, m) => s + m.vol, 0);
      const cTwoSided = catMarkets.filter(m => m.twoSided).length;
      categorized[cat].push({
        ...entry,
        pnlUsdc:    Math.round(cPnl * 100) / 100,
        winRate:    Math.round(cWins / catMarkets.length * 1000) / 10,
        wilsonScore: Math.round(wilsonLower(cWins, catMarkets.length) * 10000) / 10000,
        lowSample:   catMarkets.length < LOW_SAMPLE_THRESHOLD,
        resolvedMarkets: catMarkets.length,
        volumeUsdc: Math.round(cVol * 100) / 100,
        wins: cWins,
        losses: catMarkets.length - cWins,
        twoSidedMkts: cTwoSided,
      });
    }

    // Duration buckets — ultra-fast takes priority (no double-count)
    const ultraFastMkts = recent.filter(m => m.durationMin != null && m.durationMin <= 5);
    const fastMkts      = recent.filter(m => m.durationMin != null && m.durationMin > 5 && m.durationMin <= 15);

    if (ultraFastMkts.length >= MIN_MARKETS_RANK) {
      const uWins     = ultraFastMkts.filter(isWin).length;
      const uTwoSided = ultraFastMkts.filter(m => m.twoSided).length;
      categorized['Ultra-fast ≤5 min'].push({
        ...entry,
        pnlUsdc:    Math.round(ultraFastMkts.reduce((s, m) => s + m.pnl, 0) * 100) / 100,
        winRate:    Math.round(uWins / ultraFastMkts.length * 1000) / 10,
        wilsonScore: Math.round(wilsonLower(uWins, ultraFastMkts.length) * 10000) / 10000,
        lowSample:   ultraFastMkts.length < LOW_SAMPLE_THRESHOLD,
        resolvedMarkets: ultraFastMkts.length,
        volumeUsdc: Math.round(ultraFastMkts.reduce((s, m) => s + m.vol, 0) * 100) / 100,
        wins:   uWins,
        losses: ultraFastMkts.length - uWins,
        twoSidedMkts: uTwoSided,
      });
    } else if (fastMkts.length >= MIN_MARKETS_RANK) {
      const fWins     = fastMkts.filter(isWin).length;
      const fTwoSided = fastMkts.filter(m => m.twoSided).length;
      categorized['Fast 5–15 min'].push({
        ...entry,
        pnlUsdc:    Math.round(fastMkts.reduce((s, m) => s + m.pnl, 0) * 100) / 100,
        winRate:    Math.round(fWins / fastMkts.length * 1000) / 10,
        wilsonScore: Math.round(wilsonLower(fWins, fastMkts.length) * 10000) / 10000,
        lowSample:   fastMkts.length < LOW_SAMPLE_THRESHOLD,
        resolvedMarkets: fastMkts.length,
        volumeUsdc: Math.round(fastMkts.reduce((s, m) => s + m.vol, 0) * 100) / 100,
        wins:   fWins,
        losses: fastMkts.length - fWins,
        twoSidedMkts: fTwoSided,
      });
    }
  }

  const categories   = {};
  const mmCategories = {};

  // Bots / HFT / market-makers are excluded from the DIRECTIONAL (skill) board — they get the
  // Bots-HFT tab instead. Without this, tiny-P&L scrapers with perfect capped records saturate
  // the Wilson ceiling and fill the top. actorType comes from the enrichment profiles.
  const isBotEntry = (e) => {
    const at = profiles[e.wallet]?.actorType;
    return at?.type === 'bot' || at?.hft === true;
  };
  const isDirectionalEntry = (e) => !isBotEntry(e) && e.walletType !== 'MM';

  // Skill sort: Wilson DESC, then deterministic tie-breaks so perfect records don't tie at the
  // ceiling — larger true sample (resolvedTotal, capped fallback) then realized P&L then wallet.
  const skillSort = (a, b) =>
    (b.wilsonScore - a.wilsonScore)
    || ((b.resolvedTotal ?? b.resolvedMarkets) - (a.resolvedTotal ?? a.resolvedMarkets))
    || (b.pnlUsdc - a.pnlUsdc)
    || (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0);

  for (const cat of ALL) {
    // Directional/All view: humans only, Wilson 95% CI + sample/P&L tie-breaks
    categories[cat] = categorized[cat]
      .filter(isDirectionalEntry)
      .sort(skillSort)
      .slice(0, TOP_N_PER_CAT);
    // MM view: only MM wallets, sorted by twoSidedMkts (activity), then volumeUsdc
    // Wilson is wrong for MM — their win rate is ~50% by construction (spread capture).
    mmCategories[cat] = categorized[cat]
      .filter(e => e.walletType === 'MM')
      .sort((a, b) => (b.twoSidedMkts || 0) - (a.twoSidedMkts || 0) || b.volumeUsdc - a.volumeUsdc)
      .slice(0, TOP_N_PER_CAT);
  }

  // Bots / HFT tab: the wallets excluded from the directional board (bot- or HFT-classified),
  // sorted by inference confidence then realized P&L. Kept in the dataset, just not skill-ranked.
  const bots = categorized['All']
    .filter(isBotEntry)
    .sort((a, b) =>
      ((profiles[b.wallet]?.actorType?.confidence ?? 0) - (profiles[a.wallet]?.actorType?.confidence ?? 0))
      || (b.pnlUsdc - a.pnlUsdc))
    .slice(0, TOP_N_PER_CAT);

  // HONEST ENGINE: a topic tab must have real traders behind it. Drop any topic
  // category (CATS.slice(1) — excludes 'All' and the structural DCATS speed
  // buckets) that is empty in BOTH the directional and MM boards, so widening the
  // CATS list never surfaces a phantom — Esports/Geopolitics/Weather/Mentions only
  // appear once real classified traders exist.
  for (const cat of CATS.slice(1)) {
    if (!(categories[cat]?.length) && !(mmCategories[cat]?.length)) {
      delete categories[cat];
      delete mmCategories[cat];
    }
  }

  return { categories, mmCategories, bots };
}

function writeOutput(tsOverride = null) {
  const { categories, mmCategories, bots } = buildLeaderboard();
  const totalWallets = Object.values(wallets).filter(w => (w.markets || []).length >= MIN_MARKETS_RANK).length;

  // Attach compact per-trader inference + ops to each list entry so the leaderboard
  // renders bot/HFT badges without a join. Heavy per-trader data (positions, closed
  // trades, activity, category breakdown, windows) lives once in the normalized
  // `profiles` map below — keyed by wallet, never duplicated across category lists.
  const attachInline = (list) => {
    for (const e of list) {
      const p = profiles[e.wallet];
      e.actorType  = p ? p.actorType : null;   // HEURISTIC (type+confidence+signals), null until enriched
      e.opsCounts  = p ? p.opsCounts : null;
      e.hasProfile = !!p;
    }
  };
  for (const l of Object.values(categories))   attachInline(l);
  for (const l of Object.values(mmCategories)) attachInline(l);
  attachInline(bots);

  // windows resolved at write time from the shared lb-api maps → reflect latest fetch.
  const profilesOut = {};
  for (const [addr, prof] of Object.entries(profiles)) {
    profilesOut[addr] = { ...prof, windows: windowsForWallet(addr) };
  }

  atomicWrite(LEADERBOARD_FILE, {
    updatedAt:      tsOverride ?? new Date().toISOString(),
    schemaVersion:  2,                          // v2: adds per-trader `profiles` + inline actorType/opsCounts
    pnlBasis:       'gross_platform_reported',  // honest-engine: public API exposes no fee/gas netting — never relabel as net
    windowDays:     WINDOW_DAYS,
    marketsScanned: Object.keys(processedCids).length,
    totalWallets,
    minMarketsToRank: MIN_MARKETS_RANK,
    categories,
    mmCategories,
    bots,            // bot/HFT wallets excluded from the directional board — feeds the Bots-HFT tab
    profiles:       profilesOut,
    disclaimer: 'Descriptive leaderboard from on-chain resolved markets. actorType is a labeled heuristic (inference, not fact). PnL is gross/platform-reported. Past performance is not predictive. Not financial advice.',
  });

  const allTop = categories.All;
  if (allTop.length > 0) {
    console.log(`[LB] Leaderboard updated — ${totalWallets} wallets, top: ${allTop[0].name} +$${allTop[0].pnlUsdc}`);
  } else {
    console.log(`[LB] Leaderboard updated — ${totalWallets} wallets (accumulating data…)`);
  }
}

// ══ Top Traders enrichment ════════════════════════════════════════════════════
// All calls below go through rlGet (per-host limiter). Every value is real API data;
// the ONLY inference is actorType, which is always type+confidence+signals.

// rlGet returns { status, headers, data:parsedJSON }; unwrap to the JSON body.
async function rlJson(url) {
  const r = await rlGet(url);
  if (!r || r.status !== 200) throw new Error(`HTTP ${r && r.status} ${url.slice(0, 64)}`);
  return r.data;
}

// Fetch the global profit + volume leaderboards for every window ONCE per scan and
// index them by wallet, so per-trader window stats are a map lookup (not a per-wallet
// call). Wallets outside the top LB_WINDOW_LIMIT are simply absent → null (never inferred).
async function fetchLeaderboardWindows() {
  const maps = {};
  for (const win of LB_WINDOWS) {
    maps[win] = { profit: {}, volume: {} };
    for (const metric of ['profit', 'volume']) {
      try {
        const list = await rlJson(`https://lb-api.polymarket.com/${metric}?window=${win}&limit=${LB_WINDOW_LIMIT}`);
        if (Array.isArray(list)) list.forEach((e, i) => {
          const a = (e.proxyWallet || '').toLowerCase();
          if (a) maps[win][metric][a] = { amount: e.amount, rank: i + 1 };
        });
      } catch (e) { console.warn(`[LB] window ${metric}/${win} skipped: ${e.message}`); }
    }
  }
  lbWindowMaps = maps;
}

// Per-wallet window stats from the shared maps. pnlUsdc/volumeUsdc are lb-api's own
// platform-reported (gross) figures; rank is the profit-leaderboard position. Any window
// where the wallet isn't in the global top-50 → null fields (do NOT infer). Most of our
// Wilson-skill-ranked wallets are legitimately null here — they aren't $-whales.
function windowsForWallet(addr) {
  if (!lbWindowMaps) return null;
  const a = addr.toLowerCase();
  const out = {};
  for (const win of LB_WINDOWS) {
    const p = lbWindowMaps[win].profit[a];
    const v = lbWindowMaps[win].volume[a];
    out[win] = {
      pnlUsdc:    p ? Math.round(p.amount * 100) / 100 : null,   // lb-api /profit (gross, platform-reported)
      volumeUsdc: v ? Math.round(v.amount * 100) / 100 : null,   // lb-api /volume
      rank:       p ? p.rank : null,                             // profit-leaderboard rank for this window
    };
  }
  return out;
}

// Per-category P&L breakdown aggregated from the wallet's OWN resolved-market ledger
// (real on-chain outcomes, already category-mapped by inferCategory). Only categories
// with ≥1 resolved market appear. Real aggregation — no estimation.
function computeWalletCategories(w) {
  const byCat = {};
  for (const m of (w.markets || [])) {
    const c = m.category || 'other';
    if (!byCat[c]) byCat[c] = { category: c, pnl: 0, vol: 0, wins: 0, n: 0 };
    byCat[c].pnl += m.pnl || 0;
    byCat[c].vol += m.vol || 0;
    byCat[c].wins += isWin(m) ? 1 : 0;   // same MIN_WIN_PNL win definition as the board
    byCat[c].n++;
  }
  return Object.values(byCat)
    .map(c => ({
      category:        c.category,
      pnlUsdc:         Math.round(c.pnl * 100) / 100,
      winRate:         c.n ? Math.round(c.wins / c.n * 1000) / 10 : 0,
      resolvedMarkets: c.n,
      volumeUsdc:      Math.round(c.vol * 100) / 100,
    }))
    .sort((a, b) => b.pnlUsdc - a.pnlUsdc);
}

// HEURISTIC actor classification from OBSERVABLE signals only. Returns
// { type:'bot'|'human', confidence:0-100, hft:bool, signals:string[] }. Never a bare
// certainty: confidence + the reasons that fired. Thin data → human / confidence 0.
function computeActorType(activity, w) {
  const trades = (activity || [])
    .filter(a => a && a.type === 'TRADE' && a.timestamp)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (trades.length < ACTOR_MIN_TRADES) {
    return { type: 'human', confidence: 0, hft: false,
             signals: [`insufficient recent activity to classify (${trades.length} trades)`] };
  }

  const first = trades[0].timestamp, last = trades[trades.length - 1].timestamp;
  const hoursSpan = Math.max((last - first) / 3600, 1 / 60);
  const tphAvg = trades.length / hoursSpan;

  const hourBuckets = {};             // absolute hour → count (for peak)
  const hourOfDay   = new Array(24).fill(0);
  for (const t of trades) {
    hourBuckets[Math.floor(t.timestamp / 3600)] = (hourBuckets[Math.floor(t.timestamp / 3600)] || 0) + 1;
    hourOfDay[new Date(t.timestamp * 1000).getUTCHours()]++;
  }
  const tphPeak     = Math.max(...Object.values(hourBuckets));
  const activeHours = hourOfDay.filter(c => c > 0).length;

  let sub = 0, gaps = 0;
  for (let i = 1; i < trades.length; i++) {
    const d = trades[i].timestamp - trades[i - 1].timestamp;
    if (d >= 0) { gaps++; if (d < 60) sub++; }
  }
  const subShare = gaps ? sub / gaps : 0;

  // short-market share via known durations (from our own processedCids metadata)
  let withDur = 0, shortDur = 0;
  for (const t of trades) {
    const info = processedCids[t.conditionId];
    if (info && info.durationMin != null) { withDur++; if (info.durationMin <= 15) shortDur++; }
  }
  const shortShare  = withDur ? shortDur / withDur : 0;
  const twoSidedPct = w.twoSidedPct ?? 0;

  const signals = [];
  let confidence = 0;
  if (tphAvg  >= ACTOR_TPH_AVG)   { confidence += 25; signals.push(`high frequency: ${tphAvg.toFixed(1)} trades/h avg`); }
  if (tphPeak >= ACTOR_TPH_PEAK)  { confidence += 15; signals.push(`burst: ${tphPeak} trades in busiest hour`); }
  if (subShare >= ACTOR_SUBMIN_SHARE) { confidence += 20; signals.push(`machine timing: ${Math.round(subShare * 100)}% of trades <60s apart`); }
  if (activeHours >= ACTOR_ACTIVE_HOURS) { confidence += 20; signals.push(`24/7 activity: ${activeHours}/24 UTC hours active, no sleep gap`); }
  if (withDur > 0 && shortShare >= ACTOR_SHORT_SHARE) { confidence += 20; signals.push(`short-market focus: ${Math.round(shortShare * 100)}% in ≤15min markets`); }
  if (twoSidedPct >= MM_THRESHOLD_PCT) { confidence += 10; signals.push(`two-sided quoting: ${twoSidedPct}% of markets`); }
  confidence = Math.min(100, confidence);

  const hft  = withDur > 0 && shortShare >= ACTOR_SHORT_SHARE && tphAvg >= ACTOR_TPH_AVG;
  const type = confidence >= ACTOR_BOT_CONF_MIN ? 'bot' : 'human';
  if (signals.length === 0) signals.push('no automation signals detected');
  return { type, confidence, hft, signals };
}

// Build one trader's full profile: positions (unrealized), closed trades (realized),
// recent activity, ops counts, actorType. categories come from the ledger; windows are
// merged at write time. Every network hit is try/caught → a failed field is null, never
// fabricated, and never crashes the scan.
async function enrichWallet(addr) {
  const w = wallets[addr];
  if (!w) return;
  const prof = {
    enrichedAt: Date.now(), windows: null, categories: computeWalletCategories(w),
    positionsOpen: [], tradesClosed: [], activityRecent: [], actorType: null, opsCounts: null,
  };

  // /positions → live (unrealized) exposure only. cashPnl is unrealized, gross —
  // labeled explicitly as unrealizedPnl and never mixed with realized P&L.
  try {
    const pos = await rlJson(`https://data-api.polymarket.com/positions?user=${addr}`);
    // Base fetch under-counts OPEN positions (data-api defaults: limit=100 +
    // sizeThreshold~1). Pull the COMPLETE open set so the copy-panel mirror matches
    // the detail feed. Falls back to the base open set if the complete fetch fails.
    let openSrc = Array.isArray(pos)
      ? pos.filter(p => p.redeemable === false && Math.abs(p.size || 0) > 0) : [];
    try {
      const { ok, open } = await fetchOpenPositions(rlJson, addr, { maxKeep: MAX_POSITIONS_OPEN });
      if (ok) openSrc = open;   // complete, value-sorted, already ≤ MAX_POSITIONS_OPEN
    } catch (e) { /* keep base open set — never drop open positions on a transient error */ }
    if (Array.isArray(pos)) {
      for (const p of pos) if (p.conditionId && p.title) cidTitles[p.conditionId] = p.title;
      for (const p of openSrc) if (p.conditionId && p.title) cidTitles[p.conditionId] = p.title;
      prof.positionsOpen = openSrc
        .slice(0, MAX_POSITIONS_OPEN)
        .map(p => ({
          marketTitle:   p.title ?? null,
          outcome:       p.outcome ?? null,
          size:          p.size ?? null,
          avgPrice:      p.avgPrice ?? null,
          currentValue:  p.currentValue ?? null,
          unrealizedPnl: p.cashPnl ?? null,   // /positions.cashPnl — UNREALIZED, gross
          // Additive copy-filter metadata (real fields only, never fabricated):
          category:      categoryFromText(p.title, p.slug, p.eventSlug),   // inferCategory over real title/slug/eventSlug; 'other' if no keyword matches
          cid:           p.conditionId ?? p.asset ?? null,           // real condition/market id; null if absent
          side:          p.outcome ?? null,                          // held token/outcome (Yes/No); null if absent
        }));
    }
  } catch (e) { console.warn(`[LB] positions ${addr.slice(0, 10)} skipped: ${e.message}`); }

  // /activity → recent raw trades, ops counts, actorType inputs, and title cache
  let activity = [];
  try {
    const a = await rlJson(`https://data-api.polymarket.com/activity?user=${addr}&limit=${ACTIVITY_FETCH_LIMIT}`);
    if (Array.isArray(a)) activity = a;
  } catch (e) { console.warn(`[LB] activity ${addr.slice(0, 10)} skipped: ${e.message}`); }
  for (const a of activity) if (a.conditionId && a.title) cidTitles[a.conditionId] = a.title;

  const now       = Math.floor(Date.now() / 1000);
  const tradeActs = activity.filter(a => a && a.type === 'TRADE' && a.timestamp);
  const oldest    = tradeActs.length ? Math.min(...tradeActs.map(a => a.timestamp)) : now;
  prof.opsCounts = {
    trades1h:  tradeActs.filter(a => a.timestamp > now - 3600).length,
    trades24h: tradeActs.filter(a => a.timestamp > now - 86400).length,
    // honest completeness flag: if the fetched window filled up AND is <24h deep, the
    // 24h count is a floor (there may be older trades we didn't page) — never inflate.
    complete24h: (now - oldest) >= 86400 || tradeActs.length < ACTIVITY_FETCH_LIMIT,
  };

  prof.activityRecent = tradeActs
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MAX_ACTIVITY_RECENT)
    .map(a => ({
      side:        (a.side || '').toUpperCase() || null,
      outcome:     a.outcome ?? null,
      price:       a.price ?? null,
      marketTitle: a.title ?? null,
      usdcSize:    a.usdcSize ?? null,
      timestamp:   a.timestamp,
    }));

  prof.actorType = computeActorType(activity, w);

  // tradesClosed: realized outcomes from our OWN on-chain resolved ledger — this is the
  // COMPLETE record; a partial /activity reconstruction would under-count older fills and
  // report wrong realizedPnl (fabrication). entryPrice/exitPrice/outcome are not pinned at
  // aggregate level → null (shown missing, never invented). Honest-engine.
  prof.tradesClosed = (w.markets || [])
    .filter(m => m.ts)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, MAX_TRADES_CLOSED)
    .map(m => ({
      marketTitle: cidTitles[m.cid] || (m.cid ? m.cid.slice(0, 10) + '…' : null),
      outcome:     null,   // aggregate ledger doesn't pin which side the wallet held
      entryPrice:  null,   // not reconstructed from aggregate — never fabricated
      exitPrice:   null,
      result:      m.pnl > 0 ? 'won' : (m.pnl < 0 ? 'lost' : 'resolved'),
      realizedPnl: Math.round((m.pnl || 0) * 100) / 100,   // agent20 on-chain resolved P&L (gross)
      timestamp:   m.ts,
      // Additive copy-filter metadata (real fields only, never fabricated):
      category:    m.category || 'other',   // REAL event-tag-derived category from the ledger (inferCategory at process time); 'other' if unmapped
      cid:         m.cid ?? null,            // real condition/market id from the ledger
      side:        null,                     // aggregate ledger doesn't pin the held side — null, never invented
    }));

  profiles[addr] = prof;
}

// Enrich the wallets that actually appear in the output (All directional first, then
// All MM, then other categories), capped at MAX_ENRICH_WALLETS to respect rate limits
// and the €50/mo budget. Profiles for wallets no longer in the top set are pruned.
async function enrichTopWallets() {
  const { categories, mmCategories, bots } = buildLeaderboard();
  const order = [], seen = new Set();
  const lists = [categories.All, mmCategories.All, bots,
                 ...Object.entries(categories).filter(([c]) => c !== 'All').map(([, l]) => l)];
  for (const list of lists) for (const e of (list || [])) {
    if (!seen.has(e.wallet)) { seen.add(e.wallet); order.push(e.wallet); }
  }
  const targets = order.slice(0, MAX_ENRICH_WALLETS);
  if (targets.length === 0) { console.log('[LB] Enrichment: no output wallets yet'); return; }

  console.log(`[LB] Enriching ${targets.length} top-trader profiles (positions + activity + windows)…`);
  let done = 0;
  for (const addr of targets) {
    try { await enrichWallet(addr); done++; }
    catch (e) { console.warn(`[LB] enrich ${addr.slice(0, 10)} failed: ${e.message}`); }
    if (done % 25 === 0) writeOutput();  // stream progress to the UI
  }
  const keep = new Set(targets);
  for (const a of Object.keys(profiles)) if (!keep.has(a)) delete profiles[a];
  console.log(`[LB] Enrichment done: ${done} profiles (${Object.keys(profiles).length} cached)`);
}

// ── Process one market ────────────────────────────────────────────────────────
async function processMarket(cid, winner, category, vol, durationMin) {
  const trades = await fetchTrades(cid);
  if (trades.length === 0) return 0;

  const pnls = computePnL(trades, winner);

  for (const [addr, d] of Object.entries(pnls)) {
    if (!wallets[addr]) wallets[addr] = { name: d.name, markets: [] };
    if (d.name && !wallets[addr].name) wallets[addr].name = d.name;
    if (d.name && d.name !== addr) wallets[addr].name = d.name;
    // Dedup: remove stale record for same CID before adding fresh one
    const beforeLen2 = wallets[addr].markets.length;
    wallets[addr].markets = wallets[addr].markets.filter(m => m.cid !== cid);
    const isNewCid2 = wallets[addr].markets.length === beforeLen2;  // filter removed nothing → new resolution
    const rec = { cid, category, pnl: d.pnl, vol: d.vol, won: d.won, ts: d.lastTs };
    if (durationMin  != null) rec.durationMin = durationMin;
    if (d.twoSided)            rec.twoSided   = true;
    wallets[addr].markets.push(rec);
    // resolvedTotal: true uncapped count of distinct resolved markets (survives the 300-cap).
    if (isNewCid2) wallets[addr].resolvedTotal = (wallets[addr].resolvedTotal || 0) + 1;
    wallets[addr].lastSeen = Date.now();
  }

  processedCids[cid] = { category, winner, vol, durationMin, processedAt: Date.now(), twoSidedChecked: true };
  return trades.length;
}

// ── Fetch and process a batch of events ──────────────────────────────────────
async function processEventBatch(order, ascending, limit) {
  let events;
  try {
    events = await get(`https://gamma-api.polymarket.com/events?limit=${limit}&closed=true&order=${order}&ascending=${ascending}`);
  } catch (e) {
    console.error('[LB] events fetch err:', e.message);
    return;
  }
  if (!Array.isArray(events)) return;

  // Collect all markets from events
  const toProcess = [];
  for (const ev of events) {
    const tags = (ev.tags || []).map(t => typeof t === 'string' ? t : (t.label || ''));

    // Derive duration hint from event tags (5M / 15M recurring markets)
    let evDurationMin = null;
    if (tags.some(t => t === '5M'))  evDurationMin = 5;
    else if (tags.some(t => t === '15M')) evDurationMin = 15;

    const category = inferCategory(tags);

    for (const mkt of (ev.markets || [])) {
      const cid = mkt.conditionId;
      if (!cid || processedCids[cid]) continue;

      const vol = mkt.volumeNum || parseFloat(mkt.volume || '0') || 0;
      if (vol < MIN_MARKET_VOL) continue;

      const winner = getWinner(mkt);
      if (!winner) continue; // not resolved yet

      // Compute per-market duration; fall back to event-level tag hint
      let durationMin = evDurationMin;
      if (durationMin == null && mkt.startDate && mkt.endDate) {
        const ms = new Date(mkt.endDate) - new Date(mkt.startDate);
        if (ms > 0) durationMin = ms / 60000;
      }

      toProcess.push({ cid, winner, category, vol, durationMin, question: mkt.question?.slice(0, 80) });
    }
  }

  console.log(`[LB] ${toProcess.length} new markets to process (event batch: ${events.length})`);

  let processed = 0;
  for (const m of toProcess) {
    const count = await processMarket(m.cid, m.winner, m.category, m.vol, m.durationMin);
    if (count > 0) {
      const dur = m.durationMin != null ? ` ${m.durationMin <= 5 ? '⚡' : m.durationMin <= 15 ? '⏱' : ''}${m.durationMin.toFixed(0)}min` : '';
      console.log(`[LB]   [${m.category}]${dur} ${m.question} → winner:${m.winner}, trades:${count}`);
    }
    processed++;
    // Save every 20 markets to avoid losing data on crash
    if (processed % 20 === 0) { await saveCache(); writeOutput(); }
  }

  return toProcess.length;
}

// ── Main scan ─────────────────────────────────────────────────────────────────
let isFirstScan = true;

async function scan() {
  console.log('[LB] Scan starting…');
  beat();

  if (isFirstScan) {
    // Cold start: fetch top-volume events (most meaningful for leaderboard)
    console.log('[LB] Cold start — fetching top-volume events');
    await processEventBatch('volume', false, 100);
    await processEventBatch('volume', false, 100);  // offset not supported; same batch is ok for initial seed
    isFirstScan = false;
  }

  // Always check recently-closed events for freshness
  await processEventBatch('closedTime', false, 50);

  // Wallet-centric MM classification for top-volume wallets
  await classifyTopWallets();

  // Top Traders enrichment: refresh global leaderboard windows, then build honest
  // per-trader profiles for the wallets that actually appear in the output.
  await fetchLeaderboardWindows();
  await enrichTopWallets();

  await saveCache();
  writeOutput();
  beat();

  // Parallel history sink (non-fatal): snapshot the ranked bot/HFT wallets ONCE per
  // COMPLETED scan (writeOutput also runs mid-scan for UI streaming — we log only here,
  // at the final state). Reads back the just-written file so it logs exactly what shipped.
  // Self-throttled to 6h inside the logger (leaderboard moves slowly).
  try {
    const lb = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
    require('../lib/history-logger').appendSnapshot('leaderboard', Date.now(), lb.bots || [],
      { windowDays: lb.windowDays, totalWallets: lb.totalWallets, pnlBasis: lb.pnlBasis });
  } catch (e) { console.log('[history] leaderboard snapshot skipped:', e.message); }

  console.log('[LB] Scan complete');
}

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  await loadCache();   // streamed — see loadCache() for the OOM history
  console.log('[LB] Starting agent20-leaderboard — read-only, zero Claude, 2 req/sec');
  // Preserve the on-disk updatedAt so the ticker keeps showing STALE/OFFLINE
  // while catching up — only flips to 'live' once a real scan writes a fresh timestamp.
  let _bootTs = null;
  try { _bootTs = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8')).updatedAt ?? null; } catch {}
  writeOutput(_bootTs); // emit cached data immediately so UI isn't blank

  setTimeout(async () => {
    await migrateAddTwoSided(); // one-time: backfill twoSided for pre-feature CIDs
    await scan();
    setInterval(scan, SCAN_INTERVAL_MS);
  }, 5_000);
})();
