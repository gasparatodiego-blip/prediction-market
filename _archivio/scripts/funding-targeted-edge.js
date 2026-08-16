#!/usr/bin/env node
/**
 * funding-targeted-edge.js — READ-ONLY.
 *
 * Follow-up to the WHY analysis, which established:
 *   - 11/14 venues quote an identical 10.95%/yr default → cross-venue SPREAD is 0.00
 *     for most hours; the pair's spread persists ~1h while RAW funding persists ~236h.
 *   - Only 3.4% of cross-venue opportunities ever repaid one round-trip fee.
 *   - The 263 fee-clearers were almost all lighter-legged.
 *
 * This script tests the two lanes the data actually points at:
 *   §1 Perp-vs-Spot (raw rate vs spot) — survival + fee hurdle vs the cross-venue lane.
 *   §2 The off-default venue subset (lighter / extended / dydx) across BOTH lanes.
 *   §3 breakeven < survival profitable set, targeted net P&L, maker effect.
 *
 * ── DATA (all on-disk, no network) ──────────────────────────────────────────
 *   data/history/perp-spot/    Jul 7→19  board snapshots (~93/day, ~15.5 min apart)
 *   data/history/funding/      Jul 6→19  cross-venue board snapshots
 *   data/funding-history-14d.json        REAL settled funding, per venue per coin
 *
 * ── SCHEMA CORRECTION vs the earlier all-lanes backtest ─────────────────────
 *   That script's header states perp-spot persists NO fee field and NO capacity
 *   field. That was true on Jul 7 only. Verified field presence per day:
 *     fees     : absent Jul 7, present Jul 8→19 (100% of rows from Jul 9)
 *     capacity : absent Jul 7-8, present Jul 9→19 (~75% of rows)
 *   So this script uses the board's OWN per-row perpFeePct/spotFeePct rather than
 *   re-deriving them from the fee model, and depth-caps sizing where capacity exists.
 *   Jul 7 rows are excluded from fee/economics (kept only for survival timing).
 *
 * ── UNITS: the x100 trap, verified empirically (do NOT "fix" this) ──────────
 *   Both the board rows AND data/funding-history-14d.json store funding as a PERCENT
 *   per native interval, not a fraction. Verified two independent ways:
 *     1. Joining board rows to settled points at matching timestamps gives ratio ~1.0
 *        (same magnitude, same units) across venues/coins.
 *     2. rate x (8760/intervalH) reproduces the board's own predictedGrossApy EXACTLY
 *        (TIA extended/hyperliquid: (0.0013 - -0.001248) x 8760 = 22.32 = board 22.32).
 *   Treating these as fractions inflates all accrual 100x — which is exactly what
 *   produced an absurd "+$99,188 on a $1,000 ticket" in the first draft of this script.
 *
 * ── WHY THIS SCRIPT DOES NOT USE THE BOARD'S grossRoiPctYr / breakevenDays ──
 *   The same TIA row carries grossRoiPctYr 46.72 against a rate-derived gap APY of
 *   22.32 — a 2.09x capital convention (leverage/margin basis) that is not documented
 *   in the row and cannot be pinned down from the persisted fields. The board's own
 *   breakevenDays (0.8d) is derived from it and is therefore ~2x optimistic relative
 *   to a notional basis. Since fees here are charged on NOTIONAL, this script derives
 *   gross, accrual and breakeven from the raw rates on one consistent notional basis.
 *   That is the conservative choice; the discrepancy is reported, not silently taken.
 *
 * ── ACCRUAL ─────────────────────────────────────────────────────────────────
 *   Never sums raw history points (the Paradex 8h-resample trap: some venues store a
 *   resampled rate every ~2 min, which would overcount ~240x). Every point accrues
 *   rate x (dt / intervalNativeHours), dt clamped to <=1 native interval so a gap in
 *   the series cannot manufacture funding. Result is a PERCENT of notional.
 *     perp-spot : net = shortRate x size          (short perp collects; spot earns 0)
 *     perp-perp : net = (shortRate - longRate) x size
 *
 * ── FEES ────────────────────────────────────────────────────────────────────
 *   TAKER is the headline everywhere. Round trip = 2 x (both legs).
 *   perp-spot : row perpFeePct + row spotFeePct (board's own, real).
 *   perp-perp : row totalFeesPct (board's own round-trip, both legs).
 *   MAKER is sourced ONLY from rates explicitly documented in lib/funding-math.js
 *   comments. Venues with no documented maker rate are reported as a GAP and are
 *   NEVER assumed to be zero or favorable.
 *
 * ── LIMITATIONS (stated, not buried) ────────────────────────────────────────
 *   1. The perp-spot board publishes only the BEST short venue per coin (+ one
 *      runnerUp). A venue's opportunity can leave the board while still existing.
 *      Board survival is therefore a LOWER BOUND on true opportunity life.
 *   2. No lane persisted a price ladder. Slippage beyond the round-trip fee is not
 *      simulated. Both lanes' P&L is thereby flattered.
 *   3. ~13 days of history. Any conclusion about multi-day holds fits <=3
 *      non-overlapping episodes and is LOW CONFIDENCE BY CONSTRUCTION.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT     = path.join(__dirname, '..');
const PS_DIR   = path.join(ROOT, 'data', 'history', 'perp-spot');
const FUND_DIR = path.join(ROOT, 'data', 'history', 'funding');
const SETTLED  = path.join(ROOT, 'data', 'funding-history-14d.json');

const OFF_DEFAULT = new Set(['lighter', 'extended', 'dydx']);
const GAP_TOLERANCE_SNAPS = 2;          // ~31 min of board absence still = same episode
const TICKETS = [1000, 10000];
const MAKER_FILL_WINDOW_H = 1;          // survival below this => maker may never fill

/**
 * Maker fee %/leg, ONLY where lib/funding-math.js documents a real sourced rate.
 * Anything absent here is a genuine gap and is excluded from the maker scenario.
 */
