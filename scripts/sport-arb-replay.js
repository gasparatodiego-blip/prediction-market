#!/usr/bin/env node
'use strict';

/**
 * sport-arb-replay — offline replay over agent33's raw sport record.
 *
 *   node scripts/sport-arb-replay.js 2026-07-20
 *   node scripts/sport-arb-replay.js 2026-07-20 --sport basketball
 *   node scripts/sport-arb-replay.js 2026-07-20 --event "lynx@storm" --verbose
 *
 * Reads data/sport-raw/<date>.jsonl(.gz) and reconstructs, for every event and every
 * poll, the best cross-venue arb that existed WITH BOTH LEGS LIVE — then reports what
 * it would have paid net of fees and the max stake real book depth supported.
 *
 * Zero credits, zero network, zero paid-AI: it only re-reads what was already recorded.
 * The fee model and the staleness guard are imported from the recorder itself, so replay
 * can never drift from what the live agent computed.
 */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const A = require('../agents/agent33-sport-recorder.js');
const { detectArbs, MAX_AGE_SEC } = A;

const ROOT    = path.join(__dirname, '..');
const RAW_DIR = path.join(ROOT, 'data', 'sport-raw');

function parseArgs(argv) {
  const out = { date: null, sport: null, event: null, verbose: false, minPct: 0 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sport')        out.sport   = argv[++i];
    else if (a === '--event')   out.event   = argv[++i];
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--min-pct') out.minPct  = Number(argv[++i]);
    else if (!a.startsWith('--')) out.date  = a;
  }
  return out;
}

function loadRaw(date) {
  const plain = path.join(RAW_DIR, `${date}.jsonl`);
  const gz    = plain + '.gz';
  let buf;
  if (fs.existsSync(plain))   buf = fs.readFileSync(plain);
  else if (fs.existsSync(gz)) buf = zlib.gunzipSync(fs.readFileSync(gz));
  else return null;
  const rows = [];
  for (const line of buf.toString().split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip a torn final line */ }
  }
  return rows;
}

function fmt(n, d = 5) { return n == null ? '—' : Number(n).toFixed(d); }
function hhmmss(ts)    { return new Date(ts).toISOString().slice(11, 19); }

