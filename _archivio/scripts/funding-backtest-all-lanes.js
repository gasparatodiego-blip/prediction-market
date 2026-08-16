#!/usr/bin/env node
'use strict';
/**
 * ALL-LANE FUNDING BACKTEST + 4-DAY MINIMUM-HOLD TEST — Jul 6→19 real board history.
 *
 * OFFLINE ANALYSIS. Reads only. Not wired into any agent, API or the dashboard.
 *
 * ── LANE INVENTORY (verified, not assumed) ──────────────────────────────────
 *   perp-perp      data/history/funding/      Jul 6→19   FULL fidelity (fees + real walked depth)
 *   perp-spot      data/history/perp-spot/    Jul 7→19   NO depth field persisted (see limitation)
 *   usdc-margined  ABSENT — no agent ever calls appendSnapshot('usdc'...). The only
 *                  appendSnapshot sections in the tree are funding, perp-spot, basis,
 *                  predarb, rewards-poly, rewards-kalshi, leaderboard, sports. agent15
 *                  snapshots only `o.type === 'FUNDING'` (perp/perp) into 'funding', and
 *                  the projector stores no settlement/margin discriminator. There is no
 *                  USDC-margined board history on disk, so that lane CANNOT be backtested.
 *                  It is reported as impossible and skipped. Nothing is fabricated for it.
 *
 * ── SMALL-SAMPLE FRAME (stated in the output, not buried) ───────────────────
 *   The board history is ~13 days. A 4-day-minimum-hold strategy fits at most ~3
 *   non-overlapping holds. Every 4-day conclusion here is LOW CONFIDENCE BY
 *   CONSTRUCTION. A positive result is "promising, sample far too small" — never
 *   "edge confirmed".
 *
 * ── THE 4-DAY LOGIC TRAP, handled explicitly ────────────────────────────────
 *   A delta-neutral funding position only earns the funding GAP while the gap exists.
 *   Forcing a 4-day hold after the spread leaves the board means holding two legs that
 *   no longer arbitrage. This is modelled honestly and NOT assumed away: accrual always
 *   replays the REAL settled funding series for the legs actually held, whether or not
 *   the pair is still on the board. If the gap collapses or inverts, the position eats
 *   that — exactly as it would live. Two separate readings:
 *     V3a  hold >=4d, but only ENTER spreads whose board life actually lasted >=4d
 *          → "among spreads that DID last, was holding them >=4d positive?"
 *     V3b  enter on appearance, FORCE 4 days regardless of the spread dying
 *          → "does the naive 'just hold 4 days' rule help or hurt?"
 *
 * ── ACCRUAL (identical to agent32 accrueSettled, per lane) ──────────────────
 *   perp-perp : net = (shortLegRate − longLegRate) × size   (collect short, pay long)
 *   perp-spot : net = shortLegRate × size                   (short perp collects; the spot
 *               hedge earns no funding — matches agent32 markPerpSpot)
 *   Source: data/funding-history-14d.json + /tmp/funding-history-cache.json, deduped by
 *   settlement timestamp, Δt-weighted ≤ 1 settlement per sample. Never modelled.
 *
 * ── FEES ────────────────────────────────────────────────────────────────────
 *   perp-perp : the board's own totalFeesPct (round-trip, BOTH legs).
 *   perp-spot : lib/funding-math roundTripPerpSpotPct(shortVenue, spotVenue) — the repo's
 *               real fee model: perp taker ×2 + spot taker ×2. The perp-spot rows persist
 *               no fee field, so this is the engine's own SSOT, not an invented number.
 *
 * ── LIMITATIONS (both lanes flatter the strategy) ───────────────────────────
 *   1. No lane persisted bid/ask or a ladder — history-logger stores no prices. Execution
 *      slippage BEYOND the round-trip fee model is not simulated.
 *   2. perp-spot persisted NO capacity/depth field at all, so its sizing CANNOT be
 *      depth-capped. perp-spot results assume the ticket always fills. perp-perp IS
 *      depth-capped by the real walked capacityUsd. This asymmetry is reported.
 */