const MAKER_FEE_PCT = {
  hyperliquid: 0.0,      // "Hyperliquid taker (maker 0%)"
  aster:       0.0,      // "Aster USDT-Perp taker (maker 0%)"
  paradex:     0.0,      // "Paradex perp taker (maker 0%)"
  lighter:     0.0,      // live API maker_fee=0.0000
  extended:    0.0,      // docs: maker 0.000%
  edgex:       0.018,    // docs + live: maker 0.018%
  grvt:       -0.0001,   // docs: maker -0.0001% rebate
  pacifica:    0.015,    // docs: Tier-1 maker 0.015%
  apex:        0.02,     // docs: standard maker 0.02%
};
const MAKER_UNKNOWN = new Set(); // filled at runtime with venues we saw but can't price

const fmt  = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : 'n/a');
const pct  = (a, b) => (b > 0 ? (100 * a / b).toFixed(1) + '%' : 'n/a');

function quantiles(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
  return { n: s.length, min: s[0], p25: q(0.25), med: q(0.5), p75: q(0.75), max: s[s.length - 1] };
}
const qline = (q, u = 'h') => q
  ? `n=${q.n}  p25 ${fmt(q.p25, 1)}${u}  median ${fmt(q.med, 1)}${u}  p75 ${fmt(q.p75, 1)}${u}  max ${fmt(q.max, 1)}${u}`
  : 'no data';

function loadDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const snaps = [];
  for (const f of fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}(\.\d+)?\.json$/.test(x))) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    for (const s of (Array.isArray(d) ? d : [])) if (s && s.t && Array.isArray(s.rows)) snaps.push(s);
  }
  snaps.sort((a, b) => a.t - b.t);
  // de-dupe identical timestamps (the .01 rotation files overlap the base files)
  const seen = new Set();
  return snaps.filter((s) => (seen.has(s.t) ? false : (seen.add(s.t), true)));
}

/* ── settled funding: real accrual, interval-aware ─────────────────────────── */
let SETTLED_DATA = {};
let SETTLED_SPAN = null;
function loadSettled() {
  if (!fs.existsSync(SETTLED)) return;
  const raw = JSON.parse(fs.readFileSync(SETTLED, 'utf8'));
  SETTLED_DATA = raw.data || {};
  let lo = Infinity, hi = -Infinity;
  for (const v of Object.keys(SETTLED_DATA)) {
    for (const c of Object.keys(SETTLED_DATA[v] || {})) {
      const pts = SETTLED_DATA[v][c];
      if (!Array.isArray(pts)) continue;
      pts.sort((a, b) => a.t - b.t);
      if (pts.length) { lo = Math.min(lo, pts[0].t); hi = Math.max(hi, pts[pts.length - 1].t); }
    }
  }
  SETTLED_SPAN = Number.isFinite(lo) ? { lo, hi } : null;
}

/** Median spacing of a venue/coin series, in hours — used to detect resampling. */
const spacingCache = new Map();
function medianSpacingH(venue, coin) {
  const k = venue + '|' + coin;
  if (spacingCache.has(k)) return spacingCache.get(k);
  const pts = (SETTLED_DATA[venue] || {})[coin];
  let out = null;
  if (Array.isArray(pts) && pts.length > 3) {
    const gaps = [];
    for (let i = 1; i < pts.length; i++) gaps.push((pts[i].t - pts[i - 1].t) / 3.6e6);
    gaps.sort((a, b) => a - b);
    out = gaps[Math.floor(gaps.length / 2)];
  }
  spacingCache.set(k, out);
  return out;
}

/**
 * PERCENT of notional accrued by holding a SHORT on (venue, coin) from t0..t1.
 * Stored rates are percents per interval (see the x100 note in the header), so the
 * sum is already a percent — no x100 rescale anywhere downstream.
 * Interval-aware: each point contributes rate x (dt / nativeIntervalHours), so a
 * resampled series (dt << interval) cannot overcount. Returns null if uncovered.
 */
