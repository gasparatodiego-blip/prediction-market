'use strict';
// scripts/rewards-ceiling/lib/curve.js — the capital-to-share curve, built ON the shipped reward maths.
// We IMPORT lib/rewardScore.js READ-ONLY (scoreBook / adjustedMid / quadraticUserShare) — the same
// published Polymarket quadratic S(v,s)=((v−s)/v)², Qmin two-sided, that agent24 and the board use — so
// this analysis can never diverge from the lane's own scoring. Nothing here is modified in lib/.
//
// CEILING PLACEMENT: to bound the return from ABOVE we assume the most favourable legal placement — an
// order resting AT the mid, s=0 ⇒ S=1 (the maximum score per share). A real order cannot sit exactly at
// mid, so any real placement scores LESS and needs MORE capital for the same share ⇒ our capital is a
// lower bound and our return an upper bound. That is the whole point of a ceiling.

const path = require('path');
const REWARD = require(path.join(__dirname, '..', '..', '..', 'lib', 'rewardScore'));
const { scoreBook, adjustedMid, parseOrders, quadraticUserShare } = REWARD;
// LAYERED path — reuse the board's shared layering libs READ-ONLY so ceiling/replay can score a
// multi-price configuration with the SAME math the panel uses, never a second implementation.
const LAYERED = require(path.join(__dirname, '..', '..', '..', 'lib', 'reward-layered'));
const LAYERS = require(path.join(__dirname, '..', '..', '..', 'lib', 'reward-layers'));

function clampPrice(mid) { return Math.max(0.01, Math.min(0.99, mid)); }

/**
 * TOTAL capital (both sides deployed) that must rest in-band to hold share X of a market's pot, at S=1.
 * Derivation (published quadratic, at s=0 ⇒ S=1): your per-side score Qu = size = capital_perSide/price;
 * share = Qu/(Qu+competitorQ). Solve for capital_perSide at target X: price·competitorQ·X/(1−X). A maker
 * must quote BOTH sides to score, so total = 2× that. competitorQ is the live-book Qmin from scoreBook.
 */
function capitalForShare(competitorQ, mid, X) {
  if (!(competitorQ >= 0) || !(mid > 0) || !(X >= 0) || X >= 1) return null;
  const price = clampPrice(mid);
  const perSide = price * competitorQ * (X / (1 - X));
  return 2 * perSide;
}

/**
 * Inverse: the share a TOTAL capital buys at S=1. size = (capital/2)/price; share = size/(size+cQ).
 *
 * THE VENUE MINIMUM IS PART OF THE SCORING, NOT A DETAIL. Polymarket publishes a per-market
 * min_incentive_size (`rewards_min_size`), and an order smaller than it is not scored — it earns nothing.
 * This repo already encodes that rule in BOTH directions inside its SSOT, lib/rewardScore.js: scoreSide()
 * skips `o.size < minSize` when measuring the COMPETITION, and quadraticUserShare() returns 0 for OUR OWN
 * order below the minimum. This function used to apply it to neither, which made a capital too small to be
 * scored at all look like a positive — and worst of all, look BEST: with competitorQ measured as 0 (nobody
 * else meets the minimum either) the formula returned share = 1, i.e. "you take 100% of the pot", for a
 * few dollars that the venue would score as zero. On the 2026-07-31 board that single omission accounted
 * for $28.00/day of a $52.96/day headline: three markets funded at $2 against minimums of 200, 200 and 50
 * shares.
 *
 * `minSize` is OPTIONAL and defaults to no gate, using the exact `(minSize || 0)` idiom of
 * quadraticUserShare — so a caller that does not know the market's minimum gets the old arithmetic and no
 * silent new refusal, while every caller that does know it gets the venue's real rule.
 *
 * @param {number} competitorQ  in-band qualifying depth of everyone else (shares)
 * @param {number} mid          scoring mid
 * @param {number} capitalTotal BOTH sides' capital ($)
 * @param {number} [minSize]    venue min_incentive_size (shares). Below it the share is 0, never a fraction.
 */