const fs   = require('fs');
const path = require('path');
const FM   = require('../lib/funding-math');

const ROOT       = path.join(__dirname, '..');
const FUND_14D   = path.join(ROOT, 'data', 'funding-history-14d.json');
const FUND_CACHE = '/tmp/funding-history-cache.json';
const OUT_FILE   = path.join(ROOT, 'data', 'funding-backtest-all-lanes.json');

const TICKETS              = [1000, 10000];
const CLOSE_CARRY_STREAK_N = 2;
const SOURCE_GONE_STREAK_N = 2;
const CARRY_HORIZON_DAYS   = 7;
const CARRY_JUDGE_MS       = 6 * 3_600_000;   // agent32-comparable mark cadence
const MIN_HOLD_DAYS        = 4;
const DAY_MS               = 86_400_000;

// ── accrual index ────────────────────────────────────────────────────────────
function buildAccrual() {
  const byVenue = new Map();
  let raw = 0;
  for (const f of [FUND_14D, FUND_CACHE]) {
    let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    if (!j || !j.data) continue;
    for (const venue of Object.keys(j.data)) {
      if (!byVenue.has(venue)) byVenue.set(venue, new Map());
      const vm = byVenue.get(venue);
      for (const coin of Object.keys(j.data[venue])) {
        const arr = j.data[venue][coin];
        if (!Array.isArray(arr)) continue;
        if (!vm.has(coin)) vm.set(coin, new Map());
        const cm = vm.get(coin);
        for (const p of arr) {
          if (!p || typeof p.t !== 'number' || typeof p.rate !== 'number') continue;
          raw++;
          if (!cm.has(p.t)) cm.set(p.t, p.rate);
        }
      }
    }
  }
  const out = new Map(); let dedup = 0;
  for (const [venue, vm] of byVenue) {
    const o = new Map();
    for (const [coin, cm] of vm) {
      const pts = [...cm.entries()].map(([t, rate]) => ({ t, rate })).sort((a, b) => a.t - b.t);
      dedup += pts.length; o.set(coin, pts);
    }
    out.set(venue, o);
  }
  return { accrual: out, raw, dedup };
}

function accrueSettled(accrual, venue, coin, sinceT, untilT, intervalMs) {
  const vm = accrual.get(venue);
  const pts = vm && vm.get(coin);
  if (!pts || !pts.length) return null;              // → caller marks UNKNOWN, never assumes 0
  const iv = Number(intervalMs) > 0 ? Number(intervalMs) : null;
  let sumRate = 0, points = 0, lastT = sinceT;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.t <= sinceT || p.t > untilT) continue;
    let w = 1;
    if (iv) { const prevT = i > 0 ? pts[i - 1].t : (p.t - iv); w = Math.min((p.t - prevT) / iv, 1); }
    sumRate += (p.rate / 100) * w; points++;
    if (p.t > lastT) lastT = p.t;
  }
  return { sumRate, points, lastT };
}

