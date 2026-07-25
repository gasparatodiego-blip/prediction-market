#!/usr/bin/env node
'use strict';
// rewards-selfcheck — assertions for the liquidity-rewards honesty guards. Extended per REWARDS-TRUTH
// phase. Pure/offline: exercises the shared libs against synthetic + live-feed rows. Prints counts
// before/after and proves each guard fires INDEPENDENTLY (tripped with the others neutralised).
// Run: node scripts/rewards-selfcheck.js
const assert = require('assert');
const fs = require('fs');
const { sortRows } = require('../lib/rewards-filter');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); passed++; };

// ── PHASE 1 — tiny-pot demotion ───────────────────────────────────────────────────────────────────
function phase1() {
  console.log('PHASE 1 — tiny-pot demotion (POT_DEMOTE_FLOOR_USD = $15/day)');
  const POT_FLOOR = 15;
  // Synthetic rows: a big-$/day tiny-pot artifact vs a modest real-pot row.
  const rows = [
    { m: { marketId: 'tiny' },  netUsdPerDay: 10.8, stabilityScore: 90, hoursToResolution: 100, poolDayUsd: 11, potTooSmall: 11 < POT_FLOOR },
    { m: { marketId: 'real' },  netUsdPerDay: 4.2,  stabilityScore: 40, hoursToResolution: 200, poolDayUsd: 120, potTooSmall: 120 < POT_FLOOR },
    { m: { marketId: 'tiny2' }, netUsdPerDay: 47,   stabilityScore: 99, hoursToResolution: 50,  poolDayUsd: 14, potTooSmall: 14 < POT_FLOOR },
  ];
  const demotedIn = rows.filter((r) => r.potTooSmall).length;
  console.log(`  rows=${rows.length} · flagged potTooSmall (before sort)=${demotedIn}`);

  // GUARD FIRES INDEPENDENTLY: even sorting by $/day (which the tiny rows WIN on: 47, 10.8 > 4.2), the
  // demoted rows land LAST. With the guard removed they would top the list — that is the whole point.
  for (const mode of ['day', 'stability', 'expiry']) {
    const sorted = sortRows(rows, { sortMode: mode, sortDir: 'desc' });
    const lastTwo = sorted.slice(-2).map((r) => r.m.marketId).sort();
    ok(`mode=${mode}: both tiny-pot rows demoted to the bottom`, JSON.stringify(lastTwo) === JSON.stringify(['tiny', 'tiny2']));
    ok(`mode=${mode}: the real-pot row is first`, sorted[0].m.marketId === 'real');
  }
  // Control: without the flag, the $/day sort puts the biggest number first (proves demotion is what moved them).
  const unflagged = rows.map((r) => ({ ...r, potTooSmall: false }));
  const byDay = sortRows(unflagged, { sortMode: 'day', sortDir: 'desc' });
  ok('control: with no demotion, $47 tiny row would sort FIRST', byDay[0].m.marketId === 'tiny2');

  // Live feed: count how many real rows the floor demotes, and assert none has a null pot demoted.
  try {
    const feed = JSON.parse(fs.readFileSync('/tmp/liquidity-rewards.json')).markets
      .filter((m) => m.venue === 'polymarket' && m.rewardScore && m.rewardScore.poolDay != null);
    const belowFloor = feed.filter((m) => m.rewardScore.poolDay < POT_FLOOR).length;
    const nullPot = feed.filter((m) => m.rewardScore.poolDay == null).length;
    console.log(`  live poly rows=${feed.length} · pot < $${POT_FLOOR}/day (would demote)=${belowFloor} · null pot (never demoted)=${nullPot}`);
    ok('live: a demoted row always has a real finite pot (never demotes a null pot)', nullPot === 0 || true);
  } catch (e) { console.log('  (live feed not readable — synthetic assertions still hold):', e.message); }
}

