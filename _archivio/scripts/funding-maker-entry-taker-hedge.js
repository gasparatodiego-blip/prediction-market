#!/usr/bin/env node
'use strict';
/**
 * MAKER-ENTRY + TAKER-HEDGE-AT-FILL — Diego's proposed mechanism, backtested.
 *
 * OFFLINE ANALYSIS. Reads only. Not wired into any agent, API or the dashboard.
 *
 * ── THE MECHANISM AS SPECIFIED ──────────────────────────────────────────────
 *   1. Rest a MAKER buy on SPOT (the entry leg). It fills passively, possibly partially.
 *   2. The instant it fills — per fill event — immediately fire the SHORT PERP hedge as a
 *      TAKER order sized to the ACTUAL filled quantity ($200 filled → $200 hedged).
 *   3. Now delta-neutral: HOLD, accruing the perp's real settled funding (spot pays none).
 *   4. Close ONLY when funding decays to ~zero. Window end → still open, unrealised.
 *
 * ── WHY MECHANISM A CANNOT BE PRICED (the headline, established from the repo SSOT) ──
 *   The entry leg is SPOT MAKER. data/venue-maker-fees.json is the repo's public-API fee
 *   SSOT (unauthenticated REST, base tier, no VIP/promo assumptions). Its verdict on spot
 *   maker rates:
 *     binance spot  → HTTP 200 but NO fee fields on the public endpoint  → UNAVAILABLE
 *     bybit   spot  → HTTP 200 but NO fee fields                        → UNAVAILABLE
 *     okx     spot  → HTTP 200 but NO fee fields                        → UNAVAILABLE
 *     gateio  spot  → returns a TAKER fee but NO maker field            → UNAVAILABLE
 *     bitget  spot  → maker 0.20% AVAILABLE — but bitget NEVER appears as a spot venue
 *                     in the perp-spot board (0 of 27,078 rows), so it prices nothing.
 *   The board's spot leg is binance / bybit / okx / gateio only. Every one is unpriceable,
 *   so MECHANISM A has ZERO priceable coverage. Not "mostly" — literally zero. The honest
 *   rule applies: never assume a fee, never assume zero. Mechanism A is COUNTED and
 *   REPORTED, never estimated.
 *
 * ── MECHANISM B — the same design with the legs swapped (the only priceable form) ──
 *   Rest the MAKER on the PERP leg; the instant it fills, fire the SPOT as the immediate
 *   TAKER hedge. Structurally identical (one passive leg, one immediate taker hedge sized
 *   to the fill), and priceable, because perp maker rates ARE public:
 *     API-sourced   (data/venue-maker-fees.json): gateio −0.01%, bitget 0.02%, dydx 0.01%
 *     Doc-sourced   (lib/funding-math.js comments): hyperliquid/aster/paradex/lighter/
 *                   extended 0%, grvt −0.0001%, pacifica 0.015%, edgex 0.018%, apex 0.02%
 *     UNAVAILABLE   binance / bybit / okx perp → those rows are EXCLUDED, never guessed.
 *   This is a DEVIATION from the literal spec and is labelled as one everywhere. It is
 *   reported because it is the only version of the mechanism the real fee data can price.
 *
 * ── LOWER-BOUND FRAMING (explicit) ──────────────────────────────────────────
 *   Every maker rate used is the BEST publicly-documented BASE-tier rate. Diego's real
 *   tier cannot be cheaper than a public base rate, and several of these (0%, −0.01%) are
 *   promotional. So this is a LOWER BOUND ON COST → an UPPER BOUND ON PROFIT. The real
 *   result is <= what is reported here. If it cannot beat risk-free at these fees, it
 *   will not beat risk-free at Diego's.
 *
 * ── FILL RISK — modelled, not assumed away ──────────────────────────────────
 *   A resting maker order must sit before it fills. An opportunity whose own board life
 *   from the entry snapshot is shorter than FILL_H never gets filled → the trade DOES NOT
 *   HAPPEN and is counted as LOST_TO_FILL. That is the real cost of insisting on maker
 *   entry instead of just crossing the spread. Reported at FILL_H = 1h and 4h.
 *
 * ── PARTIAL FILLS — no queue data exists, so no fill ratio is invented ──────
 *   No lane persisted an order book, queue position or trade prints, so the data CANNOT
 *   support an estimated fill ratio. The base case therefore assumes FULL FILL, which is
 *   OPTIMISTIC and flagged as such. What can be stated exactly: because fees, funding and
 *   deployed capital ALL scale linearly with filled notional, a partial fill scales net
 *   P&L and deployed capital by the same factor — so it cannot change the SIGN of the
 *   result or the %/yr on DEPLOYED capital. It only shrinks the absolute dollars and
 *   degrades %/yr on COMMITTED capital (you earmark the full ticket, deploy only part).
 *   Both denominators are reported.
 *
 * ── ACCRUAL / EXIT — identical to funding-hold-until-zero.js ────────────────
 *   Real settled funding, hour-bucketed, Δt-weighted, negative hours never floored.
 *   Exit only on funding decaying to <=5% of entry rate for 24h sustained, else the
 *   position is STILL OPEN at window end and reported as unrealised.
 *   Exit cost mirrors entry (maker leg exits maker, hedge leg exits taker); an
 *   all-taker-exit sensitivity is also reported.
 */

