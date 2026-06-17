'use strict';

// ── Deterministic arb engine ──────────────────────────────────────────────────
// Pure function: takes an array of NormalizedEvent (from any OddsRetriever),
// returns arb opportunities sorted descending by net margin.
// No I/O, no external state — safe to unit-test in isolation.

const MAX_ODDS_AGE_MS  = 30 * 60_000;  // warn stale if odds older than 30 min
const DROP_STARTED_H   = 2;            // drop events that started > 2h ago

function detectArbs(events) {
  const now  = Date.now();
  const arbs = [];

  for (const ev of events) {
    if (!ev.bookmakers?.length) continue;

    const commenceMs = new Date(ev.commenceTime).getTime();
    // Drop events that have already started (with small grace period) or far past
    if (commenceMs < now - DROP_STARTED_H * 3_600_000) continue;

    // ── Best decimal odds per outcome across all books ────────────────────────
    const best = {};  // outcomeName → { price, bookmaker, bookmakerId }
    for (const bk of ev.bookmakers) {
      for (const oc of bk.outcomes) {
        if (!oc.price || oc.price <= 1) continue;
        const prev = best[oc.name];
        if (!prev || oc.price > prev.price) {
          best[oc.name] = { price: oc.price, bookmaker: bk.title, bookmakerId: bk.key };
        }
      }
    }

    const outcomes = Object.keys(best);
    if (outcomes.length < 2) continue;

    // ── Implied probability and gross margin ──────────────────────────────────
    const impliedSum  = outcomes.reduce((s, n) => s + 1 / best[n].price, 0);
    if (impliedSum >= 1) continue;  // no arb
    const grossMargin = (1 - impliedSum) * 100;

    // Sports arb has no explicit broker fee (the overround is bypassed by using
    // best odds across different books). Actual ROI = profit / staked capital.
    // payout = 100 / impliedSum, profit = payout - 100, roi = profit / 100.
    // grossMargin = (1 - impliedSum) × 100 is the signal detection number.
    // netMargin   = (1/impliedSum - 1) × 100 is the actual return on $100 staked.
    const netMargin = (1 / impliedSum - 1) * 100;

    // ── Optimal stake split for equalized payout on $100 bankroll ────────────
    const legs = outcomes.map(n => ({
      outcome:     n,
      bookmaker:   best[n].bookmaker,
      bookmakerId: best[n].bookmakerId,
      odds:        best[n].price,
      impliedProb: Math.round((1 / best[n].price) * 10000) / 100,
      stake:       Math.round((1 / best[n].price / impliedSum) * 100 * 100) / 100,
      // Payout for this leg if this outcome wins:
      payout:      Math.round((1 / best[n].price / impliedSum) * 100 * best[n].price * 100) / 100,
    }));

    // All legs pay the same (equalized), prove it:
    // payout = stake × odds = (1/p_i / impliedSum) × 100 × odds_i = 1/impliedSum × 100

    const oddsAgeMs = now - (ev.fetchedAt ?? 0);
    const isStale   = oddsAgeMs > MAX_ODDS_AGE_MS;

    arbs.push({
      eventId:      ev.eventId,
      sport:        ev.sport,
      homeTeam:     ev.homeTeam,
      awayTeam:     ev.awayTeam,
      commenceTime: ev.commenceTime,
      legs,
      impliedSum:   Math.round(impliedSum * 10000) / 10000,
      grossMargin:  Math.round(grossMargin * 100) / 100,
      netMargin:    Math.round(netMargin * 100) / 100,
      fetchedAt:    ev.fetchedAt,
      oddsAgeMs,
      isStale,
    });
  }

  arbs.sort((a, b) => b.netMargin - a.netMargin);
  return arbs;
}

module.exports = { detectArbs };