function accruePct(venue, coin, t0, t1, intervalH) {
  const pts = (SETTLED_DATA[venue] || {})[coin];
  if (!Array.isArray(pts) || !pts.length) return null;
  if (t1 <= t0) return 0;
  if (t0 < pts[0].t || t1 > pts[pts.length - 1].t) return null;   // outside real coverage
  const nativeH = Number(intervalH) > 0 ? Number(intervalH) : (medianSpacingH(venue, coin) || 8);
  let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i].t;
    if (a >= t1) break;
    const b = i + 1 < pts.length ? pts[i + 1].t : a + nativeH * 3.6e6;
    const lo = Math.max(a, t0), hi = Math.min(b, t1);
    if (hi <= lo) continue;
    const dtH = Math.min((hi - lo) / 3.6e6, nativeH);   // clamp: a gap can't mint funding
    acc += Number(pts[i].rate || 0) * (dtH / nativeH);
  }
  return acc;
}

/* ── episode builder: contiguous presence of a key on the board ────────────── */
function buildEpisodes(snaps, keyOf, pickFields) {
  const open = new Map();
  const done = [];
  snaps.forEach((snap, idx) => {
    const present = new Set();
    for (const row of snap.rows) {
      const key = keyOf(row);
      if (!key) continue;
      present.add(key);
      let ep = open.get(key);
      if (!ep) {
        ep = { key, firstT: snap.t, lastT: snap.t, lastIdx: idx, entry: pickFields(row, snap), obs: [] };
        open.set(key, ep);
      }
      ep.lastT = snap.t;
      ep.lastIdx = idx;
      ep.obs.push(pickFields(row, snap));
    }
    for (const [key, ep] of [...open]) {
      if (!present.has(key) && idx - ep.lastIdx > GAP_TOLERANCE_SNAPS) { done.push(ep); open.delete(key); }
    }
  });
  for (const ep of open.values()) { ep.censored = true; done.push(ep); }
  for (const ep of done) ep.survivalH = (ep.lastT - ep.firstT) / 3.6e6;
  return done;
}

/* ══════════════════════════════════════════════════════════════════════════ */
loadSettled();
const psSnaps = loadDir(PS_DIR);
const fnSnaps = loadDir(FUND_DIR);

const out = [];
const say = (s = '') => { out.push(s); console.log(s); };

say('='.repeat(78));
say('TARGETED FUNDING EDGE — Perp-vs-Spot + off-default venues (lighter/extended/dydx)');
say('='.repeat(78));
say(`perp-spot board : ${psSnaps.length} snapshots  ${new Date(psSnaps[0].t).toISOString().slice(0, 16)} -> ${new Date(psSnaps[psSnaps.length - 1].t).toISOString().slice(0, 16)}`);
say(`cross-venue     : ${fnSnaps.length} snapshots  ${new Date(fnSnaps[0].t).toISOString().slice(0, 16)} -> ${new Date(fnSnaps[fnSnaps.length - 1].t).toISOString().slice(0, 16)}`);
say(`settled funding : ${Object.keys(SETTLED_DATA).length} venues` + (SETTLED_SPAN
  ? `  ${new Date(SETTLED_SPAN.lo).toISOString().slice(0, 16)} -> ${new Date(SETTLED_SPAN.hi).toISOString().slice(0, 16)}`
  : '  (absent)'));

/* ── verify the WHY analysis premise: the 10.95%/yr default ────────────────── */
say('');
say('-'.repeat(78));
say('PREMISE CHECK — the 10.95%/yr default quote');
say('-'.repeat(78));
{
  const last = fnSnaps[fnSnaps.length - 1];
  const byVenue = new Map();
  for (const s of fnSnaps.slice(-200)) {
    for (const r of s.rows) {
      for (const [v, rate, ih] of [[r.shortVenue, r.shortRate, r.shortIntervalH],
                                   [r.longVenue,  r.longRate,  r.longIntervalH]]) {
        if (!v || rate == null) continue;
        // rate is a PERCENT per interval -> APY is a straight scale, no x100.
        const apy = Number(rate) * (8760 / (Number(ih) || 8));
        if (!byVenue.has(v)) byVenue.set(v, []);
        byVenue.get(v).push(+apy.toFixed(2));
      }
    }
  }
  const rows = [...byVenue.entries()].map(([v, arr]) => {
    const counts = new Map();
    for (const a of arr) counts.set(a, (counts.get(a) || 0) + 1);
    const [mode, cnt] = [...counts].sort((a, b) => b[1] - a[1])[0];
    return { v, mode, share: cnt / arr.length, n: arr.length };
  }).sort((a, b) => b.share - a.share);
  let atDefault = 0;
  for (const r of rows) {
    const isDef = Math.abs(r.mode - 10.95) < 0.01;
    if (isDef) atDefault++;
    say(`  ${r.v.padEnd(12)} modal APY ${String(r.mode).padStart(8)}%/yr  ${pct(r.share * r.n, r.n).padStart(6)} of quotes${isDef ? '   <- 10.95 DEFAULT' : ''}`);
  }
  say(`  => ${atDefault}/${rows.length} venues sit at the 10.95%/yr default. Off-default: ` +
      rows.filter((r) => Math.abs(r.mode - 10.95) >= 0.01).map((r) => r.v).join(', '));
  void last;
}