const fs   = require('fs');
const path = require('path');
const FM   = require('../lib/funding-math');

const ROOT      = path.join(__dirname, '..');
const FUND_14D  = path.join(ROOT, 'data', 'funding-history-14d.json');
const FUND_CACHE= '/tmp/funding-history-cache.json';
const FEES_FILE = path.join(ROOT, 'data', 'venue-maker-fees.json');
const PS_DIR    = path.join(ROOT, 'data', 'history', 'perp-spot');
const HOLD_FILE = path.join(ROOT, 'data', 'funding-hold-until-zero.json');
const PRIOR_FILE= path.join(ROOT, 'data', 'funding-backtest-all-lanes.json');
const OUT_FILE  = path.join(ROOT, 'data', 'funding-maker-entry-taker-hedge.json');

const TICKETS       = [1000, 10000];
const DAY_MS        = 86_400_000;
const HOUR_MS       = 3_600_000;
const JUDGE_MS      = 6 * HOUR_MS;
const TRAIL_MS      = 24 * HOUR_MS;
const ZERO_STREAK_N = 4;
const ZERO_EPS_FRAC = 0.05;
const GONE_STREAK_N = 2;
const FILL_HOURS    = [1, 4];
const RISK_FREE_PCT = 4.0;

// Maker rates documented in lib/funding-math.js comments (doc-sourced, not API-sourced).
const DOC_PERP_MAKER = { hyperliquid: 0, aster: 0, paradex: 0, lighter: 0, extended: 0,
                         edgex: 0.018, pacifica: 0.015, apex: 0.02, grvt: -0.0001 };

// ── real fee table from the public-API SSOT ─────────────────────────────────
const feeDoc = JSON.parse(fs.readFileSync(FEES_FILE, 'utf8'));
const API_MAKER = {};
for (const r of feeDoc.results) {
  if (r.available && r.makerPct != null && r.market !== 'perp-crosscheck') {
    API_MAKER[`${r.venue}|${r.market}`] = r.makerPct;
  }
}
/** Maker fee % for a leg, or null when no public source documents one. NEVER guessed. */
function makerPct(venue, market) {
  const k = `${venue}|${market}`;
  if (API_MAKER[k] != null) return { pct: API_MAKER[k], src: 'public-api' };
  if (market === 'perp' && DOC_PERP_MAKER[venue] != null) return { pct: DOC_PERP_MAKER[venue], src: 'repo-doc' };
  return null;                                    // UNAVAILABLE → caller must exclude
}

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
          raw++; if (!cm.has(p.t)) cm.set(p.t, p.rate);
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
    points++; if (p.t > lastT) lastT = p.t;
  }
  return { buckets, points, lastT };
}