/**
 * ── QUANTE SHARE COMPRA IL CAPITALE, PER LATO ──────────────────────────────────────────────────────
 *
 * `pairCostUsd` è il costo di UNA COPPIA di share — una sul lato bid, una sul lato ask — e cambia la
 * risposta in modo che sui mercati economici non è un dettaglio ma un fattore dieci.
 *
 *   ASSENTE (il difetto storico, e resta il difetto):  size = (capitalTotal / 2) / mid
 *     Assume che i due lati costino uguale, cioè `mid` per share ciascuno. È vero solo a mid ≈ 0,50.
 *     Regge quando il lato ask è una VENDITA di share che si possiedono già: lì non costa collaterale
 *     e il capitale va tutto sul bid. È l'ipotesi con cui è nato il backtest, ed è per questo che
 *     l'assenza del parametro lo lascia byte-per-byte com'era.
 *
 *   PRESENTE:  size = capitalTotal / pairCostUsd
 *     Quotare due lati partendo da solo collaterale significa comprare YES a (mid − d) e NO a
 *     (1 − mid − d): la coppia costa `1 − 2d`, indipendentemente dal mid. Con share UGUALI sui due
 *     lati — che è anche ciò che massimizza min(Q_bids, Q_asks) a parità di capitale — il conto è
 *     una divisione sola.
 *
 * Perché conta per la CLASSIFICA e non solo per il display: il rapporto fra le due formule è
 * 2·mid/(1−2d), cioè 1,00 a mid 0,49 e 0,11 a mid 0,055. Con la formula vecchia un mercato a 5¢
 * sembra comprare nove volte le share che il capitale compra davvero, quindi sembra rendere nove
 * volte tanto, quindi il knapsack ci va. La distorsione non è nel numero mostrato: è nella SCELTA.
 */
function shareForCapital(competitorQ, mid, capitalTotal, minSize, pairCostUsd = null) {
  if (!(competitorQ >= 0) || !(mid > 0) || !(capitalTotal >= 0)) return null;
  const price = clampPrice(mid);
  const size = (typeof pairCostUsd === 'number' && Number.isFinite(pairCostUsd) && pairCostUsd > 0)
    ? capitalTotal / pairCostUsd
    : (capitalTotal / 2) / price;
  if (size < (minSize || 0)) return 0;   // venue min_incentive_size — same rule, same idiom as quadraticUserShare
  const denom = size + competitorQ;
  return denom > 0 ? size / denom : 0;
}

/**
 * The TOTAL capital that would put a qualifying order on BOTH sides: minSize shares per side, at the
 * market's own price. This is the number the operator needs when a row scores zero — "you are under the
 * venue minimum" is only actionable together with "and here is what it takes". Derived from the same rule
 * shareForCapital enforces, so the threshold and the refusal can never drift apart.
 * Returns null when the inputs cannot answer it (never a guessed floor).
 */
function capitalToQualify(mid, minSize, pairCostUsd = null) {
  if (!(mid > 0) || !(minSize > 0)) return null;
  // Stessa regola di shareForCapital, invertita: quanto capitale serve perché `size` arrivi a `minSize`.
  // Con il costo della coppia noto è `minSize × pairCost`; senza, resta il vecchio `2 × mid × minSize`.
  // Le due devono muoversi insieme, altrimenti la soglia e il rifiuto raccontano due storie diverse.
  // ⚠ IL RAMO `2 × mid × minSize` E' STATO TOLTO il 12 agosto 2026. Non era «il vecchio»: era
  // SBAGLIATO — assumeva che entrambi i lati costassero `mid`, vero solo a mid 0,50, e a mid 0,055
  // sottostimava di nove volte il capitale necessario a qualificare. La conversione vive ora in
  // `lib/rewards/size-da-capitale`, ed e' la stessa che usa il modulo che piazza.
  return require('../../../lib/rewards/size-da-capitale').capitalePerQualificare({ minSize, pairCostUsd });
}

