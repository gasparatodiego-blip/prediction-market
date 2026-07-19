#!/usr/bin/env node
'use strict';
/**
 * OPEN-AND-HOLD-UNTIL-FUNDING-ZEROES BACKTEST — full TAKER fees, Jul 6→19 real board history.
 *
 * OFFLINE ANALYSIS. Reads only. Not wired into any agent, API or the dashboard.
 *
 * ── WHAT MAKES THIS DIFFERENT FROM THE PRIOR BACKTESTS ──────────────────────
 *   funding-backtest-all-lanes.js closed on carry<=fees / spread_gone, so every
 *   cycle re-paid a round trip — the fee bill dominated (perp-perp V1 net −$11,902).
 *   THIS run opens ONCE per pair, pays the entry taker fee ONCE, HOLDS through
 *   whatever the real settled series does (including negative funding), and closes
 *   ONLY when the funding gap itself decays to ~zero. It isolates whether the RAW
 *   carry pays, separated from continuous re-trading cost — the Ethena
 *   "hold the carry" model, priced at retail TAKER on both legs (worst case).
 *
 * ── THE TWO LANES (different leg structures — never conflated) ───────────────
 *   PRIMARY  perp-vs-spot : LONG spot + SHORT perp, same coin. Funding earned is the
 *            perp's OWN funding (the spot hedge pays/earns none). This is the raw
 *            persistent carry. Source data/history/perp-spot/.
 *   CONTROL  cross-venue perp/perp : SHORT the higher-funding venue + LONG the lower.
 *            Earned is the DIFFERENCE only. Most venues quote the same 10.95%/yr
 *            default, so the spread is structurally ~0 and this lane is EXPECTED to
 *            come out flat. If it does, any PRIMARY edge is raw-vs-spot carry rather
 *            than a cross-venue spread. Source data/history/funding/.
 *
 * ── FEES: FULL TAKER, BOTH LEGS, BOTH LANES ─────────────────────────────────
 *   Recomputed from the repo's own sourced taker table (lib/funding-math), NOT taken
 *   from the board's persisted totalFeesPct, so "full taker" is guaranteed rather
 *   than inherited:
 *     perp-perp : roundTripFeeByVenue(short, long) = (takerShort + takerLong) × 2
 *     perp-spot : roundTripPerpSpotPct(short, spot) = perpTaker×2 + spotTaker×2
 *   Entry pays HALF the round trip; exit pays the other half, and ONLY if the
 *   position actually closes in-window. Open positions are charged entry fee only.
 *
 * ── ACCRUAL — real settled funding, hour-bucketed, never modelled ────────────
 *   data/funding-history-14d.json (+ /tmp/funding-history-cache.json when present),
 *   deduped by settlement timestamp, Δt-weighted at ≤1 settlement per sample (the
 *   agent32 accrueSettled convention; see the Paradex 8h-resample trap).
 *   Contributions are bucketed into UTC hours so the perp-perp NET gap can be signed
 *   per hour even when the two venues settle on different clocks:
 *     perp-perp netHour = shortHourRate − longHourRate
 *     perp-spot netHour = shortHourRate                 (spot leg contributes 0)
 *   A held pair with no settled series on a needed venue is UNKNOWN → excluded from
 *   P&L entirely and counted. Never assumed to be zero.
 *
 * ── NEGATIVE FUNDING IS NEVER FLOORED ───────────────────────────────────────
 *   Hours where netHour < 0 are accrued as a real cost (this is the Ethena risk:
 *   a held position PAYS when funding inverts) and are also tallied separately so
 *   the drag is reported explicitly rather than netted away silently.
 *
 * ── EXIT: exactly two triggers ──────────────────────────────────────────────
 *   (a) FUNDING ZEROED — judged every 6h on the position's OWN realised trailing 24h
 *       funding, annualised. When |trailing %/yr| <= 5% of the entry gross %/yr for
 *       ZERO_STREAK_N consecutive judgements (24h sustained), the gap is gone: pay
 *       the exit taker fee, CLOSED trade, counted as realised.
 *       Note the test is on ABSOLUTE trailing rate — a position whose funding went
 *       strongly negative has NOT "zeroed"; it keeps being held and keeps paying,
 *       exactly as the rules require (no drawdown stop, no time stop).
 *   (b) WINDOW END — history ends before the funding zeroed. The position is STILL
 *       OPEN: marked to window as accrued funding minus the ENTRY fee only, and
 *       reported in a SEPARATE unrealised bucket. Never mixed into realised P&L.
 *
 * ── LIMITATIONS (both flatter the strategy — stated, not buried) ────────────
 *   1. The perp-spot board persisted NO capacity/depth field, so the PRIMARY lane
 *      CANNOT be depth-capped: it assumes the ticket always fills. The CONTROL lane
 *      IS capped at the real walked greenCapacityUsd (never OI, never midpoint).
 *      This asymmetry favours the primary lane and is reported.
 *   2. No lane persisted a bid/ask ladder, so execution slippage BEYOND the taker
 *      fee model is not simulated.
 *   3. ~13 days of history is ONE funding regime. Any positive result is
 *      regime-specific and is not evidence of a durable edge.
 */

