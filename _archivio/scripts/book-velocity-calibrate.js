#!/usr/bin/env node
'use strict';
/**
 * PHASE 2 CALIBRATION — derive the book-velocity thresholds from recorded history.
 *
 * Read-only. Makes ZERO network calls and ZERO Claude calls: it replays book
 * snapshots already on disk through the exact lib/book-velocity.js functions the
 * live agent uses, so the calibration and the shipped detector cannot drift apart.
 *
 * CORPORA
 *   A. data/sport-raw/*.jsonl(.gz) (agent33) — 162k Kalshi/Polymarket book snapshots,
 *      45s cadence, 75.3h. Real executable bid/ask + size at those levels.
 *      minSize anchor: these are sports markets with ZERO overlap with the current
 *      reward set, so no true per-market qualifying size exists for them. We use the
 *      MODAL reward-program minimum per venue as an explicitly-stated proxy
 *      (Kalshi $1,000 — 197/200 of the live reward set; Polymarket $50 — 80/120).
 *      This corpus calibrates the SHAPE of the distribution over a long window.
 *   B. a live recording of the exact agent24+agent25 reward market set at 10s with
 *      TRUE per-market minSize. This corpus confirms the threshold on the real
 *      market population at the detector's real cadence.
 *
 * Usage: node scripts/book-velocity-calibrate.js <books.jsonl> [--split 0.7] [--label X]
 */

const fs = require('fs');
const path = require('path');
const bv = require(path.join(__dirname, '..', 'lib', 'book-velocity'));

// Modal reward-program minimum per venue — used ONLY for corpus A, where the market
// is not in any reward program and therefore has no true qualifying size.
const PROXY_MIN_SIZE = { kalshi: 1000, polymarket: 50 };

const HORIZON_MS = bv.DEFAULTS.horizonMs;
const HOLD_CANDIDATES = [60_000, 120_000, 180_000, 300_000, 600_000];
const NV_CANDIDATES = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 15, 20];
/** Consecutive detections on one market closer than this collapse into ONE episode. */
const EPISODE_GAP_MS = 10 * 60_000;
/** The real tracked set agent36 polls (120 polymarket + 200 kalshi reward markets),
 *  used to project a per-market rate measured on a corpus onto the deployment set. */
const TRACKED = 320;
/** Per-market alert cooldown used in the fire-rate simulation. */
const COOLDOWN_MS = Number(process.env.COOLDOWN_MIN || 15) * 60_000;

function quantile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[i];
}
const f = (v, d = 3) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));

function load(file) {
  const byMarket = new Map();
  const raw = fs.readFileSync(file, 'utf8').split('\n');
  let bad = 0;
  for (const line of raw) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { bad++; continue; }
    if (o.err) { bad++; continue; }
    const key = `${o.v}::${o.id}`;
    if (!byMarket.has(key)) byMarket.set(key, { venue: o.v, id: o.id, title: o.title, minSize: o.minSize, rows: [] });
    const m = byMarket.get(key);
    if (o.minSize != null && m.minSize == null) m.minSize = o.minSize;
    m.rows.push({ t: o.t, bid: o.bid, ask: o.ask, bidSz: o.bidSz, askSz: o.askSz });
  }
  for (const m of byMarket.values()) m.rows.sort((a, b) => a.t - b.t);
  return { byMarket, bad };
}

/** Every valid velocity pair at the calibrated horizon, for one market. */
function pairsFor(rows, minSizeUsd) {
  const s = rows.map(bv.normalizeSnapshot).filter(Boolean);
  const out = [];
  let j = 0;
  for (let i = 1; i < s.length; i++) {
    while (j < i && s[i].t - s[j].t > HORIZON_MS) j++;
    if (j === i) continue;
    let best = j;
    for (let k = j; k < i; k++) {
      if (Math.abs((s[i].t - s[k].t) - HORIZON_MS) < Math.abs((s[i].t - s[best].t) - HORIZON_MS)) best = k;
    }
    const p = bv.velocityPair(s[best], s[i], { minSizeUsd });
    if (p) out.push({ p, series: s, idx: i });
  }
  return out;
}

