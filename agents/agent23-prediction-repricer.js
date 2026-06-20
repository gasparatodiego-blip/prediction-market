#!/usr/bin/env node
'use strict';

/**
 * agent23-prediction-repricer — Tier-2 live re-pricer (15-min cadence)
 *
 * Reads the confirmed cashable pairs from the Tier-1 discovery output
 * (/tmp/arbitrage-opportunities.json), fetches CURRENT executable quotes from
 * the Kalshi orderbook and Polymarket CLOB APIs for ONLY those pairs (~dozens),
 * and rewrites the live view to /tmp/repriced-opportunities.json.
 *
 * CRITICAL CONSTRAINTS:
 *   - NO Anthropic API calls (no Claude, no Haiku). Re-prices only.
 *   - NO new pair discovery. Only confirmed pairs from Tier 1 are re-priced.
 *   - Uses EXACT same fee/ROI math as matcher-v2 (imported from lib/arb-math.js).
 *   - Atomic writes via temp-file + rename; never races with the discovery writer.
 */

const fs    = require('fs');
const https = require('https');
const http  = require('http');
const path  = require('path');

const { PLATFORM_FEES, computeArbROI } = require('../lib/arb-math');

const DISCOVERY_FILE = '/tmp/arbitrage-opportunities.json';
const REPRICED_FILE  = '/tmp/repriced-opportunities.json';
const RAW_FILE       = '/tmp/markets-raw.json';
const HB_FILE        = '/tmp/agent-heartbeats.json';

const INTERVAL_MS    = 15 * 60 * 1000;  // 15 min
const THROTTLE_MS    = 300;              // ms between individual API calls
const SUSPICIOUS_ROI = 15;              // same ceiling as matcher-v2

// ── Helpers ───────────────────────────────────────────────────────────────────

function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb['repricer'] = Date.now();
  try { fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2)); } catch {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchJson(url) {
  return new Promise(resolve => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'prediction-arb-repricer/1.0' }, timeout: 15000 }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { try { resolve({ data: JSON.parse(body), status: res.statusCode }); } catch { resolve({ data: null, status: res.statusCode }); } });
    });
    req.on('error', () => resolve({ data: null, status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ data: null, status: 0 }); });
  });
}

function writeAtomic(filePath, obj) {
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, filePath);
}

// ── Kalshi orderbook quote extraction ────────────────────────────────────────
// Kalshi exposes YES bids and NO bids.
// YES ask = 1 − best_NO_bid   (they're complementary)
// YES bid = best_YES_bid

function bestFromKalshiBook(book) {
  if (!book) return { yesAsk: null, yesBid: null };
  const noBids = (book.no_dollars || [])
    .map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }))
    .filter(x => x.price > 0 && x.price < 1)
    .sort((a, b) => b.price - a.price);
  const yesBids = (book.yes_dollars || [])
    .map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }))
    .filter(x => x.price > 0 && x.price < 1)
    .sort((a, b) => b.price - a.price);
  return {
    yesAsk: noBids.length  > 0 ? +(1 - noBids[0].price).toFixed(4)  : null,
    yesBid: yesBids.length > 0 ? +yesBids[0].price.toFixed(4)        : null,
  };
}

// ── Polymarket CLOB quote extraction ─────────────────────────────────────────
// CLOB book for the YES token: asks = YES asks (ascending), bids = YES bids (descending).

function bestFromPmBook(book) {
  if (!book) return { yesAsk: null, yesBid: null };
  const asks = (book.asks || [])
    .map(a => ({ price: parseFloat(a.price), qty: parseFloat(a.size) }))
    .filter(x => x.price > 0 && x.price < 1)
    .sort((a, b) => a.price - b.price);
  const bids = (book.bids || [])
    .map(b => ({ price: parseFloat(b.price), qty: parseFloat(b.size) }))
    .filter(x => x.price > 0 && x.price < 1)
    .sort((a, b) => b.price - a.price);
  return {
    yesAsk: asks.length > 0 ? +asks[0].price.toFixed(4) : null,
    yesBid: bids.length > 0 ? +bids[0].price.toFixed(4) : null,
  };
}

// ── Identifier helpers ────────────────────────────────────────────────────────

function kalshiTicker(legId) { return (legId || '').replace(/^ka-/, ''); }

function pmClobTokenId(leg, rawPmById) {
  // Prefer the stored clobTokenId written by matcher-v2 (after our formatOutput patch).
  if (leg.clobTokenId) return leg.clobTokenId;
  // Fallback: look up in /tmp/markets-raw.json via numeric PM id.
  const pmId = (leg.id || '').replace(/^pm-/, '');
  if (!pmId) return null;
  const m = rawPmById[pmId];
  if (!m) return null;
  try { return (JSON.parse(m.clobTokenIds || '[]'))[0] || null; } catch { return null; }
}

// ── Live quote fetching ───────────────────────────────────────────────────────

async function fetchKalshiQuote(ticker) {
  if (!ticker) return { yesAsk: null, yesBid: null };
  const url = `https://api.elections.kalshi.com/trade-api/v2/markets/${ticker}/orderbook`;
  const { data, status } = await fetchJson(url);
  if (status === 429) {
    console.log(`[repricer] Kalshi 429 for ${ticker} — skipping`);
    return { yesAsk: null, yesBid: null };
  }
  return bestFromKalshiBook(data?.orderbook_fp ?? null);
}

