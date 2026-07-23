'use strict';

/**
 * sport-arb-math — the SINGLE source of truth for sports cross-venue arb math.
 *
 * Imported by BOTH:
 *   - agents/agent33-sport-recorder.js  (the 24/7 recorder, CommonJS)
 *   - app/api/sport-arb/live/route.ts   (the dashboard API, TS via allowJs)
 *
 * One math, one fee model, one staleness rule. If these ever diverged, the number the
 * recorder wrote to disk and the number the dashboard rendered would disagree — which is
 * exactly the class of bug the honest engine exists to prevent.
 *
 * HONEST-ENGINE INVARIANTS ENCODED HERE
 * ------------------------------------
 *  1. net = after ALL fees. Exchange commission applies to net winnings; prediction
 *     venues charge on cost. There is no "gross" headline anywhere downstream.
 *  2. A crossing is netArbSum < 1.00 — never a gross sum.
 *  3. Max stake = walkable book depth on the THINNER leg only, share-weighted. Never
 *     open interest, never a heuristic. Missing depth → null + sizeUnverifiable, so the
 *     UI renders "—" rather than an invented size.
 *  4. STALENESS IS THE ONLY HARD EXCLUSION. odds-api stops re-capturing fixed-odds books
 *     at kickoff (measured 4.3–5.1h old lines served in-play, still is_available:true).
 *     Pairing one against a live leg manufactures huge fake edge — a frozen NPB book vs a
 *     live Kalshi book scored net 0.81975, an apparent 18% "arb" that was pure staleness.
 *     Any crossing with a leg older than MAX_AGE_SEC is a PHANTOM and is never an arb.
 *  5. Jurisdiction is a TAG, never a filter. Short-lived crossings are KEPT and tagged.
 *  6. Never pair different market types (moneyline vs spread/totals/props). Polymarket
 *     lists spread and prop markets whose outcomes are the SAME two team names; pairing
 *     one against a moneyline leg fabricated a 34% arb in testing.
 */

const EXCHANGES = new Set(['betfair', 'betdaq', 'smarkets', 'matchbook']);

const EXCHANGE_COMMISSION = 0.02;                 // betfair et al — 2% on net winnings
const kalshiFee   = p => 0.07 * p * (1 - p);      // Kalshi published taker fee
// Polymarket taker fee is NOT a hardcoded guess anymore. It is the live, per-market value from the SSOT
// (lib/polymarket-fees.js): fraction = (base_fee/20000)·(1−p), read from GET /fee-rate. The caller must
// attach the market's base_fee (bps) to each polymarket row as `polyBaseFeeBps` (it has the token id);
// when it is unknown the fee is null and that leg is honestly NON-CASHABLE ("—"), never a guessed rate.
// (The old POLY_TAKER = 0.01 / "1% assumed pending confirmation" was removed — no flat Polymarket fee
//  exists under CLOB v2; fees are taker-only and per-market.)
const { takerFeeFractionFromBps } = require('./polymarket-fees');

const MAX_AGE_SEC     = 90;   // a leg older than this is NOT live → phantom
const SHORT_LIVED_SEC = 30;   // shown, but tagged execution-speed-critical

// ── THREE-WAY MARKETS & DRAW DETECTION ──────────────────────────────────────────
// Some sports resolve to THREE outcomes — home win / away win / DRAW (soccer). The draw
// contract is a distinct third leg: Kalshi labels it "Tie", odds-api books label it "X".
// Two failures fabricate huge fake edge here, both observed in data/sport-arb-history.jsonl:
//   (1) MISLABEL — a "Tie" contract whose name matches neither team was assigned outcome
//       'home' (teamMatch("Tie",home)=0 >= teamMatch("Tie",away)=0 → true) and then paired
//       against a real away leg, e.g. Kalshi Tie@0.28 + book away@0.42 → a bogus 40% "arb".
//   (2) TWO-OF-THREE — even correctly-labeled, covering only home+away of a three-outcome
//       market leaves the draw uncovered, so the two-leg sum understates the real cost.
// Therefore: a draw leg is NEVER a home/away candidate, and a three-way market is only an
// arb when all three legs are present with costs summing < 1. With two legs it is
// INCOMPLETE_MARKET — excluded, never summed. (A validated three-leg path can be added when
// all three legs are reliably captured cross-venue; today they are not, so we exclude.)
const THREE_WAY_SPORTS = new Set(['soccer']);
const DRAW_NAMES = /^(tie|draw|x|empate|nul|nulle|unentschieden|par|remis)$/i;
function isDrawName(name) { return DRAW_NAMES.test(String(name == null ? '' : name).trim()); }
/** A leg is a draw/tie contract — by explicit outcome or by its selection name. */
function isDrawLeg(row) { return row.outcome === 'draw' || isDrawName(row.team); }

