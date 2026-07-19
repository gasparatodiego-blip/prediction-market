/**
 * Cash & carry VENUE-OPTIMIZATION ENGINE.
 *
 * For each opportunity (coin + expiry), rank every venue that lists that dated
 * future by what actually matters to an executable carry:
 *   - richest EXECUTABLE basis  (long spot @ ask, short future @ bid — never midpoint)
 *   - lowest real fees          (official public schedules where they exist; labelled where they don't)
 *   - deepest real capacity     (walked order-book ladder — never open interest)
 * and show the honest delta against the risk-free rate, which is allowed to be negative.
 *
 * ── FEE HONESTY, THE CENTRAL CONSTRAINT ─────────────────────────────────────
 * Only Deribit publishes trading fees on an unauthenticated endpoint. OKX, Binance
 * and Bybit gate their schedules behind auth (proven, with verbatim rejections, in
 * data/venue-fees-official.json). The engine therefore tracks provenance PER FEE LEG:
 *
 *   OFFICIAL_PUBLIC_API — fetched this run from the venue's public endpoint
 *   PROJECT_CONSTANT    — agent19's FEES table: documented in-repo and per-leg, but
 *                         NOT verifiable against a public API without an account
 *
 * A venue is `feeVerified` only when EVERY leg is OFFICIAL_PUBLIC_API. Because the
 * live engine prices the spot leg on Binance (auth-gated), no two-venue route is
 * fully fee-verified today. That is reported, not hidden, and it means the
 * cross-venue "cheapest fees" ranking is directional rather than proven.
 *
 * ── SINGLE-VENUE VS TWO-VENUE ───────────────────────────────────────────────
 * Classic cash & carry wants spot and future in one account. The live engine prices
 * every route with Binance spot, which makes them all two-venue: capital split
 * across exchanges, no cross-margin, transfer latency between legs. Where a venue
 * also lists spot, a single-venue route is surfaced as an ALTERNATIVE — but only
 * with capacity UNKNOWN, because we hold no walked ladder for that venue's spot book
 * and will not size a leg we have not measured.
 *
 * Fail-closed: any field not traceable to real data is null/UNKNOWN, never inferred.
 */

const fs = require('fs');
const path = require('path');

const BASIS_FILE = '/tmp/basis-opportunities.json';
const BOOKS_FILE = '/tmp/basis-books.json';
const FEES_FILE  = path.join(__dirname, '..', 'data', 'venue-fees-official.json');

// Risk-free benchmark. Shown transparently so the user can judge a delta-neutral
// carry against simply holding cash.
const RISK_FREE_PCT = 4.0;

/**
 * APY_CAP has exactly one source of truth: lib/honest-display.ts. Commit 0bce799
 * removed a local duplicate of it, so this reads the value out of that file rather
 * than re-declaring the literal. Throws if it cannot be parsed — a silently wrong
 * cap is worse than a hard failure.
 */
function loadApyCap() {
  const src = fs.readFileSync(path.join(__dirname, 'honest-display.ts'), 'utf8');
  const cap = src.match(/export const APY_CAP\s*=\s*([\d.]+)/);
  const label = src.match(/export const APY_CAP_LABEL\s*=\s*'([^']+)'/);
  if (!cap) throw new Error('APY_CAP not parseable from lib/honest-display.ts — refusing to guess');
  return { APY_CAP: Number(cap[1]), APY_CAP_LABEL: label ? label[1] : '>cap · run-rate, not guaranteed' };
}

const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));

/**
 * Resolve the fee for one route into per-leg provenance.
 * `feeLegs` comes from agent19 and already sums exactly to its FEES[venueKey].
 * We re-source each leg against the official fetch where that is possible.
 */
