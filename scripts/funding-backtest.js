#!/usr/bin/env node
'use strict';
/**
 * ROLLING OPEN/CLOSE BACKTEST — funding opportunity board, 2026-07-06 → 2026-07-19.
 *
 * OFFLINE ANALYSIS. Reads only. Not wired into any agent, API or the dashboard.
 *
 * SOURCES (read-only)
 *   data/history/funding/<YYYY-MM-DD>[.NN].json   real 15-min board snapshots (agent15 → history-logger)
 *   data/funding-history-14d.json                 real settled funding points (venue APIs)
 *   /tmp/funding-history-cache.json               same shape, live cache (merged, deduped by timestamp)
 *
 * HONEST-ENGINE CONTRACT — what this does and does NOT model
 *   - Accrual is REAL settled funding, replayed hour by hour from the venue history, using the
 *     SAME accrueSettled() semantics agent32 uses (dedup by settlement ts, Δt-weighted ≤ 1
 *     settlement per sample, rate is PERCENT per interval → ÷100). No modelled/assumed rate.
 *   - Net funding on a delta-neutral pair = (shortLegRate − longLegRate) × notional, matching
 *     agent32 markCrossVenue(): collect on the short leg (+), pay on the long leg (−).
 *   - Fees are the board's own totalFeesPct, which lib/guardian-suppress.js documents as the
 *     ROUND-TRIP fee (open+close, BOTH legs) as a percent of the per-leg notional.
 *   - LIMITATION, stated loudly: the funding history rows carry NO bid/ask and NO ladder — the
 *     projector (lib/history-logger.js) never stored prices. So execution slippage BEYOND the
 *     round-trip fee model is NOT captured. Depth is honoured only as a size cap via the real
 *     walked capacityUsd/greenCapacityUsd. This backtest is therefore frictionless-beyond-fees
 *     and, if anything, FLATTERS the strategy. It is not a fill simulation.
 *   - Leverage: 1x. No source opportunity specified one.
 *   - Missing accrual for a held coin/venue → the trade is marked UNKNOWN and excluded from
 *     P&L totals. Never assumed zero, never backfilled.
 *
 * EXIT RULES (mirrored from agent32 so the two are comparable, not reinvented)
 *   (a) carry<=fees   trailingNetPerDay <= feesUsd/CARRY_HORIZON_DAYS for CLOSE_CARRY_STREAK_N
 *                     consecutive marks that actually had new settled funding (a mark with no
 *                     new settled interval never advances the streak — can't judge carry on it)
 *   (b) spread_gone   key absent from SOURCE_GONE_STREAK_N consecutive board snapshots
 *   (c) window_end    still open at the last snapshot; closed at its accrued value
 */

const fs   = require('fs');
const path = require('path');

const ROOT        = path.join(__dirname, '..');
const HIST_DIR    = path.join(ROOT, 'data', 'history', 'funding');
const FUND_14D    = path.join(ROOT, 'data', 'funding-history-14d.json');
const FUND_CACHE  = '/tmp/funding-history-cache.json';
const OUT_FILE    = path.join(ROOT, 'data', 'funding-backtest-jul6-19.json');

const TICKETS               = [1000, 10000];
const CLOSE_CARRY_STREAK_N  = 2;    // agent32 parity
const SOURCE_GONE_STREAK_N  = 2;    // agent32 parity
const CARRY_HORIZON_DAYS    = 7;    // agent32 amortises the round-trip fee over SIM_DAYS = 7
const DAY_MS                = 86_400_000;

