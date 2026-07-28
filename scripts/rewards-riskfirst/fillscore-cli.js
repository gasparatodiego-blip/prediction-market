#!/usr/bin/env node
'use strict';
// scripts/rewards-riskfirst/fillscore-cli.js — CONSTRAINT 2: the structural fill score, its HONEST
// validation against the 11 observed fills, and the offset frontier (fills avoided vs reward lost).
//   node fillscore-cli.js [--pots snapshot.json]

const fs = require('fs');
const { loadWindow } = require('../rewards-worstcase/lib/data');
const { marketFeatures } = require('./lib/features');
const { computeFillScores, auc } = require('./lib/fillscore');
const { perMarketNetAtSize } = require('../../lib/rewards/allocator');
const { reconstructTapeFillsForMarket } = require('../rewards-replay/lib/tape');

const NOW = 1785160829000;
const num = (x, d = 2) => (x == null ? '—' : x.toFixed(d));
const money = (x) => (x == null ? '—' : '$' + x.toFixed(2));
function parseArgs(argv) { const a = { pots: null }; for (let i = 2; i < argv.length; i++) if (argv[i] === '--pots') { a.pots = argv[i + 1]; i++; } return a; }
function buildMeta(potsPath) {
  const meta = new Map();
  if (potsPath) { const s = JSON.parse(fs.readFileSync(potsPath, 'utf8')); for (const [c, o] of Object.entries(s.byCond)) meta.set(c, { pot: o.pot, maxSpread: o.maxSpread, minSize: o.minSize }); }
  try { const b = JSON.parse(fs.readFileSync('/root/prediction-market/data/liquidity-rewards.json', 'utf8')); for (const m of b.markets || []) { const cur = meta.get(m.conditionId) || {}; meta.set(m.conditionId, { ...cur, endDate: m.endDate ?? null, category: m.category ?? null, pot: cur.pot ?? m.rewardsDailyRate, maxSpread: cur.maxSpread ?? m.rewardsMaxSpread }); } } catch {}
  return meta;
}

