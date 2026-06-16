#!/usr/bin/env node
// agent18-mm-analyzer.js — Polymarket two-sided maker SIMULATOR (read-only, zero Claude)
//
// Models a passive YES quote on each eligible binary market. Infers fills from the
// public trade stream (APPROXIMATE — no public maker/taker flag; queue position unknown).
// Persists cycles to disk and back-fills resolutions via CLOB on startup.
//
// TWO P&L numbers in /tmp/mm-analysis.json:
//   measuredPnl      = spread captures − adverse losses                    (verifiable)
//   estimatedRewards = vol × takerFee × price-factor × rebate × our-share  (derived from public data)
//                      our-share = our-size / (our-size + CLOB book depth in reward band)
//
// Reward pool formula replaces the old flat 0.25%/day assumption.
// All inputs (vol24, feeSchedule.rate, feeSchedule.rebateRate, book depth) are public.
// Competition depth is a snapshot — label it ESTIMATE in UI.
'use strict';

const fs    = require('fs');
const https = require('https');

// ── CONFIG ─────────────────────────────────────────────────────────────────────

const DISCOVERY_MS    = 15 * 60_000;  // re-scan Gamma every 15 min
const FILL_CHECK_MS   = 3  * 60_000;  // check fills every 3 min
const STARTUP_DELAY   = 12_000;
const MAX_RPS         = 1.0;          // ≤1 req/sec
const QUOTE_SIZE      = 50;           // USDC per simulated order (floor)
const FILL_WINDOW_MS  = 30 * 60_000;  // 30-min window to pair bid+ask → perfect cycle
const CUT_LOSS_PP     = 0.05;         // 5pp adverse move → cut simulated position
const MAX_REWARD_MKTS = 15;           // reward-program markets (any mid, any vol, just rms>0)
const MAX_BALANCED    = 10;           // golden-rule markets (mid 0.30–0.70, ≥$100/d, ≥14d)

// Golden-rule eligibility (for the BALANCED tier only)
const MIN_VOL24 = 100;
const MIN_DAYS  = 14;
const MID_LOW   = 0.30;
const MID_HIGH  = 0.70;

// ── REWARD POOL NOTE ──────────────────────────────────────────────────────────
// The daily reward pool is DERIVED from public Gamma data — NOT from a dedicated
// rewards endpoint (none exists). Formula:
//   pool = vol24hr × feeSchedule.rate × 2 × min(mid, 1−mid) × feeSchedule.rebateRate
// This equals the USDC that Polymarket redistributes daily to qualifying makers as
// fee rebates. The 2 × min(mid, 1−mid) factor accounts for the price-scaled fee.
// Our share of the pool = our-quote-size / (our-size + competing-depth-in-reward-band).
// Competing depth is a CLOB book snapshot — it changes continuously.
const REWARD_POOL_NOTE =
  'Daily pool = vol24hr × rate × 2 × min(mid, 1−mid) × rebateRate. ' +
  'All inputs from public Gamma feeSchedule. ' +
  'Competing depth from CLOB book snapshot (changes continuously — estimate only). ' +
  'Our share = $50 / ($50 + competingDepth). ' +
  'umaReward in Gamma is a fixed UMA-bond field (always $5) — NOT the daily pool.';

const DISCLAIMER =
  'Fill simulation is APPROXIMATE — no public maker/taker flag in Polymarket data-api. ' +
  'Fills inferred from price-crossing; queue position unknown. ' +
  'measuredPnl = captured spread − adverse losses, NO rewards. ' +
  'estimatedRewards = real pool formula × estimated share (competition snapshot).';

// ── File paths ─────────────────────────────────────────────────────────────────
const LOG_FILE    = '/tmp/mm-log.json';
const STATE_FILE  = '/tmp/mm-state.json';
const OUTPUT_FILE = '/tmp/mm-analysis.json';

// ── Rate-limited HTTP queue (serial, ≤1 req/sec) ──────────────────────────────
const _q = [];
let _running = false;

function httpGet(url, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    _q.push({ url, timeoutMs, resolve, reject });
    _drain();
  });
}