// ── accrual index ────────────────────────────────────────────────────────────
// venue → coin → [{t, rate}] ascending, deduped by settlement timestamp.
function buildAccrual() {
  const byVenue = new Map();
  let files = 0, rawPoints = 0;
  for (const f of [FUND_14D, FUND_CACHE]) {
    let j;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const data = j && j.data;
    if (!data) continue;
    files++;
    for (const venue of Object.keys(data)) {
      if (!byVenue.has(venue)) byVenue.set(venue, new Map());
      const vm = byVenue.get(venue);
      for (const coin of Object.keys(data[venue])) {
        const arr = data[venue][coin];
        if (!Array.isArray(arr)) continue;
        if (!vm.has(coin)) vm.set(coin, new Map());
        const cm = vm.get(coin);
        for (const p of arr) {
          if (!p || typeof p.t !== 'number' || typeof p.rate !== 'number') continue;
          rawPoints++;
          if (!cm.has(p.t)) cm.set(p.t, p.rate);
        }
      }
    }
  }
  // freeze to sorted arrays
  const out = new Map();
  let dedupPoints = 0;
  for (const [venue, vm] of byVenue) {
    const o = new Map();
    for (const [coin, cm] of vm) {
      const pts = [...cm.entries()].map(([t, rate]) => ({ t, rate })).sort((a, b) => a.t - b.t);
      dedupPoints += pts.length;
      o.set(coin, pts);
    }
    out.set(venue, o);
  }
  return { accrual: out, files, rawPoints, dedupPoints };
}

// Verbatim semantics of agent32 accrueSettled(): Δt-weighted, capped at one settlement/sample.
function accrueSettled(accrual, venue, coin, sinceT, untilT, intervalMs) {
  const vm = accrual.get(venue);
  const pts = vm && vm.get(coin);
  if (!pts || !pts.length) return null;               // no data → caller marks UNKNOWN
  const iv = Number(intervalMs) > 0 ? Number(intervalMs) : null;
  let sumRate = 0, points = 0, lastT = sinceT;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.t <= sinceT || p.t > untilT) continue;
    let weight = 1;
    if (iv) {
      const prevT = i > 0 ? pts[i - 1].t : (p.t - iv);
      weight = Math.min((p.t - prevT) / iv, 1);
    }
    sumRate += (p.rate / 100) * weight;
    points += 1;
    if (p.t > lastT) lastT = p.t;
  }
  return { sumRate, points, lastT };
}

// ── snapshot files in true chronological order ───────────────────────────────
function snapshotFiles() {
  const names = fs.readdirSync(HIST_DIR).filter(f => /^\d{4}-\d{2}-\d{2}(\.\d+)?\.json$/.test(f));
  return names.map(n => {
    const m = n.match(/^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.json$/);
    return { name: n, day: m[1], part: m[2] ? parseInt(m[2], 10) : 0 };
  }).sort((a, b) => a.day === b.day ? a.part - b.part : (a.day < b.day ? -1 : 1));
}

const keyOf = r => `${r.coin}|${r.shortVenue}|${r.longVenue}`;

// ── entry gate ───────────────────────────────────────────────────────────────
// No bid/ask exists in this dataset, so "positive net edge after entry fees on executable
// prices" is enforced with the board's OWN net-of-fees figure plus its real verification and
// depth flags. Every rejection is counted and reported — nothing is silently dropped.
function entryGate(r, ticket, tally, sel) {
  if (r.netRoiPctYr == null)                    { tally.no_net_roi++;      return null; }
  if (r.netRoiPctYr <= 0)                       { tally.net_edge_nonpos++; return null; }
  // Selectivity: the board's OWN quality signals. A MARGINAL 2%/yr spread earns ~$0.05/day on
  // $1k against a ~$1.30 round-trip fee — it needs ~26 days to repay entry, on a board where the
  // median spread does not survive a day. Testing HARVEST-only and a breakeven ceiling is the
  // honest way to ask "is there an edge if you only take the good ones".
  if (sel.tier && r.tier !== sel.tier)          { tally.tier_filtered++;   return null; }
  if (sel.maxBreakevenDays != null) {
    if (r.breakevenDays == null)                { tally.no_breakeven++;    return null; }
    if (r.breakevenDays <= 0)                   { tally.no_breakeven++;    return null; }
    if (r.breakevenDays > sel.maxBreakevenDays) { tally.breakeven_too_long++; return null; }
  }
  if (sel.requireNotThin && (r.thinFlag || r.depthThin)) { tally.thin_filtered++; return null; }
  if (r.fullyConfirmed !== true)                { tally.not_confirmed++;   return null; }
  if (r.oneLegUnverified === true)              { tally.one_leg_unverified++; return null; }
  if (r.spikeFlag === true)                     { tally.spike_flag++;      return null; }
  if (r.totalFeesPct == null)                   { tally.no_fee++;          return null; }
  // Real walked depth is the only size authority. greenCapacityUsd (verified-green) preferred.
  const cap = (r.greenCapacityUsd != null ? r.greenCapacityUsd : r.capacityUsd);
  if (cap == null)                              { tally.no_capacity++;     return null; }
  if (cap <= 0)                                 { tally.zero_capacity++;   return null; }
  const size = Math.min(ticket, cap);           // fill only what the book actually holds
  if (size < ticket) tally.sized_down++;
  return { size, sizedDown: size < ticket };
}