const fs   = require('fs');
const path = require('path');
const FM   = require('../lib/funding-math');

const ROOT       = path.join(__dirname, '..');
const FUND_14D   = path.join(ROOT, 'data', 'funding-history-14d.json');
const FUND_CACHE = '/tmp/funding-history-cache.json';
const OUT_FILE   = path.join(ROOT, 'data', 'funding-hold-until-zero.json');

const TICKETS       = [1000, 10000];
const DAY_MS        = 86_400_000;
const HOUR_MS       = 3_600_000;
const JUDGE_MS      = 6 * HOUR_MS;    // decay judged every 6h
const TRAIL_MS      = 24 * HOUR_MS;   // on the trailing 24h of REALISED funding
const ZERO_STREAK_N = 4;              // 4 × 6h = 24h sustained before calling it zero
const ZERO_EPS_FRAC = 0.05;           // "~zero" = <= 5% of the entry gross rate
const RISK_FREE_PCT = 4.0;            // T-bill-ish reference for the %/yr comparison

// ── accrual index (dedup by settlement timestamp) ────────────────────────────
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

/**
 * Per-hour-bucket contribution of ONE leg over (sinceT, untilT].
 * Returns null when the venue/coin has no settled series at all → caller marks UNKNOWN.
 * Rates are Δt-weighted at <= 1 settlement per sample (never summed raw).
 */
function legBuckets(accrual, venue, coin, sinceT, untilT, intervalMs) {
  const vm = accrual.get(venue);
  const pts = vm && vm.get(coin);
  if (!pts || !pts.length) return null;
  const iv = Number(intervalMs) > 0 ? Number(intervalMs) : null;
  const buckets = new Map();
  let points = 0, lastT = sinceT;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.t <= sinceT || p.t > untilT) continue;
    let w = 1;
    if (iv) { const prevT = i > 0 ? pts[i - 1].t : (p.t - iv); w = Math.min((p.t - prevT) / iv, 1); }
    const b = Math.floor(p.t / HOUR_MS);
    buckets.set(b, (buckets.get(b) || 0) + (p.rate / 100) * w);
    points++;
    if (p.t > lastT) lastT = p.t;
  }
  return { buckets, points, lastT };
}