// ── load the perp-spot board ─────────────────────────────────────────────────
function loadBoard() {
  const files = fs.readdirSync(PS_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}(\.\d+)?\.json$/.test(f))
    .map(n => { const m = n.match(/^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.json$/);
                return { name: n, day: m[1], part: m[2] ? +m[2] : 0 }; })
    .sort((a, b) => a.day === b.day ? a.part - b.part : (a.day < b.day ? -1 : 1));

  const keys = [], keyIdx = new Map(), keyMeta = [];
  const snapT = [], snapStart = [];
  const evKey = [], evGrossPctYr = [], evIv = [];
  let excludedRows = 0;

  for (const f of files) {
    let snaps; try { snaps = JSON.parse(fs.readFileSync(path.join(PS_DIR, f.name), 'utf8')); } catch { continue; }
    if (!Array.isArray(snaps)) continue;
    for (const s of snaps) {
      if (typeof s.t !== 'number' || !Array.isArray(s.rows)) continue;
      snapStart.push(evKey.length); snapT.push(s.t);
      for (const r of s.rows) {
        if (r == null || r.coin == null || r.shortVenue == null) { excludedRows++; continue; }
        const spot = r.spotVenueSuggested || null;
        if (!spot) { excludedRows++; continue; }
        const key = `${r.coin}|${r.shortVenue}|spot:${spot}`;
        let ki = keyIdx.get(key);
        if (ki === undefined) {
          ki = keys.length; keyIdx.set(key, ki); keys.push(key);
          keyMeta.push({ coin: r.coin, perpVenue: r.shortVenue, spotVenue: spot });
        }
        // fundingPct8h is a PERCENT per 8h (the ×100 trap) → %/yr = ×3×365
        evKey.push(ki);
        evGrossPctYr.push(r.fundingPct8h == null ? null : r.fundingPct8h * 3 * 365);
        evIv.push(r.intervalH || 1);
      }
    }
    snaps = null;
  }
  snapStart.push(evKey.length);

  // presence runs → how long each opportunity actually lived from any given snapshot
  const presence = new Map();
  for (let si = 0; si < snapT.length; si++) {
    for (let e = snapStart[si]; e < snapStart[si + 1]; e++) {
      const k = evKey[e];
      let a = presence.get(k); if (!a) { a = []; presence.set(k, a); }
      if (a.length === 0 || a[a.length - 1] !== si) a.push(si);
    }
  }
  const runEndBySnap = new Map();
  for (const [k, idxs] of presence) {
    let runStart = 0;
    for (let i = 0; i < idxs.length; i++) {
      const isLast = i === idxs.length - 1;
      if (isLast || (idxs[i + 1] - idxs[i]) > GONE_STREAK_N) {
        const endIdx = idxs[i];
        for (let j = runStart; j <= i; j++) runEndBySnap.set(`${k}:${idxs[j]}`, endIdx);
        runStart = i + 1;
      }
    }
  }
  return { keys, keyMeta, snapT, snapStart, evKey, evGrossPctYr, evIv, runEndBySnap, excludedRows };
}

// ── the simulation ───────────────────────────────────────────────────────────
/**
 * @param {'A_maker_spot_entry'|'B_maker_perp_entry'} mech
 *   A = literal spec: maker on SPOT entry, taker PERP hedge  (expected: unpriceable)
 *   B = leg-swapped:  maker on PERP entry, taker SPOT hedge  (the priceable form)
 */