function runSim(ticket, files, accrual, opts) {
  const REENTRY      = opts.reentry !== false;      // may a closed pair re-open later?
  const CARRY_JUDGE_MS = opts.carryJudgeMs || 0;    // min spacing between carry judgements
  const seenOnce     = new Set();                   // pairs ever opened (for no-reentry mode)
  const SEL          = opts.select || {};           // entry selectivity filters
  const open = new Map();
  const closed = [];
  const perDay = new Map();          // YYYY-MM-DD → net $ realised that day
  const reject = { no_net_roi:0, net_edge_nonpos:0, not_confirmed:0, one_leg_unverified:0,
                   spike_flag:0, no_fee:0, no_capacity:0, zero_capacity:0, sized_down:0,
                   reentry_blocked:0, tier_filtered:0, no_breakeven:0, breakeven_too_long:0,
                   thin_filtered:0 };
  let snapshots = 0, rowsSeen = 0, firstT = null, lastT = null;

  const closeTrade = (p, t, reason) => {
    p.exitT = t;
    p.exitReason = reason;
    p.netUsd = p.unknown ? null : (p.cumFundingUsd - p.feesUsd);
    p.holdDays = (t - p.entryT) / DAY_MS;
    closed.push(p);
    if (!p.unknown) {
      const d = new Date(t).toISOString().slice(0, 10);
      perDay.set(d, (perDay.get(d) || 0) + p.netUsd);
    }
    open.delete(p.key);
  };

  for (const f of files) {
    let snaps;
    try { snaps = JSON.parse(fs.readFileSync(path.join(HIST_DIR, f.name), 'utf8')); }
    catch (e) { continue; }
    if (!Array.isArray(snaps)) { snaps = null; continue; }

    for (const snap of snaps) {
      const t = snap.t;
      if (typeof t !== 'number' || !Array.isArray(snap.rows)) continue;
      snapshots++;
      if (firstT == null) firstT = t;
      lastT = t;
      rowsSeen += snap.rows.length;

      const present = new Map();
      for (const r of snap.rows) present.set(keyOf(r), r);

      // ── 1. mark every open position on real settled funding, then test exits ──
      for (const p of [...open.values()]) {
        const sAcc = accrueSettled(accrual, p.shortVenue, p.coin, p.cursorT, t, p.shortIntervalMs);
        const lAcc = accrueSettled(accrual, p.longVenue,  p.coin, p.cursorT, t, p.longIntervalMs);
        if (sAcc == null || lAcc == null) {
          p.unknown = true;                       // no accrual source → never assume a rate
          p.unknownLeg = sAcc == null ? p.shortVenue : p.longVenue;
        } else {
          const add  = (sAcc.sumRate - lAcc.sumRate) * p.size;
          const pts  = sAcc.points + lAcc.points;
          const span = (Math.max(sAcc.lastT, lAcc.lastT) - p.cursorT) / DAY_MS;
          p.cumFundingUsd += add;
          p.settledPoints += pts;
          if (pts > 0 && span > 0) {
            const trailingNetPerDay = add / span;
            p.lastTrailingNetPerDay = trailingNetPerDay;
            p.marks++;
            // Carry streak advances ONLY on marks with new settled funding (agent32 parity), and
            // only once per CARRY_JUDGE_MS. Judging every 15-min snapshot trips the 2-mark streak
            // after ~2 settled hours and churns the book on round-trip fees — an artifact of the
            // snapshot cadence, not of the strategy. agent32 marks ~6-hourly.
            if (t - (p.lastJudgeT ?? 0) >= CARRY_JUDGE_MS) {
              p.lastJudgeT = t;
              p.negCarryStreak = trailingNetPerDay <= p.dailyCarryCost ? p.negCarryStreak + 1 : 0;
            }
          }
          p.cursorT = Math.max(sAcc.lastT, lAcc.lastT, p.cursorT);
        }

        p.goneStreak = present.has(p.key) ? 0 : p.goneStreak + 1;

        if (p.negCarryStreak >= CLOSE_CARRY_STREAK_N) { closeTrade(p, t, 'carry<=fees'); continue; }
        if (p.goneStreak    >= SOURCE_GONE_STREAK_N)  { closeTrade(p, t, 'spread_gone'); continue; }
      }

      // ── 2. open anything eligible that is not already held ──
      for (const [k, r] of present) {
        if (open.has(k)) continue;
        if (!REENTRY && seenOnce.has(k)) { reject.reentry_blocked++; continue; }
        const g = entryGate(r, ticket, reject, SEL);
        if (!g) continue;
        seenOnce.add(k);
        open.set(k, {
          key: k, coin: r.coin, shortVenue: r.shortVenue, longVenue: r.longVenue,
          entryT: t, entryIso: new Date(t).toISOString(),
          size: g.size, sizedDown: g.sizedDown,
          entryNetRoiPctYr: r.netRoiPctYr,
          entryNetUsdPerDayPer1k: r.netUsdPerDayPer1k,
          entryTier: r.tier, entryVerdict: r.verdict,
          entryThin: !!(r.thinFlag || r.depthThin),
          entryCapacityUsd: r.greenCapacityUsd != null ? r.greenCapacityUsd : r.capacityUsd,
          totalFeesPct: r.totalFeesPct,
          feesUsd: (r.totalFeesPct / 100) * g.size,
          dailyCarryCost: ((r.totalFeesPct / 100) * g.size) / CARRY_HORIZON_DAYS,
          shortIntervalMs: (r.shortIntervalH || 1) * 3_600_000,
          longIntervalMs:  (r.longIntervalH  || 1) * 3_600_000,
          cursorT: t, cumFundingUsd: 0, settledPoints: 0, marks: 0,
          negCarryStreak: 0, goneStreak: 0,
          lastTrailingNetPerDay: null, unknown: false, unknownLeg: null,
        });
      }
    }
    snaps = null;   // release the day before reading the next
  }

  // (c) window end
  for (const p of [...open.values()]) closeTrade(p, lastT, 'window_end');

  const known   = closed.filter(p => !p.unknown);
  const unknown = closed.filter(p =>  p.unknown);
  const gross   = known.reduce((s, p) => s + p.cumFundingUsd, 0);
  const fees    = known.reduce((s, p) => s + p.feesUsd, 0);
  const net     = known.reduce((s, p) => s + p.netUsd, 0);
  const holds   = known.map(p => p.holdDays).sort((a, b) => a - b);
  const reasons = {};
  for (const p of closed) reasons[p.exitReason] = (reasons[p.exitReason] || 0) + 1;

  const top = [...known].sort((a, b) => b.netUsd - a.netUsd);
  const slim = p => ({
    key: p.key, coin: p.coin, shortVenue: p.shortVenue, longVenue: p.longVenue,
    entry: p.entryIso, exit: new Date(p.exitT).toISOString(), exitReason: p.exitReason,
    holdDays: +p.holdDays.toFixed(3), sizeUsd: p.size, sizedDown: p.sizedDown,
    entryNetRoiPctYr: p.entryNetRoiPctYr, entryTier: p.entryTier, entryThin: p.entryThin,
    grossFundingUsd: +p.cumFundingUsd.toFixed(4), feesUsd: +p.feesUsd.toFixed(4),
    netUsd: +p.netUsd.toFixed(4), settledPoints: p.settledPoints, marks: p.marks,
    lastTrailingNetPerDay: p.lastTrailingNetPerDay == null ? null : +p.lastTrailingNetPerDay.toFixed(5),
  });

  return {
    ticketUsd: ticket,
    variant: opts.label || 'default',
    reentry: REENTRY, carryJudgeHours: CARRY_JUDGE_MS / 3_600_000,
    selectivity: SEL,
    uniquePairsTraded: new Set(closed.map(p => p.key)).size,
    windowFrom: new Date(firstT).toISOString(), windowTo: new Date(lastT).toISOString(),
    snapshots, rowsSeen,
    tradesOpened: closed.length,
    tradesClosed: closed.length,
    stillOpenAtWindowEnd: reasons.window_end || 0,
    unknownCount: unknown.length,
    countedInPnl: known.length,
    grossFundingUsd: +gross.toFixed(2),
    totalFeesUsd: +fees.toFixed(2),
    netPnlUsd: +net.toFixed(2),
    winners: known.filter(p => p.netUsd > 0).length,
    losers:  known.filter(p => p.netUsd < 0).length,
    flat:    known.filter(p => p.netUsd === 0).length,
    medianHoldDays: holds.length ? +holds[Math.floor(holds.length / 2)].toFixed(3) : null,
    exitReasons: reasons,
    rejectedAtEntry: reject,
    top10: top.slice(0, 10).map(slim),
    bottom10: top.slice(-10).reverse().map(slim),
    perDayNetUsd: [...perDay.entries()].sort().map(([d, v]) => ({ day: d, netUsd: +v.toFixed(2) })),
    sampleTrades: known.slice(0, 10).map(slim),
    thinSplit: {
      thinCount: known.filter(p => p.entryThin).length,
      thinNetUsd: +known.filter(p => p.entryThin).reduce((s, p) => s + p.netUsd, 0).toFixed(2),
      execCount: known.filter(p => !p.entryThin).length,
      execNetUsd: +known.filter(p => !p.entryThin).reduce((s, p) => s + p.netUsd, 0).toFixed(2),
    },
  };
}

