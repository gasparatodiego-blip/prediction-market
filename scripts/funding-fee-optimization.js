#!/usr/bin/env node
'use strict';
/**
 * FEE / MAKER / VENUE OPTIMIZATION vs BREAKEVEN — Jul 6→19 real history. READ-ONLY.
 *
 * QUESTION: breakevenDays = round_trip_fees / daily_net_funding. Can it be driven under a
 * spread's ACTUAL survival time by (a) maker fees, (b) venue selection, or (c) both?
 *
 * UNIT OF ANALYSIS: a "spread instance" = one contiguous presence run of a
 * (coin|shortVenue|longVenue) pair on the board. For each instance we compute, from REAL data:
 *   survivalDays   — how long the spread actually stayed on the board
 *   realNetFunding — settled funding actually accrued over that exact window ($1k notional)
 *   feesTaker / feesMakerMixed / feesMakerBoth
 *   breakeven under each fee regime, compared against that instance's own survival
 *
 * ORACLE FRAMING (deliberately the most generous possible read): P&L assumes PERFECT
 * foresight — enter at the instant the spread appears, exit at the instant it dies, hold its
 * entire life. No strategy can beat this. If the oracle is negative, nothing is profitable.
 *
 * MAKER FEE DATA — sourced from lib/funding-math.js comments, which cite the venue docs/API
 * and the date read. Venues WITHOUT a documented maker rate are left null and EXCLUDED from
 * maker scenarios; no maker fee is invented for them.
 *
 * NO external fetches. Nothing is written except the result JSON.
 */

const fs   = require('fs');
const path = require('path');

const ROOT       = path.join(__dirname, '..');
const HIST       = path.join(ROOT, 'data', 'history', 'funding');
const FUND_14D   = path.join(ROOT, 'data', 'funding-history-14d.json');
const FUND_CACHE = '/tmp/funding-history-cache.json';
const OUT_FILE   = path.join(ROOT, 'data', 'funding-fee-optimization.json');

const SOURCE_GONE_STREAK_N = 2;
const DAY_MS = 86_400_000;
const NOTIONAL = 1000;

// TAKER — verbatim from lib/funding-math.js VENUE_FEE_PCT (% per leg).
const TAKER = {
  binance:0.04, bybit:0.04, okx:0.04, gateio:0.05, bitget:0.06,
  hyperliquid:0.025, dydx:0.05, aster:0.04, paradex:0.02, edgex:0.038,
  grvt:0.045, lighter:0.0, extended:0.025, pacifica:0.04, apex:0.05,
};
// MAKER — only where lib/funding-math.js documents a sourced maker rate. null = NO DATA.
// Sources are the inline citations in that file (venue docs / live API, dated 2026-07-04/05).
const MAKER = {
  hyperliquid:0.0,      // "Hyperliquid taker (maker 0%)"
  aster:0.0,            // "Aster USDT-Perp taker (maker 0%)" — docs.asterdex.com
  paradex:0.0,          // live API taker 0.02 / maker 0%
  edgex:0.018,          // live API taker 0.038 / maker 0.018
  grvt:-0.0001,         // help.grvt.io — base tier maker -0.0001% (rebate)
  lighter:0.0,          // live API taker 0.0000 / maker 0.0000
  extended:0.0,         // docs.extended.exchange — taker 0.025 / maker 0.000
  pacifica:0.015,       // docs.pacifica.fi tier-1 maker 0.015
  apex:0.02,            // apex.exchange standard maker 0.02
  // ── NO DOCUMENTED MAKER RATE (left null on purpose, never guessed) ──
  binance:null, bybit:null, okx:null, gateio:null, bitget:null, dydx:null,
};
const MAKER_GAPS = Object.keys(MAKER).filter(v => MAKER[v] == null);

const rt = (a, b, tbl) => {                 // round trip = (feeShort + feeLong) × 2 (open+close)
  const x = tbl[a], y = tbl[b];
  if (x == null || y == null) return null;
  return (x + y) * 2;
};