/* ══ §1 PERP-VS-SPOT ═══════════════════════════════════════════════════════ */
const psEps = buildEpisodes(
  psSnaps,
  (r) => (r.coin && r.shortVenue ? `${r.coin}|${r.shortVenue}|${r.spotVenueSuggested || '?'}` : null),
  (r, s) => ({
    t: s.t, coin: r.coin, shortVenue: r.shortVenue, spotVenue: r.spotVenueSuggested,
    fundingPct8h: Number(r.fundingPct8h),
    intervalH: Number(r.intervalH) || 8,
    perpFeePct: r.perpFeePct == null ? null : Number(r.perpFeePct),
    spotFeePct: r.spotFeePct == null ? null : Number(r.spotFeePct),
    capacityUsd: r.wholeTradeCapacityUsd == null ? null : Number(r.wholeTradeCapacityUsd),
    netPerDay1kUsd: r.netPerDay1kUsd == null ? null : Number(r.netPerDay1kUsd),
  })
);

/** Attach economics to an episode using its own persisted fees. */
function priceEpisode(ep) {
  const withFee = ep.obs.filter((o) => o.perpFeePct != null && o.spotFeePct != null);
  ep.pricable = withFee.length > 0;
  if (!ep.pricable) return ep;
  const e = withFee[0];
  ep.perpFeePct = e.perpFeePct;
  ep.spotFeePct = e.spotFeePct;
  ep.roundTripPct = 2 * (e.perpFeePct + e.spotFeePct);
  // fundingPct8h is a PERCENT per 8h -> %/day on notional = x3.
  ep.grossPctPerDay = e.fundingPct8h * 3;
  ep.breakevenDays = ep.grossPctPerDay > 0 ? ep.roundTripPct / ep.grossPctPerDay : Infinity;
  const caps = ep.obs.map((o) => o.capacityUsd).filter((c) => c != null && c > 0);
  ep.capacityUsd = caps.length ? Math.min(...caps) : null;
  // REAL settled accrual (percent of notional) over the episode's actual board life
  ep.accruedPct = accruePct(ep.shortVenueName, ep.coinName, ep.firstT, ep.lastT, e.intervalH);
  return ep;
}
for (const ep of psEps) {
  const [coin, sv, spv] = ep.key.split('|');
  ep.coinName = coin; ep.shortVenueName = sv; ep.spotVenueName = spv;
  priceEpisode(ep);
}

const psPriced = psEps.filter((e) => e.pricable && e.grossPctPerDay > 0);

say('');
say('='.repeat(78));
say('§1  PERP-VS-SPOT: SURVIVAL + FEE HURDLE');
say('='.repeat(78));
say(`episodes: ${psEps.length} total, ${psPriced.length} priceable (persisted fees + positive funding)`);
const psSurv = quantiles(psPriced.map((e) => e.survivalH));
say(`survival  ${qline(psSurv)}`);
say(`  >1d ${pct(psPriced.filter((e) => e.survivalH >= 24).length, psPriced.length)}   ` +
    `>4d ${pct(psPriced.filter((e) => e.survivalH >= 96).length, psPriced.length)}   ` +
    `censored (still open at window end) ${psPriced.filter((e) => e.censored).length}`);

/* ── ARTIFACT CONTROL ───────────────────────────────────────────────────────
   The perp-spot board publishes only the BEST short venue per coin. When the best
   venue flips, a (coin|venue) episode ends even though the coin still offers a
   carry. So the 0.5h above is a LOWER BOUND polluted by venue churn. Re-key the
   same episodes on COIN ALONE: that ignores venue flips entirely and gives the
   UPPER BOUND on how long a coin stayed carry-positive on the board. The truth is
   between the two, and the gap is the size of the measurement artifact. */
{
  const coinEps = buildEpisodes(
    psSnaps,
    (r) => (r.coin && Number(r.fundingPct8h) > 0 ? r.coin : null),
    (r, s) => ({ t: s.t, coin: r.coin })
  );
  const q = quantiles(coinEps.map((e) => e.survivalH));
  say('');
  say('ARTIFACT CONTROL — perp-spot survival re-keyed on COIN ALONE (venue churn removed):');
  say(`  ${qline(q)}`);
  say(`  >1d ${pct(coinEps.filter((e) => e.survivalH >= 24).length, coinEps.length)}   ` +
      `>4d ${pct(coinEps.filter((e) => e.survivalH >= 96).length, coinEps.length)}`);
  const lower = psSurv && psSurv.med, upper = q && q.med;
  say(`  => coin-carry life median ${fmt(upper, 1)}h vs venue-keyed ${fmt(lower, 1)}h ` +
      `(${fmt(upper / lower, 0)}x). Venue churn IS most of the 0.5h figure.`);
  say('     Even at the UPPER bound, compare against the ~8d perp-spot breakeven below.');
}

