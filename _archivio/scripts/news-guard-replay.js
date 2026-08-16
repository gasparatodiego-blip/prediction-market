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
const { buildSignal } = require('../lib/news-guard/signal');
const { stepRegime, isElevatedState, PARAMS } = require('../lib/news-guard/regime');

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
      // Upstream one-sided "trap" flag, persisted per snapshot (history stores flags as an object).
      const flags = r.flags;
      const trap = flags && typeof flags === 'object' && !Array.isArray(flags) ? !!flags.TRAP
                 : (Array.isArray(flags) ? flags.includes('TRAP') : false);
      const sample = {
        t: snap.t,
        mid: typeof r.mid === 'number' ? r.mid : null,
        spread: typeof spread === 'number' && isFinite(spread) ? spread : null,
        depthMin: null,                        // per-side depth is not persisted in history → can't fire honestly
        bandDepth: typeof r.existingLiquidityUsd === 'number' ? r.existingLiquidityUsd : null,
        trap,
      };
      if (sample.mid == null && sample.spread == null && sample.bandDepth == null && !sample.trap) continue;
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
  // Structural-trap BEFORE vs AFTER the baseline gate.
  //   BEFORE = the old unconditional fold-in: EVERY snapshot carrying the trap flag fired 'medium'.
  //   AFTER  = the baseline-gated detector: fires only when one-sidedness is a CHANGE from baseline.
  let trapSamplesBefore = 0, trapFiresAfter = 0;
  const trapMarketsBefore = new Set(), trapMarketsAfter = new Set();
  for (const [id, { title, venue, samples }] of series) {
    samples.sort((a, b) => a.t - b.t);
    if (samples.length > THRESHOLDS.MIN_SAMPLES) marketsWithHistory++;
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].trap) { trapSamplesBefore++; trapMarketsBefore.add(id); }   // old fold-in ignored history length
      const hist = samples.slice(Math.max(0, i - BOOK_HIST_MAX), i);   // prior window, capped like the agent
      if (hist.length < THRESHOLDS.MIN_SAMPLES) continue;
      steps++;
      const res = detectBookMove(samples[i], hist);
      if (res.triggers.some(t => t.type === 'structural-trap')) { trapFiresAfter++; trapMarketsAfter.add(id); }
      if (res.fired) fires.push({ id, title, venue, t: samples[i].t, iso: new Date(samples[i].t).toISOString(), triggers: res.triggers });
    }
  }
  return {
    section, snapshots: snaps.length, markets: series.size, marketsWithHistory, steps, fires,
    trap: {
      samplesBefore: trapSamplesBefore, firesAfter: trapFiresAfter,
      marketsBefore: trapMarketsBefore.size, marketsAfter: trapMarketsAfter.size,
      marketsFlippedCalm: trapMarketsBefore.size - trapMarketsAfter.size,
    },
  };
}

// ── AFTER: the same walk, layered with the persisted, hysteretic regime state machine ───────────
// For each market we walk the series keeping a regime state (starting null) and, at each step, run
// the SAME detectBookMove → buildSignal, then step the regime. News is null in replay (we have no
// historical Google-News feed), so severity never reaches 'high' from book+news → EVENT cannot fire
// historically. The measurable difference is therefore on the ELEVATED (book-only 'medium') firing
// count, the frozen-feed HALTs, and the FLAPPING rate — reported honestly below.
function replaySectionRegime(section) {
  const snaps = readDaySnaps(section);
  const series = buildSeries(section, snaps);
  let steps = 0;
  let rawFires = 0, rawToggles = 0;             // "before": stateless detector fired / oscillations
  let entriesElevated = 0, entriesEvent = 0;    // "after": transitions INTO elevated / event (firings)
  let regimeToggles = 0, frozenSteps = 0;       // "after": elevated↔not oscillations / book-unchanged (telemetry)
  for (const [, { samples }] of series) {
    samples.sort((a, b) => a.t - b.t);
    let regime = null, prevFired = false, prevElevated = false;
    for (let i = 0; i < samples.length; i++) {
      const hist = samples.slice(Math.max(0, i - BOOK_HIST_MAX), i);
      if (hist.length < THRESHOLDS.MIN_SAMPLES) continue;
      steps++;
      const cur = samples[i];
      const book = detectBookMove(cur, hist);
      const sig = buildSignal({ marketId: 'x', book, news: null, ts: cur.t });

      // BEFORE metrics (stateless)
      if (book.fired) rawFires++;
      if (book.fired !== prevFired) rawToggles++;
      prevFired = book.fired;

      // AFTER metrics (regime state machine)
      const next = stepRegime({
        prev: regime, severity: sig.severity, source: sig.source,
        summary: sig.evidence.summary, sample: { mid: cur.mid, spread: cur.spread },
        resolved: false, now: cur.t,
      });
      if (next.transition && isElevatedState(next.transition.to) && !isElevatedState(next.transition.from)) {
        entriesElevated++;
        if (next.transition.to === 'event') entriesEvent++;
      }
      const nowElevated = isElevatedState(next.state);
      if (nowElevated !== prevElevated) regimeToggles++;
      prevElevated = nowElevated;
      if (next.frozenStreak >= 3) frozenSteps++;   // telemetry only — NOT a halt (see regime.js header)
      regime = next;
    }
  }
  return { section, steps, rawFires, rawToggles, entriesElevated, entriesEvent, regimeToggles, frozenSteps };
}