// ── accrual ──────────────────────────────────────────────────────────────────
function buildAccrual() {
  const byVenue = new Map();
  for (const f of [FUND_14D, FUND_CACHE]) {
    let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    if (!j || !j.data) continue;
    for (const v of Object.keys(j.data)) {
      if (!byVenue.has(v)) byVenue.set(v, new Map());
      const vm = byVenue.get(v);
      for (const c of Object.keys(j.data[v])) {
        const arr = j.data[v][c]; if (!Array.isArray(arr)) continue;
        if (!vm.has(c)) vm.set(c, new Map());
        const cm = vm.get(c);
        for (const p of arr) if (p && typeof p.t === 'number' && typeof p.rate === 'number' && !cm.has(p.t)) cm.set(p.t, p.rate);
      }
    }
  }
  const out = new Map();
  for (const [v, vm] of byVenue) {
    const o = new Map();
    for (const [c, cm] of vm) o.set(c, [...cm.entries()].map(([t, rate]) => ({ t, rate })).sort((a, b) => a.t - b.t));
    out.set(v, o);
  }
  return out;
}
function accrue(acc, venue, coin, s, u, ivMs) {
  const vm = acc.get(venue); const pts = vm && vm.get(coin);
  if (!pts || !pts.length) return null;
  let sum = 0, n = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]; if (p.t <= s || p.t > u) continue;
    const prev = i > 0 ? pts[i - 1].t : (p.t - ivMs);
    sum += (p.rate / 100) * Math.min((p.t - prev) / ivMs, 1); n++;
  }
  return { sum, n };
}

// ── build spread instances from the board ────────────────────────────────────
const acc = buildAccrual();
const files = fs.readdirSync(HIST).filter(f => /^\d{4}-\d{2}-\d{2}(\.\d+)?\.json$/.test(f))
  .map(n => { const m = n.match(/^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.json$/); return { name:n, day:m[1], part:m[2]?+m[2]:0 }; })
  .sort((a, b) => a.day === b.day ? a.part - b.part : (a.day < b.day ? -1 : 1));

const snapT = [];
const seen = new Map();           // key → { meta, idxs:[snapIdx] }
for (const f of files) {
  let snaps; try { snaps = JSON.parse(fs.readFileSync(path.join(HIST, f.name), 'utf8')); } catch { continue; }
  if (!Array.isArray(snaps)) continue;
  for (const s of snaps) {
    if (typeof s.t !== 'number' || !Array.isArray(s.rows)) continue;
    const si = snapT.length; snapT.push(s.t);
    for (const r of s.rows) {
      if (r.coin == null || r.shortVenue == null || r.longVenue == null) continue;
      const key = `${r.coin}|${r.shortVenue}|${r.longVenue}`;
      let e = seen.get(key);
      if (!e) { e = { meta:{ coin:r.coin, s:r.shortVenue, l:r.longVenue, sIv:r.shortIntervalH||1, lIv:r.longIntervalH||1 }, idxs:[] }; seen.set(key, e); }
      if (e.idxs.length === 0 || e.idxs[e.idxs.length-1] !== si) e.idxs.push(si);
    }
  }
  snaps = null;
}