/**
 * Measure a market from its live YES CLOB book: the size-cutoff-adjusted mid, the competitor Qmin (the
 * quadratic denominator — same scoreBook the pipeline uses), and the observed in-band $ depth per side
 * (Σ price×size of qualifying ≥minSize orders within the band). Returns null fields + a reason when the
 * book cannot be scored, so the caller EXCLUDES it (never defaults).
 */
function measureFromBook(book, rewardsMaxSpread, minSize) {
  if (!book || (!Array.isArray(book.bids) && !Array.isArray(book.asks))) return { ok: false, reason: 'no book' };
  const bids = parseOrders(book.bids, true);
  const asks = parseOrders(book.asks, false);
  if (!bids.length && !asks.length) return { ok: false, reason: 'empty book' };
  if (!(rewardsMaxSpread > 0)) return { ok: false, reason: 'no reward band' };
  const mid = adjustedMid(bids, asks, minSize, null);
  if (mid == null) return { ok: false, reason: 'mid unscoreable (no ≥minSize touch)' };
  const qs = scoreBook({ bids, asks }, rewardsMaxSpread, minSize, mid); // { Qbids, Qasks, Qmin, mid }
  const r = (rewardsMaxSpread / 2) / 100;
  const inbandUsd = (arr) => arr.filter((o) => o.size >= minSize && o.price >= mid - r - 1e-12 && o.price <= mid + r + 1e-12)
    .reduce((a, o) => a + o.price * o.size, 0);
  return {
    ok: true,
    mid,
    competitorQ: qs.Qmin,
    qBids: qs.Qbids,
    qAsks: qs.Qasks,
    inbandBidUsd: inbandUsd(bids),
    inbandAskUsd: inbandUsd(asks),
    inbandDepthUsd: inbandUsd(bids) + inbandUsd(asks), // observed qualifying in-band depth, both sides ($)
  };
}

/**
 * LAYERED scoring for the ceiling/replay: instead of a single mid placement, accept a multi-price
 * configuration (numLayers, spacing) and score each layer against its OWN per-level depth, summing to a
 * per-market total. This is a thin REUSE of the shared board libs (lib/reward-layers geometry +
 * lib/reward-layered scoring/cap) — the exact same math the panel and agent34 use — so a layered ceiling
 * or replay can never diverge from what the operator sees. Single-level callers keep using shareForCapital
 * / capitalForShare unchanged; this is additive.
 *
 * @param {object} cfg
 *   rewardScore   { mid, maxSpreadCents, minSize, poolDay }
 *   tick, bandLow, bandHigh
 *   perSideSizeUsd   capital committed per side
 *   numLayers, spacingTicks   the layered configuration
 *   perLevelDepth    [{ bidSizeAtLevel, askSizeAtLevel } | null] aligned to layers (from book or history)
 *   depthSource      { kind:'storico'|'live', hours? } — disclosed through
 * @returns the scoreLayeredPlan result (layers[], totalDailyUsd, poolCapped, reconciliation via the plan)
 */
function scoreLayeredConfig(cfg = {}) {
  const plan = LAYERED.computeLayeredPlan({
    rewardScore: cfg.rewardScore,
    tick: cfg.tick,
    bandLow: cfg.bandLow,
    bandHigh: cfg.bandHigh,
    perSideSizeUsd: cfg.perSideSizeUsd,
    numLayers: cfg.numLayers,
    spacingTicks: cfg.spacingTicks,
  });
  const capped = LAYERED.capLayeredPlan(plan, cfg.perLevelDepth || []);
  const scored = LAYERED.scoreLayeredPlan({
    plan: capped,
    perLevelDepth: cfg.perLevelDepth || [],
    rewardScore: cfg.rewardScore,
    depthSource: cfg.depthSource || null,
  });
  return { ...scored, reconciliation: capped.reconciliation, maxUsablePerSide: plan.maxUsablePerSide };
}

module.exports = { capitalForShare, shareForCapital, capitalToQualify, scoreLayeredConfig, measureFromBook, quadraticUserShare, clampPrice, rewardLayers: LAYERS.rewardLayers };