// ── main ─────────────────────────────────────────────────────────────────────
const { accrual, files: accFiles, rawPoints, dedupPoints } = buildAccrual();
const files = snapshotFiles();
console.error(`[bt] accrual: ${accFiles} file(s), ${rawPoints} raw → ${dedupPoints} deduped points`);
console.error(`[bt] snapshot files: ${files.length}`);

// Three variants. The carry-judge cadence is a METHODOLOGY choice, not a strategy parameter —
// judging every 15-min snapshot churns the book on round-trip fees purely because the board is
// sampled 4x/hour. Reporting all three makes the sensitivity visible instead of hiding it.
const VARIANTS = [
  { label: 'A_reentry_judge15min', reentry: true,  carryJudgeMs: 0 },
  { label: 'B_reentry_judge6h',    reentry: true,  carryJudgeMs: 6 * 3_600_000 },
  { label: 'C_singleentry_judge6h',reentry: false, carryJudgeMs: 6 * 3_600_000 },
  { label: 'D_harvest_only_judge6h', reentry: true, carryJudgeMs: 6 * 3_600_000,
    select: { tier: 'HARVEST' } },
  { label: 'E_harvest_fastpayback_notthin', reentry: true, carryJudgeMs: 6 * 3_600_000,
    select: { tier: 'HARVEST', maxBreakevenDays: 3, requireNotThin: true } },
];