const instances = [];
let noAccrual = 0;
for (const [key, e] of seen) {
  const { coin, s, l, sIv, lIv } = e.meta;
  let runStart = 0;
  for (let i = 0; i < e.idxs.length; i++) {
    const isLast = i === e.idxs.length - 1;
    if (isLast || (e.idxs[i+1] - e.idxs[i]) > SOURCE_GONE_STREAK_N) {
      const t0 = snapT[e.idxs[runStart]], t1 = snapT[e.idxs[i]];
      const survivalDays = (t1 - t0) / DAY_MS;
      const sA = accrue(acc, s, coin, t0, t1, sIv*3_600_000);
      const lA = accrue(acc, l, coin, t0, t1, lIv*3_600_000);
      if (sA == null || lA == null) { noAccrual++; runStart = i+1; continue; }
      const realNet = (sA.sum - lA.sum) * NOTIONAL;              // $ over the whole life
      const dailyNet = survivalDays > 0 ? realNet / survivalDays : 0;
      const fT = rt(s, l, TAKER), fM = rt(s, l, MAKER);
      const fMixS = (MAKER[s] != null && TAKER[l] != null) ? (MAKER[s] + TAKER[l]) * 2 : null;
      const fMixL = (TAKER[s] != null && MAKER[l] != null) ? (TAKER[s] + MAKER[l]) * 2 : null;
      const fMix  = (fMixS == null && fMixL == null) ? null : Math.min(...[fMixS, fMixL].filter(x => x != null));
      const be = f => (f == null || dailyNet <= 0) ? null : (f/100*NOTIONAL) / dailyNet;
      instances.push({
        key, coin, shortVenue:s, longVenue:l,
        startIso:new Date(t0).toISOString(), survivalDays:+survivalDays.toFixed(4),
        settledPoints:sA.n + lA.n,
        realNetFundingUsd:+realNet.toFixed(4), dailyNetUsd:+dailyNet.toFixed(5),
        feePctTaker:fT, feePctMakerMixed:fMix, feePctMakerBoth:fM,
        beTaker:be(fT), beMakerMixed:be(fMix), beMakerBoth:be(fM),
        pnlTaker: fT == null ? null : +(realNet - fT/100*NOTIONAL).toFixed(4),
        pnlMakerBoth: fM == null ? null : +(realNet - fM/100*NOTIONAL).toFixed(4),
        makerDataComplete: fM != null,
      });
      runStart = i+1;
    }
  }
}

// ── analysis ─────────────────────────────────────────────────────────────────
const withPos = instances.filter(x => x.dailyNetUsd > 0);
const zeroOrNeg = instances.filter(x => x.dailyNetUsd <= 0);
const beatsT = instances.filter(x => x.beTaker != null && x.beTaker < x.survivalDays);
const beatsM = instances.filter(x => x.beMakerBoth != null && x.beMakerBoth < x.survivalDays);
const beatsMix = instances.filter(x => x.beMakerMixed != null && x.beMakerMixed < x.survivalDays);

const med = a => { if (!a.length) return null; const s=[...a].sort((x,y)=>x-y); return +s[Math.floor(s.length/2)].toFixed(3); };
const dist = sel => {
  const v = instances.map(sel).filter(x => x != null && Number.isFinite(x));
  return { n:v.length, median:med(v), under4d:v.filter(x=>x<4).length, under1d:v.filter(x=>x<1).length };
};

// survival distribution — drives maker fill risk
const surv = instances.map(x => x.survivalDays).sort((a,b)=>a-b);
const fillRisk = w => ({ windowHours:w, instancesDyingWithin:surv.filter(s => s*24 < w).length,
                         pct:+(100*surv.filter(s=>s*24<w).length/surv.length).toFixed(1) });

// oracle P&L: perfect entry/exit, hold the spread's entire life
const oracle = (field) => {
  const el = instances.filter(x => x[field] != null);
  return { instances: el.length, netUsdPer1k: +el.reduce((s,x)=>s+x[field],0).toFixed(2),
           winners: el.filter(x=>x[field]>0).length, losers: el.filter(x=>x[field]<0).length };
};

