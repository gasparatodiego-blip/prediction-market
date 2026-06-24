#!/usr/bin/env node
// agent17-poly-whales.js — Polymarket short-market whale watcher
// READ-ONLY: no wallet, no orders, no execution, ZERO Claude API calls
// Writes: /tmp/poly-whales.json  /tmp/poly-whales-cache.json
//
// Runs at 0.5 req/sec (1 req per 2 s) — conservative since agent16 also runs.
// Scans every 5 min; processes only newly-resolved short markets.
// PnL formula: sum(BUY usdc) → cost; resolved position * 1.0 → payoff.
// Requires ≥10 resolved markets to rank a wallet.

'use strict';

const fs    = require('fs');
const { httpGet: _sharedGet } = require('../lib/httpGet');

// ── Paths ─────────────────────────────────────────────────────────────────
const WHALE_FILE = '/tmp/poly-whales.json';
const CACHE_FILE = '/tmp/poly-whales-cache.json';

// ── Config ────────────────────────────────────────────────────────────────
const SCAN_MS          = 5 * 60_000;   // 5-min scan cadence
const MAX_RPS          = 0.5;          // 1 req per 2 s (agent16 also runs ≤1/s)
const ROLLING_DAYS     = 7;
const MIN_MARKETS      = 10;           // min resolved markets to rank
const TOP_N            = 20;           // how many wallets to surface
const MAX_TRADES_PER_MKT = 500;        // pagination cap per market

// ── Rate-limited HTTP queue (0.5 req/sec) ─────────────────────────────────
const queue    = [];
let qRunning   = false;

function httpsGet(url, ms = 10000) {
  return new Promise((resolve, reject) => {
    queue.push({ url, ms, resolve, reject });
    drainQ();
  });
}

async function drainQ() {
  if (qRunning) return;
  qRunning = true;
  while (queue.length > 0) {
    const { url, ms, resolve, reject } = queue.shift();
    const t0 = Date.now();
    try { resolve(await rawGet(url, ms)); } catch (e) { reject(e); }
    const wait = 1000 / MAX_RPS - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
  }
  qRunning = false;
  if (queue.length > 0) drainQ();
}

function rawGet(url, ms) { return _sharedGet(url, { timeoutMs: ms }).then(r => r.data); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Atomic write ──────────────────────────────────────────────────────────
function atomicWrite(file, data) {
  const tmp = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ── State ─────────────────────────────────────────────────────────────────
// processedMarkets: { conditionId → { winner, title, windowStart, windowEnd, coin, duration, processedAt } }
// walletStats: { proxyWallet → WalletStat }
// WalletStat: { name, markets: [{cid, winner, ourSide, pnl, entryTimingPct, tradesInMarket, windowStart, windowEnd}] }

let processedMarkets = {};
let walletStats      = {};

function loadCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    processedMarkets = c.processedMarkets || {};
    walletStats      = c.walletStats      || {};
    console.log(`[WHALES] Loaded cache: ${Object.keys(processedMarkets).length} markets, ${Object.keys(walletStats).length} wallets`);
  } catch {
    processedMarkets = {};
    walletStats      = {};
  }
}

function saveCache() {
  atomicWrite(CACHE_FILE, { processedMarkets, walletStats, savedAt: new Date().toISOString() });
}

// ── Slug helpers ──────────────────────────────────────────────────────────
function slugToMeta(slug) {
  // btc-updown-5m-1781379900
  let m = slug.match(/^([a-z]+)-updown-(5m|15m|4h)-(\d{10})$/);
  if (m) {
    const DUR = { '5m': 300, '15m': 900, '4h': 14400 };
    const start = +m[3];
    return { coin: m[1].toUpperCase(), duration: m[2], windowStart: start, windowEnd: start + DUR[m[2]] };
  }
  // bitcoin-up-or-down-june-13-2026-3pm-et  (hourly)
  m = slug.match(/^(bitcoin|ethereum|solana|xrp|bnb)-up-or-down-/);
  if (m) {
    const NAMES = { bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL', xrp: 'XRP', bnb: 'BNB' };
    return { coin: NAMES[m[1]] || m[1].toUpperCase(), duration: '1h', windowStart: null, windowEnd: null };
  }
  return null;
}

// ── Discover new short-market conditionIds from trade stream ──────────────
async function discoverCids() {
  let trades;
  try { trades = await httpsGet('https://data-api.polymarket.com/trades?limit=500'); }
  catch (e) { console.error('[WHALES] discover err:', e.message); return []; }
  if (!Array.isArray(trades)) return [];

  const cids = new Set();
  for (const t of trades) {
    const slug = t.slug || '';
    if (!slug.includes('updown') && !slug.includes('up-or-down')) continue;
    if (t.conditionId) cids.add(t.conditionId);
  }
  return [...cids];
}

// ── Check if a market is resolved via CLOB ────────────────────────────────
async function checkResolution(cid) {
  // Returns { winner, closed } or null
  try {
    const c = await httpsGet(`https://clob.polymarket.com/markets/${cid}`);
    if (!c?.tokens || !c.closed) return null;
    for (const t of c.tokens) {
      if (t.winner) return { winner: t.outcome, tokens: c.tokens };
    }
    return null;
  } catch { return null; }
}

// ── Fetch all trades for a resolved market (paginated) ────────────────────
async function fetchAllTrades(cid) {
  const all = [];
  let offset = 0;
  while (all.length < MAX_TRADES_PER_MKT) {
    let page;
    try { page = await httpsGet(`https://data-api.polymarket.com/trades?market=${cid}&limit=50&offset=${offset}`); }
    catch (e) { break; }
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < 50) break; // last page
    offset += 50;
  }
  return all;
}