// ── PER-VENUE FRESHNESS ─────────────────────────────────────────────────────────
// Prediction venues (Kalshi/Polymarket) are read from a live CLOB orderbook every 45s, so
// age is 0 by construction — MAX_AGE_SEC (90s) is a generous live bound for them.
//
// Fixed-odds BOOKS are different: odds-api's Starter plan FREEZES them at kickoff, and even
// pre-kickoff they re-quote slowly. Measured over data/sport-raw: genuine intra-session book
// source_ts advances have p50 130s and NONE occur faster than ~60s. A frozen line still reads
// ~80s old for the poll right after its last update — which is exactly how 80–88s book legs
// slipped past the old flat 90s gate and produced 25–30% phantom "arbs". Two defences:
//   1. BOOK_MAX_AGE_SEC = 60 — derived from the observed re-quote floor (>60s): a book quote
//      older than 60s cannot be assumed to reflect a live re-quote. Tighter than the 90s that
//      admitted the artifacts, and it does not touch prediction legs (gated separately).
//   2. FROZEN flag — authoritative. Age ALONE cannot tell a genuinely fast-re-quoting book
//      (rare, ~80s old) from one that updated once and froze (also ~80s old): both read the
//      same. The recorder sets row.frozen=true when a book's source_ts has not advanced since
//      the previous poll; a frozen quote is never live regardless of its computed age.
const BOOK_MAX_AGE_SEC = 60;

function legAgeLimit(row) {
  return row.source_type === 'prediction' ? MAX_AGE_SEC : BOOK_MAX_AGE_SEC;
}
/** A leg is live iff fresh for its venue class AND not a frozen (non-advancing) quote. */
function isLegLive(row) {
  if (row.frozen === true) return false;
  const age = row.age_sec;
  if (age == null || !Number.isFinite(age)) return false;
  return age <= legAgeLimit(row);
}

/**
 * Cost of covering one outcome for $1/€1 of payout, net of that venue's fee.
 * @returns {number|null} null when the row carries no usable price.
 */
function netCost(row) {
  if (row.source_type === 'prediction') {
    if (row.price == null) return null;
    if (row.source === 'kalshi')     return row.price + kalshiFee(row.price);
    if (row.source === 'polymarket') {
      // Real per-market taker fee from the live base_fee the caller attached. Cost to cover $1 of payout
      // = price · (1 + feeFraction), feeFraction = (base_fee/20000)·(1−price). Unknown base_fee → null:
      // an honest "—", never a guessed fee — the leg simply cannot be confirmed cashable.
      const feeFraction = takerFeeFractionFromBps(row.polyBaseFeeBps, row.price);
      if (feeFraction == null) return null;
      return row.price * (1 + feeFraction);
    }
    return row.price;
  }
  if (row.odds == null || row.odds <= 1) return null;
  const eff = EXCHANGES.has(row.source)
    ? 1 + (row.odds - 1) * (1 - EXCHANGE_COMMISSION)
    : row.odds;                                   // fixed-odds books: vig already in the price
  return 1 / eff;
}

/**
 * Executable size for one leg, expressed as the payout it can absorb.
 * @returns {number|null} null when the venue publishes no depth — fixed-odds books never
 *   do. null must propagate to "size unverifiable"; never substitute OI or a guess.
 */
function legCapacity(row) {
  if (row.source === 'kalshi' || row.source === 'polymarket') {
    return row.best_ask_size != null ? Number(row.best_ask_size) : null;
  }
  const back = row.depth_levels && row.depth_levels.back;
  if (back && back[0] && back[0][1] != null) return Number(back[0][1]);
  return null;
}

/** Jurisdiction/venue tags. Descriptive only — callers must never filter on these. */
function jurisdictionTag(h, a) {
  const tags = [];
  for (const r of [h, a]) {
    if (r.source === 'kalshi')     tags.push('kalshi:us-cftc');
    if (r.source === 'polymarket') tags.push(r.accepting_orders === false ? 'polymarket:close-only' : 'polymarket:openable');
    if (EXCHANGES.has(r.source))   tags.push(`${r.source}:exchange-uk-au-eu`);
    if (r.source_type === 'book')  tags.push(`${r.source}:sportsbook-ban-risk`);
  }
  return { tags, openableBoth: !tags.some(t => t.includes('close-only')) };
}

/**
 * Detect cross-venue crossings in one poll's rows.
 * @param {Array} rows  raw rows for ONE poll (any number of events)
 * @param {number} ts   poll timestamp (ms)
 * @returns {{real: Array, phantom: Array}}  real = both legs live; phantom = a stale leg.
 */
