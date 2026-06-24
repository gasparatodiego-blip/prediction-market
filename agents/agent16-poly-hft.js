#!/usr/bin/env node
// agent16-poly-hft.js — Polymarket short-market divergence detector
// READ-ONLY: no wallet, no orders, no execution, ZERO Claude API calls
// Writes: /tmp/poly-hft-signals.json  /tmp/poly-hft-log.json

'use strict';

const fs    = require('fs');
const { httpGet: _sharedGet } = require('../lib/httpGet');

// ── Paths ─────────────────────────────────────────────────────────────────
const SIGNALS_FILE = '/tmp/poly-hft-signals.json';
const LOG_FILE     = '/tmp/poly-hft-log.json';

// ── Config ────────────────────────────────────────────────────────────────
const DISCOVERY_MS     = 30_000;   // poll trade stream every 30 s
const POLL_NORMAL_MS   = 10_000;   // per-market poll interval
const POLL_FINAL_MS    =  3_000;   // faster in last 60 s
const DIV_THRESHOLD    = 0.05;     // flag when |fairP - polyP| ≥ 5 pp
const MAX_RPS          = 1;        // hard cap: ≤ 1 HTTP req/sec aggregate
const VOL_ANNUAL       = 0.55;     // assumed BTC/ETH/SOL annualised vol (55 %)
const RETENTION_MS     = 30 * 86_400_000; // keep log for 30 days

// ── Rate-limited HTTP queue ───────────────────────────────────────────────
const queue    = [];
let qRunning   = false;

function httpsGet(url, ms = 8000) {
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
  if (queue.length > 0) drainQ(); // items added during final sleep
}