// ── lane loaders → compact column store ──────────────────────────────────────
// Columns are parallel arrays over "presence events" (one row seen in one snapshot),
// already grouped by snapshot, so all variants replay from memory without re-reading.
function loadLane(lane) {
  const dir = path.join(ROOT, 'data', 'history', lane === 'perp-perp' ? 'funding' : 'perp-spot');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => /^\d{4}-\d{2}-\d{2}(\.\d+)?\.json$/.test(f))
    .map(n => { const m = n.match(/^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.json$/);
                return { name: n, day: m[1], part: m[2] ? +m[2] : 0 }; })
    .sort((a, b) => a.day === b.day ? a.part - b.part : (a.day < b.day ? -1 : 1));

  const keys = [], keyIdx = new Map(), keyMeta = [];
  const snapT = [], snapStart = [];
  const evKey = [], evNetPctYr = [], evFeesPct = [], evCap = [], evBreakeven = [];
  const evTier = [], evFlags = [], evShortIv = [], evLongIv = [];
  let excludedRows = 0;

  for (const f of files) {
    let snaps; try { snaps = JSON.parse(fs.readFileSync(path.join(dir, f.name), 'utf8')); } catch { continue; }
    if (!Array.isArray(snaps)) continue;
    for (const s of snaps) {
      if (typeof s.t !== 'number' || !Array.isArray(s.rows)) continue;
      snapStart.push(evKey.length); snapT.push(s.t);
      for (const r of s.rows) {
        let key, meta, netPctYr, feesPct, cap, breakeven, tier, flags, sIv, lIv;

        if (lane === 'perp-perp') {
          if (r.coin == null || r.shortVenue == null || r.longVenue == null) { excludedRows++; continue; }
          key  = `${r.coin}|${r.shortVenue}|${r.longVenue}`;
          meta = { coin: r.coin, shortVenue: r.shortVenue, longVenue: r.longVenue };
          netPctYr  = r.netRoiPctYr;
          feesPct   = r.totalFeesPct;
          cap       = r.greenCapacityUsd != null ? r.greenCapacityUsd : r.capacityUsd;
          breakeven = r.breakevenDays;
          tier      = r.tier === 'HARVEST' ? 1 : 0;
          flags     = (r.fullyConfirmed === true ? 1 : 0)
                    | (r.oneLegUnverified === true ? 2 : 0)
                    | (r.spikeFlag === true ? 4 : 0)
                    | ((r.thinFlag || r.depthThin) ? 8 : 0);
          sIv = r.shortIntervalH || 1; lIv = r.longIntervalH || 1;
        } else {
          // perp-spot: short the perp, long the spot hedge. Spot earns no funding.
          if (r.coin == null || r.shortVenue == null) { excludedRows++; continue; }
          const spot = r.spotVenueSuggested || null;
          if (!spot) { excludedRows++; continue; }
          key  = `${r.coin}|${r.shortVenue}|spot:${spot}`;
          meta = { coin: r.coin, shortVenue: r.shortVenue, longVenue: `spot:${spot}` };
          // fundingPct8h is a PERCENT per 8h (the ×100 trap) → %/yr = ×3×365.
          const grossPctYr = (r.fundingPct8h == null) ? null : r.fundingPct8h * 3 * 365;
          feesPct   = FM.roundTripPerpSpotPct(r.shortVenue, spot);
          netPctYr  = grossPctYr == null ? null : FM.netApy30d(grossPctYr, feesPct);
          breakeven = grossPctYr ? FM.breakevenDays(grossPctYr, feesPct) : null;
          cap       = null;                                   // NO depth persisted for this lane
          tier      = (r.trailingPositiveSettlements || 0) >= 12 ? 1 : 0;
          flags     = (r.spotVenueVerified === true ? 1 : 0);  // verified spot leg ≈ "confirmed"
          sIv = r.intervalH || 1; lIv = 0;
        }

        let ki = keyIdx.get(key);
        if (ki === undefined) { ki = keys.length; keyIdx.set(key, ki); keys.push(key); keyMeta.push(meta); }
        evKey.push(ki); evNetPctYr.push(netPctYr); evFeesPct.push(feesPct); evCap.push(cap);
        evBreakeven.push(breakeven); evTier.push(tier); evFlags.push(flags);
        evShortIv.push(sIv); evLongIv.push(lIv);
      }
    }
    snaps = null;
  }
  snapStart.push(evKey.length);

  // presence runs per key (a run tolerates gaps < SOURCE_GONE_STREAK_N snapshots)
  const presence = new Map();
  for (let si = 0; si < snapT.length; si++) {
    for (let e = snapStart[si]; e < snapStart[si + 1]; e++) {
      const k = evKey[e];
      let a = presence.get(k); if (!a) { a = []; presence.set(k, a); }
      if (a.length === 0 || a[a.length - 1] !== si) a.push(si);
    }
  }
  const runEndBySnap = new Map();   // `${key}:${snapIdx}` → snapIdx the run ends at
  for (const [k, idxs] of presence) {
    let runStart = 0;
    for (let i = 0; i < idxs.length; i++) {
      const isLast = i === idxs.length - 1;
      const breaks = isLast || (idxs[i + 1] - idxs[i]) > SOURCE_GONE_STREAK_N;
      if (breaks) {
        const endIdx = idxs[i];
        for (let j = runStart; j <= i; j++) runEndBySnap.set(`${k}:${idxs[j]}`, endIdx);
        runStart = i + 1;
      }
    }
  }

  return { lane, keys, keyMeta, snapT, snapStart, evKey, evNetPctYr, evFeesPct, evCap,
           evBreakeven, evTier, evFlags, evShortIv, evLongIv, runEndBySnap, excludedRows };
}

