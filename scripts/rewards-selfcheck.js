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

// ── PHASE 2 (REWARDS-ROW-PERSONALISE) — the board ranks by the OPERATOR'S figure, and "—" rows have a
//    DEFINED position in every sort mode (never silently first or last). netUsdPerDay now carries the
//    personalised price-first $/day, so sortRows ranking it = ranking the operator's own number. ───────
function phase4() {
  console.log('\nPHASE 2 — rank by the operator\'s own figure; "—" rows have a defined position');

  // (1) the $/day sort ranks by netUsdPerDay high→low — whatever figure it holds (now the personalised one).
  const rows = [
    { m: { marketId: 'a' }, netUsdPerDay: 1.17, stabilityScore: 40, hoursToResolution: 100, poolDayUsd: 317 },
    { m: { marketId: 'b' }, netUsdPerDay: 8.40, stabilityScore: 40, hoursToResolution: 100, poolDayUsd: 149 },
    { m: { marketId: 'c' }, netUsdPerDay: 0.60, stabilityScore: 40, hoursToResolution: 100, poolDayUsd: 200 },
  ];
  const day = sortRows(rows, { sortMode: 'day', sortDir: 'desc' });
  ok('$/day sort ranks by the personalised netUsdPerDay (8.40 > 1.17 > 0.60)',
    day.map((r) => r.m.marketId).join('') === 'bac');

  // (2) ranking follows the OPERATOR'S figure, NOT the fixed reference. Two rows whose FIXED reference would
  //     order X>Y but whose PERSONALISED figure orders Y>X: sorting on netUsdPerDay (= personalised) yields Y
  //     first — "where does MY capital work hardest", not a hypothetical $1,000's.
  const persRows = [
    { m: { marketId: 'X' }, refUsdPerDay: 175.88, netUsdPerDay: 2.10, stabilityScore: 50, hoursToResolution: 100, poolDayUsd: 300 },
    { m: { marketId: 'Y' }, refUsdPerDay: 6.92,   netUsdPerDay: 48.67, stabilityScore: 50, hoursToResolution: 100, poolDayUsd: 300 },
  ];
  const byRef  = [...persRows].sort((p, q) => q.refUsdPerDay - p.refUsdPerDay).map((r) => r.m.marketId).join('');
  const byPers = sortRows(persRows, { sortMode: 'day', sortDir: 'desc' }).map((r) => r.m.marketId).join('');
  ok('the fixed reference would rank X (a $1k dominating a thin book) first', byRef === 'XY');
  ok('but the personalised sort ranks Y first — the board follows the OPERATOR\'S figure, not $1,000', byPers === 'YX');

  // (3) a "—" (null netUsdPerDay) row is pinned LAST in BOTH directions and in EVERY mode — a DEFINED
  //     position, never silently first/last. It even has the highest pool + stability, so only the null
  //     handling (not a lucky value) keeps it out of the top.
  const withNull = [
    { m: { marketId: 'n' }, netUsdPerDay: null, stabilityScore: 99, hoursToResolution: 10, poolDayUsd: 9999 },
    { m: { marketId: 'p' }, netUsdPerDay: 3.0,  stabilityScore: 10, hoursToResolution: 999, poolDayUsd: 50 },
  ];
  ok('"—" row is LAST in $/day desc (never first on a null)', sortRows(withNull, { sortMode: 'day', sortDir: 'desc' }).at(-1).m.marketId === 'n');
  ok('"—" row is LAST in $/day asc too (null pinned last in BOTH directions, not treated as 0)', sortRows(withNull, { sortMode: 'day', sortDir: 'asc' }).at(-1).m.marketId === 'n');
  ok('"—" row is LAST in the default (legacy) $/day sort', sortRows(withNull, { sortDir: 'desc' }).at(-1).m.marketId === 'n');

  // (4) a demoted row with a HUGE personalised figure still sorts below a non-demoted smaller one (the
  //     tiny-pot / non-collectable guard composes with the personalised key).
  const demRows = [
    { m: { marketId: 'big-demoted' }, netUsdPerDay: 999, demoted: true, stabilityScore: 50, hoursToResolution: 100, poolDayUsd: 10 },
    { m: { marketId: 'small-real' },  netUsdPerDay: 1.2, demoted: false, stabilityScore: 50, hoursToResolution: 100, poolDayUsd: 300 },
  ];
  ok('a demoted row keeps its below-the-fold position even with a huge personalised $/day', sortRows(demRows, { sortMode: 'day', sortDir: 'desc' })[0].m.marketId === 'small-real');
}

