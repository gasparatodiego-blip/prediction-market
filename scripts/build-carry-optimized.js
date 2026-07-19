#!/usr/bin/env node
/**
 * Build data/carry-optimized.json from the live basis feed, the persisted walkable
 * ladders and the official public fee schedules, then print the ranked venue
 * comparison for inspection.
 *
 * Offline/read-only: reads /tmp/basis-opportunities.json, /tmp/basis-books.json and
 * data/venue-fees-official.json; writes only data/carry-optimized.json. No agent or
 * route wiring, no trading.
 *
 *   node scripts/build-carry-optimized.js            # build + summary
 *   node scripts/build-carry-optimized.js BTC 2027-06-25   # build + full detail for one opportunity
 */

const fs = require('fs');
const path = require('path');
const { buildOptimized } = require('../lib/carry-optimize');

const OUT = path.join(__dirname, '..', 'data', 'carry-optimized.json');

const pc  = (v, d = 2) => (v == null ? '—' : (v * 100).toFixed(d) + '%');
const pct = (v, d = 2) => (v == null ? '—' : v.toFixed(d) + '%');
const sgn = (v, d = 2) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(d) + '%');
const usd = v => (v == null ? '—' : '$' + Math.round(v).toLocaleString());

const doc = buildOptimized();
fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n');

console.log(`basis @ ${doc.sourceUpdatedAt} | books @ ${doc.booksGeneratedAt} | fees @ ${doc.feesGeneratedAt}`);
console.log(`opportunities ${doc.counts.opportunities} | venue options ${doc.counts.venueOptions} `
          + `| measured capacity ${doc.counts.withMeasuredCapacity} | fee-verified ${doc.counts.feeVerifiedOptions} `
          + `| beat risk-free ${doc.counts.beatRiskFree}`);
console.log(`invariant violations (exec > indicative): ${doc.invariantViolations.length}`);

console.log('\n=== BEST VENUE PER OPPORTUNITY ===');
console.log('ASSET | EXPIRY     | days | venues | BEST VENUE       | net ann | vs risk-free | capacity');
for (const g of doc.opportunities) {
  const b = g.best;
  console.log([
    g.asset.padEnd(5), g.expiry, String(g.daysToExpiry).padStart(4),
    String(g.venueCount).padStart(6),
    (b ? b.venue : '—').padEnd(16),
    pct(b && b.netAnnualizedPct).padStart(7),
    sgn(b && b.riskFreeDeltaPct).padStart(12),
    usd(b && b.capacityUsd).padStart(9),
  ].join(' | '));
}

// Full detail for one opportunity — the check-4 view.
const [asset, expiry] = process.argv.slice(2);
const target = asset
  ? doc.opportunities.find(g => g.asset === asset && (!expiry || g.expiry === expiry))
  : doc.opportunities[0];

if (target) {
  console.log(`\n=== FULL RANKED VENUE COMPARISON — ${target.asset} ${target.expiry} `
            + `(${target.daysToExpiry}d, ${target.venueCount} venues) ===`);
  for (const [i, o] of target.options.entries()) {
    console.log(`\n${i === 0 ? '>> BEST' : '   #' + (i + 1)}  ${o.venue}  ${o.contract}`);
    // Single-venue rows carry no comparable indicative (they price off a different spot
    // book), so the invariant is N/A there rather than violated.
    const inv = o.indicativeBasisPct == null
      ? 'n/a — ' + (o.invariantNote || 'no comparable indicative')
      : (o.executableBasisPct <= o.indicativeBasisPct ? 'OK' : 'VIOLATED');
    console.log(`   exec basis   ${pc(o.executableBasisPct)}  (indicative ${pc(o.indicativeBasisPct)}, `
              + `invariant exec<=indic ${inv})`);
    console.log(`   prices       spotAsk ${o.spotAsk} / futureBid ${o.futureBid}   [${o.priceBasis}]`);
    console.log(`   fees         ${pc(o.feePct, 3)} total | verified ${o.feeVerified} `
              + `| official fraction ${o.feeOfficialFraction == null ? '—' : (o.feeOfficialFraction * 100).toFixed(0) + '%'}`);
    for (const l of o.feeLegs) {
      console.log(`                - ${l.label} (${l.venue}) ${pc(l.pct, 3)} [${l.provenance}]`
                + (l.officialPct != null ? ` official=${l.officialPct} match=${l.matchesOfficial}` : ''));
    }
    console.log(`   net carry    ${pc(o.netCarryPct)} over ${o.daysToExpiry}d`);
    console.log(`   net annual   ${pct(o.netAnnualizedPct)}${o.netAnnualizedCapped ? '  [' + o.netAnnualizedLabel + ']' : ''}`);
    console.log(`   RISK-FREE Δ  ${sgn(o.riskFreeDeltaPct)}  (vs ${o.riskFreePct}%/yr) `
              + `-> ${o.beatsRiskFree ? 'BEATS risk-free' : 'BELOW risk-free'}`);
    console.log(`   capacity     ${usd(o.capacityUsd)} [${o.capacitySource}] `
              + `ladder ${o.capacityLadderKey || '—'} (${o.capacityLadderLevels ?? '—'} levels), `
              + `spot ${o.spotLadderKey || '—'} (${o.spotLadderLevels ?? '—'} levels)`);
    console.log(`   tier         ${o.tier}${o.thinFlag && o.tier !== 'THIN' ? ' (thin)' : ''}`
              + `${o.coinMargined ? ' | ' + o.coinMarginedNote : ''}`);
    console.log(`   route        ${o.routeType}`);
    const sv = o.singleVenueAlternative;
    if (sv) {
      console.log(`   single-venue ${sv.available} | fee ${sv.feePct == null ? 'UNKNOWN' : pc(sv.feePct, 3)} `
                + `| verified ${sv.feeVerified} | capacity ${sv.capacityUsd == null ? 'UNKNOWN' : usd(sv.capacityUsd)}`);
    }
  }
  if (target.spreadBetweenVenuesPct != null) {
    console.log(`\n   venue spread (best - worst, sizable only): ${pct(target.spreadBetweenVenuesPct)}/yr`);
  }
}

console.log('\nLIMITATIONS');
for (const l of doc.limitations) console.log('  - ' + l);
console.log(`\nwrote ${path.relative(process.cwd(), OUT)}`);
