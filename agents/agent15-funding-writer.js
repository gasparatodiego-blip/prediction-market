#!/usr/bin/env node
'use strict';

/**
 * agent15-funding-writer
 *
 * Every 60 s:
 *   1. Read /tmp/exchange-prices.json (written by agent10)
 *   2. Refresh settled funding-rate history (every 15 min) from venue APIs
 *   3. Compute cross-exchange FUNDING SPREAD arb — headline from TRAILING SETTLED
 *      rates, never from a single predicted spike
 *      — spike flag: |predicted − median| > 3× median (per leg)
 *      — confirmed flag: ≥2 of last 3 settlements in same direction as trailing avg
 *      — predictedGrossApy stored separately for transparency
 *   4. Merge into /tmp/unified-opportunities.json atomically
 *      — PRESERVES type=CASHABLE/SIGNAL/SPORTS, REPLACES type=FUNDING
 *
 * Venues WITHOUT settled history (Hyperliquid 1h, dYdX 1h):
 *   trailingRate = predictedRate (best available estimate, clearly unverified)
 *   oneLegUnverified = true → verdict = 'PARTIAL — 1 leg unverified' → fullyConfirmed = false
 *   These are NOT shown as green/confirmed on any surface (headline, list, alerts).
 *
 * Zero Claude calls. No trades. Read-only + math only.
 */

const fs = require('fs');
const { httpGet } = require('../lib/httpGet');
const {
  annualize,
  venueFeePct,
  roundTripFeeByVenue,
  netApy30d,
  breakevenDays,
  spreadStatus,
} = require('../lib/funding-math');

const EXCHANGE_FILE      = '/tmp/exchange-prices.json';
const UNIFIED_FILE       = '/tmp/unified-opportunities.json';
const HISTORY_CACHE_FILE = '/tmp/funding-history-cache.json';
const HB_FILE            = '/tmp/agent-heartbeats.json';
const INTERVAL_MS        = 60_000;

// Spread filter
const THRESHOLD_APY      = 3.0;           // min trailing gross %/yr to emit
const MAX_GROSS_APY      = 200;           // sanity cap on trailing
const MIN_LIQ_USD        = 500_000;
const MAX_DATA_AGE       = 5 * 60_000;

// Anti-spike / persistence
const HISTORY_N          = 8;            // settled periods to average
const HISTORY_REFRESH_MS = 15 * 60_000;  // refresh history cache every 15 min
const SPIKE_MULT         = 3;            // |pred − median| > SPIKE_MULT × |median| → spike
const SPIKE_ABS_FLOOR    = 0.01;         // %/interval — min deviation to flag (avoids near-zero noise)
const SPIKE_ABS_MIN_RATE = 0.02;         // %/interval — min predicted rate magnitude to flag
const CONFIRM_LOOK       = 3;            // last N settlements to check direction
const CONFIRM_MIN        = 2;            // need ≥ this many same-direction as trailing
const HOURLY_SPIKE_ANN   = 115;          // %/yr — extreme threshold for hourly venues (no history)

let historyCache     = null;
let historyFetchedAt = 0;
let isRunning        = false;

// ── HTTP helper ───────────────────────────────────────────────────────────────

function get(url) {
  return httpGet(url, {
    timeoutMs: 12_000,
    headers: { 'User-Agent': 'Mozilla/5.0 prediction-arb-scanner/1.0', 'Accept': 'application/json' },
  }).then(r => r.data).catch(() => null);
}

// ── Venue history fetchers ────────────────────────────────────────────────────
// Return array of settled funding rates in % (newest first), length ≤ n.
// All raw API values are fractions → ×100 for consistency with exchange-prices.json.