function runSim(B, ticket, accrual, mech, fillH) {
  const open = new Map(), entered = new Set(), done = [];
  const tally = { no_gross: 0, funding_nonpos: 0, lost_to_fill: 0,
                  excluded_maker_unpriceable: 0, entered: 0 };
  const unpriceableVenues = new Map();
  const makerSrc = new Map();
  const capTimeline = [];
  const fillMs = fillH * HOUR_MS;

  for (let si = 0; si < B.snapT.length; si++) {
    const t = B.snapT[si];

    // 1. accrue + zero-decay exit
    for (const p of [...open.values()]) {
      const sB = legBuckets(accrual, p.perpVenue, p.coin, p.cursorT, t, p.ivMs);
      if (sB == null) { p.unknown = true; p.unknownLeg = p.perpVenue; }
      else {
        for (const [, v] of sB.buckets) {
          const usd = v * p.size;                    // spot leg earns no funding
          p.cumFundingUsd += usd; p.accrualHours++;
          if (v < 0) { p.negHours++; p.negFundingUsd += usd; }   // never floored
          else if (v > 0) { p.posHours++; p.posFundingUsd += usd; }
        }
        p.settledPoints += sB.points;
        p.cursorT = Math.max(sB.lastT, p.cursorT);
        p.marks.push({ t, cum: p.cumFundingUsd });
      }

      if (!p.unknown && (t - p.entryT) >= TRAIL_MS && (t - p.lastJudgeT) >= JUDGE_MS) {
        p.lastJudgeT = t;
        const cutoff = t - TRAIL_MS;
        let base = null;
        for (let i = p.marks.length - 1; i >= 0; i--) if (p.marks[i].t <= cutoff) { base = p.marks[i]; break; }
        if (base) {
          const spanDays = (t - base.t) / DAY_MS;
          if (spanDays > 0) {
            const trail = ((p.cumFundingUsd - base.cum) / p.size / spanDays) * 365 * 100;
            p.lastTrailPctYr = trail;
            p.zeroStreak = Math.abs(trail) <= p.zeroEpsPctYr ? p.zeroStreak + 1 : 0;
          }
        }
        if (p.zeroStreak >= ZERO_STREAK_N) {
          p.exitT = t; p.status = 'CLOSED'; p.exitReason = 'funding_zeroed';
          p.feesUsd     = p.entryFeeUsd + p.exitFeeMirrorUsd;
          p.feesUsd_allTakerExit = p.entryFeeUsd + p.exitFeeAllTakerUsd;
          p.netUsd      = p.cumFundingUsd - p.feesUsd;
          p.netUsd_allTakerExit = p.cumFundingUsd - p.feesUsd_allTakerExit;
          p.netUsd_takerBothLegs = p.cumFundingUsd - (p.entryFeeUsd_takerBoth + p.exitFeeUsd_takerBoth);
          p.holdDays = (t - p.entryT) / DAY_MS;
          done.push(p); open.delete(p.keyId);
        }
      }
    }

    // 2. entry — first positive-funding appearance, subject to maker pricing + fill risk
    for (let e = B.snapStart[si]; e < B.snapStart[si + 1]; e++) {
      const ki = B.evKey[e];
      if (entered.has(ki)) continue;
      const gross = B.evGrossPctYr[e];
      if (gross == null || !Number.isFinite(gross)) { tally.no_gross++; continue; }
      if (gross <= 0) { tally.funding_nonpos++; continue; }
      const m = B.keyMeta[ki];

      // maker leg pricing — UNAVAILABLE means the trade cannot be priced, never assumed
      const makerVenue  = mech === 'A_maker_spot_entry' ? m.spotVenue : m.perpVenue;
      const makerMarket = mech === 'A_maker_spot_entry' ? 'spot' : 'perp';
      const mk = makerPct(makerVenue, makerMarket);
      if (mk == null) {
        entered.add(ki);                            // resolved once, never retried
        tally.excluded_maker_unpriceable++;
        unpriceableVenues.set(`${makerVenue}|${makerMarket}`,
          (unpriceableVenues.get(`${makerVenue}|${makerMarket}`) || 0) + 1);
        continue;
      }

      // FILL RISK — the resting maker needs the opportunity to outlive fillH
      const endIdx = B.runEndBySnap.get(`${ki}:${si}`);
      const survivalMs = endIdx == null ? 0 : (B.snapT[endIdx] - t);
      if (survivalMs < fillMs) { entered.add(ki); tally.lost_to_fill++; continue; }

      entered.add(ki); tally.entered++;
      makerSrc.set(mk.src, (makerSrc.get(mk.src) || 0) + 1);

      // hedge leg = TAKER, fired at fill, sized to the fill (base case: full fill)
      const hedgeTakerPct = mech === 'A_maker_spot_entry'
        ? FM.venueFeePct(m.perpVenue)          // perp taker
        : FM.spotVenueFeePct(m.spotVenue);     // spot taker
      const entryFeePct        = mk.pct + hedgeTakerPct;
      const exitFeeMirrorPct   = mk.pct + hedgeTakerPct;   // symmetric unwind
      const makerLegTakerPct   = mech === 'A_maker_spot_entry'
        ? FM.spotVenueFeePct(m.spotVenue) : FM.venueFeePct(m.perpVenue);
      const exitFeeAllTakerPct = makerLegTakerPct + hedgeTakerPct;
      // CONTROL: the SAME entered set priced at taker on BOTH legs. Isolates how much of
      // the maker result is the fee saving vs. the selection effect of the fill filter
      // (which only admits long-surviving — i.e. better — opportunities).
      const takerBothPct = makerLegTakerPct + hedgeTakerPct;

      open.set(ki, {
        keyId: ki, key: B.keys[ki], coin: m.coin, perpVenue: m.perpVenue, spotVenue: m.spotVenue,
        entryT: t, entryIso: new Date(t).toISOString(),
        size: ticket,
        entryGrossPctYr: gross, zeroEpsPctYr: Math.abs(gross) * ZERO_EPS_FRAC,
        makerVenue, makerMarket, makerPct: mk.pct, makerSrc: mk.src, hedgeTakerPct,
        entryFeePct, entryFeeUsd: (entryFeePct / 100) * ticket,
        exitFeeMirrorUsd:  (exitFeeMirrorPct / 100) * ticket,
        exitFeeAllTakerUsd:(exitFeeAllTakerPct / 100) * ticket,
        takerBothPct, entryFeeUsd_takerBoth: (takerBothPct / 100) * ticket,
        exitFeeUsd_takerBoth:  (takerBothPct / 100) * ticket,
        opportunitySurvivalH: +(survivalMs / HOUR_MS).toFixed(2),
        ivMs: (B.evIv[e] || 1) * HOUR_MS,
        cursorT: t, cumFundingUsd: 0, settledPoints: 0,
        accrualHours: 0, negHours: 0, posHours: 0, negFundingUsd: 0, posFundingUsd: 0,
        marks: [{ t, cum: 0 }], lastJudgeT: t, zeroStreak: 0, lastTrailPctYr: null,
        unknown: false, unknownLeg: null,
        status: null, exitReason: null, exitT: null,
        feesUsd: null, netUsd: null, feesUsd_allTakerExit: null, netUsd_allTakerExit: null,
        holdDays: null,
      });
    }

    let cap = 0, capKnown = 0;
    for (const p of open.values()) { cap += p.size; if (!p.unknown) capKnown += p.size; }
    capTimeline.push({ t, cap, capKnown, n: open.size });
  }

  const endT = B.snapT[B.snapT.length - 1];
  for (const p of [...open.values()]) {
    p.exitT = endT; p.status = 'OPEN'; p.exitReason = 'window_end_still_open';
    p.feesUsd = p.entryFeeUsd;                       // exit NOT paid — unrealised
    p.feesUsd_allTakerExit = p.entryFeeUsd;
    p.netUsd  = p.unknown ? null : p.cumFundingUsd - p.feesUsd;
    p.netUsd_allTakerExit = p.netUsd;
    p.netUsd_takerBothLegs = p.unknown ? null : p.cumFundingUsd - p.entryFeeUsd_takerBoth;
    p.holdDays = (endT - p.entryT) / DAY_MS;
    done.push(p); open.delete(p.keyId);
  }

  const slim = p => ({
    key: p.key, coin: p.coin, perpVenue: p.perpVenue, spotVenue: p.spotVenue,
    status: p.status, exitReason: p.exitReason,
    entry: p.entryIso, exit: new Date(p.exitT).toISOString(),
    holdDays: +p.holdDays.toFixed(3), sizeUsd: p.size,
    makerLeg: `${p.makerVenue}|${p.makerMarket}`, makerPct: p.makerPct, makerSrc: p.makerSrc,
    hedgeTakerPct: p.hedgeTakerPct, entryFeePct: +p.entryFeePct.toFixed(4),
    opportunitySurvivalH: p.opportunitySurvivalH,
    entryGrossPctYr: p.entryGrossPctYr == null ? null : +p.entryGrossPctYr.toFixed(2),
    grossFundingUsd: +p.cumFundingUsd.toFixed(4),
    feesUsd: +p.feesUsd.toFixed(4),
    netUsd: p.netUsd == null ? null : +p.netUsd.toFixed(4),
    netUsd_allTakerExit: p.netUsd_allTakerExit == null ? null : +p.netUsd_allTakerExit.toFixed(4),
    netUsd_takerBothLegs: p.netUsd_takerBothLegs == null ? null : +p.netUsd_takerBothLegs.toFixed(4),
    accrualHours: p.accrualHours, negHours: p.negHours,
    negFundingUsd: +p.negFundingUsd.toFixed(4), settledPoints: p.settledPoints,
  });

  const agg = list => {
    const known = list.filter(p => !p.unknown);
    const holds = known.map(p => p.holdDays).sort((a, b) => a - b);
    const byKey = {}, byVenue = {};
    for (const p of known) {
      byKey[p.key] = (byKey[p.key] || 0) + p.netUsd;
      byVenue[p.makerVenue] = (byVenue[p.makerVenue] || 0) + p.netUsd;
    }
    const sorted = [...known].sort((a, b) => b.netUsd - a.netUsd);
    return {
      count: list.length, countedInPnl: known.length,
      unknownCount: list.filter(p => p.unknown).length,
      grossFundingUsd: +known.reduce((s, p) => s + p.cumFundingUsd, 0).toFixed(2),
      feesUsd:         +known.reduce((s, p) => s + p.feesUsd, 0).toFixed(2),
      netUsd:          +known.reduce((s, p) => s + p.netUsd, 0).toFixed(2),
      netUsd_allTakerExit: +known.reduce((s, p) => s + p.netUsd_allTakerExit, 0).toFixed(2),
      netUsd_sameSetPricedAtTakerBothLegs: +known.reduce((s, p) => s + p.netUsd_takerBothLegs, 0).toFixed(2),
      winners: known.filter(p => p.netUsd > 0).length,
      losers:  known.filter(p => p.netUsd < 0).length,
      medianHoldDays: holds.length ? +holds[Math.floor(holds.length / 2)].toFixed(3) : null,
      maxHoldDays:    holds.length ? +holds[holds.length - 1].toFixed(3) : null,
      independentPositions: new Set(known.map(p => p.key)).size,
      netByMakerVenue: Object.entries(byVenue).sort((a, b) => b[1] - a[1])
        .map(([v, n]) => ({ makerVenue: v, netUsd: +n.toFixed(2),
                            positions: known.filter(p => p.makerVenue === v).length,
                            makerPct: (known.find(p => p.makerVenue === v) || {}).makerPct })),
      concentration: Object.entries(byKey).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 12)
        .map(([k, v]) => ({ pair: k, netUsd: +v.toFixed(2) })),
      netUsd_exLargestContributor: (() => {
        if (!known.length) return null;
        const w = [...known].sort((a, b) => Math.abs(b.netUsd) - Math.abs(a.netUsd))[0];
        return { droppedPair: w.key, droppedNetUsd: +w.netUsd.toFixed(2),
                 netUsd: +(known.reduce((s, p) => s + p.netUsd, 0) - w.netUsd).toFixed(2) };
      })(),
      allPositions: known.length <= 400 ? sorted.map(slim) : null,
    };
  };

  const closed = done.filter(p => p.status === 'CLOSED');
  const stillOpen = done.filter(p => p.status === 'OPEN');
  const knownAll = done.filter(p => !p.unknown);

  const touchedNeg = knownAll.filter(p => p.negHours > 0);
  const neg = {
    positionsPassingThroughNegativeFunding: touchedNeg.length,
    pctOfPositions: knownAll.length ? +(100 * touchedNeg.length / knownAll.length).toFixed(1) : null,
    negativeFundingHours: knownAll.reduce((s, p) => s + p.negHours, 0),
    positiveFundingHours: knownAll.reduce((s, p) => s + p.posHours, 0),
    totalNegativeFundingUsd: +knownAll.reduce((s, p) => s + p.negFundingUsd, 0).toFixed(2),
    totalPositiveFundingUsd: +knownAll.reduce((s, p) => s + p.posFundingUsd, 0).toFixed(2),
    netFundingUsd: +knownAll.reduce((s, p) => s + p.cumFundingUsd, 0).toFixed(2),
    note: 'Negative hours accrued as a real cost, never floored. A held position PAYS when funding inverts.',
  };

  let peakCap = 0, peakCapKnown = 0, peakN = 0, peakAt = null;
  for (const c of capTimeline) {
    if (c.cap > peakCap) { peakCap = c.cap; peakAt = new Date(c.t).toISOString(); }
    if (c.capKnown > peakCapKnown) peakCapKnown = c.capKnown;
    if (c.n > peakN) peakN = c.n;
  }
  const windowDays = (B.snapT[B.snapT.length - 1] - B.snapT[0]) / DAY_MS;
  const realised = closed.filter(p => !p.unknown).reduce((s, p) => s + p.netUsd, 0);
  const total    = knownAll.reduce((s, p) => s + p.netUsd, 0);
  const totalTakerCtl = knownAll.reduce((s, p) => s + p.netUsd_takerBothLegs, 0);
  const pctYr = (n, c) => (c > 0 && windowDays > 0) ? +((n / c) * (365 / windowDays) * 100).toFixed(2) : null;

  const candidates = tally.entered + tally.lost_to_fill + tally.excluded_maker_unpriceable;
  return {
    mechanism: mech, ticketUsd: ticket, fillWindowHours: fillH,
    windowDays: +windowDays.toFixed(2),
    entryFunnel: {
      positiveFundingCandidates: candidates,
      entered: tally.entered,
      lostToFill: tally.lost_to_fill,
      excludedMakerUnpriceable: tally.excluded_maker_unpriceable,
      pctEntered: candidates ? +(100 * tally.entered / candidates).toFixed(1) : null,
      pctLostToFill: candidates ? +(100 * tally.lost_to_fill / candidates).toFixed(1) : null,
      pctUnpriceable: candidates ? +(100 * tally.excluded_maker_unpriceable / candidates).toFixed(1) : null,
      unpriceableByVenue: Object.fromEntries(unpriceableVenues),
      makerRateSource: Object.fromEntries(makerSrc),
      rowsNonPositiveFunding: tally.funding_nonpos, rowsNoGross: tally.no_gross,
    },
    closedRealised: agg(closed),
    openUnrealised: agg(stillOpen),
    negativeFundingExposure: neg,
    capital: {
      peakConcurrentPositions: peakN,
      peakDeployedCapitalUsd: peakCapKnown,
      peakAt,
      capitalConvention: 'Capital = 1× ticket per open position (one leg\'s notional). If both legs were funded separately the denominator doubles and every %/yr HALVES.',
      realisedNetUsd: +realised.toFixed(2),
      totalNetUsd_realisedPlusUnrealised: +total.toFixed(2),
      realisedPctYrOnPeakCapital: pctYr(realised, peakCapKnown),
      totalPctYrOnPeakCapital: pctYr(total, peakCapKnown),
      control_sameSetAtTakerBothLegs_netUsd: +totalTakerCtl.toFixed(2),
      control_sameSetAtTakerBothLegs_pctYr: pctYr(totalTakerCtl, peakCapKnown),
      makerFeeSavingPctYr: pctYr(total - totalTakerCtl, peakCapKnown),
      controlNote: 'The control prices the IDENTICAL entered set at taker on both legs. The gap between it and the maker result is the pure FEE saving; whatever the control itself earns above the all-opportunities taker baseline is the SELECTION effect of the fill filter.',
      riskFreeRefPctYr: RISK_FREE_PCT,
      vsRiskFreePctYr: pctYr(total, peakCapKnown) == null ? null : +(pctYr(total, peakCapKnown) - RISK_FREE_PCT).toFixed(2),
      annualisationCaveat: 'Annualised from a ~12-day window: a run-rate, not guaranteed. Read anything above 200%/yr as ">200%/yr run-rate, not guaranteed".',
    },
  };
}

