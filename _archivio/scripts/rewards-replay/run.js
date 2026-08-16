#!/usr/bin/env node
'use strict';
// scripts/rewards-replay/run.js — REWARDS adverse-selection replay. Offline; places/signs nothing.
//   node run.js --offsets 1 --size 1000 --max-inventory 5000 [--from ISO --to ISO] [--method auto|tape|inference] [--sweep]
//
// Fills are detected from the REAL executed-trade tape (agent34 last_trade_price) when it covers the
// window; the old 45s level-crossing INFERENCE stays behind --method inference. The CLI always reports
// WHICH method produced a figure, and prints the tape-vs-inference DISAGREEMENT over the same window —
// that gap is the size of the sampling artifact the previous UNPROVEN run suffered from. Honest-engine
// intact: null excluded+counted, stale reported separately, refusal to annualise under 48h, APY_CAP +
// run-rate label, coverage header from lib/mid-history-coverage.

const fs = require('fs');
const path = require('path');
const { loadJournal } = require('./lib/journal');
const { reconstructFills } = require('./lib/fills');
const { loadTape, reconstructTapeFills } = require('./lib/tape');
const { markoutAll, summarize, HORIZONS } = require('./lib/markout');
const { computeNet } = require('./lib/net');
const { coverageHeader } = require('../../lib/mid-history-coverage');
const { fetchRewardMarkets } = require('../rewards-ceiling/lib/gamma');

const MIN_WINDOW_HOURS = 48;
const STALE_UNTRUST = 0.20;
const OUT_DIR = '/tmp/rewards-replay';
const RISK_FREE_PCT = 4.0;