async function fetchBinanceHistory(coin, n) {
  // Binance returns oldest-first → sort by time descending
  const d = await get(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${coin}USDT&limit=${n}`);
  if (!Array.isArray(d)) return [];
  return d
    .sort((a, b) => (b.fundingTime ?? 0) - (a.fundingTime ?? 0))
    .map(e => parseFloat(e.fundingRate) * 100)
    .filter(v => isFinite(v));
}

async function fetchBybitHistory(coin, n) {
  // Bybit returns newest-first
  const d = await get(`https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${coin}USDT&limit=${n}`);
  const list = d?.result?.list;
  if (!Array.isArray(list)) return [];
  return list
    .sort((a, b) => Number(b.fundingRateTimestamp ?? 0) - Number(a.fundingRateTimestamp ?? 0))
    .map(e => parseFloat(e.fundingRate) * 100)
    .filter(v => isFinite(v));
}

async function fetchOkxHistory(coin, n) {
  // OKX returns newest-first; use realizedRate (settled), not fundingRate (predicted at that time)
  const d = await get(`https://www.okx.com/api/v5/public/funding-rate-history?instId=${coin}-USDT-SWAP&limit=${n}`);
  if (!Array.isArray(d?.data)) return [];
  return d.data
    .sort((a, b) => Number(b.fundingTime ?? 0) - Number(a.fundingTime ?? 0))
    .map(e => parseFloat(e.realizedRate ?? e.fundingRate) * 100)
    .filter(v => isFinite(v));
}

async function fetchBitgetHistory(coin, n) {
  // Bitget returns newest-first
  const d = await get(`https://api.bitget.com/api/v2/mix/market/history-fund-rate?symbol=${coin}USDT&productType=USDT-FUTURES&pageSize=${n}`);
  if (!Array.isArray(d?.data)) return [];
  return d.data
    .sort((a, b) => Number(b.fundingTime ?? 0) - Number(a.fundingTime ?? 0))
    .map(e => parseFloat(e.fundingRate) * 100)
    .filter(v => isFinite(v));
}

async function fetchGateHistory(coin, n) {
  // Gate.io returns newest-first; sort by timestamp to be safe
  const d = await get(`https://api.gateio.ws/api/v4/futures/usdt/funding_rate?contract=${coin}_USDT&limit=${n}`);
  if (!Array.isArray(d)) return [];
  return d
    .sort((a, b) => (b.t ?? 0) - (a.t ?? 0))
    .map(e => parseFloat(e.r) * 100)
    .filter(v => isFinite(v));
}

const HISTORY_FETCHERS = {
  binance: fetchBinanceHistory,
  bybit:   fetchBybitHistory,
  okx:     fetchOkxHistory,
  bitget:  fetchBitgetHistory,
  gateio:  fetchGateHistory,
  // hyperliquid, dydx: no settled per-market history endpoint — handled in legAnalytics
};

// ── History cache management ──────────────────────────────────────────────────

async function refreshHistoryCache(futures) {
  console.log('[funding-hist] refreshing settled funding-rate history…');

  const tasks = [];
  for (const [exchange, coins] of Object.entries(futures)) {
    const fetcher = HISTORY_FETCHERS[exchange];
    if (!fetcher) continue;
    for (const coin of Object.keys(coins || {})) {
      tasks.push({ exchange, coin, fetcher });
    }
  }

  const fresh = {};
  await Promise.all(tasks.map(async ({ exchange, coin, fetcher }) => {
    try {
      const rates = await fetcher(coin, HISTORY_N);
      if (!rates.length) return;
      if (!fresh[exchange]) fresh[exchange] = {};
      fresh[exchange][coin] = rates;
    } catch { /* silent: old cache entry kept */ }
  }));

  // Merge: new fetch overwrites; failed fetches keep old entry
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(HISTORY_CACHE_FILE, 'utf8')).data || {}; } catch {}

  for (const [exchange, coins] of Object.entries(fresh)) {
    if (!existing[exchange]) existing[exchange] = {};
    Object.assign(existing[exchange], coins);
  }

  historyCache     = existing;
  historyFetchedAt = Date.now();

  const total = Object.values(historyCache).reduce((s, v) => s + Object.keys(v).length, 0);
  console.log(`[funding-hist] cache ready: ${total} coin-venue pairs (${tasks.length} fetched)`);

  try { fs.writeFileSync(HISTORY_CACHE_FILE, JSON.stringify({ fetchedAt: historyFetchedAt, data: historyCache })); } catch {}
  return historyCache;
}

function loadHistoryCacheFromDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_CACHE_FILE, 'utf8'));
    historyCache     = raw.data || {};
    historyFetchedAt = raw.fetchedAt || 0;
    const total = Object.values(historyCache).reduce((s, v) => s + Object.keys(v).length, 0);
    console.log(`[funding-hist] loaded cache from disk: ${total} coin-venue pairs (age ${Math.round((Date.now() - historyFetchedAt) / 60_000)}m)`);
  } catch {
    historyCache     = {};
    historyFetchedAt = 0;
  }
}

