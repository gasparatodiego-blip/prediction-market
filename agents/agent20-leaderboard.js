#!/usr/bin/env node
// agent20-leaderboard.js  — Polymarket Top Traders leaderboard by category
// READ-ONLY · Zero Claude API · No wallet · No orders
// Sources: gamma-api (events+categories+outcomePrices), data-api (trades)
// Rate limit: 2 req/sec  ·  Output: /tmp/leaderboard.json

'use strict';

const fs = require('fs');
const https = require('https');

const LEADERBOARD_FILE  = '/tmp/leaderboard.json';
const CACHE_FILE        = '/tmp/leaderboard-cache.json';
const HB_FILE           = '/tmp/agent-heartbeats.json';

const SCAN_INTERVAL_MS  = 30 * 60_000;   // 30-min cadence
const MAX_RPS           = 2.0;            // 2 req/sec (no other agent hitting Polymarket)
const MIN_MARKET_VOL    = 500;            // skip markets under $500 volume
const MIN_MARKETS_RANK     = 20;  // raised from 5 — 5 binary markets is statistically meaningless
const LOW_SAMPLE_THRESHOLD = 30;  // below this show a warning even if above the floor
const TOP_N_PER_CAT        = 25;
const MAX_TRADES_PER_MKT = 400;           // 8 pages of 50
const MAX_CIDS_CACHED   = 1500;          // memory bound
const MAX_WALLETS_CACHED = 5000;         // memory bound — mirrors MAX_CIDS_CACHED
const WINDOW_DAYS       = 730;           // 2-year window (covers 2024 election, 2025 sports)
const MM_THRESHOLD_PCT  = 50;            // ≥50% two-sided markets → MM / NEUTRAL
const CLASSIFY_TOP_N    = 300;           // wallet-centric classification for top-N by volume
const CLASSIFY_STALE_DAYS = 7;          // re-classify wallet every 7 days

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
        wallets[addr].markets = wallets[addr].markets.filter(m => m.cid !== cid);
        const rec = { cid, category: info.category, pnl: d.pnl, vol: d.vol, won: d.won, ts: d.lastTs };
        if (info.durationMin != null) rec.durationMin = info.durationMin;
        if (d.twoSided) rec.twoSided = true;
        wallets[addr].markets.push(rec);
        wallets[addr].lastSeen = Date.now();
      }
    }
    processedCids[cid].twoSidedChecked = true;
    done++;
    if (done % 100 === 0) { saveCache(); writeOutput(); console.log(`[LB] Migration: ${done}/${toMigrate.length}`); }
  }
  saveCache();
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

// ── Heartbeat ─────────────────────────────────────────────────────────────────
function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb['agent20-leaderboard'] = Date.now();
  try { fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2)); } catch {}
}

// ── Category inference from event tags ────────────────────────────────────────
const POLITICS_TAGS   = new Set(['politics','elections','trump','biden','harris','congress','senate','president','democrat','republican','fed rates','economic policy','fomc','jerome powell','geopolitics','world','middle east','iran','china','russia']);
const SPORTS_TAGS     = new Set(['sports','nba','nfl','soccer','nhl','mlb','tennis','golf','mma','basketball','football','baseball','ufc','premier league','champions league','world cup','nba finals','superbowl','super bowl','fifa','olympics']);
const CRYPTO_TAGS     = new Set(['crypto','bitcoin','ethereum','solana','blockchain','defi','web3','btc','eth','sol','xrp','bnb','crypto prices','up or down']);
const POPCULTURE_TAGS = new Set(['pop culture','music','entertainment','tv','movies','celebrity','oscar','grammy','emmy','celebrity death','kardashian','taylor swift','elon musk','show','award']);

function inferCategory(tags = []) {
  const lower = tags.map(t => (typeof t === 'string' ? t : t.label || '').toLowerCase());
  if (lower.some(t => SPORTS_TAGS.has(t)))     return 'Sports';
  if (lower.some(t => POLITICS_TAGS.has(t)))   return 'Politics';
  if (lower.some(t => CRYPTO_TAGS.has(t)))     return 'Crypto';
  if (lower.some(t => POPCULTURE_TAGS.has(t))) return 'Pop Culture';
  return 'World';
}

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

  const { categories, mmCategories } = buildLeaderboard();
  const protectedAddrs = new Set();
  for (const list of [...Object.values(categories), ...Object.values(mmCategories)]) {
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

function loadCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    processedCids = c.processedCids || {};
    wallets       = c.wallets       || {};
    console.log(`[LB] Cache: ${Object.keys(processedCids).length} cids, ${Object.keys(wallets).length} wallets`);
  } catch {
    processedCids = {};
    wallets       = {};
    console.log('[LB] No cache — cold start');
    return;
  }

  const before = Object.keys(wallets).length;
  if (before > MAX_WALLETS_CACHED) {
    evictWallets();
    const after = Object.keys(wallets).length;
    console.log(`[LB] wallets cache trimmed ${before} -> ${after} on load`);
    saveCache();
  }
}

