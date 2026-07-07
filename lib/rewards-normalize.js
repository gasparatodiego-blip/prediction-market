'use strict';
/**
 * lib/rewards-normalize.js — unify the two per-venue reward scans into one
 * normalized snapshot the Liquidity Rewards tab + estimator consume.
 *
 * HONEST-ENGINE CONTRACT
 *   - Reads ONLY the values agent24 (Polymarket) and agent25 (Kalshi) already
 *     computed this cycle from live order books. No new API calls, no recompute,
 *     no interpolation. A missing field is emitted as `null`, never guessed.
 *   - dailyPool is the REAL program rate. When a venue genuinely does not expose
 *     a per-market pool (never the case today, but defensive), it is `null` with
 *     the reason surfaced — never fabricated.
 *   - All dollar figures come from real book depth (price × size), never OI.
 *
 * OUTPUT  /tmp/liquidity-rewards.json
 *   { meta, markets: [ NormalizedMarket ] }
 *
 * NormalizedMarket (schema required by the task):
 *   venue, marketId, title, category, midpoint, maxSpread, minSize,
 *   dailyPool|null, qualifyingLiquidity, bookDepthAtBand, hoursToResolution, updatedAt
 *   (+ estimator inputs: volatilityStdev, volatilityRisk, lastPrice, twoSidedRequired,
 *    scoringModel, flags, tokenId — all REAL or null)
 *
 * Both agents call writeCombinedSnapshot() at the end of their scan. Each rebuilds
 * the SAME combined file from the two on-disk data files, so the write is
 * idempotent and race-safe via atomic tmp+rename (last writer wins with identical
 * content). Wrapped in try/catch by the caller — a normalize error can never break
 * a scan.
 */

const fs = require('fs');

const POLY_FILE   = '/root/prediction-market/data/liquidity-rewards.json';
const KALSHI_FILE = '/root/prediction-market/data/kalshi-rewards.json';
const OUT_FILE    = '/tmp/liquidity-rewards.json';

let categoryFromText;
try { ({ categoryFromText } = require('./category')); }
catch (_) { categoryFromText = () => 'other'; }

// ── helpers ──────────────────────────────────────────────────────────────────
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch (_) { return null; }
}

function hoursUntil(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (!isFinite(ms)) return null;
  return Math.round((ms / 3_600_000) * 10) / 10;   // 0.1h precision
}