// ── entry gate ───────────────────────────────────────────────────────────────
function gate(L, e, si, ticket, V, tally) {
  const net = L.evNetPctYr[e], fees = L.evFeesPct[e];
  if (net == null || !Number.isFinite(net)) { tally.no_net_roi++; return null; }
  if (net <= 0)                             { tally.net_edge_nonpos++; return null; }
  if (fees == null || !Number.isFinite(fees)) { tally.no_fee++; return null; }
  const fl = L.evFlags[e];
  if (L.lane === 'perp-perp') {
    if (!(fl & 1))  { tally.not_confirmed++; return null; }
    if (fl & 2)     { tally.one_leg_unverified++; return null; }
    if (fl & 4)     { tally.spike_flag++; return null; }
  }
  if (V.selective) {
    if (!L.evTier[e]) { tally.tier_filtered++; return null; }
    const be = L.evBreakeven[e];
    if (be == null || be <= 0 || be > 3) { tally.breakeven_too_long++; return null; }
    if (L.lane === 'perp-perp') { if (fl & 8) { tally.thin_filtered++; return null; } }
    else                        { if (!(fl & 1)) { tally.spot_unverified++; return null; } }
  }
  if (V.requirePersist4d) {
    const endIdx = L.runEndBySnap.get(`${L.evKey[e]}:${si}`);
    if (endIdx == null) { tally.no_run++; return null; }
    if ((L.snapT[endIdx] - L.snapT[si]) < MIN_HOLD_DAYS * DAY_MS) { tally.run_too_short++; return null; }
  }
  // sizing: perp-perp caps at the REAL walked book; perp-spot persisted no depth at all
  let size = ticket, sizedDown = false;
  if (L.lane === 'perp-perp') {
    const cap = L.evCap[e];
    if (cap == null)  { tally.no_capacity++; return null; }
    if (cap <= 0)     { tally.zero_capacity++; return null; }
    size = Math.min(ticket, cap); sizedDown = size < ticket;
    if (sizedDown) tally.sized_down++;
  } else {
    tally.no_depth_data_uncapped++;
  }
  return { size, sizedDown };
}