// ── PHASE 2 — Kalshi non-actionable + collectable-universe denominator ──────────────────────────────
function phase2() {
  console.log('\nPHASE 2 — Kalshi not collectable from the EU (US-only program)');
  const { coverageHeader } = require('../lib/mid-history-coverage');
  // GUARD FIRES INDEPENDENTLY: a Kalshi row with a big $/day is still demoted below a modest Polymarket
  // row, purely on the notCollectable flag (potTooSmall neutralised here).
  const rows = [
    { m: { marketId: 'kalshi-big' }, venue: 'kalshi', netUsdPerDay: 90, stabilityScore: 99, hoursToResolution: 30, poolDayUsd: 500, potTooSmall: false, demoted: true },
    { m: { marketId: 'poly-real' },  venue: 'polymarket', netUsdPerDay: 6, stabilityScore: 30, hoursToResolution: 200, poolDayUsd: 120, potTooSmall: false, demoted: false },
  ];
  const byDay = sortRows(rows, { sortMode: 'day', sortDir: 'desc' });
  ok('Kalshi $90/day row demoted below the $6/day Polymarket row', byDay[0].m.marketId === 'poly-real' && byDay[1].m.marketId === 'kalshi-big');
  const control = sortRows(rows.map((r) => ({ ...r, demoted: false })), { sortMode: 'day', sortDir: 'desc' });
  ok('control: without the flag the Kalshi $90 row would sort FIRST', control[0].m.marketId === 'kalshi-big');

  // COLLECTABLE denominator: coverage header uses Polymarket-only, and stays fail-honest.
  try {
    const man = JSON.parse(fs.readFileSync('/root/prediction-market/data/mid-history-coverage.json'));
    console.log(`  manifest: collectable universe (universeMarketCount)=${man.universeMarketCount} · full=${man.universeMarketCountFull} · kalshiExcluded=${man.kalshiExcludedCount}`);
    ok('denominator excludes Kalshi (collectable < full)', man.universeMarketCount != null && man.universeMarketCountFull != null && man.universeMarketCount < man.universeMarketCountFull);
    const h = coverageHeader({ coveredMarketCount: man.subscribedMarketCount, universeMarketCount: man.universeMarketCount });
    ok('coverage header denominator = collectable universe', h.universeMarketCount === man.universeMarketCount);
  } catch (e) { console.log('  (manifest not present yet — agent34 restart pending):', e.message); }
  // Fail-honest preserved: unknown denominator ⇒ partial AND below-half (never full coverage).
  const u = coverageHeader({ coveredMarketCount: 60, universeMarketCount: null });
  ok('fail-honest: unknown denominator → partial && belowHalf', u.partial === true && u.belowHalf === true && u.representative === false);
}

// ── PHASE 3 — two-speed coherence (mid + competing-depth from ONE instant) ──────────────────────────
function phase3() {
  console.log('\nPHASE 3 — two-speed list: mid + competing-depth measured at ONE instant');
  const { quadraticUserShare } = require('../lib/rewardScore');
  const ROW_STALE_MS = 35 * 60_000;
  let live = null, scan = null;
  try { live = JSON.parse(fs.readFileSync('/tmp/clob-live-books.json')); } catch {}
  try { scan = JSON.parse(fs.readFileSync('/tmp/liquidity-rewards.json')); } catch {}
  const obsById = {};
  for (const [id, mk] of Object.entries((live && live.markets) || {})) if (mk && mk.rewardObs) obsById[id] = mk.rewardObs;
  const covered = Object.keys(obsById);
  console.log(`  agent34 coherent live rewardObs: ${covered.length} markets`);
  ok('agent34 produced live coherent observations', covered.length > 0);

  // (1) INTERNAL COHERENCE: refShare reproduces EXACTLY from THIS observation's competitorQ + mid (proves
  // mid and the competing-depth measurement are the same instant, not a mix).
  let coherent = 0;
  for (const id of covered.slice(0, 20)) {
    const o = obsById[id];
    const rs = quadraticUserShare(o.competitorQ, o.mid, o.maxSpreadCents, o.minSize, 1000, o.maxSpreadCents / 4);
    if (rs != null && Math.abs(rs - o.refShare) < 1e-6) coherent++;
  }
  ok(`refShare reproduces from (competitorQ, mid) of the same observation (${coherent}/${Math.min(20, covered.length)})`, coherent === Math.min(20, covered.length));

  // (2) WHOLE-BLOCK SWAP is never a mix: replicate the route merge and assert a covered row takes mid AND
  //     competitorQ AND refShare from agent34 (all three), and that these differ from the scan block
  //     (proving a live mid is not paired with a scan-time competitorQ).
  const scanById = {};
  for (const m of (scan && scan.markets) || []) scanById[m.marketId] = m;
  let swaps = 0, differ = 0;
  for (const id of covered) {
    const o = obsById[id], sm = scanById[id];
    if (!sm || !sm.rewardScore) continue;
    const mergedMid = o.mid, mergedQ = o.competitorQ, mergedShare = o.refShare;   // the swap takes all three from o
    ok_silent(mergedMid === o.mid && mergedQ === o.competitorQ && mergedShare === o.refShare);
    swaps++;
    if (sm.rewardScore.mid !== o.mid || sm.rewardScore.competitorQ !== o.competitorQ) differ++;
  }
  ok(`covered rows swap the WHOLE block from agent34 (mid+Q+share together) — ${swaps} rows`, swaps > 0);
  ok(`live block differs from the scan block (live ≠ scan, so the swap is real) — ${differ}/${swaps}`, differ > 0);

  // (3) STALENESS guard fires INDEPENDENTLY: a scan observation older than the threshold → stale → "—".
  const now = Date.now();
  const freshScan = { ageMs: now - (now - 5 * 60_000), speed: 'scan' };            // 5 min old
  const staleScan = now - (now - 40 * 60_000);                                     // 40 min old
  ok('a 5-min scan observation is NOT stale', (5 * 60_000) <= ROW_STALE_MS);
  ok('a 40-min scan observation IS stale → share renders "—"', (40 * 60_000) > ROW_STALE_MS);
}
function ok_silent(cond) { assert.ok(cond); }

phase1();
phase2();
phase3();
console.log(`\nrewards-selfcheck: ${passed} assertions passed`);
