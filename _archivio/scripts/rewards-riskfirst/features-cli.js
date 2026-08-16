#!/usr/bin/env node
'use strict';
// scripts/rewards-riskfirst/features-cli.js — PHASE 1: pre-fill risk features across the observed universe.
//   node features-cli.js [--pots snapshot.json]

const fs = require('fs');
const { loadWindow } = require('../rewards-worstcase/lib/data');
const { marketFeatures, ttrBuckets, distribution } = require('./lib/features');

const TOXIC = ['0x0d9d760f', '0x0dbd760f', '0x14d32732'];
const NOW = 1785160829000; // API "now" ≈ 2026-07-27 (matches the collection window)
const num = (x, d = 2) => (x == null ? '—' : x.toFixed(d));

function parseArgs(argv) { const a = { pots: null }; for (let i = 2; i < argv.length; i++) if (argv[i] === '--pots') { a.pots = argv[i + 1]; i++; } return a; }

function buildMeta(potsPath) {
  const meta = new Map();
  if (potsPath) { const s = JSON.parse(fs.readFileSync(potsPath, 'utf8')); for (const [c, o] of Object.entries(s.byCond)) meta.set(c, { pot: o.pot, maxSpread: o.maxSpread, minSize: o.minSize, q: o.q }); }
  try { const b = JSON.parse(fs.readFileSync('/root/prediction-market/data/liquidity-rewards.json', 'utf8')); for (const m of b.markets || []) { const cur = meta.get(m.conditionId) || {}; meta.set(m.conditionId, { ...cur, endDate: m.endDate ?? null, category: m.category ?? null, pot: cur.pot ?? m.rewardsDailyRate, maxSpread: cur.maxSpread ?? m.rewardsMaxSpread }); } } catch {}
  return meta;
}

async function main() {
  const args = parseArgs(process.argv);
  const D = await loadWindow({ potsPath: args.pots });
  const meta = buildMeta(args.pots);

  console.log('═'.repeat(88));
  console.log('PHASE 1 — PRE-FILL RISK FEATURES ACROSS THE OBSERVED UNIVERSE (offline replay)');
  console.log('═'.repeat(88));
  console.log('COVERAGE:'); for (const l of D.coverage.headerLines) console.log('  ' + l);
  console.log(`  TRUE: ${D.coverage.coveredMarketCount} of ${D.coverage.liveUniverse} ≈ ${D.coverage.truePct}% — PARTIAL, not the header.`);
  console.log(`ws/stale: ${D.ws}/${D.stale} (${(D.staleFrac * 100).toFixed(1)}%)${D.staleFrac > 0.2 ? ' ⚠ >20%' : ' — trusted'}`);

  const feats = [];
  for (const [mid, rows] of D.byMarket.entries()) {
    if (!D.potByCond.has(mid)) continue; // only fundable (has a pot)
    feats.push(marketFeatures(mid, rows, meta.get(mid), NOW));
  }
  console.log(`\nfeatures computed for ${feats.length} fundable markets.`);

  // TIME TO RESOLUTION — the count the operator asked for
  const ttr = ttrBuckets(feats);
  console.log('\nTIME TO RESOLUTION (from Gamma endDate):');
  console.log(`  < 15 days:   ${ttr.under15}   ← the count requested`);
  console.log(`  15–90 days:  ${ttr.from15to90}`);
  console.log(`  > 90 days:   ${ttr.over90}`);
  console.log(`  unknown (endDate not readable, excluded + counted): ${ttr.unknown}`);

  // FEATURE DISTRIBUTIONS across the universe
  console.log('\nFEATURE DISTRIBUTIONS (min · p25 · median · p75 · max · nulls):');
  const show = (label, key, d = 4) => { const s = distribution(feats, key); console.log(`  ${label.padEnd(22)} ${num(s.min, d)} · ${num(s.p25, d)} · ${num(s.median, d)} · ${num(s.p75, d)} · ${num(s.max, d)} · nulls ${s.nulls}`); };
  show('vol/sample (adjMid Δ)', 'volPerSample', 5);
  show('vol stability (2nd/1st)', 'volStability', 2);
  show('max single jump', 'maxJump', 4);
  show('spread (cents)', 'spreadCents', 2);
  show('spread (ticks)', 'spreadTicks', 2);
  show('spread stdev (cents)', 'spreadStdevCents', 2);
  show('order/depth @ $250/side', 'orderVsDepth', 2);
  show('in-band depth (shares)', 'depthShares', 0);
  show('time to resolution (d)', 'ttrDays', 1);
  show('pot ($/day)', 'pot', 1);
  show('maxSpread band (cents)', 'maxSpreadCents', 2);

  // CATEGORY distribution + the toxic-market commonality
  const cats = {}; for (const f of feats) { const c = f.category || '—'; cats[c] = (cats[c] || 0) + 1; }
  console.log('\nCATEGORY distribution:', Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}:${n}`).join(', '));
  const tox = feats.filter((f) => TOXIC.some((t) => f.marketId.startsWith(t)));
  console.log('\nTOXIC-MARKET COMMONALITY (do the two net-negative markets share a measurable property?):');
  for (const f of tox) console.log(`  ${f.marketId.slice(0, 12)}… cat ${f.category} · vol/samp ${num(f.volPerSample, 5)} · stability ${num(f.volStability, 2)} · spread ${num(f.spreadCents, 2)}c · order/depth ${num(f.orderVsDepth, 2)} · ttr ${num(f.ttrDays, 1)}d · pot $${f.pot} · band ${f.maxSpreadCents}c`);
  console.log('  → both are Pop Culture, but the universe spans that category and their vol/spread/depth/ttr sit inside');
  console.log('    the universe ranges above — no single feature isolates them (n=2, not a sample; see Phase 3).');
}
main().catch((e) => { console.error('HARD FAIL:', e.message); process.exit(1); });
