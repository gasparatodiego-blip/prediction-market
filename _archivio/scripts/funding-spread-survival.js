#!/usr/bin/env node
'use strict';
/**
 * WHY DO CROSS-VENUE FUNDING SPREADS CLOSE SO FAST? — offline analysis, Jul 6-19 2026.
 *
 * OFFLINE ANALYSIS. Reads only. Fetches nothing. Not wired into any agent, API or the
 * dashboard. Writes no file. Run: node --max-old-space-size=3500 scripts/funding-spread-survival.js
 *
 * The question is whether spreads are short-lived because the market regime is quiet, or
 * because they are structurally competed away. This measures four things:
 *   1. how long each cross-venue opportunity actually stays on the board
 *   2. RAW single-venue funding persistence vs CROSS-VENUE SPREAD persistence
 *   3. whether spread life/width tracks realized volatility inside the sample
 *   4. what fraction ever accrues enough funding to repay one round-trip fee
 *
 * SOURCES (all already on disk)
 *   data/history/funding/<date>[.NN].json  board snapshots, 16-min cadence
 *   data/funding-history-14d.json          real settled funding points, per venue per coin
 *   data/history/perp-spot/<date>.json     real markPrice series (volatility proxy)
 *
 * HONESTY CONTRACT
 *   - ~12.4 days. This CANNOT compare market regimes; there is no bull run in the sample.
 *     Any bull-vs-bear claim is out of scope and is reported as unmeasurable, not estimated.
 *   - Runs alive at the first or last snapshot are CENSORED: counted and reported separately,
 *     never silently treated as completed lives.
 *   - UNIT TRAP: a venue's stored `rate` is a PERCENT PER ITS OWN SETTLEMENT INTERVAL, and the
 *     interval is taken from the BOARD's declared shortIntervalH/longIntervalH — never inferred
 *     from the gap between stored points. Paradex publishes an 8h-normalized rate resampled
 *     every ~45s; inferring its interval from sampling would inflate it ~1920x, so it is
 *     detected and excluded from the per-venue rate sections.
 *   - Accrual integrates the board's own netUsdPerDayPer1k over real elapsed time. Nothing is
 *     modelled or extrapolated.
 *   - Non-finite/missing fields are excluded and counted, never defaulted.
 */
const fs = require('fs');

const FUNDING_DIR = 'data/history/funding';
const PERPSPOT_DIR = 'data/history/perp-spot';
const HIST_14D = 'data/funding-history-14d.json';
const HOUR = 3600000;

// A run breaks after an absence longer than this. Cadence is a steady 16 min (max observed gap
// 16.3 min, zero gaps > 60 min), so 35 min means "missed 2+ snapshots" and cannot be jitter.
const GAP_TOLERANCE_MS = 35 * 60_000;