const results = {};
for (const v of VARIANTS) {
  for (const ticket of TICKETS) {
    const k = `${v.label}__ticket_${ticket}`;
    console.error(`[bt] ${k} ...`);
    results[k] = runSim(ticket, files, accrual, v);
    const r = results[k];
    console.error(`[bt]   → net $${r.netPnlUsd} | ${r.countedInPnl} trades | ${r.uniquePairsTraded} unique pairs | median hold ${r.medianHoldDays}d`);
  }
}

const out = {
  kind: 'funding-rolling-backtest',
  generatedAt: new Date().toISOString(),
  simulated: true,
  window: { from: results.A_reentry_judge15min__ticket_1000.windowFrom,
            to:   results.A_reentry_judge15min__ticket_1000.windowTo },
  variants: {
    A_reentry_judge15min: 'carry judged at every 15-min snapshot, re-entry allowed — churns on round-trip fees; reported to expose the cadence artifact, NOT the headline',
    B_reentry_judge6h:    'carry judged at most 6-hourly (agent32-comparable mark cadence), re-entry allowed — the fairest rolling read',
    C_singleentry_judge6h:'carry judged 6-hourly, ONE entry per pair for the whole window — the closest structural analogue to agent32\'s single cohort',
    D_harvest_only_judge6h: 'as B, but only the board\'s own HARVEST tier is eligible — drops MARGINAL/CAUTION spreads whose fee payback exceeds their lifetime',
    E_harvest_fastpayback_notthin: 'as D, plus breakevenDays <= 3 and non-thin depth — the most selective honest read: only strong, fast-paying, genuinely fillable spreads',
  },
  sources: {
    board:   'data/history/funding/*.json (real 15-min snapshots, agent15 → lib/history-logger.js)',
    accrual: ['data/funding-history-14d.json', '/tmp/funding-history-cache.json'],
    accrualPoints: dedupPoints,
  },
  rules: {
    leverage: '1x — no source opportunity specified leverage',
    entry: 'first snapshot a (coin|shortVenue|longVenue) pair appears while flat, gated on the board\'s own net-of-fees netRoiPctYr > 0 AND fullyConfirmed AND !oneLegUnverified AND !spikeFlag; size = min(ticket, greenCapacityUsd ?? capacityUsd) from the REAL walked book',
    accrual: 'real settled funding replayed hour by hour; net = (shortRate − longRate) × size, Δt-weighted ≤ 1 settlement/sample (agent32 accrueSettled parity)',
    exit_a: `carry<=fees — trailingNetPerDay <= feesUsd/${CARRY_HORIZON_DAYS}d for ${CLOSE_CARRY_STREAK_N} consecutive marks that had new settled funding`,
    exit_b: `spread_gone — key absent from ${SOURCE_GONE_STREAK_N} consecutive board snapshots`,
    exit_c: 'window_end — still open at the final snapshot, closed at accrued value',
    fees: 'board totalFeesPct — round-trip, BOTH legs, open+close (lib/guardian-suppress.js F25). Pure percentage: NO fixed component, so fees do not amortise away with size',
    unknown: 'a held pair with no settled-funding series on either venue is marked UNKNOWN and excluded from P&L — never assumed zero',
  },
  limitations: [
    'The funding history rows contain NO bid/ask and NO ladder — lib/history-logger.js never stored prices. Execution slippage beyond the round-trip fee model is NOT simulated. Depth is honoured only as a size cap via the real walked capacityUsd. This FLATTERS the strategy; it is not a fill simulation.',
    'Re-entry is allowed: after a pair closes it may re-open on a later snapshot that passes the entry gate. This makes the run rolling rather than single-cohort.',
    'Annualised figures are deliberately omitted from the headline; net $ over the real window is the primary number.',
  ],
  results,
};

fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
console.error(`[bt] wrote ${OUT_FILE}`);
