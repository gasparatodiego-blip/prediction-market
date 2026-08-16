#!/usr/bin/env node
'use strict';
// scripts/rewards-ceiling/phase1-pot.js — THE REAL POT.
// Read the published daily reward pot for every market in the collectable (Polymarket) universe from the
// PRIMARY SOURCE (Gamma), and print the full distribution: total, median, quartiles, sub-$15/day count,
// and the aggregate $/day the entire lane pays ALL makers combined. Offline, read-only.
//
// Writes the market set + pots to scripts/rewards-ceiling/out/pots.json for phases 2/3 (deterministic
// hand-off; each phase can be re-read without re-hitting the API).

const fs = require('fs');
const path = require('path');
const { fetchRewardMarkets } = require('./lib/gamma');

const OUT_DIR = path.join(__dirname, 'out');
const POT_FLOOR = 15; // $/day — the same demotion floor shipped in commit b8d5ecc

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

(async () => {
  const nowIso = new Date().toISOString();
  const { markets, rawSample, endpoint, pagesScanned } = await fetchRewardMarkets();
  if (!markets.length) { console.error('HARD FAIL: no reward markets read from Gamma primary source'); process.exit(1); }

  const pots = markets.map((m) => m.rewardsDailyRate).sort((a, b) => a - b);
  const total = pots.reduce((a, b) => a + b, 0);
  const belowFloor = pots.filter((p) => p < POT_FLOOR);

  console.log('═'.repeat(72));
  console.log('PHASE 1 — THE REAL POT (collectable Polymarket universe, primary source)');
  console.log('═'.repeat(72));
  console.log('snapshot (UTC):        ', nowIso);
  console.log('primary endpoint:      ', endpoint);
  console.log('gamma pages scanned:   ', pagesScanned);
  console.log('reward markets found:  ', markets.length);
  console.log('');
  console.log('POT DISTRIBUTION ($/day per market):');
  console.log('  total (whole lane):  $' + total.toFixed(2) + '/day  ← aggregate the lane pays ALL makers combined');
  console.log('  min:                 $' + pots[0].toFixed(2));
  console.log('  p25:                 $' + quantile(pots, 0.25).toFixed(2));
  console.log('  median:              $' + quantile(pots, 0.50).toFixed(2));
  console.log('  p75:                 $' + quantile(pots, 0.75).toFixed(2));
  console.log('  p90:                 $' + quantile(pots, 0.90).toFixed(2));
  console.log('  max:                 $' + pots[pots.length - 1].toFixed(2));
  console.log('  below $' + POT_FLOOR + '/day:       ' + belowFloor.length + ' of ' + pots.length +
    ' markets (' + Math.round(belowFloor.length / pots.length * 100) + '%), summing $' + belowFloor.reduce((a, b) => a + b, 0).toFixed(2) + '/day');
  console.log('');
  console.log('POT TREND: Gamma exposes only the CURRENT rewardsDailyRate (a snapshot the market operator');
  console.log('  can change at any time) — there is NO published historical pot series, so a trend cannot be');
  console.log('  established from primary source. This is a snapshot; treat the ceiling as of the date above.');
  console.log('');
  console.log('RAW PRIMARY SAMPLE (first reward market, untouched Gamma object — clobRewards + reward params):');
  console.log('  question:        ', rawSample.question);
  console.log('  conditionId:     ', rawSample.conditionId);
  console.log('  clobRewards[0]:  ', JSON.stringify(rawSample.clobRewards[0]));
  console.log('  rewardsMaxSpread:', rawSample.rewardsMaxSpread, ' rewardsMinSize:', rawSample.rewardsMinSize);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'pots.json'), JSON.stringify({ snapshot: nowIso, endpoint, potFloor: POT_FLOOR, markets }, null, 0));
  console.log('\nwrote', path.join(OUT_DIR, 'pots.json'), '(' + markets.length + ' markets) for phases 2/3');
})().catch((e) => { console.error('HARD FAIL:', e.message); process.exit(1); });