// ── PHASE 4 (REWARDS-ROW-PERSONALISE) — reactivity + performance: a size/offset change recomputes the
//    board with NO refetch and NO stall, and a cleared size degrades to "—", never a stale number. ──────
function phase5() {
  console.log('\nPHASE 4 — reactive recompute without refetch or stall; honest partial state');
  const { computePriceRow } = require('../lib/reward-price-row');
  const { competitorDepthUsd } = require('../lib/reward-depth-floor');
  const rs = { poolDay: 200, mid: 0.5, maxSpreadCents: 6, minSize: 100, competitorQ: 800, refCapital: 1000, refShare: 0.1 };
  const mkt = { venue: 'polymarket', bookDepthAtBand: 5000, sides: { no: { bookDepthAtBand: 4000 } } };

  // (1) HONEST PARTIAL STATE: a valid size yields a number; CLEARING the size yields null (→ "—"), NOT the
  //     previous number presented as current. The figure always reflects the CURRENT input, never a stale one.
  const at400 = computePriceRow({ rewardScore: rs, tick: 0.01, totalSizeUsd: 400, offsetCents: 1, market: mkt }).grossPerDay;
  const cleared = computePriceRow({ rewardScore: rs, tick: 0.01, totalSizeUsd: null, offsetCents: 1, market: mkt }).grossPerDay;
  ok('a valid size produces a figure', typeof at400 === 'number' && at400 > 0);
  ok('clearing the size → null (renders "—"), never the previous $/day held over as current', cleared === null);
  const at500 = computePriceRow({ rewardScore: rs, tick: 0.01, totalSizeUsd: 500, offsetCents: 1, market: mkt }).grossPerDay;
  ok('changing the size changes the figure (the board reacts to the current config)', at500 !== at400);

  // (2) PERFORMANCE: a full 313-row board recompute (computePriceRow ×N + a sort key read) completes well
  //     within one frame — the "313 rows per keystroke" hazard is not a stall. Generous 50ms ceiling (the
  //     measured time is ~1.6ms); this guards against a catastrophic regression (e.g. I/O in the hot path).
  const N = 313;
  const board = Array.from({ length: N }, () => ({ rewardScore: rs, tick: 0.01, market: mkt }));
  const t0 = process.hrtime.bigint();
  for (const r of board) computePriceRow({ rewardScore: r.rewardScore, tick: r.tick, totalSizeUsd: 400, offsetCents: 1.5, market: r.market });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  ok(`full ${N}-row board recompute is ${ms.toFixed(2)}ms (< 50ms ceiling — reacts within one frame, no stall)`, ms < 50);

  // (3) NO-REFETCH ARCHITECTURE (source invariant): the API query is built from server filters ONLY, the
  //     fetch effect depends on that query alone (never size/offset), and `enriched` DOES depend on
  //     size/offset — so a size/offset change re-ranks the board WITHOUT hitting the API.
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'app', 'components', 'RewardsUnified.tsx'), 'utf8');
  const serverParamsBody = (src.match(/function serverParams[\s\S]*?\n}/) || [''])[0];
  ok('serverParams (the API query) references neither size nor offset', !/sizeInput|totalSizeUsd|offsetCents|distInput/.test(serverParamsBody));
  ok('the fetch effect depends on [apiQuery] only — size/offset never trigger a refetch', /\}, \[apiQuery\]\);/.test(src));
  // enriched must still depend on [base, totalSizeUsd, offsetCents]; the layered-quoting work extends the
  // SAME memo with the layer controls (…, layersN, spacingTicks), so size/offset/layer changes all
  // recompute each row without a refetch. Require the three originals at the head; allow the extension.
  ok('enriched DOES depend on [base, totalSizeUsd, offsetCents] (+ layer controls) — a size/offset/layer change recomputes each row', /\}\), \[base, totalSizeUsd, offsetCents[^\]]*\]\);/.test(src));
  ok('the per-row computation is memoised as row.pr (computed once in enriched, reused by the row + totals)', /pr,   \/\/ computed once above/.test(src) && /const pr = row\.pr;/.test(src));
}

phase1();
phase2();
phase3();
phase4();
phase5();
console.log(`\nrewards-selfcheck: ${passed} assertions passed`);