function rawGet(url, ms) { return _sharedGet(url, { timeoutMs: ms }).then(r => r.data); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Atomic write ──────────────────────────────────────────────────────────
function atomicWrite(file, data) {
  const tmp = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ── Normal CDF (Abramowitz & Stegun) ──────────────────────────────────────
function normCdf(x) {
  if (x < -6) return 0; if (x > 6) return 1;
  const s = x < 0 ? -1 : 1, a = Math.abs(x);
  const t = 1 / (1 + 0.2316419 * a);
  const p = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return 0.5 + s * (0.5 - 0.39894228 * Math.exp(-0.5 * a * a) * p);
}

// Fair P(Up): log-normal digital-option model
// P = Φ( ln(current/open) / (σ × √t_remaining_years) )
// HONEST: assumes constant vol, lognormal returns; divergence may be model error.
function fairP(open, current, tRemSec) {
  if (!open || !current || tRemSec <= 0) return null;
  const logM = Math.log(current / open);
  const tYr  = tRemSec / (365.25 * 86400);
  const sig  = VOL_ANNUAL * Math.sqrt(tYr);
  if (sig < 1e-10) return logM >= 0 ? 0.99 : 0.01;
  return normCdf(logM / sig);
}

// ── Slug parser ───────────────────────────────────────────────────────────
// Returns { coin, duration, windowStartSec, windowEndSec, sourceConfidence }
const DUR_SEC = { '5m': 300, '15m': 900, '4h': 14400 };

function parseSlug(slug, gammaEndDate) {
  // Pattern A: btc-updown-5m-1781379900
  let m = slug.match(/^([a-z]+)-updown-(5m|15m|4h)-(\d{10})$/);
  if (m) {
    const start = +m[3];
    return {
      coin: m[1].toUpperCase(),
      duration: m[2],
      windowStartSec: start,
      windowEndSec: start + DUR_SEC[m[2]],
      sourceConfidence: 'proxy', // Chainlink — we proxy with Binance spot
    };
  }
  // Pattern B: bitcoin-up-or-down-june-13-2026-3pm-et  (hourly, Binance candle)
  m = slug.match(/^(bitcoin|ethereum|solana|xrp|bnb)-up-or-down-/);
  if (m && gammaEndDate) {
    const end = Math.floor(new Date(gammaEndDate).getTime() / 1000);
    const NAMES = { bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL', xrp: 'XRP', bnb: 'BNB' };
    return {
      coin: NAMES[m[1]] || m[1].toUpperCase(),
      duration: '1h',
      windowStartSec: end - 3600,
      windowEndSec: end,
      sourceConfidence: 'canonical', // Binance 1H candle — exact match to resolution source
    };
  }
  return null;
}

// Binance symbol map
const BSYM = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT', BNB: 'BNBUSDT', DOGE: 'DOGEUSDT' };

// ── State ─────────────────────────────────────────────────────────────────
const active   = new Map(); // conditionId → MarketState
const resolved = new Set(); // conditionIds fully closed
let spots      = {};        // coin → number (current Binance price)
let log        = [];        // measurement log entries
let signals    = [];        // live signal objects

function loadLog() {
  try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch { log = []; }
}

// ── Discovery ─────────────────────────────────────────────────────────────
async function discover() {
  let trades;
  try { trades = await httpsGet('https://data-api.polymarket.com/trades?limit=300'); }
  catch (e) { console.error('[HFT] discover err:', e.message); return; }
  if (!Array.isArray(trades)) return;

  const nowSec = Date.now() / 1000;
  const seen   = new Set();

  for (const t of trades) {
    const slug = t.slug || '';
    if (!slug.includes('updown') && !slug.includes('up-or-down')) continue;
    const cid = t.conditionId;
    if (!cid || seen.has(cid) || active.has(cid) || resolved.has(cid)) continue;
    seen.add(cid);

    let meta, parsed;
    try {
      const arr = await httpsGet(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`);
      const mArr = Array.isArray(arr) ? arr : (arr?.data || []);
      if (!mArr.length) continue;
      meta = mArr[0];
      if (meta.closed) { resolved.add(cid); continue; }
      parsed = parseSlug(slug, meta.endDate);
      if (!parsed) continue;
      if (parsed.windowEndSec < nowSec - 120) { resolved.add(cid); continue; }
    } catch { continue; }

    let tokenIds = [];
    try { tokenIds = JSON.parse(meta.clobTokenIds || '[]'); } catch {}
    const outcomes = (() => { try { return JSON.parse(meta.outcomes || '["Up","Down"]'); } catch { return ['Up','Down']; } })();
    const upIdx  = outcomes.indexOf('Up');
    const dwnIdx = outcomes.indexOf('Down');

    active.set(cid, {
      conditionId: cid,
      slug,
      title: meta.question || slug,
      coin: parsed.coin,
      duration: parsed.duration,
      sourceConfidence: parsed.sourceConfidence,
      windowStartSec: parsed.windowStartSec,
      windowEndSec: parsed.windowEndSec,
      tokenUp:   tokenIds[upIdx]  ?? null,
      tokenDown: tokenIds[dwnIdx] ?? null,
      openPrice:  null,
      polyPUp:    null,
      polyPDown:  null,
      bestBid:    null,
      bestAsk:    null,
      capacityUsdc: null,
      flagged:    false,  // has a log entry been created?
      lastPollMs: 0,
    });
    console.log(`[HFT] +market ${meta.question} (${parsed.sourceConfidence})`);
  }
}

// ── Fetch open price ──────────────────────────────────────────────────────
async function fetchOpen(mkt) {
  const sym = BSYM[mkt.coin];
  if (!sym) return null; // HYPE etc – no Binance pair
  const startMs = mkt.windowStartSec * 1000;
  const interval = mkt.duration === '1h' ? '1h' : '1m';
  try {
    const kl = await httpsGet(
      `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${interval}&startTime=${startMs}&limit=1`
    );
    if (Array.isArray(kl) && kl[0]) return parseFloat(kl[0][1]); // open
  } catch { }
  return null;
}

// ── Refresh spot prices ───────────────────────────────────────────────────
async function refreshSpots() {
  const coins = [...new Set([...active.values()].map(m => m.coin))].filter(c => BSYM[c]);
  for (const coin of coins) {
    try {
      const d = await httpsGet(`https://api.binance.com/api/v3/ticker/price?symbol=${BSYM[coin]}`);
      if (d?.price) spots[coin] = parseFloat(d.price);
    } catch { }
  }
}

// ── Poll one market ───────────────────────────────────────────────────────
async function pollMarket(mkt) {
  const nowSec = Date.now() / 1000;
  const tRem   = mkt.windowEndSec - nowSec;

  // Past resolution window → check winner
  if (tRem < -60) { await finalise(mkt); return; }

  // Fetch current Polymarket prices from CLOB
  let clob;
  try { clob = await httpsGet(`https://clob.polymarket.com/markets/${mkt.conditionId}`); }
  catch (e) { return; }

  if (!clob?.tokens) return;
  let winnerOutcome = null;
  for (const tok of clob.tokens) {
    if (tok.outcome === 'Up')   mkt.polyPUp   = tok.price;
    if (tok.outcome === 'Down') mkt.polyPDown = tok.price;
    if (tok.winner === true)    winnerOutcome  = tok.outcome;
  }
  if (clob.closed || winnerOutcome) { await finalise(mkt, winnerOutcome); return; }

  // Fetch open price once
  if (!mkt.openPrice) mkt.openPrice = await fetchOpen(mkt);

  const current = spots[mkt.coin];
  if (!mkt.openPrice || !current || mkt.polyPUp === null) return;

  const fp  = fairP(mkt.openPrice, current, Math.max(1, tRem));
  if (fp === null) return;

  const div  = fp - mkt.polyPUp;
  const edge = Math.abs(div);
  const side = div > 0 ? 'Up' : 'Down';

  // Update book depth only when divergence is notable
  if (edge >= DIV_THRESHOLD && tRem > 5) {
    const queryToken = side === 'Up' ? mkt.tokenUp : mkt.tokenDown;
    if (queryToken) {
      try {
        const bk = await httpsGet(`https://clob.polymarket.com/book?token_id=${queryToken}`);
        if (bk?.asks?.length) {
          mkt.bestAsk      = parseFloat(bk.asks[0].price);
          mkt.capacityUsdc = parseFloat(bk.asks[0].size);
        }
        if (bk?.bids?.length) {
          mkt.bestBid = parseFloat(bk.bids[0].price);
        }
      } catch { }
    }
  }

  // Build signal
  const sig = {
    conditionId:      mkt.conditionId,
    slug:             mkt.slug,
    title:            mkt.title,
    coin:             mkt.coin,
    duration:         mkt.duration,
    sourceConfidence: mkt.sourceConfidence, // 'canonical' | 'proxy'
    windowStart:      mkt.windowStartSec,
    windowEnd:        mkt.windowEndSec,
    timeRemainingSec: Math.round(tRem),
    openPrice:        mkt.openPrice,
    currentPrice:     current,
    priceMoveP:       (current - mkt.openPrice) / mkt.openPrice,
    fairP:            Math.round(fp   * 1000) / 1000,
    polyPUp:          mkt.polyPUp,
    divergence:       Math.round(div  * 1000) / 1000,
    flaggedSide:      side,
    edgeP:            Math.round(edge * 1000) / 1000,
    bestBid:          mkt.bestBid,
    bestAsk:          mkt.bestAsk,
    capacityUsdc:     mkt.capacityUsdc,
    status:           'live',
    flaggedAt:        new Date().toISOString(),
    disclaimer:       edge >= DIV_THRESHOLD
      ? 'ESTIMATE. Model assumes ' + (VOL_ANNUAL * 100).toFixed(0) + '% annual vol & lognormal returns.'
        + (mkt.sourceConfidence === 'proxy'
          ? ' 5m/15m/4h resolve on Chainlink; Binance proxy may create FALSE divergences.'
          : ' Hourly resolves on Binance — same source as our model.')
        + ' Edge evaporates in last seconds. Polling latency may miss execution window.'
      : null,
  };

  // Only maintain live-signals list and log entries when divergence is above threshold
  if (edge >= DIV_THRESHOLD) {
    const idx = signals.findIndex(s => s.conditionId === mkt.conditionId);
    if (idx >= 0) signals[idx] = sig; else signals.push(sig);

    // Create ONE measurement log entry per market (first crossing)
    if (!mkt.flagged) {
      mkt.flagged = true;
      const entry = {
        ...sig,
        resolvedAt:     null,
        winner:         null,
        flaggedSideWon: null,
      };
      log.push(entry);
      pruneLog();
      atomicWrite(LOG_FILE, log);
    }
  } else {
    // Divergence dropped — remove from live signals
    signals = signals.filter(s => s.conditionId !== mkt.conditionId);
  }
}

// ── Finalise a resolved market ────────────────────────────────────────────
async function finalise(mkt, knownWinner) {
  let winner = knownWinner;
  if (!winner) {
    try {
      const c = await httpsGet(`https://clob.polymarket.com/markets/${mkt.conditionId}`);
      for (const t of (c?.tokens || [])) { if (t.winner) { winner = t.outcome; break; } }
    } catch { }
  }
  if (winner) {
    let dirty = false;
    for (const e of log) {
      if (e.conditionId === mkt.conditionId && !e.resolvedAt) {
        e.resolvedAt     = new Date().toISOString();
        e.winner         = winner;
        e.flaggedSideWon = e.flaggedSide === winner;
        dirty = true;
      }
    }
    if (dirty) atomicWrite(LOG_FILE, log);
    console.log(`[HFT] resolved ${mkt.title} → ${winner}`);
  }
  active.delete(mkt.conditionId);
  resolved.add(mkt.conditionId);
  signals = signals.filter(s => s.conditionId !== mkt.conditionId);
  if (resolved.size > 500) {
    const a = [...resolved]; resolved.clear(); a.slice(-200).forEach(id => resolved.add(id));
  }
}

// ── Prune log ─────────────────────────────────────────────────────────────
function pruneLog() {
  const cutoff = Date.now() - RETENTION_MS;
  log = log.filter(e => new Date(e.flaggedAt).getTime() > cutoff);
}

// ── Stats from measurement log ────────────────────────────────────────────
function computeStats() {
  const res = log.filter(e => e.resolvedAt);
  const byC = {
    canonical: { flagged: 0, resolved: 0, won: 0 },
    proxy:     { flagged: 0, resolved: 0, won: 0 },
  };
  for (const e of log) {
    const b = byC[e.sourceConfidence] || byC.proxy;
    b.flagged++;
    if (e.resolvedAt) { b.resolved++; if (e.flaggedSideWon) b.won++; }
  }
  const pct = (b) => b.resolved >= 5 ? +(b.won / b.resolved * 100).toFixed(1) : null;
  return {
    totalFlagged:  log.length,
    totalResolved: res.length,
    totalWon:      res.filter(e => e.flaggedSideWon).length,
    hitRatePct:    res.length >= 5 ? +(res.filter(e => e.flaggedSideWon).length / res.length * 100).toFixed(1) : null,
    bySourceConfidence: {
      canonical: { ...byC.canonical, hitRatePct: pct(byC.canonical) },
      proxy:     { ...byC.proxy,     hitRatePct: pct(byC.proxy)     },
    },
    note: 'Hit-rate is not meaningful until ≥50 resolved signals. Accumulate data over several days before drawing conclusions.',
  };
}

// ── Write output ──────────────────────────────────────────────────────────
function writeOutput() {
  const out = {
    updatedAt:     new Date().toISOString(),
    agentVersion:  16,
    liveSignals:   signals.filter(s => s.status === 'live'),
    monitoredMarkets: [...active.values()].map(m => ({
      conditionId:      m.conditionId,
      title:            m.title,
      coin:             m.coin,
      duration:         m.duration,
      sourceConfidence: m.sourceConfidence,
      windowEnd:        m.windowEndSec,
      polyPUp:          m.polyPUp,
      openPrice:        m.openPrice,
      currentSpot:      spots[m.coin] ?? null,
    })),
    stats: computeStats(),
  };
  atomicWrite(SIGNALS_FILE, out);
}

// ── Main loop ─────────────────────────────────────────────────────────────
let lastDiscover = 0;

async function loop() {
  try {
    const now = Date.now();

    if (now - lastDiscover >= DISCOVERY_MS) {
      lastDiscover = now;
      await discover();
    }

    await refreshSpots();

    const nowSec = now / 1000;
    for (const [, mkt] of active) {
      const tRem     = mkt.windowEndSec - nowSec;
      const interval = tRem < 60 ? POLL_FINAL_MS : POLL_NORMAL_MS;
      if (now - mkt.lastPollMs >= interval) {
        mkt.lastPollMs = now;
        await pollMarket(mkt);
      }
    }

    writeOutput();
  } catch (e) {
    console.error('[HFT] loop err:', e);
  }
  setTimeout(loop, POLL_NORMAL_MS);
}

// ── Start ─────────────────────────────────────────────────────────────────
loadLog();
console.log('[HFT] Starting — zero Claude, read-only, ≤1 req/sec');
writeOutput();
loop();