// ── Compute per-wallet PnL for a resolved market ──────────────────────────
// PnL formula:
//   cost_basis    = sum(BUY size) for winning-outcome token
//   payoff        = (tokens_bought - tokens_sold) * 1.0  [winning token pays $1]
//   realized_sell = sum(SELL size) for winning-outcome token
//   pnl           = realized_sell + payoff - cost_basis
//   (Losing-token trades are a straight loss: cost - sell proceeds, net negative)
//
// We assume `size` = USDC amount (confirmed from Step 1 data).
// Tokens in holding = size / price.

function computeWalletPnL(trades, winner, windowStart, windowEnd) {
  const wallets = {};
  const windowDuration = windowEnd && windowStart ? (windowEnd - windowStart) : null;

  for (const t of trades) {
    const w = t.proxyWallet;
    if (!w) continue;
    if (!wallets[w]) wallets[w] = {
      name: t.name || '',
      positions: { Up: { cost: 0, tokens: 0, sellProceeds: 0 }, Down: { cost: 0, tokens: 0, sellProceeds: 0 } },
      tradeTimestamps: [],
      totalTrades: 0,
    };
    const wdata = wallets[w];
    const outcome = t.outcome;
    if (!wdata.positions[outcome]) continue; // skip unknown outcomes

    const price = parseFloat(t.price) || 0;
    const size  = parseFloat(t.size)  || 0;
    if (price <= 0 || size <= 0) continue;

    const tokensTraded = size / price;

    if (t.side === 'BUY') {
      wdata.positions[outcome].cost   += size;
      wdata.positions[outcome].tokens += tokensTraded;
    } else { // SELL
      wdata.positions[outcome].sellProceeds += size;
      wdata.positions[outcome].tokens       -= tokensTraded;
    }
    wdata.tradeTimestamps.push(+t.timestamp);
    wdata.totalTrades++;
  }

  const results = {};
  for (const [w, wdata] of Object.entries(wallets)) {
    if (wdata.totalTrades === 0) continue;

    let pnl = 0;
    for (const [outcome, pos] of Object.entries(wdata.positions)) {
      const isWinner       = outcome === winner;
      const terminalTokens = Math.max(0, pos.tokens); // can't go below 0
      const terminalValue  = isWinner ? terminalTokens * 1.0 : 0;
      pnl += pos.sellProceeds + terminalValue - pos.cost;
    }

    // Entry timing: use the EARLIEST trade timestamp relative to window
    const earliest = Math.min(...wdata.tradeTimestamps);
    const entryTimingPct = (windowStart && windowEnd && earliest >= windowStart)
      ? Math.max(0, Math.min(1, (earliest - windowStart) / (windowEnd - windowStart)))
      : null;

    // Side bias: did they bet more on Up or Down?
    const upCost   = wdata.positions.Up.cost;
    const downCost = wdata.positions.Down.cost;
    const dominantSide = upCost >= downCost ? 'Up' : 'Down';

    results[w] = {
      name:           wdata.name,
      pnl:            Math.round(pnl * 100) / 100,
      totalTrades:    wdata.totalTrades,
      entryTimingPct, // 0=start of window, 1=end of window
      dominantSide,
      upExposureUsdc:   Math.round(upCost   * 100) / 100,
      downExposureUsdc: Math.round(downCost * 100) / 100,
    };
  }
  return results;
}

