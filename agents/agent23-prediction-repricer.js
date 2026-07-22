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
const { atomicWriteJson } = require('../lib/atomicJsonWrite');
const path  = require('path');
const { httpGet: _sharedGet } = require('../lib/httpGet');

const { PLATFORM_FEES, computeArbROI } = require('../lib/arb-math');
// Live per-market Polymarket taker fee (SSOT). The re-pricer already fetches each leg's live book, so
// it is the honest place to attach the real fee: it resolves the Polymarket leg's token and reads
// base_fee. When base_fee is unknown the row is fee-unknown → "—", never a flattered net.
const { getBaseFeeBps, BASE_FEE_TO_RATE_DIVISOR } = require('../lib/polymarket-fees');
// Shared order-book ladder extraction + capacity walk — same source matcher-v2 (Tier 1
// discovery) uses, so live-refreshed capacity here can never diverge from discovery math.
const { laddersFromKalshiBook, laddersFromPmBook, computeCapacity, ladderToWireFormat } = require('../lib/depth');

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
  try { atomicWriteJson(HB_FILE, hb, { pretty: true }); } catch {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchJson(url) {
  return _sharedGet(url, { timeoutMs: 15_000, headers: { 'User-Agent': 'prediction-arb-repricer/1.0' } })
    .then(r => ({ data: r.data, status: r.status }))
    .catch(() => ({ data: null, status: 0 }));
}

function writeAtomic(filePath, obj) {
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, filePath);
}

// ── Kalshi / Polymarket quote + depth extraction ─────────────────────────────
// Both the scalar best bid/ask AND the full executable ladder come from the
// SAME parsed book (lib/depth.js) — previously this function threw the ladder
// away right after reading [0]; the book was already being fetched in full on
// every cycle, it just wasn't kept. yesBid is derived from the same no-ask
// ladder used for capacity (complementary: no_ask = 1 - yes_bid) so the
// scalar and the ladder can never disagree.
// depth = the leg's own YES-ask ladder (cost to buy YES), best price first —
// same side/convention as the existing yesAsk scalar, just multiple levels.

function quoteFromKalshiBook(book) {
  if (!book) return { yesAsk: null, yesBid: null, depth: [] };
  const { yesAsks, noAsks } = laddersFromKalshiBook(book);
  return {
    yesAsk: yesAsks.length > 0 ? +yesAsks[0].price.toFixed(4)      : null,
    yesBid: noAsks.length  > 0 ? +(1 - noAsks[0].price).toFixed(4) : null,
    depth:  ladderToWireFormat(yesAsks),
  };
}