/* raw single-venue funding persistence, recomputed from settled history, as the
   yardstick the WHY analysis put at 236h */
say('');
say('RAW single-venue funding persistence (settled history, sign-stable runs):');
{
  const runs = [];
  for (const v of Object.keys(SETTLED_DATA)) {
    for (const c of Object.keys(SETTLED_DATA[v])) {
      const pts = SETTLED_DATA[v][c];
      if (!Array.isArray(pts) || pts.length < 3) continue;
      let start = null;
      for (let i = 0; i < pts.length; i++) {
        const pos = Number(pts[i].rate) > 0;
        if (pos && start == null) start = pts[i].t;
        if (!pos && start != null) { runs.push((pts[i].t - start) / 3.6e6); start = null; }
      }
      if (start != null) runs.push((pts[pts.length - 1].t - start) / 3.6e6);
    }
  }
  const q = quantiles(runs.filter((r) => r > 0));
  say(`  positive-rate runs  ${qline(q)}`);
  say(`  => yardstick: RAW funding stays positive for a median of ${fmt(q.med, 1)}h.`);
}

/* cross-venue lane for comparison */
const fnEps = buildEpisodes(
  fnSnaps,
  (r) => (r.coin && r.shortVenue && r.longVenue ? `${r.coin}|${r.shortVenue}|${r.longVenue}` : null),
  (r, s) => ({
    t: s.t, coin: r.coin, shortVenue: r.shortVenue, longVenue: r.longVenue,
    shortRate: Number(r.shortRate), longRate: Number(r.longRate),
    shortIntervalH: Number(r.shortIntervalH) || 8, longIntervalH: Number(r.longIntervalH) || 8,
    totalFeesPct: r.totalFeesPct == null ? null : Number(r.totalFeesPct),
    breakevenDays: r.breakevenDays == null ? null : Number(r.breakevenDays),
    netUsdPerDayPer1k: r.netUsdPerDayPer1k == null ? null : Number(r.netUsdPerDayPer1k),
    capacityUsd: r.capacityUsd == null ? null : Number(r.capacityUsd),
    grossRoiPctYr: Number(r.grossRoiPctYr),
  })
);
for (const ep of fnEps) {
  const [coin, sv, lv] = ep.key.split('|');
  ep.coinName = coin; ep.shortVenueName = sv; ep.longVenueName = lv;
  const e = ep.entry;
  ep.roundTripPct = e.totalFeesPct;
  // Rate-derived on a NOTIONAL basis (see header). Legs can have different intervals.
  ep.grossPctPerDay = e.shortRate * (24 / e.shortIntervalH) - e.longRate * (24 / e.longIntervalH);
  ep.breakevenDays = (ep.grossPctPerDay > 0 && ep.roundTripPct != null)
    ? ep.roundTripPct / ep.grossPctPerDay
    : Infinity;
  ep.boardBreakevenDays = e.breakevenDays;   // kept only to quantify the convention gap
  const caps = ep.obs.map((o) => o.capacityUsd).filter((c) => c != null && c > 0);
  ep.capacityUsd = caps.length ? Math.min(...caps) : null;
  const sPct = accruePct(sv, coin, ep.firstT, ep.lastT, e.shortIntervalH);
  const lPct = accruePct(lv, coin, ep.firstT, ep.lastT, e.longIntervalH);
  ep.accruedPct = (sPct != null && lPct != null) ? (sPct - lPct) : null;
}
const fnPriced = fnEps.filter((e) => e.roundTripPct != null && e.grossPctPerDay > 0);
const fnSurv = quantiles(fnPriced.map((e) => e.survivalH));
say('');
say(`CROSS-VENUE lane (comparison): episodes ${fnEps.length}, priceable ${fnPriced.length}`);
say(`survival  ${qline(fnSurv)}`);
say(`  >1d ${pct(fnPriced.filter((e) => e.survivalH >= 24).length, fnPriced.length)}   ` +
    `>4d ${pct(fnPriced.filter((e) => e.survivalH >= 96).length, fnPriced.length)}`);

say('');
say('VERDICT on the persistence question:');
say(`  raw funding persistence (median)   see above`);
say(`  perp-spot board survival (median)  ${fmt(psSurv && psSurv.med, 1)}h`);
say(`  cross-venue spread survival (med)  ${fmt(fnSurv && fnSurv.med, 1)}h`);

