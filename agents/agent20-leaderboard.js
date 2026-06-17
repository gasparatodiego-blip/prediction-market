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
const WINDOW_DAYS       = 730;           // 2-year window (covers 2024 election, 2025 sports)
const MM_THRESHOLD_PCT  = 50;            // ≥50% two-sided markets → MM / NEUTRAL

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
    const req = https.get(url, { timeout: ms }, r => {
      const bufs = [];
      r.on('data', b => bufs.push(b));
      r.on('end', () => {
        try { res(JSON.parse(Buffer.concat(bufs).toString())); }
        catch (e) { rej(new Error('JSON parse: ' + e.message)); }
      });
    });
    req.on('error', rej);
    req.on('timeout', () => { req.destroy(); rej(new Error('timeout: ' + url.slice(0, 60))); });
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
  atomicWrite(CACHE_FILE, { processedCids, wallets, savedAt: new Date().toISOString() });
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

    // Two-sided / MM classification: % of markets where wallet bought both outcomes
    const twoSidedMkts = recent.filter(m => m.twoSided).length;
    const twoSidedPct  = Math.round(twoSidedMkts / recent.length * 1000) / 10;
    const walletType   = twoSidedPct >= MM_THRESHOLD_PCT ? 'MM' : 'DIRECTIONAL';

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
      twoSidedPct,
      walletType,
    };

    categorized['All'].push(entry);

    // Topic-category entries
    for (const cat of CATS.slice(1)) {
      const catMarkets = recent.filter(m => m.category === cat);
      if (catMarkets.length < MIN_MARKETS_RANK) continue;
      const cWins = catMarkets.filter(m => m.won).length;
      const cPnl  = catMarkets.reduce((s, m) => s + m.pnl, 0);
      const cVol  = catMarkets.reduce((s, m) => s + m.vol, 0);
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
      });
    }

    // Duration buckets — ultra-fast takes priority (no double-count)
    const ultraFastMkts = recent.filter(m => m.durationMin != null && m.durationMin <= 5);
    const fastMkts      = recent.filter(m => m.durationMin != null && m.durationMin > 5 && m.durationMin <= 15);

    if (ultraFastMkts.length >= MIN_MARKETS_RANK) {
      const uWins = ultraFastMkts.filter(m => m.won).length;
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
      });
    } else if (fastMkts.length >= MIN_MARKETS_RANK) {
      const fWins = fastMkts.filter(m => m.won).length;
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
      });
    }
  }

  for (const cat of ALL) {
    categorized[cat].sort((a, b) => b.wilsonScore - a.wilsonScore);
    categorized[cat] = categorized[cat].slice(0, TOP_N_PER_CAT);
  }

  return categorized;
}

function writeOutput() {
  const categories = buildLeaderboard();
  const totalWallets = Object.values(wallets).filter(w => (w.markets || []).length >= MIN_MARKETS_RANK).length;

  atomicWrite(LEADERBOARD_FILE, {
    updatedAt:      new Date().toISOString(),
    windowDays:     WINDOW_DAYS,
    marketsScanned: Object.keys(processedCids).length,
    totalWallets,
    minMarketsToRank: MIN_MARKETS_RANK,
    categories,
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

    const rec = { cid, category, pnl: d.pnl, vol: d.vol, won: d.won, ts: d.lastTs };
    if (durationMin  != null) rec.durationMin = durationMin;
    if (d.twoSided)            rec.twoSided   = true;
    wallets[addr].markets.push(rec);
  }

  processedCids[cid] = { category, winner, vol, durationMin, processedAt: Date.now() };
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

  saveCache();
  writeOutput();
  beat();
  console.log('[LB] Scan complete');
}

// ── Boot ──────────────────────────────────────────────────────────────────────
loadCache();
console.log('[LB] Starting agent20-leaderboard — read-only, zero Claude, 2 req/sec');
writeOutput(); // emit cached data immediately so UI isn't blank

setTimeout(async () => {
  await scan();
  setInterval(scan, SCAN_INTERVAL_MS);
}, 5_000);