// ── Per-leg analytics ─────────────────────────────────────────────────────────

function computeMedian(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

/**
 * Given a venue leg's predicted rate and settled history, compute:
 *   trailingRate  — avg of last HISTORY_N settled rates (used for headline)
 *   medianRate    — median of last HISTORY_N settled rates
 *   spike         — predicted deviates far from median (transient spike)
 *   confirmed     — recent settlements mostly agree with trailing direction
 *
 * @param {number}   predictedRate  — current ticker rate, %/interval
 * @param {number}   intervalHours
 * @param {number[]} historyRates   — settled rates newest-first, %
 */
function legAnalytics(predictedRate, intervalHours, historyRates) {
  if (!historyRates.length) {
    // No settled history (HL, dYdX, or fetch failed).
    // Treat hourly venues as confirmed unless the rate is extreme.
    const annPred  = annualize(predictedRate, intervalHours);
    const extreme  = Math.abs(annPred) > (intervalHours === 1 ? HOURLY_SPIKE_ANN : 50);
    return {
      trailingRate:     predictedRate,
      medianRate:       predictedRate,
      historyAvailable: false,
      spike:            false,
      confirmed:        !extreme,
    };
  }

  const recent      = historyRates.slice(0, HISTORY_N);
  const trailingRate = recent.reduce((s, r) => s + r, 0) / recent.length;
  const medianRate   = computeMedian(recent);

  // Spike: predicted deviates > SPIKE_MULT × |median| from median, and rate is non-trivial
  const deviation  = Math.abs(predictedRate - medianRate);
  const threshold  = Math.max(SPIKE_MULT * Math.abs(medianRate), SPIKE_ABS_FLOOR);
  const spike      = deviation > threshold && Math.abs(predictedRate) > SPIKE_ABS_MIN_RATE;

  // Confirmed: ≥ CONFIRM_MIN of last CONFIRM_LOOK settlements in same direction as trailing
  const direction  = trailingRate >= 0 ? 1 : -1;
  const lookback   = recent.slice(0, Math.min(CONFIRM_LOOK, recent.length));
  const sameDir    = lookback.filter(r => (r > 0 ? 1 : r < 0 ? -1 : 0) === direction).length;
  const confirmed  = sameDir >= Math.min(CONFIRM_MIN, lookback.length);

  return { trailingRate, medianRate, historyAvailable: true, spike, confirmed };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb['agent15-funding'] = Date.now();
  try { fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2)); } catch {}
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function venueLabel(exchange, isDex) {
  if (exchange === 'dydx')        return 'dYdX (DEX)';
  if (exchange === 'hyperliquid') return 'Hyperliquid (DEX)';
  if (exchange === 'gateio')      return 'Gate.io';
  if (exchange === 'bitget')      return 'Bitget';
  return isDex ? `${cap(exchange)} (DEX)` : cap(exchange);
}

function liquidityUsd(data) {
  return Math.max(data?.openInterestUsd ?? 0, data?.vol24hUsd ?? 0);
}

function liqTier(usd) {
  if (usd >= 50_000_000) return 'DEEP';
  if (usd >= 10_000_000) return 'OK';
  if (usd >= 1_000_000)  return 'THIN';
  return 'VERY THIN';
}

function dexBridgeNote(shortVenue, longVenue) {
  const venues = new Set([shortVenue, longVenue]);
  const notes  = [];
  if (venues.has('hyperliquid')) notes.push('HL: USDC bridge ~10 min + ~$1-5 ETH gas one-time');
  if (venues.has('dydx'))        notes.push('dYdX: USDC bridge via Noble ~5 min + ~$3-10 gas');
  return notes.join('; ');
}

// ── Cross-exchange funding spread ─────────────────────────────────────────────
//
// For each coin on ≥2 venues:
//   trailingA = avg of last HISTORY_N SETTLED rates on venue A
//   trailingB = avg of last HISTORY_N SETTLED rates on venue B
//   grossApy  = |annualize(trailingA) − annualize(trailingB)|   ← HEADLINE
//   predictedGrossApy = |annualize(predictedA) − annualize(predictedB)|   ← transparency only
//
// Spike/confirmation flags are computed per-leg from history. If any leg is
// spiked or unconfirmed, verdict = 'SPIKE — predicted, unconfirmed'.