function detectArbs(rows, ts) {
  const byEvent = new Map();
  for (const r of rows) {
    if (!byEvent.has(r.event_key)) byEvent.set(r.event_key, []);
    byEvent.get(r.event_key).push(r);
  }
  const real = [], phantom = [], incomplete = [];

  for (const [key, evRows] of byEvent) {
    // Only ever pair like-for-like markets — makes spread-vs-moneyline impossible.
    const ml   = evRows.filter(r => r.market === 'moneyline');

    // THREE-WAY GUARD — a market with a draw outcome (soccer, or any event carrying a draw
    // leg) cannot be covered by two legs. Do NOT sum home+away for it: that ignores the draw
    // and fabricates edge. Record it as INCOMPLETE_MARKET and move on, never as an arb.
    const sport    = ml.length ? ml[0].sport : (evRows[0] && evRows[0].sport);
    const threeWay = THREE_WAY_SPORTS.has(sport) || ml.some(isDrawLeg);
    if (threeWay) {
      incomplete.push({
        ts, event_key: key, sport: sport ?? null, league: ml.length ? ml[0].league : null,
        reason: 'INCOMPLETE_MARKET: three-way market (draw outcome) cannot be arbitraged with two legs',
      });
      continue;
    }

    // Two-way: draw legs are never eligible as home/away (defensive — should not occur here).
    const home = ml.filter(r => r.outcome === 'home' && !isDrawLeg(r) && netCost(r) != null);
    const away = ml.filter(r => r.outcome === 'away' && !isDrawLeg(r) && netCost(r) != null);
    if (!home.length || !away.length) continue;

    for (const h of home) for (const a of away) {
      if (h.source === a.source) continue;                 // cross-venue only
      const ch = netCost(h), ca = netCost(a);
      const net = ch + ca;
      if (!(net < 1)) continue;

      const gh = h.price ?? (h.odds ? 1 / h.odds : null);
      const ga = a.price ?? (a.odds ? 1 / a.odds : null);
      const gross  = gh != null && ga != null ? gh + ga : null;
      const maxAge = Math.max(h.age_sec ?? Infinity, a.age_sec ?? Infinity);
      // Liveness is recomputed per-venue here (NOT trusting the row's own is_live), so a
      // frozen or over-age book leg is a phantom even if it was flagged live upstream.
      const hLive = isLegLive(h), aLive = isLegLive(a);
      const stale = !(hLive && aLive);

      // Each leg funds its own share of the book (share = its net cost / arbSum), so the
      // total stake is bounded by min over legs of capacity/share — the THINNER leg binds.
      const capH = legCapacity(h), capA = legCapacity(a);
      let maxStake = null, bindingLeg = null, sizeUnverifiable = true;
      if (capH != null && capA != null) {
        const totH = capH / (ch / net), totA = capA / (ca / net);
        maxStake = +Math.min(totH, totA).toFixed(2);
        bindingLeg = totH <= totA ? h.source : a.source;
        sizeUnverifiable = false;
      }

      const rec = {
        ts, event_key: key, sport: h.sport, league: h.league, home: h.home, away: h.away,
        legs: [
          { outcome: 'home', source: h.source, source_type: h.source_type, team: h.team,
            odds: h.odds ?? null, price: h.price ?? null, netCost: +ch.toFixed(5),
            age_sec: h.age_sec ?? null, is_live: hLive, frozen: h.frozen === true, capacity: capH },
          { outcome: 'away', source: a.source, source_type: a.source_type, team: a.team,
            odds: a.odds ?? null, price: a.price ?? null, netCost: +ca.toFixed(5),
            age_sec: a.age_sec ?? null, is_live: aLive, frozen: a.frozen === true, capacity: capA },
        ],
        grossArbSum: gross != null ? +gross.toFixed(5) : null,
        netArbSum:   +net.toFixed(5),
        netProfitPct: +(((1 - net) / net) * 100).toFixed(4),
        maxStake, bindingLeg, sizeUnverifiable,
        maxLegAgeSec: Number.isFinite(maxAge) ? maxAge : null,
        jurisdiction: jurisdictionTag(h, a),
        feeModel: {
          exchangeCommissionPct: EXCHANGE_COMMISSION * 100,
          kalshi: '0.07*P*(1-P)',
          polymarket: 'live per-market taker fee (base_fee/20000)*(1-P) — SSOT lib/polymarket-fees.js; "—" when base_fee unknown',
        },
      };

      if (stale) {
        const frozenLeg = h.frozen === true || a.frozen === true;
        rec.phantomReason = frozenLeg
          ? 'frozen quote: a book leg\'s source_ts has not advanced across polls (NOT cashable)'
          : `stale leg: max age ${Number.isFinite(maxAge) ? maxAge + 's' : 'unknown'} exceeds venue live bound `
            + `(book ${BOOK_MAX_AGE_SEC}s / prediction ${MAX_AGE_SEC}s) (NOT cashable)`;
        phantom.push(rec);
      } else {
        real.push(rec);
      }
    }
  }
  return { real, phantom, incomplete };
}

module.exports = {
  EXCHANGES, EXCHANGE_COMMISSION, kalshiFee,
  MAX_AGE_SEC, SHORT_LIVED_SEC, BOOK_MAX_AGE_SEC, THREE_WAY_SPORTS,
  netCost, legCapacity, jurisdictionTag, detectArbs, isDrawName, isDrawLeg, isLegLive,
};
