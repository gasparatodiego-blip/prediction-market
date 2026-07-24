'use strict';
// lib/maker/venue-rules.js — the ONE shared venue-rules validator (Part B1–B3).
//
// Pure, node + browser importable. Input: the market's LIVE venue rules + a quote (side, price, size).
// Output: { valid, reasons:[{ code, detail }] } with MACHINE-READABLE reason codes. This is the SINGLE
// source of truth for "is this quote placeable under the reward program's rules" — the UI band warning
// CALLS this function (it must never reimplement the check). Wiring it into the maker placement path is a
// separate, out-of-scope step; this build uses it for the UI warning only.
//
// FAIL CLOSED. If any rule needed to judge a market cannot be read (tick, scoring mid, max spread, min
// size), every quote for that market is INVALID with reason RULES_UNREADABLE. Never fall back to a default
// band, never guess a tick.
//
// NO PARALLEL BAND MATH. The band test reuses the SSOT (lib/rewards-live-band.inBand): a quote is in-band
// iff |price − scoringMid|·100 ≤ maxSpread/2 cents (rewardScore's v = maxSpread/2). An order at exactly the
// band radius scores 0, so the warning fires precisely when the reward score collapses to 0 — never on a
// looser or a fabricated band.

const { inBand } = require('../rewards-live-band');

// Machine-readable reason codes. One per distinct rule, plus the fail-closed unreadable code.
const CODES = Object.freeze({
  OFF_TICK: 'OFF_TICK',                     // price is not a multiple of the market tick
  OUT_OF_BAND: 'OUT_OF_BAND',               // |price − scoringMid| > maxSpread/2 → scores 0 reward
  BELOW_MIN_SIZE: 'BELOW_MIN_SIZE',         // size < min_incentive_size (or ≤ 0)
  PRICE_OUT_OF_RANGE: 'PRICE_OUT_OF_RANGE', // price outside the venue's [tick, 1−tick] range
  RULES_UNREADABLE: 'RULES_UNREADABLE',     // a rule could not be read → fail closed
});

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

// On-tick test: price is a multiple of tick within FP tolerance. Mirrors the venue's priceValid.
function isOnTick(price, tick) {
  if (!fin(price) || !(tick > 0)) return false;
  const snapped = Math.round(price / tick) * tick;
  return Math.abs(price - snapped) < tick / 1000;
}

// Are ALL rules needed to judge this market present and sane? (tick>0, mid∈(0,1), band>0, minSize≥0.)
function rulesReadable(rules) {
  return !!rules
    && fin(rules.tick) && rules.tick > 0
    && fin(rules.scoringMid) && rules.scoringMid > 0 && rules.scoringMid < 1
    && fin(rules.maxSpreadCents) && rules.maxSpreadCents > 0
    && fin(rules.minSize) && rules.minSize >= 0;
}

/**
 * Validate ONE quote leg against a market's live venue rules.
 * @param {{ tick:number, scoringMid:number, maxSpreadCents:number, minSize:number, priceMin?:number, priceMax?:number }} rules
 * @param {{ side?:'BUY'|'SELL', price:number, size:number }} quote   size in SHARES
 * @returns {{ valid:boolean, reasons: Array<{code:string, detail:string}> }}
 */
