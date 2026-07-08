'use strict';

/**
 * lib/usdc-arb.js — USDC-margined funding-divergence arb surface (MAJORS ONLY).
 *
 * The trade: the SAME coin has a USDC-settled perp and a USDT-settled perp whose
 * funding rates DIVERGE. Short the higher-funding leg, long the lower-funding leg —
 * delta-neutral in price (same coin, opposite sides), collecting the funding
 * DIFFERENTIAL each settlement. Two flavours:
 *   (a) same-venue cross-quote  — e.g. short ETHUSDC-perp / long ETHUSDT-perp on Binance
 *   (b) cross-venue USDC↔USDC or USDC↔USDT — where BOTH legs are executable
 * Every row has ≥1 USDC leg (pure USDT↔USDT pairs are the MAIN lane, not here).
 *
 * Honest-engine (identical rules to the main funding lane):
 *   • net $/day is the PRIMARY figure; annualized run-rate is CAPPED at ±200%/yr.
 *   • REAL sourced fees only — venueFeePct() routes USDC-M keys to the cited
 *     USDC_M_FEE_PCT table (never the USDT-M 0.04%).
 *   • dead-contract / cap-pin / thin guards drop non-executable legs (USDC books
 *     are thin and many alt USDC funding values are exchange-cap clamps). Every
 *     exclusion is returned with a reason for the caller to log — never silent.
 *   • de-peg risk is intrinsic (USDC-vs-USDT basis can move); disclosed by label.
 *
 * PURE + deterministic: same (futures, futuresUsdc, history, now) → same rows. Shared
 * by lib/spread-compute.ts (serve) and agent29-verifier.js (independent re-read) so
 * their row keys always agree. All money math flows through lib/funding-math.js.
 */

const {
  annualize,
  venueFeePct,
  usdcVenueFeePct,
  netApy30d,
  breakevenDays,
  PERP_SPOT_ANNUAL_CAP,
} = require('./funding-math');
const { isDeadContract, buildPeerMarks } = require('./contract-liveness');

// Majors only — matches agent10's USDC_MAJORS ingest allowlist.
const USDC_MAJORS = ['BTC', 'ETH', 'SOL', 'XRP'];
// USDT counterparty venues for the divergence leg: deep major books only.
const USDT_COUNTERPARTIES = ['binance', 'bybit', 'okx', 'bitget'];

function liqUsd(d) {
  return Math.max((d && d.openInterestUsd) || 0, (d && d.vol24hUsd) || 0);
}
function liqTier(usd) {
  if (usd >= 50_000_000) return 'DEEP';
  if (usd >= 10_000_000) return 'OK';
  if (usd >= 1_000_000)  return 'THIN';
  return 'VERY THIN';
}
// Base venue (strip -usdc) so a same-venue cross-quote is recognised.
function baseVenue(v) { return String(v || '').replace(/-usdc$/, ''); }

/**
 * @param {object} futures      USDT-M venue map (exchange-prices.json .futures)
 * @param {object} futuresUsdc  USDC-M venue map (exchange-prices.json .futuresUsdc)
 * @param {object} history      14d settled mirror .data[venue][coin] (cap-pin guard); may be {}
 * @param {number} now          ms epoch (guard staleness)
 * @returns {{ rows: object[], excluded: {venue,coin,reason}[] }}
 */