// ── run ──────────────────────────────────────────────────────────────────────
const { accrual, raw, dedup } = buildAccrual();
console.error(`[mk] accrual ${raw} raw → ${dedup} deduped settled points`);
const B = loadBoard();
console.error(`[mk] board ${B.snapT.length} snapshots, ${B.evKey.length} events, ${B.keys.length} pairs`);

const results = {};
for (const mech of ['A_maker_spot_entry', 'B_maker_perp_entry']) {
  for (const fillH of FILL_HOURS) {
    for (const ticket of TICKETS) {
      const k = `${mech}__fill${fillH}h__${ticket}`;
      const r = runSim(B, ticket, accrual, mech, fillH);
      results[k] = r;
      console.error(`[mk] ${k}: entered ${r.entryFunnel.entered} | lostToFill ${r.entryFunnel.lostToFill} | ` +
        `unpriceable ${r.entryFunnel.excludedMakerUnpriceable} | closed net $${r.closedRealised.netUsd} | ` +
        `open mark $${r.openUnrealised.netUsd} | ${r.capital.totalPctYrOnPeakCapital}%/yr`);
    }
  }
}

// baselines, read from prior runs rather than retyped
let baselines = {};
try {
  const h = JSON.parse(fs.readFileSync(HOLD_FILE, 'utf8'));
  for (const k of Object.keys(h.results || {})) {
    if (!k.startsWith('perp-spot')) continue;
    baselines[`takerBothLegs_hold__${k}`] = {
      realisedNetUsd: h.results[k].capital.realisedNetUsd,
      totalNetUsd: h.results[k].capital.totalNetUsd_realisedPlusUnrealised,
      totalPctYrOnPeakCapital: h.results[k].capital.totalPctYrOnPeakCapital,
    };
  }
} catch { baselines.takerBothLegs_hold = 'UNAVAILABLE'; }
try {
  const p = JSON.parse(fs.readFileSync(PRIOR_FILE, 'utf8'));
  for (const k of Object.keys(p.results || {})) {
    if (!/^perp-spot__V1_naive/.test(k)) continue;
    baselines[`scanner_openClose__${k}`] = { netPnlUsd: p.results[k].netPnlUsd, trades: p.results[k].countedInPnl };
  }
} catch { baselines.scanner_openClose = 'UNAVAILABLE'; }