function saveCache() {
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
  atomicWrite(CACHE_FILE, { processedCids, wallets, savedAt: new Date().toISOString() });
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

  if (done > 0) { saveCache(); writeOutput(); }
  console.log(`[LB] Wallet classification done: ${done} classified`);
}

// ── Rank wallets per category ─────────────────────────────────────────────────
function buildLeaderboard() {
  const cutoff = Date.now() / 1000 - WINDOW_DAYS * 86400;
  const CATS  = ['All', 'Politics', 'Sports', 'Crypto', 'Pop Culture', 'World'];
  const DCATS = ['Ultra-fast ≤5 min', 'Fast 5–15 min'];
  const ALL   = [...CATS, ...DCATS];
  const categorized = Object.fromEntries(ALL.map(c => [c, []]));

  for (const [addr, w] of Object.entries(wallets)) {
    const recent = (w.markets || []).filter(m => !m.ts || m.ts > cutoff);
    if (recent.length < MIN_MARKETS_RANK) continue;

    const wins       = recent.filter(m => m.won).length;
    const totalPnl   = recent.reduce((s, m) => s + m.pnl, 0);
    const totalVol   = recent.reduce((s, m) => s + m.vol, 0);
    const lastActive = Math.max(...recent.map(m => m.ts || 0));

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
      volumeUsdc: Math.round(totalVol * 100) / 100,
      lastActive,
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
      const cWins     = catMarkets.filter(m => m.won).length;
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
      const uWins     = ultraFastMkts.filter(m => m.won).length;
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
      const fWins     = fastMkts.filter(m => m.won).length;
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

  for (const cat of ALL) {
    // Directional/All view: Wilson 95% CI sort
    categories[cat] = [...categorized[cat]]
      .sort((a, b) => b.wilsonScore - a.wilsonScore)
      .slice(0, TOP_N_PER_CAT);
    // MM view: only MM wallets, sorted by twoSidedMkts (activity), then volumeUsdc
    // Wilson is wrong for MM — their win rate is ~50% by construction (spread capture).
    mmCategories[cat] = categorized[cat]
      .filter(e => e.walletType === 'MM')
      .sort((a, b) => (b.twoSidedMkts || 0) - (a.twoSidedMkts || 0) || b.volumeUsdc - a.volumeUsdc)
      .slice(0, TOP_N_PER_CAT);
  }

  return { categories, mmCategories };
}

function writeOutput(tsOverride = null) {
  const { categories, mmCategories } = buildLeaderboard();
  const totalWallets = Object.values(wallets).filter(w => (w.markets || []).length >= MIN_MARKETS_RANK).length;

  atomicWrite(LEADERBOARD_FILE, {
    updatedAt:      tsOverride ?? new Date().toISOString(),
    windowDays:     WINDOW_DAYS,
    marketsScanned: Object.keys(processedCids).length,
    totalWallets,
    minMarketsToRank: MIN_MARKETS_RANK,
    categories,
    mmCategories,
    disclaimer: 'Descriptive leaderboard from on-chain resolved markets. Past performance is not predictive. Not financial advice.',
  });

  const allTop = categories.All;
  if (allTop.length > 0) {
    console.log(`[LB] Leaderboard updated — ${totalWallets} wallets, top: ${allTop[0].name} +$${allTop[0].pnlUsdc}`);
  } else {
    console.log(`[LB] Leaderboard updated — ${totalWallets} wallets (accumulating data…)`);
  }
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
    wallets[addr].markets = wallets[addr].markets.filter(m => m.cid !== cid);
    const rec = { cid, category, pnl: d.pnl, vol: d.vol, won: d.won, ts: d.lastTs };
    if (durationMin  != null) rec.durationMin = durationMin;
    if (d.twoSided)            rec.twoSided   = true;
    wallets[addr].markets.push(rec);
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
    if (processed % 20 === 0) { saveCache(); writeOutput(); }
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

  saveCache();
  writeOutput();
  beat();
  console.log('[LB] Scan complete');
}

// ── Boot ──────────────────────────────────────────────────────────────────────
loadCache();
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