function quoteFromPmBook(book) {
  if (!book) return { yesAsk: null, yesBid: null, depth: [] };
  const { yesAsks, noAsks } = laddersFromPmBook(book);
  return {
    yesAsk: yesAsks.length > 0 ? +yesAsks[0].price.toFixed(4)      : null,
    yesBid: noAsks.length  > 0 ? +(1 - noAsks[0].price).toFixed(4) : null,
    depth:  ladderToWireFormat(yesAsks),
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

// rawBook is kept (not discarded) so the same already-fetched book can be
// walked for capacity below — no second request.

async function fetchKalshiQuote(ticker) {
  if (!ticker) return { yesAsk: null, yesBid: null, depth: [], rawBook: null };
  const url = `https://api.elections.kalshi.com/trade-api/v2/markets/${ticker}/orderbook`;
  const { data, status } = await fetchJson(url);
  if (status === 429) {
    console.log(`[repricer] Kalshi 429 for ${ticker} — skipping`);
    return { yesAsk: null, yesBid: null, depth: [], rawBook: null };
  }
  const rawBook = data?.orderbook_fp ?? null;
  return { ...quoteFromKalshiBook(rawBook), rawBook };
}

async function fetchPmQuote(tokenId) {
  if (!tokenId) return { yesAsk: null, yesBid: null, depth: [], rawBook: null };
  const { data } = await fetchJson(`https://clob.polymarket.com/book?token_id=${tokenId}`);
  const rawBook = (data?.bids || data?.asks) ? data : null;
  return { ...quoteFromPmBook(rawBook), rawBook };
}

async function liveQuote(leg, rawPmById) {
  if (leg.platform === 'kalshi')     return fetchKalshiQuote(kalshiTicker(leg.id));
  if (leg.platform === 'polymarket') return fetchPmQuote(pmClobTokenId(leg, rawPmById));
  return { yesAsk: null, yesBid: null, depth: [], rawBook: null };
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
  const feeUnknown   = [];   // arb exists but a required live taker fee could not be read → render "—"

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

    // Real per-market Polymarket taker fee: resolve the Polymarket leg's token and read live base_fee.
    // polyFeeRate = base_fee/20000 (SSOT divisor), or null when unknown → computeArbROI returns
    // feeUnknown and the row renders "—" (never a net computed from an assumed fee).
    const pmLeg = low.platform === 'polymarket' ? low : high.platform === 'polymarket' ? high : null;
    let polyFeeRate = null;
    if (pmLeg) {
      const pmTok = pmClobTokenId(pmLeg, rawPmById);
      const bps = pmTok ? await getBaseFeeBps(pmTok) : null;
      polyFeeRate = bps == null ? null : bps / BASE_FEE_TO_RATE_DIVISOR;
    }

    // Recompute ROI with shared function (identical to matcher-v2 Stage 2 math) — now NET of the real,
    // price-scaled taker fee on both legs (Kalshi 0.07·p·(1−p); Polymarket base_fee/20000·p·(1−p)).
    const liveResult = computeArbROI({
      yesAsk_A: lowQ.yesAsk,  yesBid_A: lowQ.yesBid  ?? 0,
      yesAsk_B: highQ.yesAsk, yesBid_B: highQ.yesBid ?? 0,
      platformA: low.platform, platformB: high.platform,
      polyFeeRate,
    });

    // Fee-unknown: a real crossing exists but the live taker fee could not be read → "—", not cashable.
    if (liveResult && liveResult.feeUnknown) {
      feeUnknown.push({ id: opp.id, title: opp.title, status: 'fee-unknown',
        reason: 'Polymarket base_fee unavailable (GET /fee-rate) — net edge cannot be confirmed',
        discovery_roi: opp.roi, live_gross: liveResult.gross });
      continue;
    }

    // Evaporated: spread closed or above suspicious ceiling
    if (!liveResult || liveResult.net <= 0 || liveResult.net > SUSPICIOUS_ROI) {
      evaporated.push({ id: opp.id, title: opp.title, status: 'evaporated',
        discovery_roi: opp.roi, live_roi: liveResult?.net ?? 0 });
      continue;
    }

    // Capacity — refreshed every cycle from the ladders just fetched above
    // (was a stale one-time discovery-time scalar before this change).
    // Walk direction follows the winning arb direction from computeArbROI:
    // dir 1 = buy YES on A(low) + NO on B(high); dir 2 = the reverse.
    const yesLeg     = liveResult.bestDir === 1 ? low  : high;
    const noLeg      = liveResult.bestDir === 1 ? high : low;
    const kalshiBook = low.platform === 'kalshi'     ? lowQ.rawBook : high.platform === 'kalshi'     ? highQ.rawBook : null;
    const pmBook     = low.platform === 'polymarket' ? lowQ.rawBook : high.platform === 'polymarket' ? highQ.rawBook : null;
    // capacityUsd is a joint constraint of the paired position (both legs must
    // fill together to realize the arb) — not independently splittable, so the
    // same binding number is attached to each leg rather than inventing a
    // per-leg-only figure that wouldn't correspond to anything tradeable alone.
    const capacityUsd = computeCapacity(yesLeg, noLeg, kalshiBook, pmBook);

    // Live-cashable: update prices + ROI + depth + capacity; keep discovery fields intact
    liveCashable.push({
      ...opp,
      status:         'cashable',
      roi:            liveResult.net,
      live_roi:       liveResult.net,
      live_gross:     liveResult.gross,
      live_bestCost:  liveResult.bestCost,
      live_bestDir:   liveResult.bestDir,
      discovery_roi:  opp.roi,
      capacityUsd,
      lowMarket: {
        ...low,
        yesBid:      lowQ.yesBid,
        yesAsk:      lowQ.yesAsk,
        probability: Math.round((lowQ.yesAsk ?? low.yesAsk ?? 0) * 100),
        depth:       (low.platform === 'kalshi' || low.platform === 'polymarket') ? lowQ.depth : null,
        capacityUsd,
      },
      highMarket: {
        ...high,
        yesBid:      highQ.yesBid,
        yesAsk:      highQ.yesAsk,
        probability: Math.round((highQ.yesAsk ?? high.yesAsk ?? 0) * 100),
        depth:       (high.platform === 'kalshi' || high.platform === 'polymarket') ? highQ.depth : null,
        capacityUsd,
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
    // Event-comparator buckets pass through unchanged from discovery — this
    // repricer only re-verifies confirmed cashable PAIRS against live order
    // books; it does not re-fetch every bucket's platform quotes.
    events:         discovery.events ?? [],
    evaporated,
    inactive,
    feeUnknown,
    stats: {
      live_cashable:      liveCashable.length,
      evaporated:         evaporated.length,
      inactive:           inactive.length,
      fee_unknown:        feeUnknown.length,
      signal:             passedSignal.length,
      total_repriced:     cashableOpps.length,
      discovery_cashable: cashableOpps.length,
    },
  };

  writeAtomic(REPRICED_FILE, output);

  // Parallel history sink (non-fatal): snapshot cashable + signal prediction-market arbs
  // exactly as repriced (verbatim rows). An empty array is a valid recorded 0-state.
  try {
    require('../lib/history-logger').appendSnapshot('predarb', Date.now(), output.opportunities || []);
  } catch (e) { console.log('[history] predarb snapshot skipped:', e.message); }

  beat();
  console.log(`[repricer] done: ${liveCashable.length} live-cashable, ${evaporated.length} evaporated, ${inactive.length} inactive, ${passedSignal.length} signal`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

reprice().catch(e => console.error('[repricer] startup error:', e.message));
setInterval(() => reprice().catch(e => console.error('[repricer] error:', e.message)), INTERVAL_MS);