function main() {
  const args = parseArgs(process.argv);
  if (!args.date) {
    console.error('usage: node scripts/sport-arb-replay.js <YYYY-MM-DD> [--sport S] [--event substr] [--min-pct N] [--verbose]');
    process.exit(1);
  }

  const rows = loadRaw(args.date);
  if (rows === null) {
    console.error(`no raw record for ${args.date} (looked for ${RAW_DIR}/${args.date}.jsonl[.gz])`);
    process.exit(2);
  }

  let filtered = rows;
  if (args.sport) filtered = filtered.filter(r => r.sport === args.sport);
  if (args.event) filtered = filtered.filter(r => (r.event_key || '').includes(args.event.toLowerCase()));

  console.log(`\n=== SPORT ARB REPLAY ${args.date} ===`);
  console.log(`raw rows: ${rows.length}${filtered.length !== rows.length ? ` (filtered → ${filtered.length})` : ''}`);
  if (!filtered.length) { console.log('nothing to replay under this filter.'); return; }

  // Coverage summary — what was actually recorded, before any arb talk.
  const bySource = {}, byType = {}, events = new Map();
  let liveRows = 0;
  for (const r of filtered) {
    bySource[r.source] = (bySource[r.source] || 0) + 1;
    byType[r.source_type] = (byType[r.source_type] || 0) + 1;
    if (r.is_live) liveRows++;
    if (!events.has(r.event_key)) events.set(r.event_key, { sport: r.sport, league: r.league, polls: new Set(), sources: new Set() });
    const e = events.get(r.event_key);
    e.polls.add(r.ts); e.sources.add(r.source);
  }
  console.log(`events: ${events.size} | live rows: ${liveRows}/${filtered.length} (age < ${MAX_AGE_SEC}s)`);
  console.log(`by source_type: ${JSON.stringify(byType)}`);
  console.log(`by source: ${JSON.stringify(bySource)}`);

  // Group rows into polls (one cycle == one ts per event) and run the SAME detector the
  // live agent runs, so replay results are identical to what was logged in real time.
  const polls = new Map();
  for (const r of filtered) {
    const k = `${r.event_key}|${r.ts}`;
    if (!polls.has(k)) polls.set(k, []);
    polls.get(k).push(r);
  }

  const realAll = [], phantomAll = [];
  for (const [, batch] of polls) {
    let out;
    try { out = detectArbs(batch, batch[0].ts); } catch (e) { continue; }
    realAll.push(...out.real);
    phantomAll.push(...out.phantom);
  }

  // Persistence: how long did each distinct crossing survive across consecutive polls?
  const byCrossing = new Map();
  for (const r of realAll) {
    const k = `${r.event_key}|${r.legs[0].source}|${r.legs[1].source}`;
    if (!byCrossing.has(k)) byCrossing.set(k, []);
    byCrossing.get(k).push(r);
  }

  console.log(`\n--- EVENTS RECORDED ---`);
  for (const [key, e] of [...events].sort((a, b) => b[1].polls.size - a[1].polls.size)) {
    console.log(`  ${key}  [${e.sport}/${e.league}]  polls=${e.polls.size}  sources={${[...e.sources].join(',')}}`);
  }

  const shown = realAll.filter(r => r.netProfitPct >= args.minPct);
  console.log(`\n--- REAL CROSSINGS (both legs live, age < ${MAX_AGE_SEC}s) ---`);
  if (!shown.length) {
    console.log(`  0 real crossings${args.minPct ? ` above ${args.minPct}%` : ''}.`);
    console.log('  (this is the expected honest outcome — cross-venue sports books rarely disagree net of fees)');
  } else {
    for (const [k, list] of byCrossing) {
      list.sort((a, b) => a.ts - b.ts);
      const best = list.reduce((m, r) => (r.netArbSum < m.netArbSum ? r : m), list[0]);
      const durSec = Math.round((list[list.length - 1].ts - list[0].ts) / 1000);
      console.log(`\n  ${best.home} vs ${best.away}  [${best.sport}]`);
      console.log(`    window        ${hhmmss(list[0].ts)} → ${hhmmss(list[list.length - 1].ts)}  (${durSec}s across ${list.length} poll(s))`);
      console.log(`    best net      ${fmt(best.netArbSum)}  → ${best.netProfitPct.toFixed(3)}% on stake`);
      console.log(`    gross         ${fmt(best.grossArbSum)}`);
      for (const l of best.legs) {
        console.log(`    leg ${l.outcome.padEnd(4)}      ${l.source} (${l.source_type}) ${l.team ?? ''} ` +
                    `odds=${fmt(l.odds, 3)} price=${fmt(l.price, 4)} net=${fmt(l.netCost)} age=${l.age_sec}s cap=${l.capacity ?? '—'}`);
      }
      console.log(`    max stake     ${best.sizeUnverifiable ? '— (size unverifiable: a leg publishes no depth)' : best.maxStake + ` (binding: ${best.bindingLeg})`}`);
      console.log(`    jurisdiction  ${best.jurisdiction.tags.join(', ')} | openableBoth=${best.jurisdiction.openableBoth}`);
      if (durSec < 30) console.log(`    NOTE          execution-speed-critical: survived only ${durSec}s`);
    }
  }

  console.log(`\n--- PHANTOMS (live-vs-stale, NEVER cashable) ---`);
  console.log(`  ${phantomAll.length} phantom crossing(s) suppressed by the ${MAX_AGE_SEC}s staleness guard.`);
  if (phantomAll.length && args.verbose) {
    const worst = phantomAll.reduce((m, r) => (r.netArbSum < m.netArbSum ? r : m), phantomAll[0]);
    console.log(`  worst would have shown net ${fmt(worst.netArbSum)} (${worst.netProfitPct.toFixed(2)}% "profit") — ${worst.phantomReason}`);
    console.log(`    legs: ${worst.legs.map(l => `${l.source}@age${l.age_sec}s`).join('  +  ')}`);
  } else if (phantomAll.length) {
    console.log('  (re-run with --verbose to see the worst one)');
  }

  // ── summary ────────────────────────────────────────────────────────────────
  const best = realAll.length ? realAll.reduce((m, r) => (r.netArbSum < m.netArbSum ? r : m), realAll[0]) : null;
  const stakeable = realAll.filter(r => !r.sizeUnverifiable).reduce((a, r) => a + (r.maxStake || 0), 0);
  console.log(`\n=== SUMMARY ${args.date} ===`);
  console.log(`  events recorded    ${events.size}`);
  console.log(`  raw rows           ${filtered.length}`);
  console.log(`  real crossings     ${realAll.length}`);
  console.log(`  phantoms blocked   ${phantomAll.length}`);
  console.log(`  best net arbSum    ${best ? fmt(best.netArbSum) + ` (${best.netProfitPct.toFixed(3)}%)` : '— (none)'}`);
  console.log(`  total stakeable    ${stakeable > 0 ? stakeable.toFixed(2) : '—'}`);
  if (realAll.length) {
    const bySport = {};
    for (const r of realAll) bySport[r.sport] = (bySport[r.sport] || 0) + 1;
    console.log(`  by sport           ${JSON.stringify(bySport)}`);
  }
  console.log('');
}

if (require.main === module) main();