const pct = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : 'n/a';
const quant = (s, p) => s.length ? [...s].sort((a, b) => a - b)[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN;
const stats = a => ({ n: a.length, p25: quant(a, .25), med: quant(a, .5), p75: quant(a, .75), p90: quant(a, .90), max: a.length ? Math.max(...a) : NaN });

// ── declared funding interval per venue, from the board's own rows ───────────
function declaredIntervals(sampleFile) {
  const arr = JSON.parse(fs.readFileSync(sampleFile, 'utf8'));
  const seen = {};
  for (const s of arr) for (const r of s.rows || []) {
    if (Number.isFinite(r.shortIntervalH)) (seen[r.shortVenue] = seen[r.shortVenue] || {})[r.shortIntervalH] = (seen[r.shortVenue][r.shortIntervalH] || 0) + 1;
    if (Number.isFinite(r.longIntervalH)) (seen[r.longVenue] = seen[r.longVenue] || {})[r.longIntervalH] = (seen[r.longVenue][r.longIntervalH] || 0) + 1;
  }
  const out = {};
  for (const [v, m] of Object.entries(seen)) out[v] = +Object.entries(m).sort((a, b) => b[1] - a[1])[0][0];
  return out;
}

function loadSnapshots() {
  const files = fs.readdirSync(FUNDING_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  const snaps = []; let skipped = 0;
  for (const f of files) {
    const arr = JSON.parse(fs.readFileSync(`${FUNDING_DIR}/${f}`, 'utf8'));
    if (!Array.isArray(arr)) { skipped++; continue; }
    for (const s of arr) {
      if (!s || !Number.isFinite(s.t) || !Array.isArray(s.rows)) { skipped++; continue; }
      const rows = s.rows.filter(r => r && r.coin && r.shortVenue && r.longVenue);
      skipped += s.rows.length - rows.length;
      snaps.push({ t: s.t, rows });
    }
  }
  snaps.sort((a, b) => a.t - b.t);
  return { snaps, skipped, files: files.length };
}

function buildRuns(snaps) {
  const open = new Map(); const done = [];
  const firstT = snaps[0].t, lastT = snaps[snaps.length - 1].t;
  let badNum = 0;
  for (const { t, rows } of snaps) {
    const seen = new Set();
    for (const r of rows) {
      const key = `${r.coin}|${r.shortVenue}|${r.longVenue}`;
      seen.add(key);
      let run = open.get(key);
      if (!run) {
        run = { key, coin: r.coin, pair: `${r.shortVenue}->${r.longVenue}`, startT: t, lastT: t,
                nSnaps: 0, accrued: 0, gross: [], feePcts: [], caps: [], leftCensored: t === firstT };
        open.set(key, run);
      } else {
        const dtDays = (t - run.lastT) / 86_400_000;
        if (Number.isFinite(run.lastNet)) run.accrued += run.lastNet * dtDays;   // left-endpoint integration
        run.lastT = t;
      }
      run.nSnaps++;
      if (Number.isFinite(r.netUsdPerDayPer1k)) run.lastNet = r.netUsdPerDayPer1k; else { run.lastNet = NaN; badNum++; }
      if (Number.isFinite(r.grossRoiPctYr)) run.gross.push(r.grossRoiPctYr);
      if (Number.isFinite(r.totalFeesPct)) run.feePcts.push(r.totalFeesPct);
      if (Number.isFinite(r.greenCapacityUsd)) run.caps.push(r.greenCapacityUsd);
    }
    for (const [key, run] of open) {
      if (seen.has(key)) continue;
      if (t - run.lastT > GAP_TOLERANCE_MS) { run.rightCensored = false; done.push(run); open.delete(key); }
    }
  }
  for (const run of open.values()) { run.rightCensored = true; done.push(run); }
  for (const r of done) {
    r.durationH = (r.lastT - r.startT) / HOUR;
    r.censored = r.leftCensored || r.rightCensored;
    r.medGross = quant(r.gross, .5);
    r.medFeePct = quant(r.feePcts, .5);
    r.minCap = r.caps.length ? Math.min(...r.caps) : NaN;
    r.feeUsdPer1k = Number.isFinite(r.medFeePct) ? r.medFeePct * 10 : NaN;   // round-trip fee, % of $1k
  }
  return { runs: done, badNum, firstT, lastT };
}

function dailyVol() {
  const files = fs.readdirSync(PERPSPOT_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  const series = {};
  for (const f of files) {
    const arr = JSON.parse(fs.readFileSync(`${PERPSPOT_DIR}/${f}`, 'utf8'));
    if (!Array.isArray(arr)) continue;
    for (const s of arr) {
      if (!s || !Number.isFinite(s.t) || !Array.isArray(s.rows)) continue;
      for (const r of s.rows) {
        if (!r || !r.coin || !Number.isFinite(r.markPrice) || r.markPrice <= 0) continue;
        (series[r.coin] = series[r.coin] || []).push({ t: s.t, px: r.markPrice });
      }
    }
  }
  const byDay = {};
  for (const [coin, pts] of Object.entries(series)) {
    pts.sort((a, b) => a.t - b.t);
    const dd = [];
    for (const p of pts) if (!dd.length || dd[dd.length - 1].t !== p.t) dd.push(p);
    for (let i = 1; i < dd.length; i++) {
      const dt = dd[i].t - dd[i - 1].t;
      if (dt <= 0 || dt > HOUR) continue;
      const lr = Math.log(dd[i].px / dd[i - 1].px);
      if (!Number.isFinite(lr)) continue;
      const day = new Date(dd[i].t).toISOString().slice(0, 10);
      ((byDay[day] = byDay[day] || {})[coin] = byDay[day][coin] || []).push(lr);
    }
  }
  const out = {};
  for (const [day, coins] of Object.entries(byDay)) {
    const vols = [];
    for (const [coin, lrs] of Object.entries(coins)) {
      if (lrs.length < 20) continue;
      const m = lrs.reduce((a, b) => a + b, 0) / lrs.length;
      vols.push({ coin, sd: Math.sqrt(lrs.reduce((a, b) => a + (b - m) ** 2, 0) / (lrs.length - 1)) });
    }
    if (vols.length) out[day] = vols;
  }
  return out;
}

/** Hourly grid of a venue+coin funding rate, last-known-value, hard staleness = 1 interval. */
function hourlyGrid(points, declaredH, t0, t1) {
  const pts = points.filter(p => Number.isFinite(p.t) && Number.isFinite(p.rate)).sort((a, b) => a.t - b.t);
  const g = new Map(); let i = 0;
  for (let h = t0; h <= t1; h += HOUR) {
    while (i + 1 < pts.length && pts[i + 1].t <= h) i++;
    const p = pts[i];
    if (!p || p.t > h || h - p.t > declaredH * HOUR) continue;   // UNKNOWN -> dropped, never carried
    g.set(h, p.rate);
  }
  return g;
}
const runsAbove = (grid, hours, thr, toYr) => {
  const d = []; let len = 0;
  for (const h of hours) {
    const v = grid.get(h);
    if (v !== undefined && Math.abs(toYr(v)) >= thr) len++; else { if (len) d.push(len); len = 0; }
  }
  if (len) d.push(len);
  return d;
};
const pearson = (xs, ys) => {
  const n = xs.length; if (n < 3) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let nu = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; nu += a * b; dx += a * a; dy += b * b; }
  return nu / Math.sqrt(dx * dy);
};

// ══ MAIN ════════════════════════════════════════════════════════════════════
const { snaps, skipped, files } = loadSnapshots();
const { runs, badNum, firstT, lastT } = buildRuns(snaps);
const decl = declaredIntervals(`${FUNDING_DIR}/${fs.readdirSync(FUNDING_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'))[6]}`);
const H = JSON.parse(fs.readFileSync(HIST_14D, 'utf8')).data;

console.log('='.repeat(80));
console.log(`BOARD ${new Date(firstT).toISOString()} -> ${new Date(lastT).toISOString()}`);
console.log(`files ${files} · snapshots ${snaps.length} · rows ${snaps.reduce((a, s) => a + s.rows.length, 0).toLocaleString()} · malformed skipped ${skipped} · non-finite net ${badNum}`);
console.log(`span ${((lastT - firstT) / 86400000).toFixed(2)} days — TOO SHORT FOR REGIME COMPARISON (no bull run in sample)`);
console.log('='.repeat(80));

// ── 1
const complete = runs.filter(r => !r.censored);
console.log('\n### 1 — SPREAD SURVIVAL\n');
console.log(`distinct keys ${new Set(runs.map(r => r.key)).size} · runs ${runs.length} · complete ${complete.length} · censored ${runs.length - complete.length} (left ${runs.filter(r => r.leftCensored).length}, right ${runs.filter(r => r.rightCensored).length})`);
const S = stats(complete.map(r => r.durationH));
console.log(`survival h: p25 ${S.p25.toFixed(2)} · MEDIAN ${S.med.toFixed(2)} · p75 ${S.p75.toFixed(2)} · p90 ${S.p90.toFixed(2)} · max ${S.max.toFixed(1)}`);
for (const hX of [1, 6, 24, 48, 96]) {
  const det = runs.filter(r => !r.censored || r.durationH > hX);
  console.log(`  > ${String(hX).padStart(3)}h: ${pct(det.filter(r => r.durationH > hX).length, det.length).padStart(6)} (${det.filter(r => r.durationH > hX).length}/${det.length} determinable)`);
}
const grp = fn => {
  const g = {};
  for (const r of complete) (g[fn(r)] = g[fn(r)] || []).push(r.durationH);
  return Object.entries(g).filter(([, v]) => v.length >= 20).map(([k, v]) => ({ k, n: v.length, med: quant(v, .5) })).sort((a, b) => b.med - a.med);
};
for (const [label, arr] of [['venue-pair', grp(r => r.pair)], ['coin', grp(r => r.coin)]]) {
  console.log(`\nmost DURABLE ${label}s:`); arr.slice(0, 5).forEach(x => console.log(`  ${x.k.padEnd(28)} ${x.med.toFixed(2).padStart(7)}h  n=${x.n}`));
  console.log(`most EPHEMERAL ${label}s:`); arr.slice(-5).reverse().forEach(x => console.log(`  ${x.k.padEnd(28)} ${x.med.toFixed(2).padStart(7)}h  n=${x.n}`));
}

// ── 2
console.log('\n### 2 — RAW FUNDING vs CROSS-VENUE SPREAD\n');
const VENUES = Object.keys(H).filter(v => Number.isFinite(decl[v]));
console.log('modal ("default") funding rate per venue:');
console.log('venue         interval  modal rate   modal %/yr   share at modal');
const modal = {};
for (const v of VENUES.sort()) {
  const all = [];
  for (const c of Object.keys(H[v] || {})) for (const p of (H[v][c] || [])) if (Number.isFinite(p.rate)) all.push(p.rate);
  if (all.length < 50) continue;
  const cnt = {}; for (const r of all) cnt[r] = (cnt[r] || 0) + 1;
  const [mr, mn] = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
  // Paradex is continuously sampled; its modal share is not comparable, flag it.
  const pts = (H[v].BTC || []).map(p => p.t).sort((a, b) => a - b);
  const gaps = []; for (let i = 1; i < pts.length; i++) if (pts[i] - pts[i - 1] > 0) gaps.push(pts[i] - pts[i - 1]);
  const sampledH = quant(gaps, .5) / HOUR;
  const cont = Number.isFinite(sampledH) && decl[v] / sampledH > 3;
  modal[v] = { rate: +mr, yr: (+mr) * (24 / decl[v]) * 365, share: mn / all.length, cont };
  console.log(`${v.padEnd(13)} ${String(decl[v] + 'h').padEnd(9)} ${String(mr).padEnd(12)} ${modal[v].yr.toFixed(2).padStart(9)}%   ${(100 * modal[v].share).toFixed(1).padStart(8)}%${cont ? '   <- CONTINUOUSLY SAMPLED, excluded below' : ''}`);
}
const yrOf = {};
for (const v of Object.keys(modal)) yrOf[v] = modal[v].yr;
const grouped = {};
for (const [v, m] of Object.entries(modal)) if (!m.cont) (grouped[m.yr.toFixed(2)] = grouped[m.yr.toFixed(2)] || []).push(v);
console.log('\nvenues grouped by their default annualized rate:');
for (const [yr, vs] of Object.entries(grouped).sort((a, b) => +b[0] - +a[0])) console.log(`  ${yr.padStart(6)}%/yr : ${vs.join(', ')}`);

const PAIRS = [['BTC', 'lighter', 'hyperliquid'], ['BTC', 'lighter', 'binance'], ['ETH', 'lighter', 'hyperliquid'],
               ['SOL', 'lighter', 'bybit'], ['SOL', 'lighter', 'hyperliquid'], ['DOGE', 'lighter', 'binance']];
console.log('\nraw-leg vs spread persistence at >=10%/yr, and the both-at-default share:');
console.log('  coin pair                    both@def  spread|both@def  med|spread| off-def   rawA med  rawB med  SPREAD med');
for (const [coin, a, b] of PAIRS) {
  const pa = H[a]?.[coin], pb = H[b]?.[coin];
  if (!pa?.length || !pb?.length) { console.log(`  ${coin} ${a}/${b}: missing history — SKIPPED`); continue; }
  const t0 = Math.ceil(Math.max(Math.min(...pa.map(p => p.t)), Math.min(...pb.map(p => p.t))) / HOUR) * HOUR;
  const t1 = Math.floor(Math.min(Math.max(...pa.map(p => p.t)), Math.max(...pb.map(p => p.t))) / HOUR) * HOUR;
  const ga = hourlyGrid(pa, decl[a], t0, t1), gb = hourlyGrid(pb, decl[b], t0, t1);
  const hrs = []; for (let h = t0; h <= t1; h += HOUR) if (ga.has(h) && gb.has(h)) hrs.push(h);
  const yA = r => r * (24 / decl[a]) * 365, yB = r => r * (24 / decl[b]) * 365;
  const gs = new Map(hrs.map(h => [h, yA(ga.get(h)) - yB(gb.get(h))]));
  const isDef = (r, v) => Math.abs(r - modal[v].rate) < 1e-12;
  const both = hrs.filter(h => isDef(ga.get(h), a) && isDef(gb.get(h), b));
  const off = hrs.filter(h => !(isDef(ga.get(h), a) && isDef(gb.get(h), b)));
  const medOff = quant(off.map(h => Math.abs(gs.get(h))), .5);
  const f = a2 => a2.length ? quant(a2, .5).toFixed(0).padStart(6) + 'h' : '   n/a';
  console.log(`  ${coin.padEnd(5)}${(a + '/' + b).padEnd(24)}${(100 * both.length / hrs.length).toFixed(0).padStart(7)}%  ${(yrOf[a] - yrOf[b]).toFixed(2).padStart(13)}  ${medOff.toFixed(2).padStart(18)}   ${f(runsAbove(ga, hrs, 10, yA))}   ${f(runsAbove(gb, hrs, 10, yB))}   ${f(runsAbove(gs, hrs, 10, x => x))}`);
}

// ── 3
console.log('\n### 3 — VOLATILITY vs SURVIVAL / WIDTH  (WEAK 12-day SIGNAL, direction only)\n');
const vol = dailyVol();
const dayVol = {};
for (const d of Object.keys(vol)) {
  const maj = vol[d].filter(v => ['BTC', 'ETH', 'SOL'].includes(v.coin));
  const use = maj.length ? maj : vol[d];
  dayVol[d] = use.reduce((a, b) => a + b.sd, 0) / use.length;
}
const dayRuns = {};
for (const r of complete) (dayRuns[new Date(r.startT).toISOString().slice(0, 10)] = dayRuns[new Date(r.startT).toISOString().slice(0, 10)] || []).push(r);
const rows = [];
for (const d of Object.keys(vol).sort()) {
  const rs = dayRuns[d];
  if (!rs || rs.length < 20 || !Number.isFinite(dayVol[d])) continue;
  rows.push({ d, vol: dayVol[d], med: quant(rs.map(r => r.durationH), .5), width: quant(rs.map(r => r.medGross).filter(Number.isFinite), .5), n: rs.length });
}
console.log('  day          vol(sd log-ret)  median survival  median gross APY  n');
for (const r of rows) console.log(`  ${r.d}   ${(r.vol * 100).toFixed(4)}%         ${r.med.toFixed(2).padStart(7)}h         ${r.width.toFixed(1).padStart(6)}%/yr    ${String(r.n).padStart(4)}`);
console.log(`\n  r(vol, survival) = ${pearson(rows.map(r => r.vol), rows.map(r => r.med)).toFixed(3)} · r(vol, width) = ${pearson(rows.map(r => r.vol), rows.map(r => r.width)).toFixed(3)}  over ${rows.length} days`);
console.log('  WEAK: 13 daily points cannot establish a relationship. Direction only, NOT a regime comparison.');

// ── 4
console.log('\n### 4 — FEE-REPAYMENT HURDLE\n');
const scored = runs.filter(r => Number.isFinite(r.accrued) && Number.isFinite(r.feeUsdPer1k));
const cleared = scored.filter(r => r.accrued >= r.feeUsdPer1k);
console.log(`scored ${scored.length}/${runs.length} (excluded ${runs.length - scored.length}: no fee or no accrual)`);
console.log(`CLEARED one round-trip fee: ${cleared.length}/${scored.length} = ${pct(cleared.length, scored.length)}`);
for (const [lbl, min] of [['$1k', 1000], ['$10k', 10000]]) {
  const at = scored.filter(r => Number.isFinite(r.minCap) && r.minCap >= min);
  console.log(`  capacity-gated ${lbl.padEnd(5)} (greenCapacity >= ${lbl}): ${at.filter(r => r.accrued >= r.feeUsdPer1k).length}/${at.length} = ${pct(at.filter(r => r.accrued >= r.feeUsdPer1k).length, at.length)}`);
}
console.log('  NOTE: no slipCurve is persisted in board history, so per-size SLIPPAGE is not');
console.log('  measurable here. Fee% and funding% both scale linearly, so the fee ratio is');
console.log('  size-invariant; capacity gating is the only real size dependence on disk.');
const ratio = stats(scored.map(r => r.accrued / (r.feeUsdPer1k || 1)));
console.log(`\naccrued/fee ratio (1.0 = exactly repaid): p25 ${ratio.p25.toFixed(3)} · median ${ratio.med.toFixed(3)} · p75 ${ratio.p75.toFixed(3)} · p90 ${ratio.p90.toFixed(3)} · max ${ratio.max.toFixed(1)}`);
if (cleared.length) {
  const cs = stats(cleared.map(r => r.durationH));
  console.log(`\nthe ${cleared.length} clearers: median survival ${cs.med.toFixed(1)}h (vs ${S.med.toFixed(2)}h overall) · median gross ${quant(cleared.map(r => r.medGross).filter(Number.isFinite), .5).toFixed(1)}%/yr · censored share ${pct(cleared.filter(r => r.censored).length, cleared.length)}`);
  const top = o => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}(${v})`).join(', ');
  const tc = {}, tp = {};
  for (const r of cleared) { tc[r.coin] = (tc[r.coin] || 0) + 1; tp[r.pair] = (tp[r.pair] || 0) + 1; }
  console.log(`  coins: ${top(tc)}`);
  console.log(`  pairs: ${top(tp)}`);
}