function validateQuote(rules, quote) {
  if (!rulesReadable(rules)) {
    return { valid: false, reasons: [{
      code: CODES.RULES_UNREADABLE,
      detail: 'venue rules (tick / scoring mid / max spread / min size) could not be read for this market — refusing (fail closed)',
    }] };
  }
  const q = quote || {};
  const reasons = [];
  const tick = rules.tick;
  // Venue price range: [tick, 1−tick] unless the market overrides it. STRICTLY inside is enforced below.
  const priceMin = fin(rules.priceMin) ? rules.priceMin : tick;
  const priceMax = fin(rules.priceMax) ? rules.priceMax : (1 - tick);

  if (!fin(q.price)) {
    reasons.push({ code: CODES.PRICE_OUT_OF_RANGE, detail: 'price is missing' });
  } else {
    if (q.price < priceMin - 1e-12 || q.price > priceMax + 1e-12) {
      reasons.push({ code: CODES.PRICE_OUT_OF_RANGE, detail: `price ${q.price} is outside the venue range [${priceMin}, ${priceMax}]` });
    }
    if (!isOnTick(q.price, tick)) {
      reasons.push({ code: CODES.OFF_TICK, detail: `price ${q.price} is not a multiple of tick ${tick}` });
    }
    if (!inBand(q.price, rules.scoringMid, rules.maxSpreadCents)) {
      const distC = Math.abs(q.price - rules.scoringMid) * 100;
      reasons.push({ code: CODES.OUT_OF_BAND, detail: `|price − scoring mid| ${distC.toFixed(2)}¢ exceeds the reward band ±${(rules.maxSpreadCents / 2).toFixed(2)}¢ — earns no reward` });
    }
  }

  if (!fin(q.size) || q.size <= 0) {
    reasons.push({ code: CODES.BELOW_MIN_SIZE, detail: 'size is missing or ≤ 0' });
  } else if (q.size < rules.minSize) {
    reasons.push({ code: CODES.BELOW_MIN_SIZE, detail: `size ${q.size} is below min_incentive_size ${rules.minSize} — earns nothing` });
  }

  return { valid: reasons.length === 0, reasons };
}

/**
 * B3 — qMin COUPLING. The published quadratic takes the MINIMUM across the two sides (Q_min), so a
 * two-sided quote is only as good as its WEAKER leg. Validate the PAIR, not each leg alone: if either leg
 * is out of band / off tick / under min, the whole two-sided quote is DEGRADED — the score collapses to
 * the weaker side. The caller shows the expected $/day for the DEGRADED case (which the shared quadratic
 * already produces, because it scores at the actual offset/size).
 *
 * @param {object} rules            same rules object as validateQuote
 * @param {{ side?, price, size }} bid   the buy leg (e.g. buy YES at mid − offset)
 * @param {{ side?, price, size }} ask   the sell leg (e.g. sell YES at mid + offset)
 * @returns {{ valid, degraded, both, bid, ask, weakerSide, reasons, note }}
 */
function validateQuotePair(rules, bid, ask) {
  if (!rulesReadable(rules)) {
    const un = { valid: false, reasons: [{ code: CODES.RULES_UNREADABLE, detail: 'venue rules could not be read — refusing (fail closed)' }] };
    return { valid: false, degraded: true, both: false, bid: un, ask: un, weakerSide: null,
      reasons: un.reasons, note: 'venue rules unreadable — cannot judge the two-sided quote (fail closed)' };
  }
  const bidV = validateQuote(rules, bid);
  const askV = validateQuote(rules, ask);
  const both = bidV.valid && askV.valid;
  const degraded = !both;
  // The weaker (score-limiting) side is the invalid one; if both invalid, neither leg earns.
  let weakerSide = null;
  if (!bidV.valid && askV.valid) weakerSide = 'bid';
  else if (bidV.valid && !askV.valid) weakerSide = 'ask';
  else if (!bidV.valid && !askV.valid) weakerSide = 'both';
  const reasons = [
    ...bidV.reasons.map((r) => ({ ...r, leg: 'bid' })),
    ...askV.reasons.map((r) => ({ ...r, leg: 'ask' })),
  ];
  const note = both
    ? 'both legs qualify'
    : weakerSide === 'both'
      ? 'neither leg qualifies — the two-sided score is 0'
      : `the ${weakerSide} leg does not qualify — the two-sided score (Q_min) collapses to the weaker side; the $/day shown is the degraded case`;
  return { valid: both, degraded, both, bid: bidV, ask: askV, weakerSide, reasons, note };
}

module.exports = { validateQuote, validateQuotePair, isOnTick, rulesReadable, CODES };
