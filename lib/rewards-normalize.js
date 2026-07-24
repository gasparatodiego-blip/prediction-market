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

// Real-path share math (published Polymarket quadratic + Kalshi observed flat pro-rata).
// Used to recover the REAL competitor score agent24 measured but does not persist, so the
// list's saturation/share is measured — not the simplified lib/rewards-estimate model.
let recoverCompetitorQ, quadraticUserShare, flatUserShare;
try { ({ recoverCompetitorQ, quadraticUserShare, flatUserShare } = require('./rewardScore')); }
catch (_) { recoverCompetitorQ = quadraticUserShare = flatUserShare = () => null; }

const REWARD_REF_CAPITAL = 1000;   // reference maker $ for the row-level saturation/share

// Depth-at-touch suppression — the SINGLE source of truth (shared with agent24). A row whose
// real two-sided in-band depth is below the floor ($25 default) is a thin-book artifact
// (share → ~100% → net $/day ≈ the whole pool) and is DROPPED here, in the data layer the
// API serves, so it never reaches the list. Hidden, never rewritten.
const { competitorDepthUsd, belowDepthFloor, depthFloorUsd } = require('./reward-depth-floor');

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
// One normalized side from agent24's per-token book aggregate. depth doubles as
// qualifyingLiquidity and bookDepthAtBand (both are the real in-band price×size the
// estimator splits the pool against / gauges fill probability from). null book → the
// side is emitted with null numbers so the UI shows "book unavailable" calmly.
function polySide(s) {
  if (!s) return null;
  const mid   = s.mid ?? null;
  const depth = s.emptyBook ? null : (s.existing_depth_usd ?? null);
  return {
    midpoint:            mid,
    qualifyingLiquidity: depth,
    bookDepthAtBand:     depth,
    bookSpread:          s.bookSpread ?? null,
    volatilityStdev:     s.volatilityStdev ?? null,
    twoSidedRequired:    typeof s.twoSidedRequired === 'boolean'
      ? s.twoSidedRequired
      : (mid != null && (mid < 0.10 || mid > 0.90)),
    hasBook:             !s.emptyBook && depth != null,
    asksDerivedByComplement: false,   // Polymarket NO book is a real independent CLOB book
  };
}