// ── lane loaders ─────────────────────────────────────────────────────────────
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
  const evKey = [], evGrossPctYr = [], evFeesPct = [], evCap = [];
  const evFlags = [], evShortIv = [], evLongIv = [];
  let excludedRows = 0, feeMismatch = 0, feeCompared = 0;

  for (const f of files) {
    let snaps; try { snaps = JSON.parse(fs.readFileSync(path.join(dir, f.name), 'utf8')); } catch { continue; }
    if (!Array.isArray(snaps)) continue;
    for (const s of snaps) {
      if (typeof s.t !== 'number' || !Array.isArray(s.rows)) continue;
      snapStart.push(evKey.length); snapT.push(s.t);
      for (const r of s.rows) {
        let key, meta, grossPctYr, feesPct, cap, flags, sIv, lIv;

        if (lane === 'perp-perp') {
          if (r.coin == null || r.shortVenue == null || r.longVenue == null) { excludedRows++; continue; }
          key  = `${r.coin}|${r.shortVenue}|${r.longVenue}`;
          meta = { coin: r.coin, shortVenue: r.shortVenue, longVenue: r.longVenue };
          grossPctYr = (r.grossRoiPctYr != null) ? r.grossRoiPctYr : r.annualizedROI;
          // FULL TAKER, recomputed from the repo's sourced taker table — not inherited
          // from the board's persisted totalFeesPct (which is only cross-checked here).
          feesPct = FM.roundTripFeeByVenue(r.shortVenue, r.longVenue);
          if (r.totalFeesPct != null) {
            feeCompared++;
            if (Math.abs(r.totalFeesPct - feesPct) > 1e-9) feeMismatch++;
          }
          cap   = r.greenCapacityUsd != null ? r.greenCapacityUsd : r.capacityUsd;
          flags = (r.fullyConfirmed === true ? 1 : 0)
                | (r.oneLegUnverified === true ? 2 : 0)
                | (r.spikeFlag === true ? 4 : 0)
                | ((r.thinFlag || r.depthThin) ? 8 : 0);
          sIv = r.shortIntervalH || 1; lIv = r.longIntervalH || 1;
        } else {
          if (r.coin == null || r.shortVenue == null) { excludedRows++; continue; }
          const spot = r.spotVenueSuggested || null;
          if (!spot) { excludedRows++; continue; }
          key  = `${r.coin}|${r.shortVenue}|spot:${spot}`;
          meta = { coin: r.coin, shortVenue: r.shortVenue, longVenue: `spot:${spot}`, spotVenue: spot };
          // fundingPct8h is a PERCENT per 8h (the ×100 trap) → %/yr = ×3×365.
          grossPctYr = (r.fundingPct8h == null) ? null : r.fundingPct8h * 3 * 365;
          feesPct    = FM.roundTripPerpSpotPct(r.shortVenue, spot);   // perp taker×2 + spot taker×2
          cap        = null;                                          // NO depth persisted
          flags      = (r.spotVenueVerified === true ? 1 : 0);
          sIv = r.intervalH || 1; lIv = 0;
        }

        let ki = keyIdx.get(key);
        if (ki === undefined) { ki = keys.length; keyIdx.set(key, ki); keys.push(key); keyMeta.push(meta); }
        evKey.push(ki); evGrossPctYr.push(grossPctYr); evFeesPct.push(feesPct); evCap.push(cap);
        evFlags.push(flags); evShortIv.push(sIv); evLongIv.push(lIv);
      }
    }
    snaps = null;
  }
  snapStart.push(evKey.length);

  return { lane, keys, keyMeta, snapT, snapStart, evKey, evGrossPctYr, evFeesPct, evCap,
           evFlags, evShortIv, evLongIv, excludedRows, feeMismatch, feeCompared };
}

// ── entry gate: FIRST appearance with POSITIVE funding, sized by real depth ──
function gate(L, e, ticket, tally) {
  const gross = L.evGrossPctYr[e], fees = L.evFeesPct[e];
  if (gross == null || !Number.isFinite(gross)) { tally.no_gross++; return null; }
  if (gross <= 0)                               { tally.funding_nonpos++; return null; }
  if (fees == null || !Number.isFinite(fees))   { tally.no_fee++; return null; }
  const fl = L.evFlags[e];
  if (L.lane === 'perp-perp') {
    if (!(fl & 1)) { tally.not_confirmed++; return null; }
    if (fl & 2)    { tally.one_leg_unverified++; return null; }
    if (fl & 4)    { tally.spike_flag++; return null; }
  }
  let size = ticket, sizedDown = false;
  if (L.lane === 'perp-perp') {
    const cap = L.evCap[e];
    if (cap == null) { tally.no_capacity++; return null; }   // never size off OI / midpoint
    if (cap <= 0)    { tally.zero_capacity++; return null; }
    size = Math.min(ticket, cap); sizedDown = size < ticket;
    if (sizedDown) tally.sized_down++;
  } else {
    tally.no_depth_data_uncapped++;
  }
  return { size, sizedDown };
}

