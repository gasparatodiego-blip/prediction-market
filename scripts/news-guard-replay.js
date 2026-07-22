#!/usr/bin/env node
'use strict';
// scripts/news-guard-replay.js — REAL replay of the book detector against recorded history.
//
// Read-only. Reconstructs each market's time-series of book samples from data/history/rewards-poly
// and rewards-kalshi (30-min-cadence snapshots), walks it forward, and runs the EXACT same
// detectBookMove() the live agent runs at each step (rolling window = the prior samples, capped like
// the agent). Reports how many signals it WOULD have fired, per trigger type, with real evidence.
//
// This is not a smoke test: the numbers below are what the shipped detector produces on real data.
//
// Usage: node scripts/news-guard-replay.js [--days N] [--limit-evidence M]

const fs = require('fs');
const path = require('path');
const { detectBookMove, THRESHOLDS } = require('../lib/news-guard/book-detector');

const HIST = path.join(__dirname, '..', 'data', 'history');
const BOOK_HIST_MAX = 24;   // must match agent27
const args = process.argv.slice(2);
const DAYS = (() => { const i = args.indexOf('--days'); return i >= 0 ? Number(args[i + 1]) : 30; })();
const EV_LIMIT = (() => { const i = args.indexOf('--limit-evidence'); return i >= 0 ? Number(args[i + 1]) : 12; })();

function readDaySnaps(section) {
  const dir = path.join(HIST, section);
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}(\.\d{2})?\.json$/.test(f)).sort(); }
  catch { return []; }
  const cutoff = Date.now() - DAYS * 86_400_000;
  const snaps = [];
  for (const f of files) {
    let arr;
    try { arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    for (const s of arr) if (s && typeof s.t === 'number' && s.t >= cutoff) snaps.push(s);
  }
  return snaps.sort((a, b) => a.t - b.t);
}

// Build per-market time series of book samples from a section's snapshots.
function buildSeries(section, snaps) {
  const series = new Map();   // id → [{t, mid, spread, depthMin, bandDepth}]
  for (const snap of snaps) {
    const rows = Array.isArray(snap.rows) ? snap.rows : [];
    for (const r of rows) {
      const id = r.id;
      if (!id) continue;
      let spread = null;
      if (typeof r.bookSpread === 'number') spread = r.bookSpread;                       // poly
      else if (typeof r.bestBid === 'number' && typeof r.bestAsk === 'number') spread = r.bestAsk - r.bestBid; // kalshi
      const sample = {
        t: snap.t,
        mid: typeof r.mid === 'number' ? r.mid : null,
        spread: typeof spread === 'number' && isFinite(spread) ? spread : null,
        depthMin: null,                        // per-side depth is not persisted in history → can't fire honestly
        bandDepth: typeof r.existingLiquidityUsd === 'number' ? r.existingLiquidityUsd : null,
      };
      if (sample.mid == null && sample.spread == null && sample.bandDepth == null) continue;
      if (!series.has(id)) series.set(id, { title: r.title || id, venue: r.venue || section, samples: [] });
      series.get(id).samples.push(sample);
    }
  }
  return series;
}

function replaySection(section) {
  const snaps = readDaySnaps(section);
  const series = buildSeries(section, snaps);
  const fires = [];
  let steps = 0, marketsWithHistory = 0;
  for (const [id, { title, venue, samples }] of series) {
    samples.sort((a, b) => a.t - b.t);
    if (samples.length > THRESHOLDS.MIN_SAMPLES) marketsWithHistory++;
    for (let i = 0; i < samples.length; i++) {
      const hist = samples.slice(Math.max(0, i - BOOK_HIST_MAX), i);   // prior window, capped like the agent
      if (hist.length < THRESHOLDS.MIN_SAMPLES) continue;
      steps++;
      const res = detectBookMove(samples[i], hist);
      if (res.fired) fires.push({ id, title, venue, t: samples[i].t, iso: new Date(samples[i].t).toISOString(), triggers: res.triggers });
    }
  }
  return { section, snapshots: snaps.length, markets: series.size, marketsWithHistory, steps, fires };
}

function main() {
  console.log(`\n=== news-guard book-detector REPLAY (last ${DAYS} days) ===`);
  console.log('thresholds:', JSON.stringify(THRESHOLDS));
  const byTrigger = {};
  let totalFires = 0, totalSteps = 0;
  for (const section of ['rewards-poly', 'rewards-kalshi']) {
    const r = replaySection(section);
    totalFires += r.fires.length; totalSteps += r.steps;
    for (const f of r.fires) for (const t of f.triggers) byTrigger[t.type] = (byTrigger[t.type] || 0) + 1;
    const distinct = new Set(r.fires.map(f => f.id)).size;
    console.log(`\n[${section}] snapshots=${r.snapshots} markets=${r.markets} (with≥${THRESHOLDS.MIN_SAMPLES} history=${r.marketsWithHistory})`);
    console.log(`   detector evaluated ${r.steps} market-steps → FIRED ${r.fires.length} times across ${distinct} distinct markets`);
    const sample = r.fires.slice(0, EV_LIMIT);
    for (const f of sample) {
      const ev = f.triggers.map(t => {
        if (t.type === 'spread-widening') return `spread ${t.spreadNow} vs base ${t.baselineSpread} (${t.ratio}×${t.sigmas != null ? `, +${t.sigmas}σ` : ''})`;
        if (t.type === 'mid-jump') return `mid ${t.midPrev}→${t.midNow} (Δ${t.deltaMid}, +${t.sigmas}σ)`;
        return t.type;
      }).join(' | ');
      console.log(`     • ${f.iso} ${(f.title || f.id).slice(0, 54).padEnd(54)} ${ev}`);
    }
    if (r.fires.length > sample.length) console.log(`     … and ${r.fires.length - sample.length} more`);
  }
  console.log(`\n=== TOTAL: ${totalFires} firings over ${totalSteps} evaluated market-steps ===`);
  console.log('by trigger type:', JSON.stringify(byTrigger));
  console.log('(depth-collapse/band-emptied cannot fire in replay — per-side depth is not persisted in history; live agent has it for Polymarket.)\n');
}

main();
