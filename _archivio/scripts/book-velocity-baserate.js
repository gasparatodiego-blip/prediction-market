#!/usr/bin/env node
'use strict';
/**
 * PHASE 2 SUPPORT — executable-move BASE RATE on the real reward market population.
 *
 * WHAT THIS ANSWERS, AND WHAT IT DOES NOT
 *   The velocity metric needs both an executable move AND at-touch depth. The only
 *   corpora carrying both at a <=60s horizon are short. The rewards history
 *   (agent24/agent25 snapshots, 19 days) carries the RIGHT market population over a
 *   LONG window but at ~30-minute cadence and without at-touch depth.
 *
 *   So this script deliberately answers a NARROWER question than the metric:
 *     "How often does a market in the reward set move its executable price by at
 *      least M cents, per market per day?"
 *
 *   That is a rigorous UPPER BOUND on the alert rate, because an alert requires a
 *   move of at least nvThreshold / depthWeight cents inside 60s, and every 60-second
 *   move of >=M cents is also a 30-minute move of >=M cents. It over-counts (a move
 *   that took 25 minutes is counted, but would never trip a 60s detector), which is
 *   exactly the direction a bound should err in.
 *
 *   It computes NO normalised velocity and claims none — there is no at-touch depth
 *   in this corpus and none is invented.
 *
 * HELD-OUT VALIDATION
 *   With --split f the corpus is cut chronologically: the rate is computed on the
 *   first f of the window and then re-measured on the remaining slice, which the
 *   threshold never saw. Because the fire-rate projection is derived from this
 *   ceiling, this is the out-of-sample test of the number the threshold was chosen
 *   against, on the population the detector actually runs on.
 *
 * Read-only. Zero network calls, zero Claude calls.
 * Usage: node scripts/book-velocity-baserate.js [--split 0.7]
 */

const fs = require('fs');
const path = require('path');

const HIST = path.join(__dirname, '..', 'data', 'history');
const MOVE_BUCKETS = [1, 2, 3, 5, 8, 10, 15, 20, 30];

// The real tracked set agent36 polls, as reported by the agent at startup:
// every reward market agent24 and agent25 emit with a known qualifying size.
const TRACKED_POLY   = 120;
const TRACKED_KALSHI = 200;

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

function dayFiles(section) {
  const dir = path.join(HIST, section);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /^\d{4}-\d{2}-\d{2}(\.\d+)?\.json$/.test(f))
    .sort()
    .map(f => path.join(dir, f));
}

/**
 * Kalshi rewards history carries REAL executable quotes (bestBid / bestAsk) per
 * market per snapshot. Polymarket rewards history carries mid + bookSpread; the
 * executable quotes are reconstructed as mid -/+ bookSpread/2, which is an exact
 * inversion of how the mid was formed, not an estimate.
 */