// ── the simulation ───────────────────────────────────────────────────────────
function runSim(L, ticket, accrual) {
  const open = new Map();     // keyId → position (only ever ONE entry per key, ever)
  const entered = new Set();  // keys already traded once — no re-entry
  const done = [];
  const tally = { no_gross:0, funding_nonpos:0, no_fee:0, not_confirmed:0, one_leg_unverified:0,
                  spike_flag:0, no_capacity:0, zero_capacity:0, sized_down:0,
                  no_depth_data_uncapped:0 };
  const capTimeline = [];

  for (let si = 0; si < L.snapT.length; si++) {
    const t = L.snapT[si];

    // 1. accrue + test the ONLY exit trigger that can fire in-window
    for (const p of [...open.values()]) {
      const sB = legBuckets(accrual, p.shortVenue, p.coin, p.cursorT, t, p.shortIvMs);
      const lB = p.spotLeg ? { buckets: new Map(), points: 0, lastT: p.cursorT }
                           : legBuckets(accrual, p.longVenue, p.coin, p.cursorT, t, p.longIvMs);
      if (sB == null || lB == null) {
        p.unknown = true;
        p.unknownLeg = sB == null ? p.shortVenue : p.longVenue;
      } else {
        // sign the NET gap per UTC hour so a per-hour inversion is a real cost,
        // not something averaged away against a favourable hour elsewhere.
        const hours = new Set([...sB.buckets.keys(), ...lB.buckets.keys()]);
        for (const h of hours) {
          const netHour = (sB.buckets.get(h) || 0) - (lB.buckets.get(h) || 0);
          const usd = netHour * p.size;
          p.cumFundingUsd += usd;
          p.accrualHours++;
          if (netHour < 0) { p.negHours++; p.negFundingUsd += usd; }   // NEVER floored at 0
          else if (netHour > 0) { p.posHours++; p.posFundingUsd += usd; }
        }
        p.settledPoints += sB.points + lB.points;
        p.cursorT = Math.max(sB.lastT, lB.lastT, p.cursorT);
        p.marks.push({ t, cum: p.cumFundingUsd });
      }

      // (a) FUNDING ZEROED — judged on the position's own realised trailing 24h
      if (!p.unknown && (t - p.entryT) >= TRAIL_MS && (t - p.lastJudgeT) >= JUDGE_MS) {
        p.lastJudgeT = t;
        const cutoff = t - TRAIL_MS;
        let base = null;
        for (let i = p.marks.length - 1; i >= 0; i--) {
          if (p.marks[i].t <= cutoff) { base = p.marks[i]; break; }
        }
        if (base) {
          const spanDays = (t - base.t) / DAY_MS;
          if (spanDays > 0) {
            const trailPctYr = ((p.cumFundingUsd - base.cum) / p.size / spanDays) * 365 * 100;
            p.lastTrailPctYr = trailPctYr;
            p.zeroStreak = Math.abs(trailPctYr) <= p.zeroEpsPctYr ? p.zeroStreak + 1 : 0;
          }
        }
        if (p.zeroStreak >= ZERO_STREAK_N) {
          p.exitT = t; p.status = 'CLOSED'; p.exitReason = 'funding_zeroed';
          p.feesUsd = p.entryFeeUsd + p.exitFeeUsd;               // exit taker paid, once
          p.netUsd  = p.unknown ? null : p.cumFundingUsd - p.feesUsd;
          p.holdDays = (t - p.entryT) / DAY_MS;
          done.push(p); open.delete(p.keyId);
        }
      }
    }

    // 2. open — FIRST positive-funding appearance only, one shot per pair
    for (let e = L.snapStart[si]; e < L.snapStart[si + 1]; e++) {
      const ki = L.evKey[e];
      if (entered.has(ki)) continue;
      const g = gate(L, e, ticket, tally);
      if (!g) continue;
      entered.add(ki);
      const m = L.keyMeta[ki];
      const rtFeeUsd = (L.evFeesPct[e] / 100) * g.size;
      open.set(ki, {
        keyId: ki, key: L.keys[ki], coin: m.coin, shortVenue: m.shortVenue, longVenue: m.longVenue,
        spotLeg: L.lane === 'perp-spot', spotVenue: m.spotVenue || null,
        entryT: t, entryIso: new Date(t).toISOString(),
        size: g.size, sizedDown: g.sizedDown,
        entryGrossPctYr: L.evGrossPctYr[e],
        zeroEpsPctYr: Math.abs(L.evGrossPctYr[e]) * ZERO_EPS_FRAC,
        roundTripFeePct: L.evFeesPct[e],
        entryFeeUsd: rtFeeUsd / 2, exitFeeUsd: rtFeeUsd / 2,
        shortIvMs: (L.evShortIv[e] || 1) * HOUR_MS,
        longIvMs:  (L.evLongIv[e]  || 1) * HOUR_MS,
        cursorT: t, cumFundingUsd: 0, settledPoints: 0,
        accrualHours: 0, negHours: 0, posHours: 0, negFundingUsd: 0, posFundingUsd: 0,
        marks: [{ t, cum: 0 }], lastJudgeT: t, zeroStreak: 0, lastTrailPctYr: null,
        unknown: false, unknownLeg: null,
        status: null, exitReason: null, exitT: null, feesUsd: null, netUsd: null, holdDays: null,
      });
    }

    // 3. concurrent-capital timeline (for the honest %/yr denominator)
    let cap = 0, capKnown = 0;
    for (const p of open.values()) { cap += p.size; if (!p.unknown) capKnown += p.size; }
    capTimeline.push({ t, cap, capKnown, n: open.size });
  }

  // window end — everything still open is UNREALISED (entry fee only, no exit fee)
  const endT = L.snapT[L.snapT.length - 1];
  for (const p of [...open.values()]) {
    p.exitT = endT; p.status = 'OPEN'; p.exitReason = 'window_end_still_open';
    p.feesUsd = p.entryFeeUsd;                                     // exit NOT paid
    p.netUsd  = p.unknown ? null : p.cumFundingUsd - p.feesUsd;    // mark-to-window
    p.holdDays = (endT - p.entryT) / DAY_MS;
    done.push(p); open.delete(p.keyId);
  }

  const slim = p => ({
    key: p.key, coin: p.coin, shortVenue: p.shortVenue, longVenue: p.longVenue,
    status: p.status, exitReason: p.exitReason,
    entry: p.entryIso, exit: new Date(p.exitT).toISOString(),
    holdDays: +p.holdDays.toFixed(3), sizeUsd: p.size, sizedDown: p.sizedDown,
    entryGrossPctYr: p.entryGrossPctYr == null ? null : +p.entryGrossPctYr.toFixed(2),
    zeroEpsPctYr: +p.zeroEpsPctYr.toFixed(3),
    lastTrailPctYr: p.lastTrailPctYr == null ? null : +p.lastTrailPctYr.toFixed(2),
    roundTripFeePct: p.roundTripFeePct,
    grossFundingUsd: +p.cumFundingUsd.toFixed(4),
    feesUsd: +p.feesUsd.toFixed(4),
    netUsd: p.netUsd == null ? null : +p.netUsd.toFixed(4),
    accrualHours: p.accrualHours, negHours: p.negHours,
    negFundingUsd: +p.negFundingUsd.toFixed(4),
    settledPoints: p.settledPoints,
  });

  const agg = list => {
    const known = list.filter(p => !p.unknown);
    const holds = known.map(p => p.holdDays).sort((a, b) => a - b);
    const byKey = {};
    for (const p of known) byKey[p.key] = (byKey[p.key] || 0) + p.netUsd;
    const sorted = [...known].sort((a, b) => b.netUsd - a.netUsd);
    return {
      count: list.length, countedInPnl: known.length,
      unknownCount: list.filter(p => p.unknown).length,
      grossFundingUsd: +known.reduce((s, p) => s + p.cumFundingUsd, 0).toFixed(2),
      feesUsd:         +known.reduce((s, p) => s + p.feesUsd, 0).toFixed(2),
      netUsd:          +known.reduce((s, p) => s + p.netUsd, 0).toFixed(2),
      winners: known.filter(p => p.netUsd > 0).length,
      losers:  known.filter(p => p.netUsd < 0).length,
      medianHoldDays: holds.length ? +holds[Math.floor(holds.length / 2)].toFixed(3) : null,
      maxHoldDays:    holds.length ? +holds[holds.length - 1].toFixed(3) : null,
      independentPositions: new Set(known.map(p => p.key)).size,
      concentration: Object.entries(byKey).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 12)
        .map(([k, v]) => ({ pair: k, netUsd: +v.toFixed(2) })),
      top10: sorted.slice(0, 10).map(slim),
      bottom5: sorted.slice(-5).reverse().map(slim),
      // The PRIMARY lane is small enough to list in full — concentration should be
      // auditable, not inferred from a top-N slice.
      allPositions: known.length <= 400 ? sorted.map(slim) : null,
      // Sensitivity: how much of the result is one pair? Drop the single largest
      // absolute contributor and re-total. A result that flips sign here is an
      // outlier artefact, not a lane property.
      netUsd_exLargestContributor: (() => {
        if (!sorted.length) return null;
        const worst = [...known].sort((a, b) => Math.abs(b.netUsd) - Math.abs(a.netUsd))[0];
        return { droppedPair: worst.key, droppedNetUsd: +worst.netUsd.toFixed(2),
                 netUsd: +(known.reduce((s, p) => s + p.netUsd, 0) - worst.netUsd).toFixed(2) };
      })(),
    };
  };

  const closed = done.filter(p => p.status === 'CLOSED');
  const stillOpen = done.filter(p => p.status === 'OPEN');
  const knownAll = done.filter(p => !p.unknown);

  // negative-funding exposure (the Ethena risk, made explicit)
  const touchedNeg = knownAll.filter(p => p.negHours > 0);
  const neg = {
    positionsPassingThroughNegativeFunding: touchedNeg.length,
    pctOfPositions: knownAll.length ? +(100 * touchedNeg.length / knownAll.length).toFixed(1) : null,
    negativeFundingHours: knownAll.reduce((s, p) => s + p.negHours, 0),
    positiveFundingHours: knownAll.reduce((s, p) => s + p.posHours, 0),
    totalNegativeFundingUsd: +knownAll.reduce((s, p) => s + p.negFundingUsd, 0).toFixed(2),
    totalPositiveFundingUsd: +knownAll.reduce((s, p) => s + p.posFundingUsd, 0).toFixed(2),
    netFundingUsd: +knownAll.reduce((s, p) => s + p.cumFundingUsd, 0).toFixed(2),
    note: 'Negative hours are accrued as a real cost and never floored at zero. A held position PAYS when funding inverts.',
  };

  // capital-adjusted view
  let peakCap = 0, peakCapKnown = 0, peakN = 0, peakAt = null;
  for (const c of capTimeline) {
    if (c.cap > peakCap) { peakCap = c.cap; peakAt = new Date(c.t).toISOString(); }
    if (c.capKnown > peakCapKnown) peakCapKnown = c.capKnown;
    if (c.n > peakN) peakN = c.n;
  }
  const windowDays = (L.snapT[L.snapT.length - 1] - L.snapT[0]) / DAY_MS;
  const realisedNet = closed.filter(p => !p.unknown).reduce((s, p) => s + p.netUsd, 0);
  const totalNet    = knownAll.reduce((s, p) => s + p.netUsd, 0);
  const pctYr = (net, capital) =>
    (capital > 0 && windowDays > 0) ? +((net / capital) * (365 / windowDays) * 100).toFixed(2) : null;

  return {
    lane: L.lane, ticketUsd: ticket,
    windowDays: +windowDays.toFixed(2),
    positionsOpened: done.length,
    closedRealised: agg(closed),
    openUnrealised: agg(stillOpen),
    negativeFundingExposure: neg,
    capital: {
      peakConcurrentPositions: peakN,
      peakConcurrentCapitalUsd: peakCap,
      peakConcurrentCapitalUsd_knownOnly: peakCapKnown,
      peakAt,
      capitalConvention: 'Capital = 1× ticket per open position (one leg\'s notional; spot leg cash-funded, perp margin drawn from the same pool). If BOTH legs were funded separately the denominator doubles and every %/yr below HALVES.',
      realisedNetUsd: +realisedNet.toFixed(2),
      totalNetUsd_realisedPlusUnrealised: +totalNet.toFixed(2),
      realisedPctYrOnPeakCapital: pctYr(realisedNet, peakCapKnown),
      totalPctYrOnPeakCapital: pctYr(totalNet, peakCapKnown),
      riskFreeRefPctYr: RISK_FREE_PCT,
      annualisationCaveat: 'Annualised from a ~13-day window: a run-rate, not guaranteed. Any figure above 200%/yr should be read as ">200%/yr run-rate, not guaranteed".',
    },
    rejectedAtEntry: tally,
  };
}