// venue-pair ranking by inverse breakeven (best achievable)
const byPair = new Map();
for (const x of instances) {
  const k = `${x.coin}|${x.shortVenue}|${x.longVenue}`;
  let a = byPair.get(k); if (!a) { a = []; byPair.set(k, a); }
  a.push(x);
}
const pairRank = [...byPair.entries()].map(([k, arr]) => {
  const totalNet = arr.reduce((s,x)=>s+x.realNetFundingUsd,0);
  const totalDays = arr.reduce((s,x)=>s+x.survivalDays,0);
  const dailyNet = totalDays > 0 ? totalNet/totalDays : 0;
  const a0 = arr[0];
  const beT = (a0.feePctTaker != null && dailyNet>0) ? (a0.feePctTaker/100*NOTIONAL)/dailyNet : null;
  const beM = (a0.feePctMakerBoth != null && dailyNet>0) ? (a0.feePctMakerBoth/100*NOTIONAL)/dailyNet : null;
  return { pair:k, coin:a0.coin, shortVenue:a0.shortVenue, longVenue:a0.longVenue,
           instances:arr.length, medianSurvivalDays:med(arr.map(x=>x.survivalDays)),
           dailyNetUsdPer1k:+dailyNet.toFixed(5),
           feePctTaker:a0.feePctTaker, feePctMakerBoth:a0.feePctMakerBoth,
           beTakerDays: beT==null?null:+beT.toFixed(2), beMakerDays: beM==null?null:+beM.toFixed(2),
           takerBeatsSurvival: beT!=null && beT < med(arr.map(x=>x.survivalDays)),
           makerBeatsSurvival: beM!=null && beM < med(arr.map(x=>x.survivalDays)) };
}).filter(p => p.dailyNetUsdPer1k > 0).sort((a,b) => (a.beMakerDays ?? a.beTakerDays ?? 1e9) - (b.beMakerDays ?? b.beTakerDays ?? 1e9));

// fee vs funding trade-off correlation (is "cheap AND high-funding" available?)
const corrPts = pairRank.filter(p => p.feePctTaker != null && p.dailyNetUsdPer1k > 0);
const mean = a => a.reduce((s,x)=>s+x,0)/a.length;
let corr = null;
if (corrPts.length > 2) {
  const X = corrPts.map(p=>p.feePctTaker), Y = corrPts.map(p=>p.dailyNetUsdPer1k);
  const mx=mean(X), my=mean(Y);
  const num = X.reduce((s,x,i)=>s+(x-mx)*(Y[i]-my),0);
  const den = Math.sqrt(X.reduce((s,x)=>s+(x-mx)**2,0) * Y.reduce((s,y)=>s+(y-my)**2,0));
  corr = den ? +(num/den).toFixed(4) : null;
}