async function main() {
  const args = parseArgs(process.argv);
  const D = await loadWindow({ potsPath: args.pots });
  const meta = buildMeta(args.pots);

  console.log('═'.repeat(88));
  console.log('PHASE 3 — CONSTRAINT 2: FILL-LIKELIHOOD SCORE (structural, NOT fitted) + OFFSET FRONTIER');
  console.log('═'.repeat(88));

  const raw = [];
  for (const [mid, rows] of D.byMarket.entries()) if (D.potByCond.has(mid)) raw.push(marketFeatures(mid, rows, meta.get(mid), NOW));
  const scored = computeFillScores(raw);
  const nullScore = scored.filter((f) => f.fillScore == null).length;

  // filled set: markets that produce ≥1 fill at a COMMON $250/side probe (size-consistent across markets)
  const filledSet = new Set();
  let totalFills = 0;
  for (const [mid, rows] of D.byMarket.entries()) {
    if (!D.potByCond.has(mid)) continue;
    const trades = (D.marketTokens.get(mid) && D.tapeByToken.get(D.marketTokens.get(mid))) || [];
    const nf = reconstructTapeFillsForMarket(rows, trades, { offsetCents: 1, sizeUsd: 250, maxInventoryUsd: 5000 }).fills.length;
    if (nf > 0) { filledSet.add(mid); totalFills += nf; }
  }

  console.log(`\nfill score computed for ${scored.length - nullScore} markets (${nullScore} missing a feature → "—", excluded + counted).`);
  console.log('top-8 by fill score (most likely to be filled):');
  for (const f of scored.filter((x) => x.fillScore != null).sort((a, b) => b.fillScore - a.fillScore).slice(0, 8))
    console.log(`  ${f.marketId.slice(0, 12)}… score ${num(f.fillScore, 3)} [depth ${num(f.scoreParts.depth, 2)} vol ${num(f.scoreParts.vol, 2)} narrow ${num(f.scoreParts.narrow, 2)}] · order/depth ${num(f.orderVsDepth, 2)} · ${filledSet.has(f.marketId) ? 'FILLED' : 'unfilled'}`);

  // HONEST validation
  const V = auc(scored, filledSet);
  console.log('\nVALIDATION against observed fills (@ $250/side probe):');
  console.log(`  filled markets: ${V.nFilled} · unfilled: ${V.nUnfilled} · total observed fills: ${totalFills}`);
  console.log(`  AUC (P[filled outranks unfilled]) = ${V.auc == null ? '—' : num(V.auc, 3)} · 95% CI [${V.ci95 ? num(V.ci95[0], 3) + ', ' + num(V.ci95[1], 3) : '—'}] (Hanley–McNeil) · 0.5 = no discrimination`);
  console.log('  HONEST CONFIDENCE: the task anticipated n=11 (the $5,000 ALLOCATION had 11 fills across 4 markets — too');
  console.log(`  few to validate anything). A UNIVERSE-wide probe surfaces a larger sample — ${totalFills} fills across ${V.nFilled} markets —`);
  const sig = V.ci95 && V.ci95[0] > 0.5;
  console.log(`  and on it the score's discrimination is ${sig ? 'MODEST but statistically above chance (CI lower bound > 0.5)' : 'NOT distinguishable from chance'}: AUC ${num(V.auc, 3)}.`);
  console.log('  It is far from a reliable filter (1.0), and it was NOT fitted (equal-weight percentile ranks). Verdict: a');
  console.log('  structurally-reasoned heuristic with WEAK real discrimination — usable as a tie-breaker, not as a gate.');

  // OFFSET FRONTIER — the measurable lever
  console.log('\nOFFSET FRONTIER (the measurable fill-avoidance lever; $1000/side, all markets):');
  console.log('  offset  total-fills  fills-avoided-vs-0c   gross-in-band/d  reward-lost/d (band dropout: offset > maxSpread/2)');
  // gross per market at $1000/side (offset does not change gross in the S=1 ceiling; band membership does)
  const grossByMid = new Map();
  for (const [mid, rows] of D.byMarket.entries()) {
    if (!D.potByCond.has(mid)) continue;
    const trades = (D.marketTokens.get(mid) && D.tapeByToken.get(D.marketTokens.get(mid))) || [];
    const r = perMarketNetAtSize(mid, rows, trades, D.potByCond, { offsetCents: 1, sizeUsd: 1000, maxInventoryUsd: 5000 });
    if (r.grossPerDay != null) grossByMid.set(mid, { gross: r.grossPerDay, band: meta.get(mid) ? meta.get(mid).maxSpread : null });
  }
  const totalGross = [...grossByMid.values()].reduce((s, v) => s + v.gross, 0);
  const fillsAt = {};
  for (const off of [0, 1, 2, 3]) {
    let fills = 0;
    for (const [mid, rows] of D.byMarket.entries()) { if (!D.potByCond.has(mid)) continue; const trades = (D.marketTokens.get(mid) && D.tapeByToken.get(D.marketTokens.get(mid))) || []; fills += reconstructTapeFillsForMarket(rows, trades, { offsetCents: off, sizeUsd: 1000, maxInventoryUsd: 5000 }).fills.length; }
    fillsAt[off] = fills;
    // reward retained: markets whose band radius (maxSpread/2 cents) still contains the offset
    let inBand = 0, lost = 0;
    for (const v of grossByMid.values()) { const radius = v.band != null ? v.band / 2 : null; if (radius != null && off <= radius + 1e-9) inBand += v.gross; else lost += v.gross; }
    console.log('  ' + (off + '¢').padStart(6) + '  ' + String(fills).padStart(11) + '  ' + String(fillsAt[0] != null ? fillsAt[0] - fills : '—').padStart(19) + '   ' + money(inBand).padStart(15) + '  ' + money(lost).padStart(12));
  }
  console.log('\n  → widening the offset is the ONE fill-avoidance lever we can MEASURE: fills collapse fast, but past');
  console.log('    each market’s band radius (maxSpread/2) the order leaves the reward band and its gross drops to 0.');
  console.log('    Where the score is unvalidated, this trade is real and quantified.');
}
main().catch((e) => { console.error('HARD FAIL:', e.message); process.exit(1); });