// ── run ──────────────────────────────────────────────────────────────────────
const { accrual, raw, dedup } = buildAccrual();
console.error(`[hold] accrual ${raw} raw → ${dedup} deduped settled points`);

const LANES = [
  { lane: 'perp-spot', role: 'PRIMARY' },
  { lane: 'perp-perp', role: 'CONTROL' },
];
const results = {};
const laneInfo = {};

for (const { lane, role } of LANES) {
  console.error(`[hold] loading ${role} lane ${lane} ...`);
  const L = loadLane(lane);
  if (!L) { console.error(`[hold]   lane ${lane} MISSING`); continue; }
  laneInfo[lane] = {
    role,
    snapshots: L.snapT.length, presenceEvents: L.evKey.length, uniquePairs: L.keys.length,
    from: new Date(L.snapT[0]).toISOString(), to: new Date(L.snapT[L.snapT.length - 1]).toISOString(),
    rowsExcludedMalformed: L.excludedRows,
    depthCapped: lane === 'perp-perp',
    depthNote: lane === 'perp-perp'
      ? 'Sized at min(ticket, greenCapacityUsd) — the REAL walked book depth. Never OI, never midpoint.'
      : 'This board persisted NO capacity/depth field, so sizing could NOT be depth-capped. Results assume the ticket always fills, which FLATTERS this lane.',
    takerFeeRecomputed: lane === 'perp-perp'
      ? `roundTripFeeByVenue (taker×2 both legs); cross-checked against persisted totalFeesPct on ${L.feeCompared} rows, ${L.feeMismatch} differed`
      : 'roundTripPerpSpotPct (perp taker×2 + spot taker×2); this board persisted no fee field',
  };
  console.error(`[hold]   ${L.snapT.length} snaps, ${L.evKey.length} events, ${L.keys.length} pairs`);
  for (const ticket of TICKETS) {
    const k = `${lane}__${ticket}`;
    const r = runSim(L, ticket, accrual);
    results[k] = r;
    console.error(`[hold]   ${k}: closed ${r.closedRealised.countedInPnl} net $${r.closedRealised.netUsd} | ` +
                  `open ${r.openUnrealised.countedInPnl} mark $${r.openUnrealised.netUsd} | ` +
                  `peakCap $${r.capital.peakConcurrentCapitalUsd_knownOnly}`);
  }
}