function parseArgs(argv) {
  const a = { offsets: [1], size: 1000, maxInventory: 5000, from: null, to: null, sweep: false, method: 'auto' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--offsets') { a.offsets = v.split(',').map(Number).filter(Number.isFinite); i++; }
    else if (k === '--size') { a.size = Number(v); i++; }
    else if (k === '--max-inventory') { a.maxInventory = Number(v); i++; }
    else if (k === '--from') { a.from = v; i++; }
    else if (k === '--to') { a.to = v; i++; }
    else if (k === '--method') { a.method = v; i++; }
    else if (k === '--sweep') { a.sweep = true; }
  }
  return a;
}
const money = (x) => (x == null ? '—' : (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(2));
const cents = (x) => (x == null ? '—' : (x >= 0 ? '+' : '') + x.toFixed(2) + '¢');

// Compute fills for a method over a journal (byMarket) + tape (byToken), returning fills + audit.
function fillsFor(method, journalByMarket, marketTokens, tapeByToken, cfg) {
  if (method === 'tape') return { ...reconstructTapeFills(journalByMarket, tapeByToken, marketTokens, cfg), method: 'tape' };
  return { ...reconstructFills(journalByMarket, cfg), method: 'inference' };
}

async function main() {
  const args = parseArgs(process.argv);
  const argFrom = args.from ? Date.parse(args.from) : -Infinity;
  const argTo = args.to ? Date.parse(args.to) : Infinity;

  // Load the tape first to learn where real fills exist, then decide the effective window + method.
  const tapeFull = loadTape({ fromMs: argFrom, toMs: argTo });
  const tapeAvailable = tapeFull.rows > 0;
  let method = args.method;
  if (method === 'auto') method = tapeAvailable ? 'tape' : 'inference';
  // When using the tape, the analysable window is the OVERLAP of the journal and the tape (fills only
  // exist where the tape covers). Load the journal windowed to that so placement + markout align.
  let winFrom = argFrom, winTo = argTo;
  if (method === 'tape' && tapeAvailable) { winFrom = Math.max(argFrom, tapeFull.window.fromMs); winTo = Math.min(argTo, tapeFull.window.toMs); }
  const J = loadJournal({ fromMs: winFrom, toMs: winTo });
  const tape = loadTape({ fromMs: winFrom, toMs: winTo });

  console.log('═'.repeat(76));
  console.log('REWARDS-ADVERSE-SELECTION REPLAY (offline; the maker is disarmed — nothing is placed)');
  console.log('═'.repeat(76));
  console.log('journal files:      ', J.files.join(', ') || '(none)');
  console.log('journal schema:     ', J.schemaConfirmed ? 'confirmed (' + J.requiredKeys.length + ' keys)' : 'NO — missing ' + JSON.stringify(J.schemaMismatch));
  console.log('tape files:         ', tapeFull.files.join(', ') || '(none — no executed-trade tape yet)');
  console.log('tape schema:        ', tapeFull.schemaConfirmed ? 'confirmed' : (tapeFull.rows ? 'NO — missing ' + JSON.stringify(tapeFull.schemaMismatch) : 'n/a'));
  console.log('tape rows (all):    ', tapeFull.rows, '| tape window hours:', tapeFull.window.hours ? tapeFull.window.hours.toFixed(2) : '0');
  console.log('\nFILL METHOD:        ', method.toUpperCase(),
    method === 'tape' ? '— fills from REAL prints (last_trade_price)' : '— fills INFERRED from 45s level crossings (no/short tape)');
  if (!J.rows) { console.log('\nNo journal rows in the effective window. Nothing to replay.'); writeJson({ error: 'no journal data', method, window: J.window }); return; }
  console.log('effective window:   ', new Date(J.window.fromMs).toISOString(), '→', new Date(J.window.toMs).toISOString(), '(' + J.window.hours.toFixed(3) + 'h)');
  console.log('journal rows:       ', J.rows, '| markets:', J.byMarket.size, '| src: ws', J.ws, 'stale', J.stale,
    '(' + (J.staleFrac * 100).toFixed(1) + '%' + (J.staleFrac > STALE_UNTRUST ? ' ⚠ >20% NOT trustworthy' : '') + ')');
  console.log('tape rows in window:', tape.rows);

  // marketId → YES tokenId (from the journal) so tape (keyed by token) matches the market.
  const marketTokens = new Map();
  for (const [mid, rows] of J.byMarket.entries()) if (rows[0] && rows[0].tokenIdYes) marketTokens.set(mid, rows[0].tokenIdYes);

  // coverage header (shared)
  let manifest = null; try { manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'mid-history-coverage.json'), 'utf8')); } catch {}
  const cov = coverageHeader({ coveredMarketCount: J.byMarket.size, universeMarketCount: manifest ? manifest.universeMarketCount : null });
  console.log('\nCOVERAGE:'); for (const l of cov.headerLines) console.log('  ' + l);

  // pots (primary source)
  process.stdout.write('\nfetching real pots (Gamma)… ');
  const { markets: rewardMarkets } = await fetchRewardMarkets();
  const potByCond = new Map(rewardMarkets.map((m) => [m.conditionId, m.rewardsDailyRate]));
  console.log(rewardMarkets.length + ' reward markets');

  const offset = args.offsets[0];
  const cfg = { offsetCents: offset, sizeUsd: args.size, maxInventoryUsd: args.maxInventory };
  console.log('\nPLACEMENT: offset ' + offset + '¢, both sides · size $' + args.size + '/side · max inventory $' + args.maxInventory);

  // ── primary fills (chosen method) ──
  const F = fillsFor(method, J.byMarket, marketTokens, tape.byToken, cfg);
  console.log('\nPHASE 1 — FILLS (' + method + '): ' + F.fills.length +
    (method === 'tape' ? '  from real prints · partial fills: ' + F.partials + ' · inventory-capped: ' + F.capped
      : '  ⚠ INFERRED from 45s level crossings — over-detects touch-and-leave, misses intra-interval gaps'));
  console.log('  placed intervals:', F.placedIntervals, '| excluded:', F.excluded.count, JSON.stringify(F.excluded.reasons));

  const MO = markoutAll(F.fills, J.byMarket);
  const sumAll = summarize(MO);
  console.log('\nPHASE 2 — MARKOUT (' + method + '; adjMid; adverse = NEGATIVE), cents:');
  for (const side of ['buy', 'sell', 'all']) {
    const s = sumAll[side];
    console.log('  ' + side.toUpperCase().padEnd(4) + ' (' + s.fills + ' fills):');
    for (const h of HORIZONS) {
      const d = s[h.key].cents;
      if (!d.n) { console.log('    +' + h.key.padEnd(3) + ' n=0'); continue; }
      console.log('    +' + h.key.padEnd(3) + ' n=' + String(d.n).padStart(4) + '  mean ' + cents(d.mean) + '  median ' + cents(d.median) + '  p25 ' + cents(d.p25) + '  p75 ' + cents(d.p75) + '  tail p05 ' + cents(d.p05) + '/p95 ' + cents(d.p95));
    }
  }

  // ── TAPE vs INFERENCE DISAGREEMENT over the SAME window (the artifact size) ──
  let disagree = null;
  if (tape.rows > 0) {
    const fTape = fillsFor('tape', J.byMarket, marketTokens, tape.byToken, cfg);
    const fInf = fillsFor('inference', J.byMarket, marketTokens, tape.byToken, cfg);
    const mTape = summarize(markoutAll(fTape.fills, J.byMarket));
    const mInf = summarize(markoutAll(fInf.fills, J.byMarket));
    disagree = { tapeFills: fTape.fills.length, infFills: fInf.fills.length, tapeMarkout5m: mTape.all['5m'].cents.mean, infMarkout5m: mInf.all['5m'].cents.mean };
    console.log('\nPHASE 3a — TAPE vs INFERENCE over the SAME ' + J.window.hours.toFixed(3) + 'h window (the artifact):');
    console.log('  fill count:  tape ' + disagree.tapeFills + '  vs  inference ' + disagree.infFills +
      '  → inference over/under-counts by ' + (disagree.infFills - disagree.tapeFills) + ' (' + (disagree.tapeFills ? Math.round((disagree.infFills - disagree.tapeFills) / disagree.tapeFills * 100) + '%' : 'n/a') + ')');
    console.log('  markout +5m: tape ' + cents(disagree.tapeMarkout5m) + '  vs  inference ' + cents(disagree.infMarkout5m) +
      '  → the difference is the adverse-selection cost the 45s inference was hiding.');
  } else {
    console.log('\nPHASE 3a — TAPE vs INFERENCE: no tape rows in window yet (tape is still filling) — cannot compare.');
  }

  // ── NET (stale-inclusive AND ws-only) ──
  const net = computeNet(J.byMarket, MO, potByCond, { sizeUsd: args.size, windowHours: J.window.hours, wsOnly: false });
  const netWs = computeNet(J.byMarket, markoutAll(F.fills.filter((f) => f.src === 'ws' || String(f.src).startsWith('ws')), J.byMarket), potByCond, { sizeUsd: args.size, windowHours: J.window.hours, wsOnly: true });
  const ag = net.aggregate;
  console.log('\nPHASE 3 — NET, each market over ITS OWN observed window (' + method + '; gross reward − adverse cost):');
  console.log('  markets ' + ag.markets + ' · fills ' + ag.fills + ' · grossPerDay ' + money(ag.grossPerDay) + '/day · gross(Σ observed windows) ' + money(ag.grossWindow));
  for (const h of ['1m', '5m', '30m']) console.log('    at +' + h.padEnd(3) + ' costPerDay ' + money(ag.costPerDay[h]) + '/day → NET ' + money(ag.netPerDay[h]) + '/day  (unknown-net markets excluded: ' + ag.unknownNet[h] + ')');
  console.log('  excluded markets: no pot ' + net.excluded.noPot + ', no depth ' + net.excluded.noDepth);

  // ── SUFFICIENCY + VERDICT ──
  console.log('\n' + '─'.repeat(76));
  console.log('PHASE 4 — SUFFICIENCY & VERDICT (method: ' + method + ')');
  const suffices = J.window.hours >= MIN_WINDOW_HOURS;
  let annualPct = null;
  if (!suffices) {
    console.log('  REFUSING TO ANNUALISE. Window ' + J.window.hours.toFixed(3) + 'h < ' + MIN_WINDOW_HOURS + 'h required — only raw window totals above are meaningful.');
    console.log('  NEEDED: ~' + Math.max(0, MIN_WINDOW_HOURS - J.window.hours).toFixed(1) + ' more hours' +
      (method === 'tape' ? ' of TAPE (agent34 must run to accumulate real prints).' : ' of journal.'));
    console.log('  VERDICT: still UNPROVEN on ' + J.window.hours.toFixed(2) + 'h — but the machinery is now correct:');
    console.log('  fills are OBSERVED, not inferred. Re-run once ≥48h of tape exist to settle whether NET beats ' + RISK_FREE_PCT + '%.');
  } else {
    const capital = net.rows.length * 2 * args.size;
    const netPerDay = ag.netPerDay['5m']; // Σ per-market NET/day, each amortised over its OWN observed span
    annualPct = capital > 0 ? (netPerDay * 365 / capital) * 100 : null;
    const disp = annualPct == null ? '—' : (annualPct > 200 ? '>200%/yr · run-rate, not guaranteed' : annualPct.toFixed(2) + '%/yr · run-rate, not guaranteed');
    console.log('  window ≥48h — annualised NET (' + method + ', observed-window, on $' + capital.toLocaleString() + '): ' + disp + '  vs ~' + RISK_FREE_PCT + '% risk-free: ' + (annualPct > RISK_FREE_PCT ? 'CLEARS' : 'FAILS'));
    if (J.staleFrac > STALE_UNTRUST) console.log('  ⚠ stale fraction ' + (J.staleFrac * 100).toFixed(1) + '% > 20% — do not trust.');
  }

  // ── SWEEP ──
  let sweep = null;
  if (args.sweep) {
    console.log('\n' + '─'.repeat(76));
    console.log('SWEEP — NET(window,+5m) frontier (' + method + '), offsets × sizes:');
    const sizes = [250, 500, 1000, 2000, 5000];
    sweep = [];
    console.log('  offset\\size  ' + sizes.map((s) => ('$' + s).padStart(10)).join(''));
    for (const o of args.offsets) {
      const cells = [];
      for (const s of sizes) {
        const f = fillsFor(method, J.byMarket, marketTokens, tape.byToken, { offsetCents: o, sizeUsd: s, maxInventoryUsd: args.maxInventory });
        const nt = computeNet(J.byMarket, markoutAll(f.fills, J.byMarket), potByCond, { sizeUsd: s, windowHours: J.window.hours, wsOnly: false });
        cells.push(nt.aggregate.netWindow['5m']); sweep.push({ offset: o, size: s, fills: f.fills.length, netWindow5m: nt.aggregate.netWindow['5m'] });
      }
      console.log('  ' + (o + '¢').padEnd(12) + cells.map((c) => money(c).padStart(10)).join(''));
    }
    console.log('  (window totals, NOT annualised.)');
  }

  writeJson({
    method, generatedAt: new Date(J.window.toMs).toISOString(), window: J.window, tapeWindow: tapeFull.window,
    staleFrac: J.staleFrac, coverage: cov, placement: cfg, fills: F.fills.length, partials: F.partials || 0, capped: F.capped,
    markout: sumAll, disagreement: disagree, net: { stale_inclusive: net.aggregate, ws_only: netWs.aggregate, excluded: net.excluded },
    sufficiency: { windowHours: J.window.hours, minHours: MIN_WINDOW_HOURS, suffices, annualisedNetPct: annualPct }, sweep,
  });
  console.log('\nwrote ' + path.join(OUT_DIR, 'summary.json'));
}

function writeJson(obj) {
  try { fs.mkdirSync(OUT_DIR, { recursive: true }); fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(obj, null, 0)); } catch (e) { console.error('json write failed:', e.message); }
}

main().catch((e) => { console.error('HARD FAIL:', e.message); process.exit(1); });