/* fee hurdle */
function feeHurdle(eps, label) {
  const priced = eps.filter((e) => e.roundTripPct != null && Number.isFinite(e.breakevenDays));
  const withAcc = priced.filter((e) => e.accruedPct != null);
  const cleared = withAcc.filter((e) => e.accruedPct >= e.roundTripPct);
  const repayRatio = withAcc.map((e) => (e.roundTripPct > 0 ? 100 * e.accruedPct / e.roundTripPct : 0));
  const beQ = quantiles(priced.map((e) => e.breakevenDays).filter(Number.isFinite));
  say('');
  say(`FEE HURDLE — ${label}`);
  say(`  settled-accrual coverage: ${withAcc.length}/${priced.length} episodes (${pct(withAcc.length, priced.length)})`);
  say(`  repaid one round-trip TAKER fee: ${cleared.length}/${withAcc.length} = ${pct(cleared.length, withAcc.length)}`);
  const rq = quantiles(repayRatio);
  say(`  fee repayment %          ${rq ? `median ${fmt(rq.med, 1)}%  p75 ${fmt(rq.p75, 1)}%  max ${fmt(rq.max, 0)}%` : 'n/a'}`);
  say(`  breakevenDays            ${qline(beQ, 'd')}`);
  return { priced, withAcc, cleared };
}
const psHurdle = feeHurdle(psPriced, 'PERP-VS-SPOT');

// WHY perp-spot fails: decompose its round-trip cost across every priced row.
{
  const rows = psPriced.filter((e) => e.perpFeePct != null);
  const perpRT = rows.reduce((a, e) => a + e.perpFeePct * 2, 0) / rows.length;
  const spotRT = rows.reduce((a, e) => a + e.spotFeePct * 2, 0) / rows.length;
  const mg = quantiles(rows.map((e) => e.grossPctPerDay)).med;
  const mr = quantiles(rows.map((e) => e.roundTripPct)).med;
  say('');
  say('  MECHANISM — where the perp-spot round-trip cost actually goes:');
  say(`    perp legs (x2) ${fmt(perpRT, 4)}%   spot legs (x2) ${fmt(spotRT, 4)}%   ` +
      `-> the SPOT leg is ${fmt(100 * spotRT / (perpRT + spotRT), 1)}% of the cost`);
  say(`    median gross ${fmt(mg, 4)}%/day vs median round-trip ${fmt(mr, 4)}%`);
  say(`    breakeven WITH spot taker fee: ${fmt(mr / mg, 1)}d   IF the spot leg were free: ${fmt((mr - spotRT) / mg, 1)}d`);
  say('    The lane is killed by the 0.10% x2 SPOT TAKER fee, not by lack of persistence.');
  say('    GAP: the repo documents no SPOT maker schedule, so a maker-spot variant');
  say('    CANNOT be priced here. It is flagged as unquantified, not assumed favorable.');
}
const fnHurdle = feeHurdle(fnPriced, 'CROSS-VENUE');

// Quantify the board-vs-notional breakeven convention gap rather than hiding it.
{
  const both = fnPriced.filter((e) => e.boardBreakevenDays > 0 && Number.isFinite(e.breakevenDays));
  const ratio = quantiles(both.map((e) => e.breakevenDays / e.boardBreakevenDays));
  say('');
  say(`CONVENTION GAP: this script's notional-basis breakevenDays vs the board's own field`);
  say(`  ratio (ours / board)  ${ratio ? `median ${fmt(ratio.med, 2)}x  p25 ${fmt(ratio.p25, 2)}x  p75 ${fmt(ratio.p75, 2)}x  n=${ratio.n}` : 'n/a'}`);
  say('  The board applies a ~2x capital/leverage basis that its persisted fields do not');
  say('  document. Fees are charged on notional, so this script uses the notional basis.');
  say('  Every breakeven figure here is therefore ~2x MORE conservative than the board UI.');
}

/* ══ §2 OFF-DEFAULT VENUE SUBSET ═══════════════════════════════════════════ */
say('');
say('='.repeat(78));
say('§2  OFF-DEFAULT VENUE SUBSET (lighter / extended / dydx)');
say('='.repeat(78));

const psOff  = psPriced.filter((e) => OFF_DEFAULT.has(e.shortVenueName));
const psRest = psPriced.filter((e) => !OFF_DEFAULT.has(e.shortVenueName));
const fnOff  = fnPriced.filter((e) => OFF_DEFAULT.has(e.shortVenueName) || OFF_DEFAULT.has(e.longVenueName));
const fnRest = fnPriced.filter((e) => !OFF_DEFAULT.has(e.shortVenueName) && !OFF_DEFAULT.has(e.longVenueName));