// scanner baselines for the comparison (read from the prior run, not retyped)
let baselines = null;
try {
  const prior = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'funding-backtest-all-lanes.json'), 'utf8'));
  baselines = {};
  for (const k of Object.keys(prior.results || {})) {
    if (!/V1_naive/.test(k)) continue;
    baselines[k] = { netPnlUsd: prior.results[k].netPnlUsd, trades: prior.results[k].countedInPnl };
  }
} catch { baselines = null; }

const out = {
  kind: 'funding-open-and-hold-until-zero',
  generatedAt: new Date().toISOString(),
  simulated: true,
  feeAssumption: 'FULL TAKER on both legs of both lanes, recomputed from lib/funding-math\'s sourced per-venue taker table. Entry pays half the round trip; the exit half is charged ONLY if the position actually closes in-window.',
  model: 'Open ONCE on the first positive-funding appearance of each pair, HOLD, accrue real settled hourly funding (negative hours included, never floored), close ONLY when the position\'s realised trailing-24h funding decays to <=5% of its entry rate for 24h sustained. Otherwise still open at window end and reported as unrealised.',
  lanes: {
    'perp-spot': 'PRIMARY — long spot / short perp, same coin. Earns the perp\'s own funding; the spot hedge earns none. This is the raw persistent carry.',
    'perp-perp': 'CONTROL — short the higher-funding venue / long the lower. Earns only the DIFFERENCE. Most venues quote the same default rate, so this lane is EXPECTED to be flat; a flat control means any primary edge is raw-vs-spot carry, not a cross-venue spread.',
  },
  exitRules: {
    funding_zeroed: `|realised trailing-24h %/yr| <= ${ZERO_EPS_FRAC * 100}% of entry gross %/yr, for ${ZERO_STREAK_N} consecutive 6h judgements (24h sustained) → CLOSED, exit taker fee paid once.`,
    window_end_still_open: 'History ends before the funding zeroed → STILL OPEN, marked to window at funding minus ENTRY fee only, reported separately as unrealised. Never counted as realised profit.',
    notExits: 'carry<=fees, drawdown and elapsed time are NOT exits in this model — that is the whole point of the test.',
  },
  honesty: {
    unknown: 'A held pair with no settled series on a needed venue is UNKNOWN → excluded from P&L and counted. Never assumed to be zero.',
    negativeFunding: 'Accrued as a real cost, never floored at zero, and reported separately as drag.',
    unrealised: 'Open-at-window-end P&L is reported in its own bucket and is NOT realised profit.',
    smallSample: 'A result carried by fewer than 5 independent positions is an anecdote, not evidence.',
    regime: '~13 days of history is ONE funding regime. Any positive result here is regime-specific and is NOT proof of a durable edge.',
    annualisation: 'All %/yr figures are run-rates extrapolated from ~13 days, not guarantees.',
  },
  accrualPoints: dedup,
  laneInfo,
  scannerBaselines_openClose_carryLTEfees: baselines,
  results,
};
fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
console.error(`[hold] wrote ${OUT_FILE}`);