function main() {
  const file = process.argv[2];
  const splitArg = process.argv.indexOf('--split');
  const split = splitArg > -1 ? Number(process.argv[splitArg + 1]) : 0.7;
  const labArg = process.argv.indexOf('--label');
  const label = labArg > -1 ? process.argv[labArg + 1] : path.basename(file);
  if (!file) { console.error('usage: book-velocity-calibrate.js <books.jsonl> [--split f] [--label s]'); process.exit(2); }

  const { byMarket, bad } = load(file);
  let tmin = Infinity, tmax = 0, rows = 0;
  for (const m of byMarket.values()) { rows += m.rows.length; if (m.rows[0]) { tmin = Math.min(tmin, m.rows[0].t); tmax = Math.max(tmax, m.rows[m.rows.length - 1].t); } }
  const spanH = (tmax - tmin) / 3_600_000;
  const cut = tmin + (tmax - tmin) * split;

  console.log(`\n${'='.repeat(78)}`);
  console.log(`CORPUS: ${label}`);
  console.log(`${'='.repeat(78)}`);
  console.log(`rows=${rows}  markets=${byMarket.size}  unparseable=${bad}`);
  console.log(`window ${new Date(tmin).toISOString()} → ${new Date(tmax).toISOString()}  (${spanH.toFixed(1)}h)`);
  console.log(`train/holdout split at ${(split * 100).toFixed(0)}%: ${new Date(cut).toISOString()}`);

  // ── all pairs, tagged train/holdout ───────────────────────────────────────
  const all = [];
  for (const m of byMarket.values()) {
    const minSize = (m.minSize != null && m.minSize > 0) ? m.minSize : PROXY_MIN_SIZE[m.venue];
    if (!minSize) continue;
    for (const rec of pairsFor(m.rows, minSize)) {
      all.push({ ...rec, m, minSize, train: rec.p.t1 <= cut });
    }
  }
  const train = all.filter(x => x.train);
  const hold = all.filter(x => !x.train);
  console.log(`valid velocity pairs: ${all.length}  (train ${train.length} / holdout ${hold.length})`);

  // ── FULL DISTRIBUTION OF NORMALISED VELOCITY (train) ──────────────────────
  const nvAll = train.map(x => x.p.nv).sort((a, b) => a - b);
  const moved = train.filter(x => x.p.direction !== 0);
  const nvMoved = moved.map(x => x.p.nv).sort((a, b) => a - b);
  console.log(`\n── normalised velocity distribution (cent-weights/min), horizon ${HORIZON_MS / 1000}s ──`);
  console.log(`ALL pairs        n=${nvAll.length}`);
  console.log(`  p50=${f(quantile(nvAll, .50))}  p75=${f(quantile(nvAll, .75))}  p90=${f(quantile(nvAll, .90))}  p95=${f(quantile(nvAll, .95))}  p99=${f(quantile(nvAll, .99))}  max=${f(nvAll[nvAll.length - 1])}`);
  console.log(`  (${((nvAll.length - nvMoved.length) / nvAll.length * 100).toFixed(1)}% are exactly 0 — no sign-consistent executable move)`);
  console.log(`NON-ZERO moves   n=${nvMoved.length}`);
  console.log(`  p50=${f(quantile(nvMoved, .50))}  p75=${f(quantile(nvMoved, .75))}  p90=${f(quantile(nvMoved, .90))}  p95=${f(quantile(nvMoved, .95))}  p99=${f(quantile(nvMoved, .99))}  max=${f(nvMoved[nvMoved.length - 1])}`);

  const mvAbs = moved.map(x => Math.abs(x.p.moveCents)).sort((a, b) => a - b);
  const dwAll = moved.map(x => x.p.depthWeight).sort((a, b) => a - b);
  console.log(`  raw |move| cents:  p50=${f(quantile(mvAbs, .5), 2)}  p90=${f(quantile(mvAbs, .9), 2)}  p99=${f(quantile(mvAbs, .99), 2)}  max=${f(mvAbs[mvAbs.length - 1], 2)}`);
  console.log(`  depth weight:      p50=${f(quantile(dwAll, .5), 2)}  p90=${f(quantile(dwAll, .9), 2)}  p99=${f(quantile(dwAll, .99), 2)}  max=${f(dwAll[dwAll.length - 1], 2)}`);

  // ── HOLD WINDOW CALIBRATION ───────────────────────────────────────────────
  // For candidate thresholds, how does the persistent share vary with hold window?
  console.log(`\n── hold-window calibration (retentionMin=${bv.DEFAULTS.retentionMin}) ──`);
  console.log(`  candidates evaluated on train pairs with nv >= p99 (${f(quantile(nvMoved, .99))})`);
  const p99 = quantile(nvMoved, .99);
  const strong = train.filter(x => x.p.nv >= p99 && x.p.direction !== 0);
  console.log(`  hold      n_classified   PERSISTENT   REVERTING   %persist`);
  for (const h of HOLD_CANDIDATES) {
    let per = 0, rev = 0, unk = 0;
    for (const x of strong) {
      const s = x.series;
      let cls = { state: 'UNKNOWN' };
      for (let k = x.idx + 1; k < s.length; k++) {
        if (s[k].t - x.p.t1 >= h) { cls = bv.classifyHold(x.p, s[k], { holdMs: h }); break; }
      }
      if (cls.state === 'PERSISTENT') per++; else if (cls.state === 'REVERTING') rev++; else unk++;
    }
    const n = per + rev;
    console.log(`  ${String(h / 1000).padStart(4)}s   ${String(n).padStart(6)} (${String(unk).padStart(4)} unk)   ${String(per).padStart(10)}   ${String(rev).padStart(9)}   ${n ? (per / n * 100).toFixed(1) : '—'}%`);
  }

  // ── THRESHOLD → ALERT FIRE RATE ───────────────────────────────────────────
  // Simulates the LIVE alert path exactly: a detection is held for holdMs, alerts
  // only if it is then PERSISTENT, and is suppressed if this market already alerted
  // inside the cooldown. Reverting moves never alert — a maker profits from those.
  const trainDays = (cut - tmin) / 86_400_000;
  const table = [];
  console.log(`\n── threshold → ALERT fire rate (train, ${(trainDays * 24).toFixed(1)}h, ${byMarket.size} markets) ──`);
  console.log(`  simulates the live path: detect → hold ${bv.DEFAULTS.holdMs / 1000}s → alert only if PERSISTENT → per-market cooldown ${COOLDOWN_MS / 60000}min`);
  console.log(`  nv_thr   detections   PERSIST   REVERT   UNK   %persist   alerts   alerts/day/mkt   →deploy alerts/day`);
  for (const thr of NV_CANDIDATES) {
    const fired = train.filter(x => bv.isDetection(x.p, { nvThreshold: thr }));
    const byM = new Map();
    for (const x of fired) {
      const k = `${x.m.venue}::${x.m.id}`;
      if (!byM.has(k)) byM.set(k, []);
      byM.get(k).push(x);
    }
    let per = 0, rev = 0, unk = 0, alerts = 0;
    for (const list of byM.values()) {
      list.sort((a, b) => a.p.t1 - b.p.t1);
      let lastAlert = -Infinity;
      for (const x of list) {
        const s = x.series;
        let state = 'UNKNOWN';
        for (let k = x.idx + 1; k < s.length; k++) {
          if (s[k].t - x.p.t1 >= bv.DEFAULTS.holdMs) { state = bv.classifyHold(x.p, s[k]).state; break; }
        }
        if (state === 'PERSISTENT') per++; else if (state === 'REVERTING') rev++; else { unk++; continue; }
        if (state !== 'PERSISTENT') continue;
        if (x.p.t1 - lastAlert < COOLDOWN_MS) continue;   // cooldown suppression
        lastAlert = x.p.t1; alerts++;
      }
    }
    const cls = per + rev;
    const perDayPerMkt = alerts / trainDays / byMarket.size;
    table.push({ thr, detections: fired.length, per, rev, unk, alerts, perDayPerMkt });
    console.log(`  ${String(thr).padStart(5)}   ${String(fired.length).padStart(10)}   ${String(per).padStart(7)}   ${String(rev).padStart(6)}   ${String(unk).padStart(3)}   ${(cls ? (per / cls * 100).toFixed(1) : '—').padStart(7)}%   ${String(alerts).padStart(6)}   ${perDayPerMkt.toFixed(4).padStart(13)}   ${(perDayPerMkt * TRACKED).toFixed(1).padStart(18)}`);
  }

  // ── DETECTION CLUSTERING → COOLDOWN ───────────────────────────────────────
  const thrPick = Number(process.env.NV_THRESHOLD || bv.DEFAULTS.nvThreshold);
  const firedPick = train.filter(x => bv.isDetection(x.p, { nvThreshold: thrPick }));
  const gaps = [];
  {
    const byM = new Map();
    for (const x of firedPick) { const k = `${x.m.venue}::${x.m.id}`; if (!byM.has(k)) byM.set(k, []); byM.get(k).push(x.p.t1); }
    for (const ts of byM.values()) { ts.sort((a, b) => a - b); for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]); }
  }
  gaps.sort((a, b) => a - b);
  console.log(`\n── same-market detection clustering at nv>=${thrPick} (drives the cooldown) ──`);
  if (gaps.length) {
    console.log(`  consecutive-detection gap on the SAME market, n=${gaps.length}`);
    console.log(`  p25=${(quantile(gaps, .25) / 1000).toFixed(0)}s  p50=${(quantile(gaps, .5) / 1000).toFixed(0)}s  p75=${(quantile(gaps, .75) / 1000).toFixed(0)}s  p90=${(quantile(gaps, .9) / 1000).toFixed(0)}s  p95=${(quantile(gaps, .95) / 1000).toFixed(0)}s`);
    for (const c of [5, 10, 15, 20, 30, 60]) {
      const suppressed = gaps.filter(g => g < c * 60_000).length;
      console.log(`  cooldown ${String(c).padStart(2)}min → suppresses ${(suppressed / gaps.length * 100).toFixed(1)}% of repeat detections on the same market`);
    }
  } else console.log('  (no repeat detections at this threshold)');

  // ── SAMPLE EPISODES ───────────────────────────────────────────────────────
  console.log(`\n── 10 sample historical episodes that WOULD have fired at nv>=${thrPick} ──`);
  const samples = firedPick.slice().sort((a, b) => b.p.nv - a.p.nv);
  const seenM = new Set();
  const picked = [];
  for (const x of samples) {           // one per market, strongest first, for variety
    const k = `${x.m.venue}::${x.m.id}`;
    if (seenM.has(k)) continue;
    seenM.add(k); picked.push(x);
    if (picked.length >= 10) break;
  }
  for (const [i, x] of picked.entries()) {
    const p = x.p, s = x.series;
    let cls = { state: 'UNKNOWN', retention: null, pxHold: null };
    for (let k = x.idx + 1; k < s.length; k++) {
      if (s[k].t - p.t1 >= bv.DEFAULTS.holdMs) { cls = bv.classifyHold(p, s[k]); break; }
    }
    const side = p.direction > 0 ? 'ask (asks lifted)' : 'bid (bids hit)';
    console.log(`\n  [${i + 1}] ${x.m.venue}  ${String(x.m.id).slice(0, 52)}`);
    console.log(`      ${String(x.m.title || '').slice(0, 70)}`);
    console.log(`      ${new Date(p.t0).toISOString()} → ${new Date(p.t1).toISOString()}  (${(p.elapsedMs / 1000).toFixed(0)}s)`);
    console.log(`      BEFORE  bid ${f(p.bid0, 3)} x $${f(p.bid0 * p.bidSz0, 0)}   ask ${f(p.ask0, 3)} x $${f(p.ask0 * p.askSz0, 0)}`);
    console.log(`      AFTER   bid ${f(p.bid1, 3)} x $${f(p.bid1 * p.bidSz1, 0)}   ask ${f(p.ask1, 3)} x $${f(p.ask1 * p.askSz1, 0)}`);
    console.log(`      move ${p.moveCents > 0 ? '+' : ''}${f(p.moveCents, 2)}c on ${side}  depth consumed $${f(p.depthUsd0, 0)} (minSize $${x.minSize}) → weight ${f(p.depthWeight, 2)}`);
    console.log(`      nv = ${f(p.nv, 2)}`);
    console.log(`      WHAT HAPPENED NEXT (+${bv.DEFAULTS.holdMs / 1000}s): px ${f(cls.pxHold, 3)}  retention ${f(cls.retention, 2)}  → ${cls.state}`);
  }

  // ── HOLDOUT ───────────────────────────────────────────────────────────────
  if (hold.length) {
    const holdDays = (tmax - cut) / 86_400_000;
    const fired = hold.filter(x => bv.isDetection(x.p, { nvThreshold: thrPick }));
    const byM = new Map();
    for (const x of fired) { const k = `${x.m.venue}::${x.m.id}`; if (!byM.has(k)) byM.set(k, []); byM.get(k).push(x); }
    let alerts = 0, per = 0, rev = 0;
    for (const list of byM.values()) {
      list.sort((a, b) => a.p.t1 - b.p.t1);
      let lastAlert = -Infinity;
      for (const x of list) {
        const s = x.series;
        let state = 'UNKNOWN';
        for (let k = x.idx + 1; k < s.length; k++) { if (s[k].t - x.p.t1 >= bv.DEFAULTS.holdMs) { state = bv.classifyHold(x.p, s[k]).state; break; } }
        if (state === 'PERSISTENT') per++; else { if (state === 'REVERTING') rev++; continue; }
        if (x.p.t1 - lastAlert < COOLDOWN_MS) continue;
        lastAlert = x.p.t1; alerts++;
      }
    }
    const rate = alerts / holdDays / byMarket.size * TRACKED;
    const trainRow = table.find(r => r.thr === thrPick);
    console.log(`\n── HOLDOUT VERIFICATION (last ${((1 - split) * 100).toFixed(0)}% of the window, ${holdDays.toFixed(2)}d) ──`);
    console.log(`  detections=${fired.length}  persistent=${per}  reverting=${rev}  alerts after cooldown=${alerts}`);
    console.log(`  holdout implied rate @${TRACKED} markets: ${rate.toFixed(1)} alerts/day`);
    if (trainRow) console.log(`  train predicted:                   ${(trainRow.perDayPerMkt * TRACKED).toFixed(1)} alerts/day`);
  }
  console.log('');
}
main();