function runSim(L, ticket, V, accrual) {
  const open = new Map(); const closed = [];
  const tally = { no_net_roi:0, net_edge_nonpos:0, no_fee:0, not_confirmed:0, one_leg_unverified:0,
                  spike_flag:0, tier_filtered:0, breakeven_too_long:0, thin_filtered:0,
                  spot_unverified:0, no_run:0, run_too_short:0, no_capacity:0, zero_capacity:0,
                  sized_down:0, no_depth_data_uncapped:0 };
  const perDay = new Map();

  const close = (p, t, reason) => {
    p.exitT = t; p.exitReason = reason;
    p.netUsd = p.unknown ? null : p.cumFundingUsd - p.feesUsd;
    p.holdDays = (t - p.entryT) / DAY_MS;
    closed.push(p);
    if (!p.unknown) {
      const d = new Date(t).toISOString().slice(0, 10);
      perDay.set(d, (perDay.get(d) || 0) + p.netUsd);
    }
    open.delete(p.keyId);
  };

  for (let si = 0; si < L.snapT.length; si++) {
    const t = L.snapT[si];
    const present = new Set();
    for (let e = L.snapStart[si]; e < L.snapStart[si + 1]; e++) present.add(L.evKey[e]);

    // 1. mark + exit
    for (const p of [...open.values()]) {
      const sA = accrueSettled(accrual, p.shortVenue, p.coin, p.cursorT, t, p.shortIvMs);
      const lA = p.spotLeg ? { sumRate: 0, points: 0, lastT: p.cursorT }
                           : accrueSettled(accrual, p.longVenue, p.coin, p.cursorT, t, p.longIvMs);
      if (sA == null || lA == null) {
        p.unknown = true; p.unknownLeg = sA == null ? p.shortVenue : p.longVenue;
      } else {
        const add  = (sA.sumRate - lA.sumRate) * p.size;   // spot leg contributes 0 by construction
        const pts  = sA.points + lA.points;
        const last = Math.max(sA.lastT, lA.lastT);
        const span = (last - p.cursorT) / DAY_MS;
        p.cumFundingUsd += add; p.settledPoints += pts;
        if (pts > 0 && span > 0) {
          p.marks++;
          if (t - (p.lastJudgeT ?? 0) >= CARRY_JUDGE_MS) {
            p.lastJudgeT = t;
            const tnpd = add / span; p.lastTrailingNetPerDay = tnpd;
            p.negCarryStreak = tnpd <= p.dailyCarryCost ? p.negCarryStreak + 1 : 0;
          }
        }
        p.cursorT = Math.max(last, p.cursorT);
      }
      p.goneStreak = present.has(p.keyId) ? 0 : p.goneStreak + 1;

      const heldDays = (t - p.entryT) / DAY_MS;
      if (V.forceHoldDays) {
        // V3b: exits are SUPPRESSED for the forced window — the position keeps accruing whatever
        // the real series gives it, including nothing / negative once the gap dies.
        if (heldDays >= V.forceHoldDays) { close(p, t, 'forced_hold_done'); }
        continue;
      }
      if (V.minHoldDays && heldDays < V.minHoldDays) continue;   // V3a floor
      if (p.negCarryStreak >= CLOSE_CARRY_STREAK_N) { close(p, t, 'carry<=fees'); continue; }
      if (p.goneStreak    >= SOURCE_GONE_STREAK_N)  { close(p, t, 'spread_gone'); continue; }
    }

    // 2. open
    for (let e = L.snapStart[si]; e < L.snapStart[si + 1]; e++) {
      const ki = L.evKey[e];
      if (open.has(ki)) continue;
      const g = gate(L, e, si, ticket, V, tally);
      if (!g) continue;
      const m = L.keyMeta[ki];
      const feesUsd = (L.evFeesPct[e] / 100) * g.size;
      open.set(ki, {
        keyId: ki, key: L.keys[ki], coin: m.coin, shortVenue: m.shortVenue, longVenue: m.longVenue,
        spotLeg: L.lane === 'perp-spot',
        entryT: t, entryIso: new Date(t).toISOString(),
        size: g.size, sizedDown: g.sizedDown,
        entryNetPctYr: L.evNetPctYr[e], entryBreakevenDays: L.evBreakeven[e],
        entryTier: L.evTier[e] ? 'HARVEST-equiv' : 'lower',
        entryThin: !!(L.evFlags[e] & 8),
        totalFeesPct: L.evFeesPct[e], feesUsd,
        dailyCarryCost: feesUsd / CARRY_HORIZON_DAYS,
        shortIvMs: (L.evShortIv[e] || 1) * 3_600_000,
        longIvMs:  (L.evLongIv[e]  || 1) * 3_600_000,
        cursorT: t, cumFundingUsd: 0, settledPoints: 0, marks: 0,
        negCarryStreak: 0, goneStreak: 0, lastTrailingNetPerDay: null,
        unknown: false, unknownLeg: null,
      });
    }
  }
  const endT = L.snapT[L.snapT.length - 1];
  for (const p of [...open.values()]) close(p, endT, 'window_end');

  const known = closed.filter(p => !p.unknown);
  const unk   = closed.filter(p =>  p.unknown);
  const holds = known.map(p => p.holdDays).sort((a, b) => a - b);
  const reasons = {}; for (const p of closed) reasons[p.exitReason] = (reasons[p.exitReason] || 0) + 1;
  const byKey = {}; for (const p of known) byKey[p.key] = (byKey[p.key] || 0) + p.netUsd;

  const slim = p => ({
    key: p.key, coin: p.coin, shortVenue: p.shortVenue, longVenue: p.longVenue,
    entry: p.entryIso, exit: new Date(p.exitT).toISOString(), exitReason: p.exitReason,
    holdDays: +p.holdDays.toFixed(3), sizeUsd: p.size, sizedDown: p.sizedDown,
    entryNetPctYr: p.entryNetPctYr == null ? null : +p.entryNetPctYr.toFixed(2),
    entryBreakevenDays: p.entryBreakevenDays, entryTier: p.entryTier,
    grossFundingUsd: +p.cumFundingUsd.toFixed(4), feesUsd: +p.feesUsd.toFixed(4),
    netUsd: +p.netUsd.toFixed(4), settledPoints: p.settledPoints, marks: p.marks,
  });
  const sorted = [...known].sort((a, b) => b.netUsd - a.netUsd);

  return {
    lane: L.lane, ticketUsd: ticket, variant: V.label,
    trades: closed.length, countedInPnl: known.length, unknownCount: unk.length,
    uniquePairsTraded: new Set(closed.map(p => p.key)).size,
    grossFundingUsd: +known.reduce((s, p) => s + p.cumFundingUsd, 0).toFixed(2),
    totalFeesUsd:    +known.reduce((s, p) => s + p.feesUsd, 0).toFixed(2),
    netPnlUsd:       +known.reduce((s, p) => s + p.netUsd, 0).toFixed(2),
    winners: known.filter(p => p.netUsd > 0).length,
    losers:  known.filter(p => p.netUsd < 0).length,
    medianHoldDays: holds.length ? +holds[Math.floor(holds.length / 2)].toFixed(3) : null,
    maxHoldDays:    holds.length ? +holds[holds.length - 1].toFixed(3) : null,
    exitReasons: reasons,
    rejectedAtEntry: tally,
    perDayNetUsd: [...perDay.entries()].sort().map(([d, v]) => ({ day: d, netUsd: +v.toFixed(2) })),
    top10: sorted.slice(0, 10).map(slim),
    bottom5: sorted.slice(-5).reverse().map(slim),
    // V3a is the falsifiable centrepiece — list EVERY trade, there will be few.
    allTrades: V.listAllTrades ? known.map(slim) : null,
    concentration: Object.entries(byKey).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([k, v]) => ({ pair: k, netUsd: +v.toFixed(2), holds: known.filter(p => p.key === k).length })),
    independentHolds: new Set(known.map(p => p.key)).size,
  };
}