// ── Process a newly-resolved market ──────────────────────────────────────
async function processMarket(cid, resolution, slug) {
  const slugMeta = slugToMeta(slug || '');
  const title = `${slugMeta?.coin || cid.slice(0,8)} ${slugMeta?.duration || '?'}`;

  const trades = await fetchAllTrades(cid);
  if (trades.length === 0) return;

  const windowStart = slugMeta?.windowStart ?? null;
  const windowEnd   = slugMeta?.windowEnd   ?? null;

  const walletPnLs = computeWalletPnL(trades, resolution.winner, windowStart, windowEnd);

  // Merge into walletStats
  const cutoff = Date.now() / 1000 - ROLLING_DAYS * 86400;
  for (const [wallet, data] of Object.entries(walletPnLs)) {
    if (!walletStats[wallet]) {
      walletStats[wallet] = { name: data.name, markets: [] };
    }
    walletStats[wallet].markets.push({
      cid,
      title,
      winner:           resolution.winner,
      ourPnl:           data.pnl,
      won:              data.pnl > 0,
      totalTrades:      data.totalTrades,
      entryTimingPct:   data.entryTimingPct,
      dominantSide:     data.dominantSide,
      upExposureUsdc:   data.upExposureUsdc,
      downExposureUsdc: data.downExposureUsdc,
      resolvedAt:       windowEnd,
    });
    // Trim to rolling window
    walletStats[wallet].markets = walletStats[wallet].markets.filter(
      m => !m.resolvedAt || m.resolvedAt > cutoff
    );
    // Keep only last 200 market entries per wallet to bound memory
    if (walletStats[wallet].markets.length > 200) {
      walletStats[wallet].markets = walletStats[wallet].markets.slice(-200);
    }
  }

  processedMarkets[cid] = {
    winner:      resolution.winner,
    title,
    slug,
    windowStart,
    windowEnd,
    tradeCount:  trades.length,
    processedAt: Date.now(),
  };

  console.log(`[WHALES] Processed ${title}: ${trades.length} trades, ${Object.keys(walletPnLs).length} wallets`);
}

// ── Rank wallets ──────────────────────────────────────────────────────────
function rankWallets() {
  const cutoff = Date.now() / 1000 - ROLLING_DAYS * 86400;
  const ranked = [];

  for (const [wallet, stat] of Object.entries(walletStats)) {
    const recent = stat.markets.filter(m => !m.resolvedAt || m.resolvedAt > cutoff);
    if (recent.length < MIN_MARKETS) continue;

    const wins    = recent.filter(m => m.won).length;
    const losses  = recent.length - wins;
    const totalPnl = recent.reduce((s, m) => s + m.ourPnl, 0);

    // Pattern: entry timing
    const timings = recent.map(m => m.entryTimingPct).filter(t => t !== null);
    const avgTiming = timings.length > 0
      ? timings.reduce((s, t) => s + t, 0) / timings.length
      : null;
    const timingLabel =
      avgTiming === null ? 'unknown' :
      avgTiming < 0.2   ? 'early (first 20% of window)'  :
      avgTiming > 0.8   ? 'late-window (final 20%)'       :
      'mid-window';

    // Side bias: % of markets where Up was dominant
    const upBias = recent.filter(m => m.dominantSide === 'Up').length / recent.length;
    const sideBias = upBias > 0.6 ? 'momentum-biased (mostly Up)'
                   : upBias < 0.4 ? 'contrarian-biased (mostly Down)'
                   : 'balanced';

    // Market types traded
    const durations = [...new Set(recent.map(m => m.title.split(' ')[1]).filter(Boolean))];

    // Avg size and trades per market
    const avgTradesPerMkt = recent.reduce((s, m) => s + m.totalTrades, 0) / recent.length;
    const avgExposureUsdc = recent.reduce((s, m) => s + m.upExposureUsdc + m.downExposureUsdc, 0) / recent.length;

    ranked.push({
      wallet,
      name:              stat.name || wallet.slice(0, 10) + '…',
      resolvedMarkets:   recent.length,
      wins,
      losses,
      winRatePct:        Math.round(wins / recent.length * 1000) / 10,
      totalPnlUsdc:      Math.round(totalPnl * 100) / 100,
      avgPnlPerMarket:   Math.round(totalPnl / recent.length * 100) / 100,
      pattern: {
        avgEntryTimingPct: avgTiming !== null ? Math.round(avgTiming * 1000) / 10 : null,
        timingLabel,
        sideBias,
        upBiasRate:       Math.round(upBias * 1000) / 10,
        avgTradesPerMarket: Math.round(avgTradesPerMkt * 10) / 10,
        avgExposurePerMarket: Math.round(avgExposureUsdc * 100) / 100,
        durationsTraded:  durations,
      },
      disclaimer: 'Pattern is OBSERVED behavior only, not explained intent. Top short-market wallets are likely latency/infra-advantage bots whose edge is not replicable by manual or slow-polling strategies. This is analysis only — never a copy-trade signal.',
    });
  }

  // Sort: highest total PnL among wallets with ≥50% win rate; else by win rate
  ranked.sort((a, b) => {
    if (a.winRatePct >= 55 && b.winRatePct >= 55) return b.totalPnlUsdc - a.totalPnlUsdc;
    if (a.winRatePct >= 55) return -1;
    if (b.winRatePct >= 55) return 1;
    return b.winRatePct - a.winRatePct;
  });

  return ranked.slice(0, TOP_N);
}