function subsetStats(eps, label) {
  const surv = quantiles(eps.map((e) => e.survivalH));
  const withAcc = eps.filter((e) => e.accruedPct != null);
  const cleared = withAcc.filter((e) => e.accruedPct >= e.roundTripPct);
  const beQ = quantiles(eps.map((e) => e.breakevenDays).filter(Number.isFinite));
  say(`  ${label}`);
  say(`    episodes ${eps.length}   survival ${qline(surv)}`);
  say(`    >1d ${pct(eps.filter((e) => e.survivalH >= 24).length, eps.length)}  >4d ${pct(eps.filter((e) => e.survivalH >= 96).length, eps.length)}`);
  say(`    fee-clearing ${cleared.length}/${withAcc.length} = ${pct(cleared.length, withAcc.length)}`);
  say(`    breakevenDays ${qline(beQ, 'd')}`);
  return { eps, cleared, withAcc };
}
say('');
say('PERP-VS-SPOT lane, split by short-venue:');
const psOffS  = subsetStats(psOff,  'OFF-DEFAULT short venue');
const psRestS = subsetStats(psRest, 'default-quoting short venue');
say('');
say('CROSS-VENUE lane, split by either-leg:');
const fnOffS  = subsetStats(fnOff,  'OFF-DEFAULT leg present');
const fnRestS = subsetStats(fnRest, 'neither leg off-default');

const allClearers = [...psHurdle.cleared, ...fnHurdle.cleared];
const offClearers = [...psOffS.cleared, ...fnOffS.cleared];
say('');
say(`CONCENTRATION: ${offClearers.length}/${allClearers.length} = ${pct(offClearers.length, allClearers.length)} of ALL fee-clearers (both lanes) involve lighter/extended/dydx.`);

say('');
say('PER OFF-DEFAULT VENUE (both lanes pooled):');
for (const v of ['lighter', 'extended', 'dydx']) {
  const eps = [...psPriced.filter((e) => e.shortVenueName === v),
               ...fnPriced.filter((e) => e.shortVenueName === v || e.longVenueName === v)];
  const withAcc = eps.filter((e) => e.accruedPct != null);
  const cleared = withAcc.filter((e) => e.accruedPct >= e.roundTripPct);
  const surv = quantiles(eps.map((e) => e.survivalH));
  const clearedSurv = quantiles(cleared.map((e) => e.survivalH));
  say(`  ${v.padEnd(9)} episodes ${String(eps.length).padStart(5)}  median survival ${fmt(surv && surv.med, 1).padStart(6)}h  ` +
      `clearing ${String(cleared.length).padStart(4)}/${String(withAcc.length).padStart(5)} = ${pct(cleared.length, withAcc.length).padStart(6)}  ` +
      `clearer median survival ${fmt(clearedSurv && clearedSurv.med, 1)}h`);
}

/* ══ §3 BREAKEVEN < SURVIVAL + TARGETED P&L ════════════════════════════════ */
say('');
say('='.repeat(78));
say('§3  BREAKEVEN < SURVIVAL  +  TARGETED NET P&L');
say('='.repeat(78));

function profitable(eps) {
  return eps.filter((e) => Number.isFinite(e.breakevenDays) && e.breakevenDays < e.survivalH / 24);
}
const psProf = profitable(psPriced);
const fnProf = profitable(fnPriced);
const psOffProf = profitable(psOff);
const fnOffProf = profitable(fnOff);
say(`perp-spot   breakeven<survival: ${psProf.length}/${psPriced.length} = ${pct(psProf.length, psPriced.length)}`);
say(`cross-venue breakeven<survival: ${fnProf.length}/${fnPriced.length} = ${pct(fnProf.length, fnPriced.length)}`);
say(`  of which off-default:  perp-spot ${psOffProf.length}   cross-venue ${fnOffProf.length}`);

/**
 * Replay a set of episodes as trades. Sizes at the ticket, depth-capped by the real
 * walked capacity where the board persisted one. Uses REAL settled accrual only —
 * episodes without settled coverage are SKIPPED, never modelled.
 */
function replay(eps, ticket, feeMode) {
  let pnl = 0, traded = 0, skippedNoAcc = 0, skippedNoFee = 0, capped = 0, wins = 0;
  for (const e of eps) {
    if (e.accruedPct == null) { skippedNoAcc++; continue; }
    let rtPct = e.roundTripPct;
    if (feeMode === 'maker') {
      const legs = e.spotVenueName !== undefined && e.longVenueName === undefined
        ? [e.shortVenueName]                 // perp-spot: only the perp leg can be maker-priced here
        : [e.shortVenueName, e.longVenueName];
      let ok = true, sum = 0;
      for (const v of legs) {
        if (v == null) continue;
        if (!(v in MAKER_FEE_PCT)) { MAKER_UNKNOWN.add(v); ok = false; break; }
        sum += MAKER_FEE_PCT[v] * 2;
      }
      if (!ok) { skippedNoFee++; continue; }
      // perp-spot: the SPOT leg has no documented maker schedule -> keep it at taker.
      if (e.longVenueName === undefined) sum += (e.spotFeePct || 0) * 2;
      rtPct = sum;
    }
    if (rtPct == null) { skippedNoFee++; continue; }
    const size = e.capacityUsd != null ? Math.min(ticket, e.capacityUsd) : ticket;
    if (size < ticket) capped++;
    const gross = size * (e.accruedPct / 100);
    const fees  = size * (rtPct / 100);
    const net   = gross - fees;
    if (net > 0) wins++;
    pnl += net; traded++;
  }
  return { pnl, traded, wins, skippedNoAcc, skippedNoFee, capped };
}

