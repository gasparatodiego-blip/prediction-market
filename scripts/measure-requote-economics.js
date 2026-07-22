#!/usr/bin/env node
'use strict';
// scripts/measure-requote-economics.js — PHASE 1 measurement (report-only, no orders).
//
// Polls agent34's live-book snapshot (/tmp/clob-live-books.json) at a fixed cadence for a
// bounded window and records, per market, the adjustedMid time-series. From that we measure:
//   • how often the adjusted mid actually MOVES enough to matter (distribution of |Δmid| in cents)
//   • at candidate re-quote drift thresholds, how many re-quotes/hour a follow leg would trigger
//   • per re-quote, the modelled time-out-of-book (cancel+replace round-trip) → lost sample fraction
//
// Polymarket samples the book at a random instant each minute. A cancel+replace leaves a gap with
// nothing resting; if a sample lands in that gap the whole minute scores zero. Expected lost samples
// ≈ (out-of-book seconds per minute) / 60. Chasing tighter (lower threshold) ⇒ more re-quotes ⇒ more
// gap ⇒ more lost samples, but a tighter-tracking quote sits closer to mid (higher S when it IS resting).
// This script MEASURES the move frequency; it does not pick the threshold.

const fs = require('fs');
const SRC = '/tmp/clob-live-books.json';
const OUT = process.env.OUT || '/root/prediction-market/data/requote-economics-raw.jsonl';
const WINDOW_MS = Number(process.env.WINDOW_MS || 15 * 60_000);
const POLL_MS = Number(process.env.POLL_MS || 2_000);
// Modelled cancel+replace out-of-book gap (ms). Measured empirically later from live latency; this is
// a conservative placeholder used only to translate re-quote COUNT into a lost-sample estimate.
const OUT_OF_BOOK_MS = Number(process.env.OUT_OF_BOOK_MS || 400);

const t0 = Date.now();
const series = new Map(); // marketId -> [{t, mid, live}]
let polls = 0;

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

function poll() {
  const snap = readJson(SRC);
  const now = Date.now();
  if (snap && snap.markets) {
    for (const [mid, m] of Object.entries(snap.markets)) {
      if (m.mid == null) continue;
      if (!series.has(mid)) series.set(mid, { title: (m.title || '').slice(0, 60), maxSpread: m.maxSpread, points: [] });
      series.get(mid).points.push({ t: now - t0, mid: m.mid, live: !!m.live });
    }
  }
  polls++;
  if (now - t0 >= WINDOW_MS) return finish();
  setTimeout(poll, POLL_MS);
}

function finish() {
  // Per-market: consecutive |Δmid| in cents while BOTH samples are live.
  const perMarket = [];
  const allDeltas = [];
  for (const [mid, rec] of series) {
    const pts = rec.points;
    const deltas = [];
    for (let i = 1; i < pts.length; i++) {
      if (!pts[i].live || !pts[i - 1].live) continue;
      deltas.push(Math.abs(pts[i].mid - pts[i - 1].mid) * 100);
    }
    if (!pts.length) continue;
    perMarket.push({ marketId: mid, title: rec.title, maxSpreadC: rec.maxSpread, samples: pts.length, deltas });
    for (const d of deltas) allDeltas.push(d);
  }
  // Re-quote counts at candidate thresholds: a follow leg re-quotes when cumulative drift since last
  // quote exceeds threshold T (cents). Simulate per market against its adjustedMid path.
  const thresholds = [0.1, 0.2, 0.3, 0.5, 0.8, 1.0, 1.5, 2.0];
  const spanHrs = WINDOW_MS / 3_600_000;
  const byThreshold = thresholds.map(T => {
    let requotes = 0, marketsWithData = 0, totalLiveSamples = 0;
    for (const [mid, rec] of series) {
      const pts = rec.points.filter(p => p.live);
      if (pts.length < 2) continue;
      marketsWithData++;
      totalLiveSamples += pts.length;
      let anchor = pts[0].mid;
      for (let i = 1; i < pts.length; i++) {
        if (Math.abs(pts[i].mid - anchor) * 100 >= T) { requotes++; anchor = pts[i].mid; }
      }
    }
    const requotesPerHr = spanHrs > 0 ? requotes / spanHrs / Math.max(1, marketsWithData) : 0;
    // Lost-sample fraction: each re-quote is one out-of-book gap; over an hour the market is sampled
    // ~60 times (once/min), gap = OUT_OF_BOOK_MS. P(a given minute's sample lands in the gap) ≈
    // OUT_OF_BOOK_MS/60000; expected lost samples/hr ≈ requotesPerHr × (OUT_OF_BOOK_MS/60000)... but
    // more directly: fraction of wall-clock spent out-of-book = requotesPerHr × OUT_OF_BOOK_MS / 3.6e6.
    const outOfBookFrac = requotesPerHr * OUT_OF_BOOK_MS / 3_600_000;
    return { thresholdC: T, requotesPerMarketPerHr: +requotesPerHr.toFixed(2), outOfBookFracOfTime: +(outOfBookFrac).toFixed(6), lostSamplePctApprox: +(outOfBookFrac * 100).toFixed(4) };
  });
  const sorted = allDeltas.slice().sort((a, b) => a - b);
  const pct = q => sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(4) : null;
  const summary = {
    generatedAt: new Date().toISOString(),
    windowMs: WINDOW_MS, pollMs: POLL_MS, polls, outOfBookModelMs: OUT_OF_BOOK_MS,
    marketsObserved: perMarket.length,
    tickDeltaCentsDistribution: {
      n: sorted.length,
      nonZero: sorted.filter(d => d > 1e-9).length,
      p50: pct(0.5), p90: pct(0.9), p95: pct(0.95), p99: pct(0.99), max: sorted.length ? +sorted[sorted.length - 1].toFixed(4) : null,
      meanNonZero: (() => { const nz = sorted.filter(d => d > 1e-9); return nz.length ? +(nz.reduce((a, b) => a + b, 0) / nz.length).toFixed(4) : null; })(),
    },
    requotePolicyByThreshold: byThreshold,
  };
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

console.log(`[measure] recording ${WINDOW_MS / 60000}min from ${SRC} every ${POLL_MS}ms → ${OUT}`);
poll();
