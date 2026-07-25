#!/usr/bin/env node
'use strict';
// scripts/rewards-ceiling/phase2-capital.js — THE CAPITAL REQUIRED.
// For every market in out/pots.json, fetch the LIVE YES CLOB book (public REST), measure the competitor
// Qmin + observed in-band qualifying depth (both stacks, venue size cutoff + band — never OI, never a
// constant), and build the capital-to-share curve: to hold share X of the pot you must rest $Y in band.
// Report the turn point (capacity). Markets whose book/mid cannot be read are EXCLUDED and counted.
// Writes out/measured.json for Phase 3.

const fs = require('fs');
const path = require('path');
const { getJson } = require('./lib/fetch');
const { measureFromBook, capitalForShare } = require('./lib/curve');

const OUT_DIR = path.join(__dirname, 'out');
const CLOB_BOOK = (tokenId) => `https://clob.polymarket.com/book?token_id=${tokenId}`;
const SHARES = [0.10, 0.25, 0.50, 0.75, 0.90];

(async () => {
  const pots = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'pots.json'), 'utf8'));
  const markets = pots.markets;
  console.log('═'.repeat(72));
  console.log('PHASE 2 — THE CAPITAL REQUIRED (live in-band depth, both sides, size cutoff + band)');
  console.log('═'.repeat(72));
  console.log('measuring', markets.length, 'markets from live CLOB books (public REST)…');

  const measured = [];
  const excluded = [];
  let i = 0;
  for (const m of markets) {
    i++;
    if (i % 100 === 0) process.stdout.write(`  …${i}/${markets.length}\n`);
    let book = null;
    try { const r = await getJson(CLOB_BOOK(m.tokenIdYes)); if (r.status === 200) book = r.data; } catch (_) {}
    const meas = measureFromBook(book, m.rewardsMaxSpread, m.rewardsMinSize);
    if (!meas.ok) { excluded.push({ conditionId: m.conditionId, question: m.question, pot: m.rewardsDailyRate, reason: meas.reason }); continue; }
    // turn point / capacity: the capital to reach 50% share (half-saturation). Beyond it each extra dollar
    // buys <¼ the marginal share it bought at the start — the market's real capacity.
    const capacityUsd = capitalForShare(meas.competitorQ, meas.mid, 0.50);
    measured.push({
      conditionId: m.conditionId,
      question: m.question,
      pot: m.rewardsDailyRate,
      maxSpread: m.rewardsMaxSpread,
      minSize: m.rewardsMinSize,
      mid: meas.mid,
      competitorQ: meas.competitorQ,
      inbandDepthUsd: meas.inbandDepthUsd,
      inbandBidUsd: meas.inbandBidUsd,
      inbandAskUsd: meas.inbandAskUsd,
      curve: SHARES.map((X) => ({ share: X, capitalUsd: capitalForShare(meas.competitorQ, meas.mid, X) })),
      capacityUsd, // capital for 50% share
    });
  }

  // ── report ──
  console.log('\nmeasured:', measured.length, ' excluded:', excluded.length);
  const byReason = {};
  for (const e of excluded) byReason[e.reason] = (byReason[e.reason] || 0) + 1;
  console.log('exclusions by reason:', JSON.stringify(byReason));
  const depths = measured.map((m) => m.inbandDepthUsd).sort((a, b) => a - b);
  const q = (p) => depths.length ? depths[Math.floor(p * (depths.length - 1))] : null;
  console.log('\nobserved in-band qualifying depth ($, both stacks): median $' + (q(0.5) || 0).toFixed(0) +
    '  p25 $' + (q(0.25) || 0).toFixed(0) + '  p75 $' + (q(0.75) || 0).toFixed(0) + '  max $' + (q(1) || 0).toFixed(0));

  // Sample capital-to-share curve for the 3 biggest pots (traceable).
  console.log('\nCAPITAL-TO-SHARE CURVE (biggest pots) — capital ($, both sides) to hold share X, S=1 ceiling:');
  const top = [...measured].sort((a, b) => b.pot - a.pot).slice(0, 3);
  for (const m of top) {
    console.log('  "' + m.question.slice(0, 46) + '"  pot $' + m.pot + '/day · mid ' + m.mid.toFixed(3) + ' · cQ ' + m.competitorQ.toFixed(0) + ' · in-band depth $' + m.inbandDepthUsd.toFixed(0));
    console.log('     ' + m.curve.map((c) => `${Math.round(c.share * 100)}%→$${Math.round(c.capitalUsd)}`).join('  ') + '   | capacity(50%) $' + Math.round(m.capacityUsd));
  }

  fs.writeFileSync(path.join(OUT_DIR, 'measured.json'), JSON.stringify({ snapshot: pots.snapshot, potFloor: pots.potFloor, measured, excluded }, null, 0));
  console.log('\nwrote', path.join(OUT_DIR, 'measured.json'), '(' + measured.length + ' measured, ' + excluded.length + ' excluded)');
})().catch((e) => { console.error('HARD FAIL:', e.message); process.exit(1); });