function collect(section, extract) {
  const byMarket = new Map();
  let snaps = 0;
  for (const f of dayFiles(section)) {
    let arr;
    try { arr = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    for (const snap of arr) {
      if (!snap || !Array.isArray(snap.rows) || !num(snap.t)) continue;
      snaps++;
      for (const r of snap.rows) {
        const q = extract(r);
        if (!q) continue;
        const key = String(r.id || r.ticker);
        if (!byMarket.has(key)) byMarket.set(key, { title: r.title, minSize: q.minSize, rows: [] });
        byMarket.get(key).rows.push({ t: snap.t, bid: q.bid, ask: q.ask });
      }
    }
  }
  for (const m of byMarket.values()) m.rows.sort((a, b) => a.t - b.t);
  return { byMarket, snaps };
}

function kalshiQuote(r) {
  const bid = num(r.bestBid), ask = num(r.bestAsk), minSize = num(r.minSize);
  if (bid == null || ask == null || minSize == null) return null;
  if (bid <= 0 || ask <= 0 || bid >= ask || ask >= 1) return null;
  return { bid, ask, minSize };
}
function polyQuote(r) {
  const mid = num(r.mid), sp = num(r.bookSpread), minSize = num(r.minSize);
  if (mid == null || sp == null || minSize == null) return null;
  const bid = mid - sp / 2, ask = mid + sp / 2;
  if (bid <= 0 || ask <= 0 || bid >= ask || ask >= 1) return null;
  return { bid, ask, minSize };
}

const SPLIT = (() => {
  const i = process.argv.indexOf('--split');
  return i > -1 ? Number(process.argv[i + 1]) : null;
})();

function analyse(label, section, extract, tracked) {
  const { byMarket, snaps } = collect(section, extract);
  let tmin = Infinity, tmax = 0, rows = 0;
  for (const m of byMarket.values()) {
    rows += m.rows.length;
    if (m.rows.length) { tmin = Math.min(tmin, m.rows[0].t); tmax = Math.max(tmax, m.rows[m.rows.length - 1].t); }
  }
  const days = (tmax - tmin) / 86_400_000;

  // Sign-consistent executable move between consecutive snapshots — the SAME
  // definition lib/book-velocity.js uses (both sides must move the same way).
  const cut = SPLIT ? tmin + (tmax - tmin) * SPLIT : Infinity;
  const moves = [], movesTrain = [], movesHold = [];
  let gapsSkipped = 0;
  for (const m of byMarket.values()) {
    for (let i = 1; i < m.rows.length; i++) {
      const a = m.rows[i - 1], b = m.rows[i];
      const dt = b.t - a.t;
      if (dt <= 0 || dt > 90 * 60_000) { gapsSkipped++; continue; }   // day-file boundary etc.
      const dBid = (b.bid - a.bid) * 100, dAsk = (b.ask - a.ask) * 100;
      let mv = 0;
      if (dBid > 0 && dAsk > 0) mv = Math.min(dBid, dAsk);
      else if (dBid < 0 && dAsk < 0) mv = -Math.min(-dBid, -dAsk);
      moves.push(Math.abs(mv));
      (b.t <= cut ? movesTrain : movesHold).push(Math.abs(mv));
    }
  }

  console.log(`\n${'─'.repeat(76)}`);
  console.log(`${label}  (section data/history/${section}/)`);
  console.log(`${'─'.repeat(76)}`);
  console.log(`snapshots=${snaps}  markets=${byMarket.size}  market-observations=${rows}  skipped gaps=${gapsSkipped}`);
  console.log(`window ${new Date(tmin).toISOString().slice(0, 10)} → ${new Date(tmax).toISOString().slice(0, 10)}  (${days.toFixed(1)} days)`);
  console.log(`consecutive-snapshot pairs: ${moves.length}`);

  const nonzero = moves.filter(x => x > 0);
  console.log(`pairs with a sign-consistent executable move: ${nonzero.length} (${(nonzero.length / moves.length * 100).toFixed(1)}%)`);

  console.log(`\n  |move| >= M      pairs    per market per day    across ${tracked} tracked/day`);
  const out = [];
  for (const M of MOVE_BUCKETS) {
    const n = moves.filter(x => x >= M).length;
    const perMktDay = n / days / byMarket.size;
    out.push({ M, n, perMktDay });
    console.log(`  ${String(M).padStart(3)}c   ${String(n).padStart(12)}   ${perMktDay.toFixed(4).padStart(18)}   ${(perMktDay * tracked).toFixed(1).padStart(21)}`);
  }
  if (SPLIT && movesHold.length) {
    const trainDays = (cut - tmin) / 86_400_000, holdDays = (tmax - cut) / 86_400_000;
    console.log(`\n  HELD-OUT (last ${((1 - SPLIT) * 100).toFixed(0)}% of the window, ${holdDays.toFixed(1)}d, never seen by the threshold)`);
    console.log(`  |move| >= M    train ${tracked}/day    holdout ${tracked}/day    ratio`);
    for (const M of MOVE_BUCKETS) {
      const tr = movesTrain.filter(x => x >= M).length / trainDays / byMarket.size * tracked;
      const ho = movesHold.filter(x => x >= M).length / holdDays / byMarket.size * tracked;
      console.log(`  ${String(M).padStart(3)}c   ${tr.toFixed(1).padStart(14)}   ${ho.toFixed(1).padStart(17)}   ${(tr > 0 ? (ho / tr).toFixed(2) : '—').padStart(6)}x`);
    }
  }
  return { label, days, markets: byMarket.size, buckets: out };
}

console.log('='.repeat(76));
console.log('EXECUTABLE-MOVE BASE RATE — real reward market population, 19 days');
console.log('='.repeat(76));
console.log('UPPER BOUND ONLY. ~30-min cadence, so every 60s move is counted but so are');
console.log('slow 30-minute drifts that a 60s detector would never see. No depth in this');
console.log('corpus, so no normalised velocity is computed or claimed.');

const k = analyse('KALSHI reward markets — REAL bestBid/bestAsk', 'rewards-kalshi', kalshiQuote, TRACKED_KALSHI);
const p = analyse('POLYMARKET reward markets — quotes reconstructed as mid ∓ bookSpread/2', 'rewards-poly', polyQuote, TRACKED_POLY);

console.log(`\n${'='.repeat(76)}`);
console.log('COMBINED CEILING across the tracked set (Kalshi + Polymarket)');
console.log('='.repeat(76));
console.log(`  tracked set: ${TRACKED_POLY} polymarket + ${TRACKED_KALSHI} kalshi = ${TRACKED_POLY + TRACKED_KALSHI} markets`);
console.log('  |move| >= M     upper-bound alerts/day over the whole tracked set');
for (let i = 0; i < MOVE_BUCKETS.length; i++) {
  const kb = k.buckets[i], pb = p.buckets[i];
  const total = kb.perMktDay * TRACKED_KALSHI + pb.perMktDay * TRACKED_POLY;
  console.log(`  ${String(MOVE_BUCKETS[i]).padStart(3)}c   ${total.toFixed(1).padStart(12)}   (kalshi ${(kb.perMktDay * TRACKED_KALSHI).toFixed(1)} + poly ${(pb.perMktDay * TRACKED_POLY).toFixed(1)})`);
}
console.log('');