async function fetchPmQuote(tokenId) {
  if (!tokenId) return { yesAsk: null, yesBid: null };
  const { data } = await fetchJson(`https://clob.polymarket.com/book?token_id=${tokenId}`);
  return bestFromPmBook((data?.bids || data?.asks) ? data : null);
}

async function liveQuote(leg, rawPmById) {
  if (leg.platform === 'kalshi')     return fetchKalshiQuote(kalshiTicker(leg.id));
  if (leg.platform === 'polymarket') return fetchPmQuote(pmClobTokenId(leg, rawPmById));
  return { yesAsk: null, yesBid: null };
}

// ── Main reprice loop ─────────────────────────────────────────────────────────

async function reprice() {
  console.log(`[repricer] cycle start ${new Date().toISOString()}`);

  // Read discovery output
  let discovery;
  try { discovery = JSON.parse(fs.readFileSync(DISCOVERY_FILE, 'utf8')); }
  catch { console.log('[repricer] no discovery file yet — skipping'); return; }

  const allOpps     = discovery.opportunities ?? [];
  const cashableOpps = allOpps.filter(o => o.cashable);
  const signalOpps   = allOpps.filter(o => !o.cashable);

  // Build PM id→market lookup for clobTokenId fallback
  let rawPmById = {};
  try {
    const raw = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8'));
    for (const m of (raw.polymarket || [])) rawPmById[String(m.id)] = m;
  } catch {}

  const liveCashable = [];
  const evaporated   = [];
  const inactive     = [];

  for (const opp of cashableOpps) {
    const low  = opp.lowMarket;
    const high = opp.highMarket;

    // Fetch live quotes for both legs with inter-call throttle
    const lowQ  = await liveQuote(low,  rawPmById);
    await sleep(THROTTLE_MS);
    const highQ = await liveQuote(high, rawPmById);
    await sleep(THROTTLE_MS);

    // Inactive: book missing or illiquid
    if (lowQ.yesAsk === null || highQ.yesAsk === null) {
      inactive.push({ id: opp.id, title: opp.title, status: 'inactive', discovery_roi: opp.roi });
      continue;
    }

    // Recompute ROI with shared function (identical to matcher-v2 Stage 2 math)
    const liveResult = computeArbROI({
      yesAsk_A: lowQ.yesAsk,  yesBid_A: lowQ.yesBid  ?? 0,
      yesAsk_B: highQ.yesAsk, yesBid_B: highQ.yesBid ?? 0,
      platformA: low.platform, platformB: high.platform,
    });

    // Evaporated: spread closed or above suspicious ceiling
    if (!liveResult || liveResult.net <= 0 || liveResult.net > SUSPICIOUS_ROI) {
      evaporated.push({ id: opp.id, title: opp.title, status: 'evaporated',
        discovery_roi: opp.roi, live_roi: liveResult?.net ?? 0 });
      continue;
    }

    // Live-cashable: update prices + ROI; keep all discovery fields intact
    liveCashable.push({
      ...opp,
      status:         'cashable',
      roi:            liveResult.net,
      live_roi:       liveResult.net,
      live_gross:     liveResult.gross,
      live_bestCost:  liveResult.bestCost,
      live_bestDir:   liveResult.bestDir,
      discovery_roi:  opp.roi,
      lowMarket: {
        ...low,
        yesBid:      lowQ.yesBid,
        yesAsk:      lowQ.yesAsk,
        probability: Math.round((lowQ.yesAsk ?? low.yesAsk ?? 0) * 100),
      },
      highMarket: {
        ...high,
        yesBid:      highQ.yesBid,
        yesAsk:      highQ.yesAsk,
        probability: Math.round((highQ.yesAsk ?? high.yesAsk ?? 0) * 100),
      },
    });
  }

  // Signal opps pass through unchanged (no re-pricing needed for mid-price platforms)
  const passedSignal = signalOpps.map(o => ({ ...o, status: 'signal' }));

  // Sort live-cashable by live ROI desc, then append signals
  liveCashable.sort((a, b) => b.roi - a.roi);

  const output = {
    repriced_at:    Date.now(),
    discovery_at:   discovery.updatedAt ?? null,
    opportunities:  [...liveCashable, ...passedSignal],
    evaporated,
    inactive,
    stats: {
      live_cashable:      liveCashable.length,
      evaporated:         evaporated.length,
      inactive:           inactive.length,
      signal:             passedSignal.length,
      total_repriced:     cashableOpps.length,
      discovery_cashable: cashableOpps.length,
    },
  };

  writeAtomic(REPRICED_FILE, output);
  beat();
  console.log(`[repricer] done: ${liveCashable.length} live-cashable, ${evaporated.length} evaporated, ${inactive.length} inactive, ${passedSignal.length} signal`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

reprice().catch(e => console.error('[repricer] startup error:', e.message));
setInterval(() => reprice().catch(e => console.error('[repricer] error:', e.message)), INTERVAL_MS);