function computeUsdcArb(futures, futuresUsdc, history, now) {
  futures     = futures || {};
  futuresUsdc = futuresUsdc || {};
  history     = history || {};
  now         = typeof now === 'number' ? now : 0;

  // Peer marks span BOTH USDT and USDC venues so the frozen-price guard has a full
  // cross-venue median (a USDC contract with a broken mark is caught against USDT peers).
  const peerMarks = buildPeerMarks({ ...futures, ...futuresUsdc });
  const excluded  = [];

  // Build the per-coin candidate leg pool (USDC legs + USDT counterparties), guarded.
  function legsFor(coin) {
    const out = [];
    const push = (venue, d, margin) => {
      if (!d || typeof d.fundingRate !== 'number' || !isFinite(d.fundingRate)) return;
      const hist = ((history[venue] || {})[coin]) || [];
      const dead = isDeadContract(venue, coin, d, hist, { now, peerMarks: peerMarks[coin] });
      if (dead.dead) { excluded.push({ venue, coin, reason: dead.reason }); return; }
      // Honest fee sourcing: a USDC leg MUST resolve in the sourced USDC-M table —
      // usdcVenueFeePct returns null for any unsourced USDC venue → EXCLUDE it rather
      // than fall back to the USDT 0.04%. USDT legs use the standard perp fee table.
      const fee = margin === 'USDC' ? usdcVenueFeePct(venue) : venueFeePct(venue);
      if (fee == null) { excluded.push({ venue, coin, reason: 'no sourced USDC-M taker fee (excluded, not assumed)' }); return; }
      const intervalH = typeof d.fundingIntervalHours === 'number' && d.fundingIntervalHours > 0 ? d.fundingIntervalHours : 8;
      const usd = liqUsd(d);
      out.push({
        venue, margin, fee,
        fr: d.fundingRate, intervalH,
        mark: typeof d.markPrice === 'number' ? d.markPrice : null,
        liqUsd: usd, tier: usd > 0 ? liqTier(usd) : null,
      });
    };
    for (const [venue, coins] of Object.entries(futuresUsdc)) push(venue, (coins || {})[coin], 'USDC');
    for (const v of USDT_COUNTERPARTIES) push(v, (futures[v] || {})[coin], 'USDT');
    return out;
  }

  const rows = [];
  for (const coin of USDC_MAJORS) {
    const legs = legsFor(coin);
    if (legs.length < 2) continue;

    let best = null;
    for (let i = 0; i < legs.length; i++) {
      for (let j = i + 1; j < legs.length; j++) {
        const A = legs[i], B = legs[j];
        if (A.margin !== 'USDC' && B.margin !== 'USDC') continue;   // ≥1 USDC leg required
        const annA = annualize(A.fr, A.intervalH);
        const annB = annualize(B.fr, B.intervalH);
        const grossApy = Math.abs(annA - annB);
        if (grossApy === 0) continue;                               // no divergence → nothing to collect
        const shortLeg = annA >= annB ? A : B;                      // short the higher-funding leg
        const longLeg  = annA >= annB ? B : A;
        const feesPct  = (shortLeg.fee + longLeg.fee) * 2;          // round trip, both legs, sourced
        const net30d   = netApy30d(grossApy, feesPct);
        // Per $1k per leg (client scales). gross $/day on notional; fee one-time; 30d-amortized net.
        const grossPerDay1k = grossApy / 100 / 365 * 1000;
        const feesOneTime1k = feesPct / 100 * 1000;
        const netPerDay1k   = grossPerDay1k - feesOneTime1k / 30;
        const be            = net30d > 0 ? breakevenDays(grossApy, feesPct) : null;
        const annRaw        = net30d;                               // net %/yr run-rate
        const cap           = Math.abs(annRaw) > PERP_SPOT_ANNUAL_CAP;
        const cand = {
          coin,
          shortVenue: shortLeg.venue, shortMargin: shortLeg.margin,
          longVenue:  longLeg.venue,  longMargin:  longLeg.margin,
          frShortPct8h: +(annualize(shortLeg.fr, shortLeg.intervalH) / 1095).toFixed(6),  // %/8h normalized
          frLongPct8h:  +(annualize(longLeg.fr,  longLeg.intervalH)  / 1095).toFixed(6),
          intervalH: 8,
          grossApyPct: +grossApy.toFixed(3),
          sameVenue: baseVenue(shortLeg.venue) === baseVenue(longLeg.venue),
          comboLabel: `${shortLeg.margin}↔${longLeg.margin}`,
          markShort: shortLeg.mark, markLong: longLeg.mark,
          liqTierShort: shortLeg.tier, liqTierLong: longLeg.tier,
          thin: (shortLeg.tier === 'THIN' || shortLeg.tier === 'VERY THIN' ||
                 longLeg.tier  === 'THIN' || longLeg.tier  === 'VERY THIN'),
          edge: {
            grossPerDay1k: +grossPerDay1k.toFixed(4),
            feesOneTime1k: +feesOneTime1k.toFixed(4),
            netPerDay1k:   +netPerDay1k.toFixed(4),
            breakevenDays: be == null ? null : (isFinite(be) ? +be.toFixed(1) : null),
            netApy30dPct:  net30d,
            annualizedRunRatePct: +Math.max(-PERP_SPOT_ANNUAL_CAP, Math.min(annRaw, PERP_SPOT_ANNUAL_CAP)).toFixed(2),
            annualizedCapped: cap,
            shortFeePct: shortLeg.fee,
            longFeePct:  longLeg.fee,
          },
        };
        // Fee-aware selection: MAX net $/day after both legs' sourced fees.
        if (!best || cand.edge.netPerDay1k > best.edge.netPerDay1k) best = cand;
      }
    }
    if (best) rows.push(best);
  }

  rows.sort((a, b) => b.edge.netPerDay1k - a.edge.netPerDay1k);
  return { rows, excluded };
}

module.exports = { computeUsdcArb, USDC_MAJORS, USDT_COUNTERPARTIES };