async function _drain() {
  if (_running) return;
  _running = true;
  while (_q.length > 0) {
    const { url, timeoutMs, resolve, reject } = _q.shift();
    const t0 = Date.now();
    try   { resolve(await _rawGet(url, timeoutMs)); }
    catch (e) { reject(e); }
    const gap = Math.ceil(1000 / MAX_RPS) - (Date.now() - t0);
    if (gap > 0) await sleep(gap);
  }
  _running = false;
  if (_q.length > 0) _drain();
}

function _rawGet(url, ms) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: ms }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        try   { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (e) { reject(new Error(`JSON(${res.statusCode}): ${body.slice(0, 80)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Atomic write ───────────────────────────────────────────────────────────────
function atomicWrite(path, obj) {
  const tmp = path + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, path);
}

// ── In-memory state ───────────────────────────────────────────────────────────
const markets = new Map();
let   cycles  = [];

// ── Persistence ───────────────────────────────────────────────────────────────

function loadPersisted() {
  try {
    const log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    cycles = Array.isArray(log.cycles) ? log.cycles : [];
    console.log(`[init] loaded ${cycles.length} cycles from log`);
  } catch { cycles = []; }

  try {
    const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const nowSec = Math.floor(Date.now() / 1000);
    for (const [cid, m] of Object.entries(st.markets ?? {})) {
      // Advance any market with lastTradeTs=0 so we don't replay historical trades as our fills.
      if (!m.lastTradeTs) m.lastTradeTs = nowSec;
      markets.set(cid, m);
    }
    console.log(`[init] loaded ${markets.size} market states`);
  } catch {}
}

function savePersisted() {
  atomicWrite(LOG_FILE, { savedAt: new Date().toISOString(), cycles });
  const mkObj = {};
  for (const [cid, m] of markets) mkObj[cid] = m;
  atomicWrite(STATE_FILE, { savedAt: new Date().toISOString(), markets: mkObj });
}

// ── Cycle helpers ─────────────────────────────────────────────────────────────

function openCycle(market, direction, entryPrice, entryTs) {
  const id = `${market.cid}_${entryTs}`;
  const cycle = {
    id,
    cid:          market.cid,
    title:        market.title,
    rewardTag:    market.rewardTag,
    direction,
    quoteBid:     market.quoteBid,
    quoteAsk:     market.quoteAsk,
    quoteSize:    QUOTE_SIZE,
    entryTs,
    entryPrice,
    entryShares:  QUOTE_SIZE / Math.max(entryPrice, 0.05),  // cap at 1 000 shares; penny markets distort P&L
    exitTs:       null,
    exitPrice:    null,
    exitReason:   null,
    type:         'open',
    measuredPnl:  null,
    winner:       null,
    resolutionTs: null,
  };
  cycles.push(cycle);
  return cycle;
}

function closeCycle(cycleId, type, exitPrice, exitTs, exitReason) {
  const cycle = cycles.find(c => c.id === cycleId);
  if (!cycle || cycle.type !== 'open') return;
  cycle.exitTs     = exitTs;
  cycle.exitPrice  = exitPrice;
  cycle.exitReason = exitReason;
  cycle.type       = type;

  if (type === 'perfect') {
    cycle.measuredPnl = (cycle.quoteAsk - cycle.quoteBid) * cycle.entryShares;
  } else {
    cycle.measuredPnl = cycle.direction === 'long'
      ? (exitPrice - cycle.entryPrice) * cycle.entryShares
      : (cycle.entryPrice - exitPrice) * cycle.entryShares;
  }
  return cycle;
}

function resolveOpenCycle(cycleId, winner, resolutionTs) {
  const cycle = cycles.find(c => c.id === cycleId);
  if (!cycle || cycle.type !== 'open') return;
  cycle.winner       = winner;
  cycle.resolutionTs = resolutionTs;
  cycle.type         = 'resolved';
  cycle.exitTs       = resolutionTs;
  cycle.exitReason   = `resolved: ${winner} won`;
  const yesWon = winner === cycle.yesOutcome || winner === 'Yes';
  const payoff = yesWon ? 1.0 : 0.0;
  cycle.exitPrice   = cycle.direction === 'long' ? payoff : (1 - payoff);
  cycle.measuredPnl = cycle.direction === 'long'
    ? (payoff - cycle.entryPrice) * cycle.entryShares
    : (cycle.entryPrice - payoff) * cycle.entryShares;
}

// ── Competition depth (CLOB book) ─────────────────────────────────────────────
// Sums the USDC value of resting orders within the reward band [mid ± rms/100].
// This is a snapshot — competition changes continuously. Labeled as ESTIMATE.

async function fetchCompetingDepth(market) {
  const rms = market.rms;
  if (!rms || rms <= 0 || !market.yesTokenId) return 0;

  try {
    const res = await httpGet(`https://clob.polymarket.com/book?token_id=${market.yesTokenId}`);
    if (res.status !== 200 || !res.data) return 0;

    const bids = (res.data.bids || []).map(b => ({
      price: parseFloat(b.price), size: parseFloat(b.size),
    }));
    const asks = (res.data.asks || []).map(a => ({
      price: parseFloat(a.price), size: parseFloat(a.size),
    }));

    const mid = market.mid;
    const lo  = mid - rms / 100;  // lower bound of reward band
    const hi  = mid + rms / 100;  // upper bound

    // Qualifying bids: resting buy orders within the band (price ≥ lo and ≤ mid)
    const bidDepth = bids
      .filter(b => b.price >= lo)
      .reduce((s, b) => s + b.size * b.price, 0);

    // Qualifying asks: resting sell orders within the band (price ≤ hi and ≥ mid)
    const askDepth = asks
      .filter(a => a.price <= hi)
      .reduce((s, a) => s + a.size * a.price, 0);

    return Math.round((bidDepth + askDepth) * 100) / 100;
  } catch (e) {
    console.warn(`[depth] ${market.cid.slice(0, 8)}: ${e.message}`);
    return 0;
  }
}

// ── Market discovery (Gamma) ───────────────────────────────────────────────────

async function discoverMarkets() {
  console.log('[discover] scanning Gamma…');
  const now            = Date.now();
  const rewardEligible = [];
  const balancedEligible = [];

  try {
    for (let offset = 0; offset < 400; offset += 100) {
      const url = `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&offset=${offset}`;
      const res = await httpGet(url);
      if (res.status !== 200 || !Array.isArray(res.data)) break;

      for (const m of res.data) {
        if (!m.acceptingOrders || m.closed || !m.active) continue;

        let tids = [];
        try { tids = JSON.parse(m.clobTokenIds || '[]'); } catch {}
        if (tids.length < 2) continue;

        let outcomeNames = ['Yes', 'No'];
        try {
          const raw = JSON.parse(m.outcomes || '["Yes","No"]');
          if (Array.isArray(raw) && raw.length >= 2) outcomeNames = raw;
        } catch {}

        const bid  = parseFloat(m.bestBid ?? 0);
        const ask  = parseFloat(m.bestAsk ?? 0);
        const mid  = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
        const vol  = parseFloat(m.volume24hr ?? m.volumeNum ?? 0);
        const end  = m.endDate ? new Date(m.endDate).getTime() : 0;
        const days = end > 0 ? (end - now) / 86_400_000 : 0;

        if (bid <= 0 || ask <= 0 || mid <= 0) continue;

        const spread = ask - bid;
        const rms    = parseFloat(m.rewardsMaxSpread ?? 0);
        const rmn    = parseFloat(m.rewardsMinSize   ?? 0);

        // Parse fee schedule (comes as JSON string from Gamma)
        let fs = {};
        try { fs = typeof m.feeSchedule === 'string' ? JSON.parse(m.feeSchedule) : (m.feeSchedule ?? {}); } catch {}
        const takerFeeRate = parseFloat(fs.rate ?? 0.05);
        const rebateRate   = parseFloat(fs.rebateRate ?? 0.25);

        const base = {
          cid: m.conditionId,
          title: m.question ?? m.slug ?? m.conditionId.slice(0, 12),
          slug: m.slug ?? '',
          yesTokenId: tids[0],
          noTokenId:  tids[1] ?? '',
          yesOutcome: outcomeNames[0],
          negRisk:    !!m.negRisk,
          quoteBid: bid, quoteAsk: ask, mid, spread,
          vol24: vol, days, rms, rmn, takerFeeRate, rebateRate,
        };

        // REWARD tier: any market in the LP reward program (rewardsMinSize > 0)
        if (rms > 0 && rmn > 0) {
          rewardEligible.push({ ...base, rewardTag: 'reward' });
        }
        // BALANCED tier: golden-rule long-dated balanced markets (no reward program)
        else if (mid >= MID_LOW && mid <= MID_HIGH && vol >= MIN_VOL24 && days >= MIN_DAYS) {
          balancedEligible.push({ ...base, rewardTag: 'balanced' });
        }
      }

      if (res.data.length < 100) break;
    }
  } catch (e) {
    console.error('[discover] error:', e.message);
    return;
  }

  rewardEligible.sort((a, b) => b.vol24 - a.vol24);
  balancedEligible.sort((a, b) => b.vol24 - a.vol24);

  const topReward   = rewardEligible.slice(0, MAX_REWARD_MKTS);
  const topBalanced = balancedEligible
    .filter(m => !topReward.some(r => r.cid === m.cid))
    .slice(0, MAX_BALANCED);

  const top    = [...topReward, ...topBalanced];
  const newCids = new Set(top.map(m => m.cid));

  for (const m of top) {
    const existing = markets.get(m.cid);
    if (existing) {
      Object.assign(existing, {
        quoteBid: m.quoteBid, quoteAsk: m.quoteAsk, mid: m.mid,
        spread: m.spread, vol24: m.vol24, days: m.days,
        rms: m.rms, rmn: m.rmn, rewardTag: m.rewardTag,
        takerFeeRate: m.takerFeeRate, rebateRate: m.rebateRate,
      });
    } else {
      markets.set(m.cid, {
        ...m,
        lastTradeTs:      Math.floor(now / 1000),  // only count trades from discovery onward
        lastRefreshTs:    now,
        position:         null,
        resolved:         false,
        competingDepth:   null,
        competingDepthAt: 0,
        stats: {
          totalCycles: 0, perfectCycles: 0, adverseCycles: 0,
          resolvedCycles: 0, measuredPnlTotal: 0, quotedSeconds: 0,
        },
      });
      console.log(`[discover] +${m.rewardTag} ${m.title.slice(0, 55)} mid=${m.mid.toFixed(3)}`);
    }
  }

  for (const [cid, m] of markets) {
    if (!newCids.has(cid) && !m.resolved && !m.position) {
      markets.delete(cid);
    }
  }

  // Fetch competition depth for all reward markets (1 CLOB book req each)
  for (const m of [...markets.values()].filter(m => m.rewardTag === 'reward')) {
    m.competingDepth   = await fetchCompetingDepth(m);
    m.competingDepthAt = Date.now();
  }

  const rN = [...markets.values()].filter(m => m.rewardTag === 'reward').length;
  const bN = [...markets.values()].filter(m => m.rewardTag === 'balanced').length;
  console.log(`[discover] ${rN} reward + ${bN} balanced = ${markets.size} total`);
}

// ── Quote refresh (CLOB /price per market) ────────────────────────────────────

async function refreshQuote(market) {
  try {
    const [bidRes, askRes] = await Promise.all([
      httpGet(`https://clob.polymarket.com/price?token_id=${market.yesTokenId}&side=buy`),
      httpGet(`https://clob.polymarket.com/price?token_id=${market.yesTokenId}&side=sell`),
    ]);
    const bid = parseFloat(bidRes.data?.price ?? bidRes.data ?? market.quoteBid);
    const ask = parseFloat(askRes.data?.price ?? askRes.data ?? market.quoteAsk);
    if (bid > 0 && ask > 0 && ask > bid) {
      market.quoteBid = bid;
      market.quoteAsk = ask;
      market.mid      = (bid + ask) / 2;
      market.spread   = ask - bid;
    }
  } catch (e) {
    console.warn(`[quote] ${market.cid.slice(0, 8)}: ${e.message}`);
  }
}

// ── Fill check (data-api activity) ────────────────────────────────────────────

async function checkFills(market) {
  // Fill inference and spread model are unreliable at extreme prices: near-zero markets
  // have rounding-noise spreads and 50k+ implied share counts that distort P&L.
  if (market.mid < 0.03 || market.mid > 0.97) return;

  let trades;
  try {
    const res = await httpGet(`https://data-api.polymarket.com/trades?market=${market.cid}&limit=100`);
    if (res.status !== 200 || !Array.isArray(res.data)) return;
    trades = res.data;
  } catch (e) {
    console.warn(`[fills] ${market.cid.slice(0, 8)}: ${e.message}`);
    return;
  }

  const newTrades = trades.length === 0 ? [] : trades
    .filter(t => (t.timestamp ?? 0) > market.lastTradeTs)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (newTrades.length === 0) {
    if (market.position) {
      const age = Date.now() - market.position.entryTs;
      if (age > FILL_WINDOW_MS) {
        const pos = market.position;
        const unwindPrice = pos.direction === 'long' ? market.quoteBid : market.quoteAsk;
        closeCycle(pos.cycleId, 'adverse', unwindPrice, Date.now(), 'fill-window-timeout');
        updateStats(market, 'adverse');
        market.position = null;
      }
    }
    return;
  }

  market.lastTradeTs = Math.max(...newTrades.map(t => t.timestamp));

  const now = Date.now();
  for (const trade of newTrades) {
    const price   = parseFloat(trade.price ?? 0);
    const side    = trade.side;
    const outcome = trade.outcome ?? '';
    const ts      = (trade.timestamp ?? 0) * 1000;

    if (outcome !== market.yesOutcome) continue;
    if (price <= 0) continue;

    const B = market.quoteBid;
    const A = market.quoteAsk;

    // Fill inference (APPROXIMATE): price-crossing rule, queue position unknown.
    const crossesBid = side === 'SELL' && price <= B;
    const crossesAsk = side === 'BUY'  && price >= A;
    if (!crossesBid && !crossesAsk) continue;

    if (!market.position) {
      if (crossesBid) {
        const cycle = openCycle(market, 'long', B, ts);
        market.position = { direction: 'long', entryTs: ts, entryPrice: B, cycleId: cycle.id };
        console.log(`[fill] LONG  ${market.cid.slice(0, 8)} @${B.toFixed(3)}`);
      } else if (crossesAsk) {
        const cycle = openCycle(market, 'short', A, ts);
        market.position = { direction: 'short', entryTs: ts, entryPrice: A, cycleId: cycle.id };
        console.log(`[fill] SHORT ${market.cid.slice(0, 8)} @${A.toFixed(3)}`);
      }
    } else {
      const pos = market.position;
      if (ts - pos.entryTs > FILL_WINDOW_MS) {
        const unwindPrice = pos.direction === 'long' ? market.quoteBid : market.quoteAsk;
        closeCycle(pos.cycleId, 'adverse', unwindPrice, ts, 'fill-window-timeout');
        updateStats(market, 'adverse');
        market.position = null;
        continue;
      }

      if (pos.direction === 'long') {
        if (crossesAsk) {
          closeCycle(pos.cycleId, 'perfect', A, ts, 'ask-fill');
          updateStats(market, 'perfect');
          market.position = null;
          const c = cycles.find(c => c.id === pos.cycleId);
          console.log(`[fill] PERFECT ${market.cid.slice(0, 8)} pnl=${c?.measuredPnl?.toFixed(3)}`);
        } else if (price <= pos.entryPrice - CUT_LOSS_PP) {
          closeCycle(pos.cycleId, 'adverse', price, ts, `cut-loss @${price.toFixed(3)}`);
          updateStats(market, 'adverse');
          market.position = null;
        }
      } else {
        if (crossesBid) {
          closeCycle(pos.cycleId, 'perfect', B, ts, 'bid-fill');
          updateStats(market, 'perfect');
          market.position = null;
          const c = cycles.find(c => c.id === pos.cycleId);
          console.log(`[fill] PERFECT ${market.cid.slice(0, 8)} pnl=${c?.measuredPnl?.toFixed(3)}`);
        } else if (price >= pos.entryPrice + CUT_LOSS_PP) {
          closeCycle(pos.cycleId, 'adverse', price, ts, `cut-loss @${price.toFixed(3)}`);
          updateStats(market, 'adverse');
          market.position = null;
        }
      }
    }
  }

  if (market.position) {
    const age = now - market.position.entryTs;
    if (age > FILL_WINDOW_MS) {
      const pos = market.position;
      const unwindPrice = pos.direction === 'long' ? market.quoteBid : market.quoteAsk;
      closeCycle(pos.cycleId, 'adverse', unwindPrice, now, 'fill-window-timeout');
      updateStats(market, 'adverse');
      market.position = null;
    }
  }
}

function updateStats(market, type) {
  const cycle = cycles.find(c => c.id === market.position?.cycleId);
  market.stats.totalCycles++;
  const pnl = cycle?.measuredPnl ?? 0;
  if      (type === 'perfect')  { market.stats.perfectCycles++;  market.stats.measuredPnlTotal += pnl; }
  else if (type === 'adverse')  { market.stats.adverseCycles++;  market.stats.measuredPnlTotal += pnl; }
  else if (type === 'resolved') { market.stats.resolvedCycles++; market.stats.measuredPnlTotal += pnl; }
}

// ── Back-fill resolutions (CLOB tokens[].winner) ──────────────────────────────

async function backFillResolutions() {
  const openCycles = cycles.filter(c => c.type === 'open');
  if (openCycles.length === 0) return;

  console.log(`[backfill] checking ${openCycles.length} open cycles…`);
  const checked = new Set();

  for (const cycle of openCycles) {
    if (checked.has(cycle.cid)) continue;
    checked.add(cycle.cid);
    try {
      const res = await httpGet(`https://clob.polymarket.com/markets/${cycle.cid}`);
      if (res.status !== 200) continue;
      const tokens = res.data?.tokens ?? [];
      const winner = tokens.find(t => t.winner)?.outcome ?? null;
      if (winner) {
        const resTs = Date.now();
        for (const c of cycles.filter(x => x.cid === cycle.cid && x.type === 'open')) {
          resolveOpenCycle(c.id, winner, resTs);
          const m = markets.get(c.cid);
          if (m) { m.position = null; m.resolved = true; updateStats(m, 'resolved'); }
        }
        console.log(`[backfill] ${cycle.cid.slice(0, 8)} resolved → ${winner}`);
      }
    } catch (e) {
      console.warn(`[backfill] ${cycle.cid.slice(0, 8)}: ${e.message}`);
    }
  }
}

// ── Write output ───────────────────────────────────────────────────────────────

function writeOutput() {
  const now = Date.now();

  // Cycle aggregates
  let totalCycles=0, perfectCycles=0, adverseCycles=0, resolvedCycles=0, openCycles=0, measuredPnl=0;
  for (const c of cycles) {
    if      (c.type === 'open')     { openCycles++; }
    else if (c.type === 'perfect')  { perfectCycles++;  totalCycles++; measuredPnl += c.measuredPnl ?? 0; }
    else if (c.type === 'adverse')  { adverseCycles++;  totalCycles++; measuredPnl += c.measuredPnl ?? 0; }
    else if (c.type === 'resolved') { resolvedCycles++; totalCycles++; measuredPnl += c.measuredPnl ?? 0; }
  }

  // Per-market reward computation and summaries
  let totalQuotedHours = 0;
  let aggEstPerDay     = 0;   // $/day at current competition snapshot
  let aggEstCum        = 0;   // accumulated since agent start

  const marketSummaries = [];
  for (const m of markets.values()) {
    const hours = m.stats.quotedSeconds / 3600;
    totalQuotedHours += hours;

    let dailyPool = null, ourShare = null, estPerDay = null, estCum = null;

    if (m.rewardTag === 'reward') {
      // Pool = vol24 × takerRate × priceFactor × rebateRate
      // priceFactor = 2 × min(mid, 1-mid) peaks at 1.0 when mid=0.5, lower for extreme prices
      const priceFactor = 2 * Math.min(m.mid, 1 - m.mid);
      dailyPool  = m.vol24 * m.takerFeeRate * priceFactor * m.rebateRate;
      const quoteSize = Math.max(QUOTE_SIZE, m.rmn);  // meet reward minimum
      const competing = m.competingDepth ?? 0;
      ourShare   = quoteSize / (quoteSize + competing);
      estPerDay  = dailyPool * ourShare;
      estCum     = estPerDay * (hours / 24);
      aggEstPerDay += estPerDay;
      aggEstCum    += estCum;
    }

    marketSummaries.push({
      cid:            m.cid,
      title:          m.title,
      rewardTag:      m.rewardTag,
      mid:            m.mid,
      quoteBid:       m.quoteBid,
      quoteAsk:       m.quoteAsk,
      spread:         m.spread,
      spreadPct:      m.spread * 100,
      vol24:          m.vol24,
      days:           m.days,
      negRisk:        m.negRisk,
      rms:            m.rms,
      rmn:            m.rmn,
      takerFeeRate:   m.takerFeeRate,
      rebateRate:     m.rebateRate,
      dailyPool:      dailyPool  !== null ? Math.round(dailyPool  * 100) / 100 : null,
      competingDepth: m.competingDepth !== null ? Math.round(m.competingDepth) : null,
      ourShare:       ourShare   !== null ? Math.round(ourShare   * 10000) / 10000 : null,
      estRewardPerDay: estPerDay !== null ? Math.round(estPerDay  * 10000) / 10000 : null,
      estRewardCum:   estCum     !== null ? Math.round(estCum     * 10000) / 10000 : null,
      hasOpenPosition:   !!m.position,
      positionDirection: m.position?.direction ?? null,
      totalCycles:       m.stats.totalCycles,
      perfectCycles:     m.stats.perfectCycles,
      adverseCycles:     m.stats.adverseCycles,
      measuredPnl:       m.stats.measuredPnlTotal,
      quotedHours:       Math.round(hours * 10) / 10,
    });
  }

  // Sort: reward markets first (by vol24 desc), then balanced
  marketSummaries.sort((a, b) => {
    if (a.rewardTag !== b.rewardTag) return a.rewardTag === 'reward' ? -1 : 1;
    return b.vol24 - a.vol24;
  });

  const recentCycles = cycles
    .filter(c => c.type !== 'open')
    .slice(-30)
    .reverse()
    .map(c => ({
      id: c.id, title: c.title, rewardTag: c.rewardTag, direction: c.direction,
      type: c.type, entryTs: c.entryTs, exitTs: c.exitTs,
      entryPrice: c.entryPrice, exitPrice: c.exitPrice,
      exitReason: c.exitReason, measuredPnl: c.measuredPnl, winner: c.winner,
    }));

  const rN = [...markets.values()].filter(m => m.rewardTag === 'reward').length;
  const bN = [...markets.values()].filter(m => m.rewardTag === 'balanced').length;

  atomicWrite(OUTPUT_FILE, {
    updatedAt:      new Date(now).toISOString(),
    agentVersion:   'agent18-mm-analyzer v2',
    rewardPoolNote: REWARD_POOL_NOTE,
    markets:        marketSummaries,
    aggregate: {
      totalMarkets:     markets.size,
      rewardMarkets:    rN,
      balancedMarkets:  bN,
      totalCycles, openCycles, perfectCycles, adverseCycles, resolvedCycles,
      measuredPnl:       Math.round(measuredPnl    * 10000) / 10000,
      // Reward: derived from real pool × estimated competition share.
      estRewardPerDay:   Math.round(aggEstPerDay   * 10000) / 10000,
      estimatedRewards:  Math.round(aggEstCum      * 10000) / 10000,
      totalWithRewards:  Math.round((measuredPnl + aggEstCum) * 10000) / 10000,
      quotedHours:       Math.round(totalQuotedHours * 10) / 10,
    },
    recentCycles,
    disclaimer: DISCLAIMER,
  });
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function fillCheckCycle() {
  for (const market of markets.values()) {
    if (market.resolved) continue;
    if (market.mid < 0.03 || market.mid > 0.97) {
      market.position = null;  // discard any position opened before this filter existed
      continue;
    }
    await refreshQuote(market);
    await checkFills(market);
    market.stats.quotedSeconds += FILL_CHECK_MS / 1000;
  }
  writeOutput();
  savePersisted();
}

async function discoveryCycle() {
  await discoverMarkets();  // also fetches competingDepth for reward markets
  await backFillResolutions();
  writeOutput();
  savePersisted();
}

async function main() {
  console.log('[agent18] v2 starting — real pool formula, two tiers, zero Claude');
  await sleep(STARTUP_DELAY);

  loadPersisted();
  await backFillResolutions();
  await discoveryCycle();

  setInterval(fillCheckCycle,  FILL_CHECK_MS);
  setInterval(discoveryCycle,  DISCOVERY_MS);

  writeOutput();
  console.log('[agent18] running — fills every 3 min, discovery+depth every 15 min');
}

main().catch(e => { console.error('[agent18] fatal:', e); process.exit(1); });
