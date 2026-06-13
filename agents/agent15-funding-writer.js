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
  roundTripFee,
  netApy30d,
  breakevenDays,
  spreadStatus,
  VENUE_FEE_PCT,
} = require('../lib/funding-math');

const EXCHANGE_FILE  = '/tmp/exchange-prices.json';
const UNIFIED_FILE   = '/tmp/unified-opportunities.json';
const HB_FILE        = '/tmp/agent-heartbeats.json';
const INTERVAL_MS    = 60_000;

const THRESHOLD_APY  = 3.0;        // min gross %/yr to emit to unified panel
const MAX_DATA_AGE   = 5 * 60_000; // skip if exchange data > 5 min old

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
  return isDex ? `${cap(exchange)} (DEX)` : cap(exchange);
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
    const isDex = ex === 'hyperliquid';
    for (const [coin, data] of Object.entries(coins || {})) {
      const fr           = data?.fundingRate;
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

        // Interval-aware annualization — the key fix
        const annA = annualize(A.fr, A.intervalHours);
        const annB = annualize(B.fr, B.intervalHours);
        const grossApy = Math.abs(annA - annB);

        if (grossApy < THRESHOLD_APY) continue;

        // SHORT = higher annualized rate (collect), LONG = lower
        const shortSide = annA >= annB ? A : B;
        const longSide  = annA >= annB ? B : A;

        const totalFees = roundTripFee(shortSide.isDex, longSide.isDex);
        const net30d    = netApy30d(grossApy, totalFees);
        const beDays    = breakevenDays(grossApy, totalFees);
        const status    = spreadStatus(beDays);
        const hasDexLeg = shortSide.isDex || longSide.isDex;

        // Describe how legs reset
        const resetNote = hasDexLeg
          ? 'HL leg resets HOURLY; CEX leg every 8h — each can flip independently.'
          : 'Both legs reset every 8h.';

        const feeNote = hasDexLeg
          ? `Round-trip fees: CEX 0.04%/leg × 2 + HL ${VENUE_FEE_PCT.dex}%/leg × 2 = ${totalFees.toFixed(3)}%`
          : `Round-trip fees: 4 CEX legs × 0.04% = ${totalFees.toFixed(3)}%`;

        const bridgeNote = hasDexLeg
          ? 'Bridge friction: ~10 min + ~$1–5 ETH gas one-time to deposit to Hyperliquid L1.'
          : '';

        opps.push({
          type:             'FUNDING',
          id:               `funding-${coin}-${shortSide.exchange}-${longSide.exchange}`,
          question:         `${coin}/USDT Funding Spread`,
          legs: [
            {
              platform:     venueLabel(shortSide.exchange, shortSide.isDex),
              side:         'SHORT',
              price:        +shortSide.fr.toFixed(6),         // %/interval
              intervalHours: shortSide.intervalHours,
              isDex:        shortSide.isDex,
              url:          null,
            },
            {
              platform:     venueLabel(longSide.exchange, longSide.isDex),
              side:         'LONG',
              price:        +longSide.fr.toFixed(6),
              intervalHours: longSide.intervalHours,
              isDex:        longSide.isDex,
              url:          null,
            },
          ],
          annualizedROI:    +grossApy.toFixed(2),
          netROI:           net30d,     // net 30d APY %/yr (for OpportunitiesPanel secondary line)
          grossROI:         +grossApy.toFixed(2),
          spread:           null,
          daysToResolution: null,
          resolutionDate:   null,
          capacityUsd:      null,       // no orderbook depth → display as "—"
          lockupFlag:       null,
          verdict:          'HARVEST · variable',
          confidence:       grossApy > 10 ? 0.7 : 0.85,
          note:             [feeNote, resetNote, bridgeNote].filter(Boolean).join(' '),
          // Extended fields consumed by /api/crypto and crypto page
          hasDexLeg,
          totalFeesPct:     +totalFees.toFixed(3),
          breakevenDays:    beDays,
          status,
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