// ── variants ─────────────────────────────────────────────────────────────────
const VARIANTS = [
  { label: 'V1_naive' },
  { label: 'V2_selective', selective: true },
  { label: 'V3a_hold4d_if_alive', minHoldDays: MIN_HOLD_DAYS, requirePersist4d: true, listAllTrades: true },
  { label: 'V3b_force4d_regardless', forceHoldDays: MIN_HOLD_DAYS },
];

const { accrual, raw, dedup } = buildAccrual();
console.error(`[bt] accrual ${raw} raw → ${dedup} deduped points`);

const LANES = ['perp-perp', 'perp-spot'];
const results = {};
const laneInfo = {};

for (const lane of LANES) {
  console.error(`[bt] loading lane ${lane} ...`);
  const L = loadLane(lane);
  if (!L) { console.error(`[bt]   lane ${lane} MISSING`); continue; }
  laneInfo[lane] = {
    snapshots: L.snapT.length, presenceEvents: L.evKey.length, uniquePairs: L.keys.length,
    from: new Date(L.snapT[0]).toISOString(), to: new Date(L.snapT[L.snapT.length - 1]).toISOString(),
    rowsExcludedMalformed: L.excludedRows,
    depthCapped: lane === 'perp-perp',
  };
  console.error(`[bt]   ${L.snapT.length} snapshots, ${L.evKey.length} events, ${L.keys.length} pairs`);
  for (const V of VARIANTS) {
    for (const ticket of TICKETS) {
      const k = `${lane}__${V.label}__${ticket}`;
      const r = runSim(L, ticket, V, accrual);
      results[k] = r;
      console.error(`[bt]   ${k}: net $${r.netPnlUsd} | ${r.countedInPnl} trades | ${r.independentHolds} pairs | med ${r.medianHoldDays}d`);
    }
  }
}

