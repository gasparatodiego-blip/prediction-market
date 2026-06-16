#!/usr/bin/env node
'use strict';

/**
 * agent15-funding-writer
 *
 * Every 60 s:
 *   1. Read /tmp/exchange-prices.json (written by agent10)
 *   2. Compute cross-exchange FUNDING SPREAD arb for every coin on ≥2 venues
 *      — uses interval-aware annualization from shared lib/funding-math.js
 *      — handles CEX (8h) and Hyperliquid DEX (1h) venues correctly
 *   3. Merge into /tmp/unified-opportunities.json atomically
 *      — PRESERVES type=CASHABLE/SIGNAL/SPORTS, REPLACES type=FUNDING
 *
 * Zero Claude calls. No trades. Read-only + math only.
 */

const fs = require('fs');
const {
  annualize,
  venueFeePct,
  roundTripFeeByVenue,
  netApy30d,
  breakevenDays,
  spreadStatus,
  VENUE_FEE_PCT,
} = require('../lib/funding-math');

const EXCHANGE_FILE  = '/tmp/exchange-prices.json';
const UNIFIED_FILE   = '/tmp/unified-opportunities.json';
const HB_FILE        = '/tmp/agent-heartbeats.json';
const INTERVAL_MS    = 60_000;

const THRESHOLD_APY  = 3.0;          // min gross %/yr to emit
const MAX_GROSS_APY  = 200;          // sanity cap — >200%/yr almost certainly stale data
const MIN_LIQ_USD    = 500_000;      // $500k OI or vol on the thinner leg minimum
const MAX_DATA_AGE   = 5 * 60_000;  // skip if exchange data > 5 min old

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
//   annualizedA = annualize(frA, hA),  annualizedB = annualize(frB, hB)
//   grossApy    = |annualizedA − annualizedB|
//   SHORT the higher-annualized venue (collect), LONG the other (pay less)
//
// DEX (Hyperliquid) legs:
//   - labelled "Hyperliquid (DEX)"
//   - taker fee 0.025%/leg vs CEX 0.04%/leg
//   - note: bridge friction (one-time ~10 min + ~$1-5 ETH gas)
//   - HL funds HOURLY — its leg can flip every hour