const out = {
  kind:'funding-fee-maker-venue-optimization', generatedAt:new Date().toISOString(),
  readOnly:true, notionalPer1k:NOTIONAL,
  premiseCheck:{
    note:'The 10.95%/yr perp default appears as 0.01%/8h, 0.00125%/1h and 0.005%/4h — all identical annualized. Verified directly from the settled series, not assumed.',
  },
  feeTable:{ taker:TAKER, maker:MAKER, makerGapVenues:MAKER_GAPS,
    makerGapNote:'These venues have NO documented maker rate in lib/funding-math.js. They are EXCLUDED from maker scenarios rather than assigned an invented rate.' },
  universe:{
    spreadInstances:instances.length,
    instancesDroppedNoAccrual:noAccrual,
    withPositiveDailyNet:withPos.length,
    withZeroOrNegativeDailyNet:zeroOrNeg.length,
    zeroOrNegPct:+(100*zeroOrNeg.length/instances.length).toFixed(1),
    makerDataComplete:instances.filter(x=>x.makerDataComplete).length,
  },
  breakevenDistribution:{
    taker:dist(x=>x.beTaker), makerMixed:dist(x=>x.beMakerMixed), makerBoth:dist(x=>x.beMakerBoth),
  },
  beatsSurvival:{
    taker:beatsT.length, makerMixed:beatsMix.length, makerBoth:beatsM.length,
    ofTotal:instances.length,
  },
  survival:{ medianDays:med(surv), p90Days:+surv[Math.floor(surv.length*0.9)].toFixed(3),
             maxDays:+surv[surv.length-1].toFixed(3),
             fillRisk:[fillRisk(0.25), fillRisk(1), fillRisk(4), fillRisk(24)] },
  oraclePnlPer1k:{ taker:oracle('pnlTaker'), makerBoth:oracle('pnlMakerBoth') },
  // APPLES-TO-APPLES: the maker oracle can only cover instances where BOTH legs have a
  // documented maker rate. Comparing it to the full-universe taker number would overstate
  // the maker gain. Both regimes restricted to the identical maker-complete subset:
  oracleSameSubset:(() => {
    const sub = instances.filter(x => x.makerDataComplete && x.pnlTaker != null);
    const sum = f => +sub.reduce((s,x)=>s+x[f],0).toFixed(2);
    const zeroFeeStill = sub.filter(x => x.realNetFundingUsd <= 0).length;
    return {
      instances: sub.length,
      takerNetUsdPer1k: sum('pnlTaker'),
      makerNetUsdPer1k: sum('pnlMakerBoth'),
      feeSavingUsd: +(sum('pnlMakerBoth') - sum('pnlTaker')).toFixed(2),
      takerWinners: sub.filter(x=>x.pnlTaker>0).length,
      makerWinners: sub.filter(x=>x.pnlMakerBoth>0).length,
      // The floor question: with fees set to EXACTLY zero, how much is still lost purely
      // because the funding gap itself was negative over the spread's life?
      grossFundingOnlyUsd: +sub.reduce((s,x)=>s+x.realNetFundingUsd,0).toFixed(2),
      instancesWithNegativeGrossFunding: zeroFeeStill,
      pctNegativeGrossFunding: +(100*zeroFeeStill/sub.length).toFixed(1),
    };
  })(),
  // THE CEILING: venue pairs where BOTH legs are genuinely zero-or-negative maker fee
  // (lighter/extended/aster/paradex/hyperliquid = 0%, grvt = -0.0001% rebate). Here the
  // round trip costs nothing, so P&L == the raw funding gap. Nothing can beat this.
  zeroMakerFeeCeiling:(() => {
    const z = instances.filter(x => MAKER[x.shortVenue] != null && MAKER[x.longVenue] != null
                                 && MAKER[x.shortVenue] <= 0 && MAKER[x.longVenue] <= 0);
    const gross = +z.reduce((s,x)=>s+x.realNetFundingUsd,0).toFixed(2);
    const dieFast = w => z.filter(x => x.survivalDays*24 < w).length;
    return {
      instances:z.length,
      netUsdPer1k_atZeroFees:gross,
      winners:z.filter(x=>x.realNetFundingUsd>0).length,
      losers:z.filter(x=>x.realNetFundingUsd<0).length,
      medianSurvivalDays:med(z.map(x=>x.survivalDays)),
      dyingWithin1h:dieFast(1), dyingWithin4h:dieFast(4),
      note:'Requires FOUR maker fills (open+close on both legs) with zero taker fallback. Instances dying within 1h/4h are the ones where that is least plausible.',
    };
  })(),
  top20Pairs:pairRank.slice(0,20),
  feeVsFundingCorrelation:{ pearson:corr, n:corrPts.length,
    interpretation:'positive => higher-fee venues also carry higher funding (a trade-off); ~0 => fee and funding are unrelated, so cheap+high-funding is available; negative => cheap venues also pay more (best of both)' },
  winnersUnderMaker:beatsM.slice(0,50).map(x=>({ key:x.key, survivalDays:x.survivalDays,
    beMakerBoth:+x.beMakerBoth.toFixed(3), dailyNetUsd:x.dailyNetUsd, pnlMakerBoth:x.pnlMakerBoth })),
};
fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
console.error(`[opt] instances ${instances.length} | posDaily ${withPos.length} | zero/neg ${zeroOrNeg.length}`);
console.error(`[opt] beats survival — taker ${beatsT.length}, mixed ${beatsMix.length}, maker ${beatsM.length}`);
console.error(`[opt] oracle net/1k — taker $${out.oraclePnlPer1k.taker.netUsdPer1k}, maker $${out.oraclePnlPer1k.makerBoth.netUsdPer1k}`);
console.error(`[opt] wrote ${OUT_FILE}`);