function resolveFees(opp, official) {
  const legs = (opp.feeLegs || []).map(l => {
    const label = String(l.label || '');
    let venue = 'Binance', provenance = 'PROJECT_CONSTANT', officialPct = null;

    if (/spot/i.test(label)) {
      // Live engine prices both spot legs on Binance, whose fees are auth-gated.
      venue = 'Binance';
      provenance = 'PROJECT_CONSTANT';
    } else {
      venue = opp.exchange;
      // Deribit is the one venue with a public per-instrument schedule.
      if (opp.venueKey === 'DERIBIT') {
        const rec = official.venues.DERIBIT.datedFutures.perInstrument[opp.contract];
        if (rec && rec.status === 'OK' && Number.isFinite(rec.takerFee)) {
          officialPct = rec.takerFee;
          provenance = 'OFFICIAL_PUBLIC_API';
        }
      } else if (opp.venueKey === 'BYBIT' && /delivery/i.test(label)) {
        const rec = official.venues.BYBIT.datedFutures.perInstrument[opp.contract];
        if (rec && Number.isFinite(rec.deliveryFeeRate)) {
          officialPct = rec.deliveryFeeRate;
          provenance = 'OFFICIAL_PUBLIC_API';
        }
      }
    }
    return {
      label, venue, pct: l.pct,
      provenance,
      officialPct,
      // Where the official number contradicts the project constant, say so loudly.
      matchesOfficial: officialPct == null ? null : Math.abs(officialPct - l.pct) < 1e-9,
    };
  });

  const total = legs.reduce((s, l) => s + (l.pct || 0), 0);
  const officialPortion = legs.filter(l => l.provenance === 'OFFICIAL_PUBLIC_API')
                              .reduce((s, l) => s + (l.pct || 0), 0);
  return {
    feePct: total,
    feeLegs: legs,
    feeVerified: legs.length > 0 && legs.every(l => l.provenance === 'OFFICIAL_PUBLIC_API'),
    feeOfficialFraction: total > 0 ? officialPortion / total : null,
    feeNote: legs.every(l => l.provenance === 'OFFICIAL_PUBLIC_API')
      ? 'Every leg sourced from an official public endpoint.'
      : 'Spot legs price on Binance, whose fee schedule is auth-gated — not publicly verifiable. '
      + 'Total is directional, not proven.',
  };
}

/** Single-venue alternative: spot + future in one account, where the venue lists spot. */
function singleVenueRoute(opp, official) {
  const v = official.venues[opp.venueKey === 'USDTM' || opp.venueKey === 'COINM' ? 'BINANCE' : opp.venueKey];
  if (!v || !v.hasSpotMarket) return null;

  // Deribit is the only venue whose spot AND futures fees are both public, so it is
  // the only one where a single-venue route can be fee-priced at all.
  if (opp.venueKey !== 'DERIBIT') {
    return {
      available: 'POSSIBLE', feePct: null, feeVerified: false,
      capacityUsd: null, capacitySource: 'UNKNOWN',
      note: `${v.venue} lists spot alongside the dated future, so a single-account carry is possible, `
          + 'but its spot fees are auth-gated and we hold no walked ladder for its spot book. '
          + 'Neither fee nor capacity can be stated honestly.',
    };
  }
  const fut = official.venues.DERIBIT.datedFutures.perInstrument[opp.contract];
  const spot = official.venues.DERIBIT.spot;
  if (!fut || fut.status !== 'OK' || !spot || spot.status !== 'OK') return null;

  const feePct = spot.takerFee * 2 + fut.takerFee; // spot open + spot close + futures taker
  return {
    available: 'POSSIBLE',
    feePct, feeVerified: true,
    feeLegs: [
      { label: 'Deribit spot open',  venue: 'Deribit', pct: spot.takerFee, provenance: 'OFFICIAL_PUBLIC_API' },
      { label: 'Deribit futures',    venue: 'Deribit', pct: fut.takerFee,  provenance: 'OFFICIAL_PUBLIC_API' },
      { label: 'Deribit spot close', venue: 'Deribit', pct: spot.takerFee, provenance: 'OFFICIAL_PUBLIC_API' },
    ],
    capacityUsd: null,
    capacitySource: 'UNKNOWN',
    note: 'Fees fully sourced from Deribit public endpoints and materially cheaper than the two-venue route, '
        + 'but CAPACITY IS UNKNOWN: no walked ladder exists for Deribit spot, whose book is far thinner than '
        + 'Binance. Not ranked against measured routes until that book is walked.',
  };
}