function normalizePoly(polyData) {
  const markets = polyData?.markets || [];
  return markets.map(m => {
    const mid   = m.mid ?? null;
    const depth = m.existing_depth_usd ?? null;
    // Two-sided REQUIRED when mid outside [0.10, 0.90] (Polymarket rule).
    const twoSidedRequired = mid != null && (mid < 0.10 || mid > 0.90);
    // Per-side snapshot: YES and NO are each a real independent CLOB book (agent24
    // fetches both token books). Absent (older scan) → null, UI falls back to top-level.
    const sides = m.sides
      ? { yes: polySide(m.sides.yes), no: polySide(m.sides.no) }
      : null;
    // ── MEASURED reward-share block (real live-book quadratic) ──
    // Recover the exact Q_competitors agent24 scored from the CLOB book (published
    // S(v,s)=((v-s)/v)^2, c=3) and express a reference $1k maker's share + saturation.
    // null when the book/pool can't be scored → UI shows "—", never fabricated.
    const rewardScore = (() => {
      const dp = m.rewardsDailyRate ?? null;
      const v  = m.rewardsMaxSpread ?? null;
      const mn = m.rewardsMinSize ?? 0;
      if (dp == null || mid == null || !(v > 0) || !m.levels) return null;
      const competitorQ = recoverCompetitorQ(m.levels, mid, v, mn);
      if (competitorQ == null) return null;
      // Typical placement = quarter of the full band (agent24's "typical": scoreOrder's
      // internal half-band is v/2, and its typical distance is (v/2)/2 = v/4). This makes
      // refShare consistent with the levels[] the competitor Q was recovered from.
      const refShare = quadraticUserShare(competitorQ, mid, v, mn, REWARD_REF_CAPITAL, v / 4);
      if (refShare == null) return null;
      return {
        source:        'measured-clob-quadratic', // Polymarket: real, published formula
        model:         'polymarket',
        poolDay:       dp,
        mid,
        maxSpreadCents: v,                        // full reward band (cents)
        minSize:       mn,
        competitorQ:   round(competitorQ, 4),      // REAL Q_min from the live book
        refCapital:    REWARD_REF_CAPITAL,
        refShare:      round(refShare, 6),         // reference $1k maker's pool share
      };
    })();
    return {
      venue:               'polymarket',
      marketId:            m.conditionId,
      slug:                m.slug || null,          // real Gamma event slug for platform deep-link (null when absent)
      marketSlug:          m.marketSlug || null,    // per-outcome slug → …/event/<slug>/<marketSlug> (multi-outcome)
      groupItemTitle:      m.groupItemTitle || null,// outcome label (e.g. "England") for the multi-outcome hint
      negRisk:             Boolean(m.negRisk),      // true → multi-outcome event (per-outcome deep-link applies)
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
      tokenIdNo:           m.tokenIdNo ?? null,
      // Price-first row inputs (Part A) — REAL market tick + REAL YES-token touch (null when absent).
      // tickSize: needed to display on-tick posted prices; bestBid/bestAsk: the live book touch markers.
      tickSize:            m.tickSize ?? null,
      bestBid:             m.bestBid ?? null,
      bestAsk:             m.bestAsk ?? null,
      rewardScore,
      sides,
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
    // Per-side split. Kalshi's orderbook returns BIDS ONLY for both sides
    // (yes_dollars, no_dollars); the ask ladders are the contract complement
    // (best ask YES = 100¢ − best bid NO, and vice-versa) — a real Kalshi identity,
    // marked asksDerivedByComplement:true so the UI can label it honestly.
    //   Trade YES → you make the YES market; your competition is the YES-bid stack (bidUsd).
    //   Trade NO  → your competition is the NO-bid stack (askUsd). Prices are complementary
    //               (mid_no = 1 − mid_yes) but the two stacks differ, so net/day differs.
    const noMid = mid != null ? round(1 - mid, 4) : null;
    const sides = {
      yes: {
        midpoint:            mid,
        qualifyingLiquidity: round(bidUsd),
        bookDepthAtBand:     round(bothUsd),
        bookSpread:          (m.best_ask != null && m.best_bid != null) ? round(m.best_ask - m.best_bid, 4) : null,
        volatilityStdev:     null,
        twoSidedRequired,
        hasBook:             bidUsd != null || askUsd != null,
        asksDerivedByComplement: true,
      },
      no: {
        midpoint:            noMid,
        qualifyingLiquidity: round(askUsd),
        bookDepthAtBand:     round(bothUsd),
        bookSpread:          (m.best_ask != null && m.best_bid != null) ? round(m.best_ask - m.best_bid, 4) : null,
        volatilityStdev:     null,
        twoSidedRequired:    noMid != null && (noMid < 0.10 || noMid > 0.90),
        hasBook:             bidUsd != null || askUsd != null,
        asksDerivedByComplement: true,
      },
    };
    // ── OBSERVED reward-share block (real pool + real depth; INFERRED split rule) ──
    // Kalshi publishes no band and no reward formula. Inputs are REAL (pool_day; the
    // limiting side's qualifying SIZE in shares from the live orderbook), but the flat
    // pro-rata split is an OBSERVED model (agent25) — labeled as such, never "measured".
    const rewardScore = (() => {
      const dp = m.pool_day ?? null;
      const qb = m.competitor_qualifying_bids;
      const qa = m.competitor_qualifying_asks;
      const qLim = (qb != null && qa != null) ? Math.min(qb, qa) : (qb ?? qa ?? null);
      if (dp == null || mid == null || qLim == null) return null;
      const refShare = flatUserShare(qLim, mid, REWARD_REF_CAPITAL);
      if (refShare == null) return null;
      return {
        source:        'observed-flat-prorata',    // Kalshi: inferred split, real inputs
        model:         'kalshi',
        poolDay:       dp,
        mid,
        maxSpreadCents: null,                       // no published band
        minSize:       m.min_size ?? 0,
        competitorQ:   round(qLim, 2),              // limiting side qualifying SHARES
        refCapital:    REWARD_REF_CAPITAL,
        refShare:      round(refShare, 6),
      };
    })();
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
      tokenIdNo:           null,
      rewardScore,
      sides,
    };
  });
}

// ── Build combined snapshot from both on-disk data files ─────────────────────
function buildCombined() {
  const poly   = readJson(POLY_FILE);
  const kalshi = readJson(KALSHI_FILE);

  const polyMarkets   = poly   ? normalizePoly(poly)     : [];
  const kalshiMarkets = kalshi ? normalizeKalshi(kalshi) : [];
  const allMarkets = [...polyMarkets, ...kalshiMarkets];

  // ── DEPTH-AT-TOUCH SUPPRESSION ──────────────────────────────────────────────
  // Drop rows whose real two-sided in-band depth is below the floor (thin-book artifacts).
  // Suppressed rows are HIDDEN — not rewritten to a "corrected" value. A null/missing depth
  // is never below the floor (that row is unknown and renders "—" downstream, not suppressed).
  const floor = depthFloorUsd();
  const suppressed = [];
  const markets = allMarkets.filter(m => {
    const d = competitorDepthUsd(m);
    if (belowDepthFloor(d, floor)) {
      suppressed.push({ venue: m.venue, marketId: m.marketId, depthUsd: round(d) });
      return false;
    }
    return true;
  });

  const withPool = markets.filter(m => m.dailyPool != null).length;

  return {
    meta: {
      generatedAt:    new Date().toISOString(),
      venues:         ['polymarket', 'kalshi'],
      totalMarkets:   markets.length,
      polymarket:     markets.filter(m => m.venue === 'polymarket').length,
      kalshi:         markets.filter(m => m.venue === 'kalshi').length,
      // Depth-floor suppression accounting (visible, not asserted).
      depthFloorUsd:        floor,
      suppressedThinDepth:  suppressed.length,
      scannedBeforeFloor:   allMarkets.length,
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