const out = {
  kind: 'funding-maker-entry-taker-hedge',
  generatedAt: new Date().toISOString(),
  simulated: true,
  mechanismSpec: 'Rest a MAKER order on the entry leg; the instant it fills (per fill event, including partials) fire the hedge leg IMMEDIATELY as a TAKER order sized to the ACTUAL fill; hold delta-neutral; close only when funding decays to ~zero.',
  mechanisms: {
    A_maker_spot_entry: 'THE LITERAL SPEC — maker on the SPOT entry leg, taker on the PERP hedge. Every spot venue in this board (binance/bybit/okx/gateio) has NO publicly-documented maker rate, so this mechanism is UNPRICEABLE on real data. Reported as a count, never estimated.',
    B_maker_perp_entry: 'DEVIATION, clearly labelled — the same structure with the legs swapped: maker on the PERP entry leg, taker on the SPOT hedge. Priceable because perp maker rates ARE public. This is the only version real fee data can price.',
  },
  feeFraming: 'LOWER BOUND ON COST → UPPER BOUND ON PROFIT. Every maker rate used is the BEST publicly-documented BASE-tier rate (several are 0% or negative promotional rates). Diego\'s real tier cannot be cheaper than a public base rate, so the real result is <= what is reported here.',
  feeSources: {
    apiSourced: 'data/venue-maker-fees.json — public unauthenticated REST, base tier, no VIP/promo assumptions',
    docSourced: 'lib/funding-math.js comments (DOC_PERP_MAKER): hyperliquid/aster/paradex/lighter/extended 0%, grvt −0.0001%, pacifica 0.015%, edgex 0.018%, apex 0.02%',
    unavailableRule: 'A venue with no public maker schedule is UNAVAILABLE — excluded and counted, never guessed and never assumed zero.',
    spotMakerVerdict: 'binance/bybit/okx spot: HTTP 200 but no fee fields. gateio spot: taker only, no maker field. bitget spot: maker 0.20% IS available but bitget never appears as a spot venue in this board (0 of 27,078 rows).',
  },
  fillRisk: {
    model: 'A resting maker order needs the opportunity to outlive FILL_H before it can fill. Opportunities whose own board life from the entry snapshot is shorter are LOST_TO_FILL — the trade does not happen. Tested at 1h and 4h.',
    partialFills: 'No order book, queue position or trade prints were ever persisted, so the data CANNOT support an estimated fill ratio. The base case assumes FULL FILL, which is OPTIMISTIC. Because fees, funding and deployed capital all scale linearly with filled notional, a partial fill scales net P&L and deployed capital by the same factor — it cannot change the SIGN or the %/yr on DEPLOYED capital, only the absolute dollars and the %/yr on COMMITTED capital.',
  },
  hedgeLegIsTaker: 'The hedge leg is priced as TAKER in every scenario. It is never modelled as maker — it must cross the spread immediately to reach delta-neutral.',
  honesty: {
    unknown: 'A held pair with no settled funding series is UNKNOWN → excluded from P&L and counted. Never assumed zero.',
    negativeFunding: 'Accrued as a real cost, never floored, reported separately as drag.',
    unrealised: 'Open-at-window-end P&L is reported separately and is NOT realised profit.',
    smallSample: 'A result carried by fewer than 5 independent positions is an anecdote, not evidence.',
    venuePromotion: 'A result resting on one venue\'s 0% maker promotion vanishes if that venue starts charging. Net is broken out by maker venue so this is visible.',
    regime: '~12 days is ONE funding regime. Any positive result is regime-specific, NOT a durable edge.',
  },
  accrualPoints: dedup,
  board: {
    snapshots: B.snapT.length, presenceEvents: B.evKey.length, uniquePairs: B.keys.length,
    from: new Date(B.snapT[0]).toISOString(), to: new Date(B.snapT[B.snapT.length - 1]).toISOString(),
    rowsExcludedMalformed: B.excludedRows,
    depthCaveat: 'This board persisted NO capacity/depth field, so sizing could NOT be depth-capped. Results assume the ticket always fills at size, which FLATTERS them.',
  },
  baselines,
  results,
};
fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
console.error(`[mk] wrote ${OUT_FILE}`);