function buildOptimized() {
  const { APY_CAP, APY_CAP_LABEL } = loadApyCap();
  const basis    = readJson(BASIS_FILE);
  const booksDoc = readJson(BOOKS_FILE);
  const official = readJson(FEES_FILE);
  const books    = booksDoc.books || {};

  const invariantViolations = [];
  const groups = new Map();

  for (const opp of basis.opportunities || []) {
    // ── Executable-only guard. Executable basis must come from bid/ask, and must
    // never exceed the indicative (midpoint) basis — midpoint flatters by
    // construction, so exec > indicative means a pricing bug, not an opportunity.
    const exec = opp.executableBasisPct;
    const indic = opp.indicativeBasisPct;
    if (!Number.isFinite(exec) || !Number.isFinite(indic)) continue;
    if (exec > indic + 1e-12) {
      invariantViolations.push({ contract: opp.contract, venue: opp.exchange, exec, indic });
      continue; // fail closed — drop rather than ship an impossible edge
    }

    // ── Capacity must trace to a walked ladder. Never OI, never a proxy.
    const ladderKey = `${opp.venueKey}|${opp.contract}`;
    const spotKey   = `SPOT|${opp.asset}`;
    const futBook   = books[ladderKey];
    const spotBook  = books[spotKey];
    const capacityOk = opp.capacitySource === 'book'
                    && Number.isFinite(opp.capacityUsd) && opp.capacityUsd > 0
                    && futBook && Array.isArray(futBook.bids) && futBook.bids.length > 0;

    const fees = resolveFees(opp, official);
    const netCarryPct = exec - fees.feePct;
    const days = opp.daysToExpiry;
    const netAnnualizedPct = days > 0 ? (netCarryPct * 365 / days) * 100 : null;
    const overCap = netAnnualizedPct != null && netAnnualizedPct > APY_CAP;

    const option = {
      venue: opp.exchange,
      venueKey: opp.venueKey,
      contract: opp.contract,
      daysToExpiry: days,

      // executable prices only — recorded so any number here can be re-derived
      spotAsk: opp.spotAsk,
      futureBid: opp.futureBid,
      priceBasis: 'EXECUTABLE (long spot @ ask, short future @ bid)',
      executableBasisPct: exec,
      indicativeBasisPct: indic,
      invariantExecLeIndicative: true,

      ...fees,
      netCarryPct,
      netAnnualizedPct: overCap ? APY_CAP : netAnnualizedPct,
      netAnnualizedRaw: netAnnualizedPct,
      netAnnualizedCapped: overCap,
      netAnnualizedLabel: overCap ? APY_CAP_LABEL : null,

      // honest comparison to doing nothing — negative is a real, shown answer
      riskFreePct: RISK_FREE_PCT,
      riskFreeDeltaPct: netAnnualizedPct == null ? null : netAnnualizedPct - RISK_FREE_PCT,
      beatsRiskFree: netAnnualizedPct == null ? null : netAnnualizedPct > RISK_FREE_PCT,

      capacityUsd: capacityOk ? opp.capacityUsd : null,
      capacitySource: capacityOk ? 'book' : 'UNKNOWN',
      capacityLadderKey: capacityOk ? ladderKey : null,
      capacityLadderLevels: futBook && futBook.bids ? futBook.bids.length : null,
      spotLadderKey: spotBook ? spotKey : null,
      spotLadderLevels: spotBook && spotBook.asks ? spotBook.asks.length : null,
      capacityNote: capacityOk ? null : 'No walked ladder — capacity not stated.',

      tier: opp.tier || null,
      thinFlag: !!opp.thinFlag,
      coinMargined: !!opp.coinMargined,
      coinMarginedNote: opp.coinMargined
        ? 'Coin-settled: the carry is locked in coin, not USD.' : null,

      routeType: 'TWO_VENUE',
      routeNote: 'Spot leg prices on Binance; future on the listed venue. Capital sits on two exchanges, '
               + 'no cross-margin between legs.',
      singleVenueAlternative: singleVenueRoute(opp, official),
    };

    const gk = `${opp.asset}|${opp.expiry}`;
    if (!groups.has(gk)) {
      groups.set(gk, { key: gk, asset: opp.asset, expiry: opp.expiry, daysToExpiry: days, options: [] });
    }
    groups.get(gk).options.push(option);
  }

  // ── Rank. Primary key is net annualized carry after fees. Options with no
  // measured capacity cannot be "best" — an unsizable edge is not executable —
  // so they sort last regardless of headline rate.
  const opportunities = [...groups.values()].map(g => {
    g.options.sort((a, b) => {
      const aOk = a.capacityUsd != null, bOk = b.capacityUsd != null;
      if (aOk !== bOk) return aOk ? -1 : 1;
      return (b.netAnnualizedRaw ?? 0) - (a.netAnnualizedRaw ?? 0);
    });
    const best = g.options[0] || null;
    const sizable = g.options.filter(o => o.capacityUsd != null);
    return {
      ...g,
      venueCount: g.options.length,
      best: best ? {
        venue: best.venue, contract: best.contract,
        netAnnualizedPct: best.netAnnualizedPct,
        riskFreeDeltaPct: best.riskFreeDeltaPct,
        capacityUsd: best.capacityUsd,
        feeVerified: best.feeVerified,
        why: best.capacityUsd == null
          ? 'Highest net carry available, but no measured capacity.'
          : `Highest net carry after fees among ${sizable.length} venue(s) with measured book capacity.`,
      } : null,
      spreadBetweenVenuesPct: sizable.length > 1
        ? sizable[0].netAnnualizedRaw - sizable[sizable.length - 1].netAnnualizedRaw : null,
      options: g.options,
    };
  }).sort((a, b) => (b.best?.netAnnualizedPct ?? -1e9) - (a.best?.netAnnualizedPct ?? -1e9));

  return {
    generatedAt: new Date().toISOString(),
    sourceUpdatedAt: basis.updatedAt || null,
    booksGeneratedAt: booksDoc.generatedAt || null,
    feesGeneratedAt: official.generatedAt || null,
    riskFreePct: RISK_FREE_PCT,
    apyCap: APY_CAP,
    method: {
      pricing: 'EXECUTABLE ONLY — long spot at ask, short future at bid. Midpoint is never used for a shown carry.',
      invariant: 'executableBasisPct <= indicativeBasisPct, enforced per row; violations dropped, not clamped.',
      capacity: 'Walked order-book ladder only (capacitySource "book" + a present ladder). Open interest is never capacity.',
      fees: 'Per-leg provenance. OFFICIAL_PUBLIC_API where the venue publishes fees unauthenticated (Deribit only, '
          + 'plus Bybit delivery); PROJECT_CONSTANT otherwise. feeVerified requires every leg official.',
      ranking: 'Net annualized carry after fees. Options without measured capacity always sort last.',
      riskFree: `Delta against ${RISK_FREE_PCT}%/yr risk-free, shown signed — negative deltas are displayed, not hidden.`,
    },
    limitations: [
      'Only Deribit publishes fees on a public endpoint; OKX, Binance and Bybit maker/taker are auth-gated. '
      + 'Cross-venue fee ranking is therefore directional, not proven.',
      'Both spot legs price on Binance, so no two-venue route is fully fee-verified.',
      'Single-venue routes are surfaced but never ranked: no walked ladder exists for any venue-native spot book.',
      'Base-tier fees are the worst case; a real account may pay materially less.',
    ],
    invariantViolations,
    counts: {
      opportunities: opportunities.length,
      venueOptions: opportunities.reduce((s, g) => s + g.options.length, 0),
      withMeasuredCapacity: opportunities.reduce((s, g) => s + g.options.filter(o => o.capacityUsd != null).length, 0),
      feeVerifiedOptions: opportunities.reduce((s, g) => s + g.options.filter(o => o.feeVerified).length, 0),
      beatRiskFree: opportunities.reduce((s, g) => s + g.options.filter(o => o.beatsRiskFree).length, 0),
    },
    opportunities,
  };
}

module.exports = { buildOptimized, loadApyCap, RISK_FREE_PCT };