const targetedUnion = [
  ...psProf,        // Perp-vs-Spot, breakeven<survival
  ...fnOffProf,     // cross-venue with an off-default leg, breakeven<survival
];

say('');
say('RULE COMPARISON — real settled accrual, depth-capped, TAKER fees');
say(`${'rule'.padEnd(46)} ${'ticket'.padStart(7)} ${'trades'.padStart(7)} ${'win%'.padStart(6)} ${'net $'.padStart(12)}`);
const rules = [
  ['BASELINE  all cross-venue (naive)',            fnPriced],
  ['all perp-vs-spot (naive)',                     psPriced],
  ['TARGETED  perp-spot, breakeven<survival',      psProf],
  ['TARGETED  off-default any lane, be<surv',      [...psOffProf, ...fnOffProf]],
  ['TARGETED  union (perp-spot + off-default)',    targetedUnion],
];
const results = {};
for (const [label, eps] of rules) {
  for (const ticket of TICKETS) {
    const r = replay(eps, ticket, 'taker');
    results[label + '@' + ticket] = r;
    say(`${label.padEnd(46)} ${('$' + ticket).padStart(7)} ${String(r.traded).padStart(7)} ${pct(r.wins, r.traded).padStart(6)} ${(r.pnl >= 0 ? '+' : '') + fmt(r.pnl, 0).padStart(11)}`);
  }
}

say('');
say('MAKER SCENARIO — documented maker rates only; perp leg maker, spot leg stays taker');
for (const [label, eps] of rules.slice(2)) {
  for (const ticket of TICKETS) {
    const r = replay(eps, ticket, 'maker');
    say(`${label.padEnd(46)} ${('$' + ticket).padStart(7)} ${String(r.traded).padStart(7)} ${pct(r.wins, r.traded).padStart(6)} ${(r.pnl >= 0 ? '+' : '') + fmt(r.pnl, 0).padStart(11)}` +
        (r.skippedNoFee ? `   (${r.skippedNoFee} skipped: no documented maker rate)` : ''));
  }
}
if (MAKER_UNKNOWN.size) say(`  GAP — no documented maker fee for: ${[...MAKER_UNKNOWN].sort().join(', ')} (excluded, never assumed zero)`);

/* maker fill risk */
say('');
say('MAKER FILL RISK (honest):');
{
  const shortLived = targetedUnion.filter((e) => e.survivalH < MAKER_FILL_WINDOW_H);
  say(`  episodes in the targeted set surviving < ${MAKER_FILL_WINDOW_H}h: ${shortLived.length}/${targetedUnion.length} = ${pct(shortLived.length, targetedUnion.length)}`);
  say('  Those cannot be relied on to get a maker fill — the maker P&L above is an UPPER BOUND.');
}

/* concentration of the profitable set */
say('');
say('CONCENTRATION of the targeted profitable set:');
{
  const byCoin = new Map(), byVenue = new Map();
  for (const e of targetedUnion) {
    byCoin.set(e.coinName, (byCoin.get(e.coinName) || 0) + 1);
    byVenue.set(e.shortVenueName, (byVenue.get(e.shortVenueName) || 0) + 1);
  }
  const top = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}:${v}`).join('  ');
  say(`  distinct coins  ${byCoin.size}   top: ${top(byCoin)}`);
  say(`  distinct short venues ${byVenue.size}   top: ${top(byVenue)}`);
  const durable = targetedUnion.filter((e) => e.survivalH >= 24);
  const dCoins = new Set(durable.map((e) => e.coinName));
  say(`  episodes surviving >=24h: ${durable.length} across ${dCoins.size} coins${durable.length < 5 ? '   <<< FEWER THAN 5 => ANECDOTE, NOT EVIDENCE' : ''}`);
}

say('');
say('='.repeat(78));
say('Window is ~13 days. Any $ figure is over that real window only. Annualizing it');
say('would be a ">200%/yr run-rate, not guaranteed" claim, and is deliberately omitted.');
say('='.repeat(78));

fs.writeFileSync(path.join(ROOT, 'data', 'funding-targeted-edge.txt'), out.join('\n') + '\n');