// ── Write output ──────────────────────────────────────────────────────────
function writeOutput() {
  const topWallets = rankWallets();
  const allStats   = Object.values(walletStats);
  const recentMarkets = Object.values(processedMarkets).filter(
    m => !m.processedAt || m.processedAt > Date.now() - ROLLING_DAYS * 86400 * 1000
  );

  atomicWrite(WHALE_FILE, {
    updatedAt:          new Date().toISOString(),
    windowDays:         ROLLING_DAYS,
    minMarketsToRank:   MIN_MARKETS,
    marketsProcessed:   Object.keys(processedMarkets).length,
    marketsInWindow:    recentMarkets.length,
    uniqueWallets:      allStats.length,
    qualifiedWallets:   topWallets.length,
    topWallets,
    recentMarkets: recentMarkets
      .sort((a, b) => (b.processedAt || 0) - (a.processedAt || 0))
      .slice(0, 30)
      .map(m => ({ title: m.title, winner: m.winner, tradeCount: m.tradeCount, processedAt: new Date(m.processedAt).toISOString() })),
    stats: {
      disclaimer: `Requires ≥${MIN_MARKETS} resolved markets in the last ${ROLLING_DAYS} days to rank a wallet. Most short-market wallets are one-time participants. "Consistently profitable" wallets here are likely automated bots with latency/infrastructure advantages.`,
    },
  });
}

// ── Main scan loop ────────────────────────────────────────────────────────
async function scan() {
  console.log('[WHALES] Scanning…');

  // 1. Discover conditionIds from recent trade stream
  const cids = await discoverCids();
  console.log(`[WHALES] Found ${cids.length} short-market cids in trade stream`);

  // 2. For each unknown cid, check resolution
  let newResolved = 0;
  for (const cid of cids) {
    if (processedMarkets[cid]) continue; // already done

    const res = await checkResolution(cid);
    if (!res) continue; // not yet resolved or error

    // Find slug from trade stream (re-use from cid → slug mapping in processedMarkets, else derive)
    // We'll just store whatever slug we can find from the discovery phase
    const slug = ''; // we don't have it here; rely on CLOB data / slug from cache

    await processMarket(cid, res, slug);
    newResolved++;

    // Small pause between markets to stay rate-limited
    // (the HTTP queue already enforces 0.5 req/sec, so no extra sleep needed)
  }

  if (newResolved > 0) {
    console.log(`[WHALES] Processed ${newResolved} newly-resolved markets`);
    saveCache();
    writeOutput();
  } else {
    console.log('[WHALES] No new resolved markets');
  }
}

// Improved discover that also captures slug from trades
async function discoverCidsWithSlug() {
  let trades;
  try { trades = await httpsGet('https://data-api.polymarket.com/trades?limit=500'); }
  catch (e) { console.error('[WHALES] discover err:', e.message); return {}; }
  if (!Array.isArray(trades)) return {};

  const cidToSlug = {};
  for (const t of trades) {
    const slug = t.slug || '';
    if (!slug.includes('updown') && !slug.includes('up-or-down')) continue;
    if (t.conditionId) cidToSlug[t.conditionId] = slug;
  }
  return cidToSlug;
}

async function scanWithSlugs() {
  console.log('[WHALES] Scanning…');

  const cidToSlug = await discoverCidsWithSlug();
  const cids = Object.keys(cidToSlug);
  console.log(`[WHALES] Found ${cids.length} short-market cids in trade stream`);

  let newResolved = 0;
  for (const cid of cids) {
    if (processedMarkets[cid]) continue;

    const res = await checkResolution(cid);
    if (!res) continue;

    await processMarket(cid, res, cidToSlug[cid] || '');
    newResolved++;
  }

  if (newResolved > 0 || Object.keys(processedMarkets).length === 0) {
    console.log(`[WHALES] Processed ${newResolved} newly-resolved markets`);
    saveCache();
  }
  writeOutput();
}

// ── Start ─────────────────────────────────────────────────────────────────
loadCache();
console.log('[WHALES] Starting — zero Claude, read-only, ≤0.5 req/sec');
writeOutput(); // write empty/cached output immediately

// Run first scan after a 30s delay (let agent16 warm up first)
setTimeout(async () => {
  await scanWithSlugs();
  setInterval(scanWithSlugs, SCAN_MS);
}, 30_000);