function crossExchangeSpread(futures) {
  // Build byExchange: coin → [{ exchange, fr, intervalHours, isDex }]
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

        // Interval-aware annualization
        const annA     = annualize(A.fr, A.intervalHours);
        const annB     = annualize(B.fr, B.intervalHours);
        const grossApy = Math.abs(annA - annB);

        if (grossApy < THRESHOLD_APY) continue;
        // Sanity cap: >200%/yr almost always means stale or erroneous data
        if (grossApy > MAX_GROSS_APY) continue;

        // SHORT = higher annualized rate (collect), LONG = lower
        const shortSide = annA >= annB ? A : B;
        const longSide  = annA >= annB ? B : A;

        // Per-venue fee: HL=0.025%/leg, dYdX=0.05%/leg, CEX=0.04%/leg
        const totalFees = roundTripFeeByVenue(shortSide.exchange, longSide.exchange);
        const net30d    = netApy30d(grossApy, totalFees);
        const beDays    = breakevenDays(grossApy, totalFees);
        const status    = spreadStatus(beDays);
        const hasDexLeg = shortSide.isDex || longSide.isDex;

        // Liquidity: use OI or vol24h from each leg; capacity = min(both legs, 1% of OI)
        const shortData  = (futures[shortSide.exchange] || {})[coin] || {};
        const longData   = (futures[longSide.exchange]  || {})[coin] || {};
        const shortLiq   = liquidityUsd(shortData);
        const longLiq    = liquidityUsd(longData);
        const minLiq     = shortLiq > 0 && longLiq > 0
          ? Math.min(shortLiq, longLiq)
          : Math.max(shortLiq, longLiq);
        // Hard floor: skip illiquid pairs where neither leg has OI/vol data or both are tiny
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

        opps.push({
          type:             'FUNDING',
          id:               `funding-${coin}-${shortSide.exchange}-${longSide.exchange}`,
          question:         `${coin}/USDT Funding Spread`,
          legs: [
            {
              platform:      venueLabel(shortSide.exchange, shortSide.isDex),
              side:          'SHORT',
              price:         +shortSide.fr.toFixed(6),
              intervalHours: shortSide.intervalHours,
              isDex:         shortSide.isDex,
              url:           null,
            },
            {
              platform:      venueLabel(longSide.exchange, longSide.isDex),
              side:          'LONG',
              price:         +longSide.fr.toFixed(6),
              intervalHours: longSide.intervalHours,
              isDex:         longSide.isDex,
              url:           null,
            },
          ],
          annualizedROI:    +grossApy.toFixed(2),
          netROI:           net30d,
          grossROI:         +grossApy.toFixed(2),
          spread:           null,
          daysToResolution: null,
          resolutionDate:   null,
          capacityUsd:      capUsd,
          lockupFlag:       null,
          verdict:          thinFlag ? 'HARVEST · thin — not executable at size' : 'HARVEST · variable',
          confidence:       grossApy > 10 ? 0.7 : 0.85,
          note:             [feeNote, resetNote, bridgeNoteStr].filter(Boolean).join(' '),
          hasDexLeg,
          totalFeesPct:     +totalFees.toFixed(3),
          breakevenDays:    beDays,
          status,
          liquidityTier:    tier,
          oiUsd:            minLiq > 0 ? Math.round(minLiq) : null,
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
// Owns type=FUNDING only. CASHABLE/SIGNAL/SPORTS are preserved untouched.

const TYPE_RANK = { CASHABLE: 0, SPORTS: 1, FUNDING: 2, SIGNAL: 3 };

function mergeUnifiedFunding(allFundingOpps) {
  let existing = { generatedAt: null, sources: {}, summary: {}, opportunities: [] };
  try {
    existing = JSON.parse(fs.readFileSync(UNIFIED_FILE, 'utf8'));
  } catch { /* file absent or corrupt — start fresh */ }

  const kept   = (existing.opportunities || []).filter(o => o.type !== 'FUNDING');
  const toEmit = allFundingOpps;  // threshold already applied in crossExchangeSpread

  const merged = [...kept, ...toEmit];

  merged.sort((a, b) => {
    const ra = TYPE_RANK[a.type] ?? 9, rb = TYPE_RANK[b.type] ?? 9;
    if (ra !== rb) return ra - rb;
    if (a.annualizedROI !== null && b.annualizedROI !== null) return b.annualizedROI - a.annualizedROI;
    if (a.annualizedROI !== null) return -1;
    if (b.annualizedROI !== null) return 1;
    return 0;
  });

  const allROIs       = merged.map(o => o.annualizedROI).filter(v => v != null);
  const bestAnnualized = allROIs.length ? Math.max(...allROIs) : null;

  const result = {
    generatedAt: existing.generatedAt ?? null,
    sources: {
      ...(existing.sources ?? {}),
      funding: {
        updatedAt:  Date.now(),
        emitCount:  toEmit.length,
        totalFound: allFundingOpps.length,
        threshold:  THRESHOLD_APY,
      },
    },
    summary: {
      total:          merged.length,
      cashable:       merged.filter(o => o.type === 'CASHABLE').length,
      signal:         merged.filter(o => o.type === 'SIGNAL').length,
      sports:         merged.filter(o => o.type === 'SPORTS').length,
      funding:        toEmit.length,
      bestAnnualized,
    },
    opportunities: merged,
  };

  // Atomic write: temp file → rename (atomic on Linux same filesystem)
  const tmpPath = UNIFIED_FILE + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(result, null, 2));
  fs.renameSync(tmpPath, UNIFIED_FILE);
}

// ── Main loop ─────────────────────────────────────────────────────────────────

function run() {
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

    const allOpps = crossExchangeSpread(data.futures || {});

    console.log(`[funding] ${allOpps.length} pairs ≥${THRESHOLD_APY}%/yr:`);
    for (const o of allOpps) {
      const dex = o.hasDexLeg ? ' [DEX]' : '';
      console.log(`  ${o.id}: +${o.annualizedROI}%/yr  net30d:+${o.netROI}%/yr  be:${o.breakevenDays}d  ${o.status}${dex}`);
    }

    mergeUnifiedFunding(allOpps);
    beat();

  } catch (e) {
    console.error('[funding] error:', e.message, e.stack?.split('\n')[1] ?? '');
  }
}

run();
setInterval(run, INTERVAL_MS);