function main() {
  console.log(`\n=== news-guard book-detector REPLAY (last ${DAYS} days) ===`);
  console.log('thresholds:', JSON.stringify(THRESHOLDS));
  const byTrigger = {};
  let totalFires = 0, totalSteps = 0;
  const trapAgg = { samplesBefore: 0, firesAfter: 0, marketsBefore: 0, marketsAfter: 0, marketsFlippedCalm: 0 };
  for (const section of ['rewards-poly', 'rewards-kalshi']) {
    const r = replaySection(section);
    totalFires += r.fires.length; totalSteps += r.steps;
    for (const k of Object.keys(trapAgg)) trapAgg[k] += r.trap[k];
    for (const f of r.fires) for (const t of f.triggers) byTrigger[t.type] = (byTrigger[t.type] || 0) + 1;
    const distinct = new Set(r.fires.map(f => f.id)).size;
    console.log(`\n[${section}] snapshots=${r.snapshots} markets=${r.markets} (with≥${THRESHOLDS.MIN_SAMPLES} history=${r.marketsWithHistory})`);
    console.log(`   detector evaluated ${r.steps} market-steps → FIRED ${r.fires.length} times across ${distinct} distinct markets`);
    console.log(`   structural-trap: BEFORE ${r.trap.marketsBefore} markets permanently one-sided (folded in every cycle) → AFTER ${r.trap.marketsAfter} fire on a real transition · ${r.trap.marketsFlippedCalm} flip to CALM`);
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
  console.log(`\n=== BEFORE (stateless detector): ${totalFires} firings over ${totalSteps} evaluated market-steps ===`);
  console.log('by trigger type:', JSON.stringify(byTrigger));
  console.log('(depth-collapse/band-emptied cannot fire in replay — per-side depth is not persisted in history; live agent has it for Polymarket.)');

  // ── STRUCTURAL-TRAP: the systematic false positive, before vs after the baseline gate ──────────
  const tPct = trapAgg.marketsBefore > 0 ? (100 * trapAgg.marketsFlippedCalm / trapAgg.marketsBefore).toFixed(1) : '0.0';
  console.log(`\n=== STRUCTURAL-TRAP (one-side-empty) — baseline gate ===`);
  console.log(`  BEFORE (unconditional fold-in): ${trapAgg.samplesBefore} trap-snapshots across ${trapAgg.marketsBefore} distinct markets each forced 'medium'.`);
  console.log(`  AFTER  (change-gated): ${trapAgg.firesAfter} firings across ${trapAgg.marketsAfter} markets — only genuine two-sided→one-sided transitions.`);
  console.log(`  → ${trapAgg.marketsFlippedCalm} of ${trapAgg.marketsBefore} permanently-one-sided markets flip to CALM (${tPct}%). A permanently one-sided book is its own baseline, not an event.`);

  // ── AFTER: regime state machine (hysteresis; HALT is resolved-only, NOT frozen — see below) ──
  console.log(`\n=== AFTER (regime machine: EXIT_STREAK=${PARAMS.EXIT_STREAK}) ===`);
  let aFires = 0, aToggles = 0, aEnter = 0, aEvent = 0, aRegToggles = 0, aFrozen = 0, aSteps = 0;
  for (const section of ['rewards-poly', 'rewards-kalshi']) {
    const g = replaySectionRegime(section);
    aFires += g.rawFires; aToggles += g.rawToggles; aEnter += g.entriesElevated; aEvent += g.entriesEvent;
    aRegToggles += g.regimeToggles; aFrozen += g.frozenSteps; aSteps += g.steps;
    console.log(`\n[${section}] steps=${g.steps}`);
    console.log(`   BEFORE: fired ${g.rawFires} times · flapping (fired↔calm toggles) ${g.rawToggles}`);
    console.log(`   AFTER : entered ELEVATED/EVENT ${g.entriesElevated} times (of which EVENT/high ${g.entriesEvent}) · flapping (regime toggles) ${g.regimeToggles}`);
  }
  const pct = (a, b) => b > 0 ? `${(100 * (b - a) / b).toFixed(1)}% fewer` : 'n/a';
  console.log(`\n=== SIDE BY SIDE (${aSteps} steps) ===`);
  console.log(`  firings:  BEFORE ${aFires}  →  AFTER ${aEnter}   (${pct(aEnter, aFires)})`);
  console.log(`  flapping: BEFORE ${aToggles}  →  AFTER ${aRegToggles}   (${pct(aRegToggles, aToggles)})`);
  console.log(`  would-withdraw (EVENT/high): BEFORE 0  →  AFTER ${aEvent}   (book+news 'high' needs live news — 0 in a book-only historical replay, both sides)`);
  console.log(`  est. reward forgone: $0 BEFORE and AFTER — withdraws are 'high'-gated and no 'high' fires without historical news; the machine changes the WATCH signal + flapping, not withdraws.`);
  console.log(`  frozen-price HALT: REJECTED (measured). ${aFrozen}/${aSteps} steps (${(100*aFrozen/aSteps).toFixed(0)}%) show a book unchanged ≥3 snapshots — that is normal quiet, not a dead feed, and frozen data cannot fire the detector anyway. Halting on it would relabel correct 'calm' as '—' for the majority of markets. HALT is resolved-only.\n`);
}

main();