function crossExchangeSpread(futures, hCache) {
  // Build byExchange: coin → [{ exchange, fr (predicted), intervalHours, isDex }]
  const byExchange = {};
  for (const [ex, coins] of Object.entries(futures)) {
    const isDex = ex === 'hyperliquid' || ex === 'dydx';
    for (const [coin, data] of Object.entries(coins || {})) {
      const fr            = data?.fundingRate;
      const intervalHours = data?.fundingIntervalHours ?? 8;
      if (fr == null || typeof fr !== 'number' || !isFinite(fr)) continue;
      if (!byExchange[coin]) byExchange[coin] = [];
      byExchange[coin].push({ exchange: ex, fr, intervalHours, isDex });
    }
  }

  const opps = [];

  for (const [coin, list] of Object.entries(byExchange)) {
    if (list.length < 2) continue;

    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const A = list[i], B = list[j];

        // Per-leg analytics from settled history
        const histA  = (hCache[A.exchange] || {})[coin] || [];
        const histB  = (hCache[B.exchange] || {})[coin] || [];
        const analA  = legAnalytics(A.fr, A.intervalHours, histA);
        const analB  = legAnalytics(B.fr, B.intervalHours, histB);

        // Trailing-based annualized rates → headline
        const annTrailA      = annualize(analA.trailingRate, A.intervalHours);
        const annTrailB      = annualize(analB.trailingRate, B.intervalHours);
        const trailingGrossApy = Math.abs(annTrailA - annTrailB);

        // Predicted-based (for transparency / notes)
        const annPredA       = annualize(A.fr, A.intervalHours);
        const annPredB       = annualize(B.fr, B.intervalHours);
        const predictedGrossApy = Math.abs(annPredA - annPredB);

        // Emit only if trailing spread is meaningful; if predicted is inflated
        // but trailing is trivial, this is pure noise — skip silently.
        if (trailingGrossApy < THRESHOLD_APY) continue;
        if (trailingGrossApy > MAX_GROSS_APY)  continue;

        // SHORT = higher trailing annualized (collect), LONG = lower (pay less / collect)
        const [shortSide, longSide, analShort, analLong] =
          annTrailA >= annTrailB
            ? [A, B, analA, analB]
            : [B, A, analB, analA];

        // Spike / confirmation flags
        const spikeFlag        = analShort.spike || analLong.spike;
        const allConfirmed     = analShort.confirmed && analLong.confirmed;
        const oneLegUnverified = !analShort.historyAvailable || !analLong.historyAvailable;
        const fullyConfirmed   = allConfirmed && !oneLegUnverified && !spikeFlag;

        const totalFees  = roundTripFeeByVenue(shortSide.exchange, longSide.exchange);
        const net30d     = netApy30d(trailingGrossApy, totalFees);
        const beDays     = breakevenDays(trailingGrossApy, totalFees);
        const status     = spreadStatus(beDays);
        const hasDexLeg  = shortSide.isDex || longSide.isDex;

        // Liquidity
        const shortData  = (futures[shortSide.exchange] || {})[coin] || {};
        const longData   = (futures[longSide.exchange]  || {})[coin] || {};
        const shortLiq   = liquidityUsd(shortData);
        const longLiq    = liquidityUsd(longData);
        const minLiq     = shortLiq > 0 && longLiq > 0
          ? Math.min(shortLiq, longLiq)
          : Math.max(shortLiq, longLiq);
        if (minLiq > 0 && minLiq < MIN_LIQ_USD) continue;
        const capUsd     = minLiq > 0 ? Math.round(Math.min(minLiq * 0.01, 500_000)) : null;
        const tier       = minLiq > 0 ? liqTier(minLiq) : null;
        const thinFlag   = tier === 'THIN' || tier === 'VERY THIN';

        // Reset cadence note
        const resetParts = [];
        if (shortSide.intervalHours === 1) resetParts.push(`${shortSide.exchange} resets HOURLY`);
        if (longSide.intervalHours  === 1) resetParts.push(`${longSide.exchange} resets HOURLY`);
        const resetNote = resetParts.length > 0
          ? resetParts.join('; ') + ' — these legs can flip every hour. CEX legs every 8h.'
          : 'Both legs reset every 8h.';

        const shortFeePct = venueFeePct(shortSide.exchange);
        const longFeePct  = venueFeePct(longSide.exchange);
        const feeNote = `Round-trip fees: ${shortSide.exchange} ${shortFeePct}%/leg + ${longSide.exchange} ${longFeePct}%/leg × 2 = ${totalFees.toFixed(3)}%`;

        const bridgeNoteStr = hasDexLeg ? dexBridgeNote(shortSide.exchange, longSide.exchange) : '';

        // Spike transparency note
        let spikeNote = '';
        if (spikeFlag) {
          const spikeLeg = analShort.spike ? shortSide.exchange : longSide.exchange;
          const spikePredAnn = analShort.spike
            ? +annPredA.toFixed(1) : +annPredB.toFixed(1);
          const spikeTrailAnn = analShort.spike
            ? +annTrailA.toFixed(1) : +annTrailB.toFixed(1);
          spikeNote = `SPIKE FLAG: ${spikeLeg} predicted rate annualizes to ${spikePredAnn >= 0 ? '+' : ''}${spikePredAnn}%/yr vs trailing avg ${spikeTrailAnn >= 0 ? '+' : ''}${spikeTrailAnn}%/yr — headline uses trailing.`;
        }

        // Verdict — severity order: SPIKE > PARTIAL > THIN > HARVEST
        let verdict;
        if (spikeFlag || !allConfirmed) {
          verdict = 'SPIKE — predicted, unconfirmed';
        } else if (oneLegUnverified) {
          verdict = 'PARTIAL — 1 leg unverified';
        } else if (thinFlag) {
          verdict = 'HARVEST · thin — not executable at size';
        } else {
          verdict = 'HARVEST · variable';
        }

        opps.push({
          type:             'FUNDING',
          id:               `funding-${coin}-${shortSide.exchange}-${longSide.exchange}`,
          question:         `${coin}/USDT Funding Spread`,
          legs: [
            {
              platform:       venueLabel(shortSide.exchange, shortSide.isDex),
              side:           'SHORT',
              price:          +shortSide.fr.toFixed(6),
              intervalHours:  shortSide.intervalHours,
              isDex:          shortSide.isDex,
              url:            null,
              // ── Anti-spike fields ──
              predictedRate:  +shortSide.fr.toFixed(6),
              trailingRate:   +analShort.trailingRate.toFixed(6),
              medianRate:     +analShort.medianRate.toFixed(6),
              historyAvailable: analShort.historyAvailable,
              spike:          analShort.spike,
              confirmed:      analShort.confirmed,
            },
            {
              platform:       venueLabel(longSide.exchange, longSide.isDex),
              side:           'LONG',
              price:          +longSide.fr.toFixed(6),
              intervalHours:  longSide.intervalHours,
              isDex:          longSide.isDex,
              url:            null,
              // ── Anti-spike fields ──
              predictedRate:  +longSide.fr.toFixed(6),
              trailingRate:   +analLong.trailingRate.toFixed(6),
              medianRate:     +analLong.medianRate.toFixed(6),
              historyAvailable: analLong.historyAvailable,
              spike:          analLong.spike,
              confirmed:      analLong.confirmed,
            },
          ],
          // ── Headline numbers (trailing-based — honest engine) ──
          annualizedROI:      +trailingGrossApy.toFixed(2),
          netROI:             net30d,
          grossROI:           +trailingGrossApy.toFixed(2),
          // ── Raw predicted (for transparency) ──
          predictedGrossApy:  +predictedGrossApy.toFixed(2),
          // ── Spike/confirmation flags ──
          spikeFlag,
          allConfirmed,
          oneLegUnverified,
          fullyConfirmed,
          // ── Existing fields ──
          spread:             null,
          daysToResolution:   null,
          resolutionDate:     null,
          capacityUsd:        capUsd,
          lockupFlag:         null,
          verdict,
          confidence:         (spikeFlag || !allConfirmed) ? 0.3
                            : oneLegUnverified             ? 0.5
                            : trailingGrossApy > 10        ? 0.7
                            :                               0.85,
          note:               [feeNote, resetNote, spikeNote, bridgeNoteStr].filter(Boolean).join(' '),
          hasDexLeg,
          totalFeesPct:       +totalFees.toFixed(3),
          breakevenDays:      beDays,
          status,
          liquidityTier:      tier,
          oiUsd:              minLiq > 0 ? Math.round(minLiq) : null,
          thinFlag,
          fundingIntervalHoursShort: shortSide.intervalHours,
          fundingIntervalHoursLong:  longSide.intervalHours,
        });
      }
    }
  }

  return opps.sort((a, b) => b.annualizedROI - a.annualizedROI);
}