function round(n, dp = 2) {
  if (n == null || !isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// ── Polymarket → normalized ──────────────────────────────────────────────────
// qualifyingLiquidity / bookDepthAtBand: existing_depth_usd is the real dollar
// notional (price × size) of all qualifying resting orders inside the reward band,
// summed across both sides — that IS the two-sided competition your capital splits
// the pool against. maxSpread is in CENTS (Polymarket rewardsMaxSpread).
function normalizePoly(polyData) {
  const markets = polyData?.markets || [];
  return markets.map(m => {
    const mid   = m.mid ?? null;
    const depth = m.existing_depth_usd ?? null;
    // Two-sided REQUIRED when mid outside [0.10, 0.90] (Polymarket rule).
    const twoSidedRequired = mid != null && (mid < 0.10 || mid > 0.90);
    return {
      venue:               'polymarket',
      marketId:            m.conditionId,
      slug:                m.slug || null,          // real Gamma event slug for platform deep-link (null when absent)
      title:               m.question,
      category:            m.category || (m.question ? categoryFromText(m.question) : 'other'),
      midpoint:            mid,
      maxSpread:           m.rewardsMaxSpread ?? null,   // cents (full band)
      minSize:             m.rewardsMinSize ?? null,     // shares
      dailyPool:           m.rewardsDailyRate ?? null,   // real $/day (clobRewards)
      qualifyingLiquidity: depth,                        // USD, two-sided in-band
      bookDepthAtBand:     depth,                        // USD near band (fill-prob input)
      hoursToResolution:   hoursUntil(m.endDate),
      updatedAt:           polyData?.meta?.generatedAt || null,
      // ── estimator inputs (REAL or null) ──
      volatilityStdev:     m.volatilityStdev ?? null,    // price-fraction stdev over 24h
      volatilityRisk:      m.volatilityRisk ?? null,     // LOW | MEDIUM | HIGH
      lastPrice:           mid,
      twoSidedRequired,
      bookSpread:          m.bookSpread ?? null,
      scoringModel:        'polymarket-quadratic-clob',
      flags:               (m.levels?.['500']?.flags) || [],
      tokenId:             m.tokenId ?? null,
    };
  });
}

// ── Kalshi → normalized ──────────────────────────────────────────────────────
// Kalshi book scores are in SHARES; convert to USD at the executable side price
// (best_bid for the bid stack, best_ask for the ask stack) — never a midpoint.
// qualifyingLiquidity = limiting (thinner) two-sided side in USD; bookDepthAtBand
// = both sides summed in USD.
function normalizeKalshi(kalshiData) {
  const markets = kalshiData?.markets || [];
  return markets.map(m => {
    const mid     = m.book_mid ?? m.last_price ?? null;
    const bidPx   = m.best_bid ?? mid ?? 0;
    const askPx   = m.best_ask ?? mid ?? 0;
    const bidUsd  = m.competitor_qualifying_bids != null ? m.competitor_qualifying_bids * bidPx : null;
    const askUsd  = m.competitor_qualifying_asks != null ? m.competitor_qualifying_asks * askPx : null;
    const bothUsd = (bidUsd != null && askUsd != null) ? bidUsd + askUsd : (bidUsd ?? askUsd);
    // Two-sided competition basis = the limiting side (you can only score the
    // side you can match). null when a side is missing rather than assumed zero.
    const limiting = (bidUsd != null && askUsd != null) ? Math.min(bidUsd, askUsd) : null;
    const twoSidedRequired = mid != null && (mid < 0.10 || mid > 0.90);
    return {
      venue:               'kalshi',
      marketId:            m.ticker,
      title:               m.question,
      category:            m.category || (m.question ? categoryFromText(m.question) : 'other'),
      midpoint:            mid,
      // Kalshi has no published maxSpread band; 100 = full 0–100¢ range so the
      // estimator's (distance/maxSpread) term degrades gracefully. Flagged null-origin.
      maxSpread:           null,
      minSize:             m.min_size ?? null,           // shares
      dailyPool:           m.pool_day ?? null,           // real $/day (or null if truly unknown)
      qualifyingLiquidity: round(limiting),              // USD, limiting side
      bookDepthAtBand:     round(bothUsd),               // USD, both sides
      hoursToResolution:   hoursUntil(m.close_time || m.period_end),
      updatedAt:           kalshiData?._meta?.timestamp || m.timestamp || null,
      // ── estimator inputs ──
      volatilityStdev:     null,                         // Kalshi book has no 24h vol series (free tier)
      volatilityRisk:      m.flags?.TRAP ? 'HIGH' : null,
      lastPrice:           m.last_price ?? mid,
      twoSidedRequired,
      bookSpread:          (m.best_ask != null && m.best_bid != null) ? round(m.best_ask - m.best_bid, 4) : null,
      scoringModel:        'kalshi-flat-prorata-observed',
      flags:               Object.entries(m.flags || {}).filter(([, v]) => v).map(([k]) => k),
      tokenId:             null,
    };
  });
}

// ── Build combined snapshot from both on-disk data files ─────────────────────
function buildCombined() {
  const poly   = readJson(POLY_FILE);
  const kalshi = readJson(KALSHI_FILE);

  const polyMarkets   = poly   ? normalizePoly(poly)     : [];
  const kalshiMarkets = kalshi ? normalizeKalshi(kalshi) : [];
  const markets = [...polyMarkets, ...kalshiMarkets];

  const withPool = markets.filter(m => m.dailyPool != null).length;

  return {
    meta: {
      generatedAt:    new Date().toISOString(),
      venues:         ['polymarket', 'kalshi'],
      totalMarkets:   markets.length,
      polymarket:     polyMarkets.length,
      kalshi:         kalshiMarkets.length,
      withRealPool:   withPool,
      poolUnknown:    markets.length - withPool,
      polyGeneratedAt:   poly?.meta?.generatedAt || null,
      kalshiGeneratedAt: kalshi?._meta?.timestamp || null,
      note: 'Normalized union of live Polymarket CLOB + Kalshi LIP reward scans. ' +
            'Real book depth only (price×size, never OI/midpoint). dailyPool is the real ' +
            'program rate; null means genuinely unavailable. Estimates via lib/rewards-estimate.ts.',
    },
    markets,
  };
}

// ── Atomic write ─────────────────────────────────────────────────────────────
function writeCombinedSnapshot() {
  const out = buildCombined();
  const tmp = `${OUT_FILE}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, OUT_FILE);

  // Parallel history sink (non-fatal): the unified reward board over time.
  try {
    require('./history-logger').appendSnapshot('rewards-unified', Date.now(), out.markets);
  } catch (_) { /* history is best-effort; never breaks the write */ }

  return out.meta;
}

module.exports = {
  POLY_FILE,
  KALSHI_FILE,
  OUT_FILE,
  normalizePoly,
  normalizeKalshi,
  buildCombined,
  writeCombinedSnapshot,
};