const out = {
  kind: 'funding-all-lane-backtest',
  generatedAt: new Date().toISOString(),
  simulated: true,
  smallSampleFrame: 'Board history is ~13 days. A 4-day minimum hold fits at most ~3 non-overlapping holds. All 4-day conclusions are LOW CONFIDENCE BY CONSTRUCTION — a positive result is "promising, sample far too small", never "edge confirmed".',
  lanes: {
    'perp-perp':     { status: 'backtested', source: 'data/history/funding/', depthCapped: true },
    'perp-spot':     { status: 'backtested', source: 'data/history/perp-spot/', depthCapped: false,
                       caveat: 'This lane persisted NO capacity/depth field, so sizing could not be depth-capped — results assume the ticket always fills, which flatters them. Fees from lib/funding-math roundTripPerpSpotPct (the repo SSOT).' },
    'usdc-margined': { status: 'IMPOSSIBLE — no board history exists',
                       evidence: 'No agent calls appendSnapshot for a usdc/margined section; the only sections written are funding, perp-spot, basis, predarb, rewards-poly, rewards-kalshi, leaderboard, sports. agent15 snapshots only o.type === "FUNDING" into "funding", and lib/history-logger.js stores no settlement/margin discriminator.',
                       action: 'Reported and skipped. No figure was fabricated for this lane.' },
  },
  laneInfo,
  rules: {
    V1_naive: 'enter any positive net-of-fees opportunity passing verification; exit on carry<=fees (2 marks, judged ≤6-hourly) OR spread_gone (2 snapshots) OR window_end',
    V2_selective: 'as V1 plus best-tier only (perp-perp HARVEST / perp-spot trailingPositiveSettlements>=12), fee payback <= 3 days, and non-thin (perp-perp) / verified spot leg (perp-spot)',
    V3a_hold4d_if_alive: 'enter ONLY where the pair\'s own board run lasted >= 4 days from entry, then hold >= 4 days before any exit rule may fire — "among spreads that DID last, was holding them >=4d positive?"',
    V3b_force4d_regardless: 'enter as V1 then force-hold exactly 4 days with ALL exits suppressed; real settled funding keeps accruing on the legs actually held even after the spread leaves the board (gap collapse is eaten, not assumed away)',
    accrual: 'perp-perp net = (shortRate − longRate) × size; perp-spot net = shortRate × size (spot hedge earns no funding). agent32 accrueSettled parity.',
    unknown: 'a held pair with no settled series on a needed venue is marked UNKNOWN and excluded from P&L — never assumed zero',
  },
  accrualPoints: dedup,
  results,
};
fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
console.error(`[bt] wrote ${OUT_FILE}`);