// ── Atomic type-preserving merge ──────────────────────────────────────────────

const TYPE_RANK = { CASHABLE: 0, SPORTS: 1, FUNDING: 2, SIGNAL: 3 };

function mergeUnifiedFunding(allFundingOpps) {
  let existing = { generatedAt: null, sources: {}, summary: {}, opportunities: [] };
  try {
    existing = JSON.parse(fs.readFileSync(UNIFIED_FILE, 'utf8'));
  } catch { /* file absent or corrupt — start fresh */ }

  const kept   = (existing.opportunities || []).filter(o => o.type !== 'FUNDING');
  const merged = [...kept, ...allFundingOpps];

  merged.sort((a, b) => {
    const ra = TYPE_RANK[a.type] ?? 9, rb = TYPE_RANK[b.type] ?? 9;
    if (ra !== rb) return ra - rb;
    if (a.annualizedROI !== null && b.annualizedROI !== null) return b.annualizedROI - a.annualizedROI;
    if (a.annualizedROI !== null) return -1;
    if (b.annualizedROI !== null) return 1;
    return 0;
  });

  const allROIs        = merged.map(o => o.annualizedROI).filter(v => v != null);
  const bestAnnualized = allROIs.length ? Math.max(...allROIs) : null;

  const result = {
    generatedAt: existing.generatedAt ?? null,
    sources: {
      ...(existing.sources ?? {}),
      funding: {
        updatedAt:  Date.now(),
        emitCount:  allFundingOpps.length,
        totalFound: allFundingOpps.length,
        threshold:  THRESHOLD_APY,
      },
    },
    summary: {
      total:          merged.length,
      cashable:       merged.filter(o => o.type === 'CASHABLE').length,
      signal:         merged.filter(o => o.type === 'SIGNAL').length,
      sports:         merged.filter(o => o.type === 'SPORTS').length,
      funding:        allFundingOpps.length,
      bestAnnualized,
    },
    opportunities: merged,
  };

  const tmpPath = UNIFIED_FILE + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(result, null, 2));
  fs.renameSync(tmpPath, UNIFIED_FILE);
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function run() {
  if (isRunning) return;
  isRunning = true;
  try {
    if (!fs.existsSync(EXCHANGE_FILE)) {
      console.log('[funding] exchange-prices.json not found — waiting for agent10');
      return;
    }

    const data  = JSON.parse(fs.readFileSync(EXCHANGE_FILE, 'utf8'));
    const ageMs = Date.now() - (data.fetchedAt || 0);

    if (ageMs > MAX_DATA_AGE) {
      console.log(`[funding] exchange data ${Math.round(ageMs / 60_000)}m old — skip`);
      return;
    }

    // Refresh settled history cache if stale (or on first run)
    if (!historyCache) loadHistoryCacheFromDisk();
    if (Date.now() - historyFetchedAt > HISTORY_REFRESH_MS) {
      await refreshHistoryCache(data.futures || {});
    }

    const allOpps = crossExchangeSpread(data.futures || {}, historyCache || {});

    const spikedCount = allOpps.filter(o => o.spikeFlag || !o.allConfirmed).length;
    console.log(`[funding] ${allOpps.length} pairs ≥${THRESHOLD_APY}%/yr (trailing) — ${spikedCount} spike/unconfirmed:`);
    for (const o of allOpps.slice(0, 10)) {
      const spikeMark = (o.spikeFlag || !o.allConfirmed) ? ' ⚠SPIKE' : '';
      const predNote  = o.spikeFlag ? ` [pred:${o.predictedGrossApy}%]` : '';
      console.log(`  ${o.id}: trailing:+${o.annualizedROI}%/yr${predNote}  net:+${o.netROI}%/yr  ${o.status}${spikeMark}`);
    }

    mergeUnifiedFunding(allOpps);
    beat();

  } catch (e) {
    console.error('[funding] error:', e.message, e.stack?.split('\n')[1] ?? '');
  } finally {
    isRunning = false;
  }
}

run();
setInterval(run, INTERVAL_MS);
