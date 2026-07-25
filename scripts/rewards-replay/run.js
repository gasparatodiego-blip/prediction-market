#!/usr/bin/env node
'use strict';
// scripts/rewards-replay/run.js — REWARDS adverse-selection replay. Offline; places/signs nothing.
//   node scripts/rewards-replay/run.js --offsets 1,2 --size 1000 --max-inventory 5000 [--from ISO --to ISO] [--sweep]
// Turns the gross reward ceiling into a NET by subtracting the measured markout of the fills that resting
// produces. REFUSES to annualise under a 48h window (required behaviour). JSON → /tmp/rewards-replay/.

const fs = require('fs');
const path = require('path');
const { loadJournal } = require('./lib/journal');
const { reconstructFills } = require('./lib/fills');
const { markoutAll, summarize, HORIZONS } = require('./lib/markout');
const { computeNet } = require('./lib/net');
const { coverageHeader } = require('../../lib/mid-history-coverage');
const { fetchRewardMarkets } = require('../rewards-ceiling/lib/gamma');

const MIN_WINDOW_HOURS = 48;   // below this, annualising is REFUSED (not engineered around)
const STALE_UNTRUST = 0.20;    // stale fraction above this ⇒ result not trustworthy
const OUT_DIR = '/tmp/rewards-replay';
const RISK_FREE_PCT = 4.0;

function parseArgs(argv) {
  const a = { offsets: [1], size: 1000, maxInventory: 5000, from: null, to: null, sweep: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--offsets') { a.offsets = v.split(',').map(Number).filter((x) => Number.isFinite(x)); i++; }
    else if (k === '--size') { a.size = Number(v); i++; }
    else if (k === '--max-inventory') { a.maxInventory = Number(v); i++; }
    else if (k === '--from') { a.from = v; i++; }
    else if (k === '--to') { a.to = v; i++; }
    else if (k === '--sweep') { a.sweep = true; }
  }
  return a;
}
const money = (x) => (x == null ? '—' : (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(2));
const cents = (x) => (x == null ? '—' : (x >= 0 ? '+' : '') + x.toFixed(2) + '¢');

async function main() {
  const args = parseArgs(process.argv);
  const fromMs = args.from ? Date.parse(args.from) : -Infinity;
  const toMs = args.to ? Date.parse(args.to) : Infinity;
  const J = loadJournal({ fromMs, toMs });

  console.log('═'.repeat(74));
  console.log('REWARDS-ADVERSE-SELECTION REPLAY (offline; the maker is disarmed — nothing is placed)');
  console.log('═'.repeat(74));
  console.log('journal files:      ', J.files.join(', ') || '(none)');
  console.log('schema confirmed:   ', J.schemaConfirmed ? 'yes (' + J.requiredKeys.length + ' keys match the writer)' : 'NO — missing ' + JSON.stringify(J.schemaMismatch));
  if (!J.rows) { console.log('\nNo journal rows in range. Nothing to replay. (agent34 must run to collect data.)'); writeJson({ error: 'no data', window: J.window }); return; }
  console.log('rows:               ', J.rows, '(malformed skipped:', J.malformed + ')');
  console.log('markets covered:    ', J.byMarket.size);
  console.log('window:             ', new Date(J.window.fromMs).toISOString(), '→', new Date(J.window.toMs).toISOString());
  console.log('window hours:       ', J.window.hours.toFixed(2));
  console.log('src split:          ', 'ws', J.ws, '| stale', J.stale, '| stale fraction', (J.staleFrac * 100).toFixed(1) + '%',
    J.staleFrac > STALE_UNTRUST ? '⚠ ABOVE 20% — result NOT trustworthy (carried-forward observation dominates)' : '(≤20%, ok)');

  // ── coverage header (shared, mandated) ──
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'mid-history-coverage.json'), 'utf8')); } catch {}
  const cov = coverageHeader({ coveredMarketCount: J.byMarket.size, universeMarketCount: manifest ? manifest.universeMarketCount : null });
  console.log('\nCOVERAGE:');
  for (const l of cov.headerLines) console.log('  ' + l);

  // ── pots (primary source, reused ceiling fetch) ──
  process.stdout.write('\nfetching real pots (Gamma primary source)… ');
  const { markets: rewardMarkets } = await fetchRewardMarkets();
  const potByCond = new Map(rewardMarkets.map((m) => [m.conditionId, m.rewardsDailyRate]));
  console.log(rewardMarkets.length + ' reward markets');

  // ── primary config (first offset) ──
  const offset = args.offsets[0];
  const cfg = { offsetCents: offset, sizeUsd: args.size, maxInventoryUsd: args.maxInventory };
  console.log('\nPLACEMENT: offset ' + offset + '¢ from adjMid, both sides · size $' + args.size + '/side · max inventory $' + args.maxInventory);

  const F = reconstructFills(J.byMarket, cfg);
  console.log('\nPHASE 1 — INFERRED FILLS: ' + F.fills.length +
    '  ⚠ INFERRED from 45s-sampled level crossings, NOT observed on the tape.');
  console.log('  This over-detects touch-and-leave fills and entirely misses intra-45s round trips; neither');
  console.log('  can be quantified precisely without the tape. Treat the count as an upper-ish bound with wide error.');
  console.log('  placed intervals:', F.placedIntervals, '| inventory-capped skips:', F.capped, '| excluded intervals:', F.excluded.count, JSON.stringify(F.excluded.reasons));

  const MO = markoutAll(F.fills, J.byMarket);
  const sumAll = summarize(MO);
  console.log('\nPHASE 2 — MARKOUT (adjMid; signed so adverse = NEGATIVE). Per side, cents:');
  for (const side of ['buy', 'sell', 'all']) {
    console.log('  ' + side.toUpperCase().padEnd(4) + ' (' + sumAll[side].fills + ' fills):');
    for (const h of HORIZONS) {
      const d = sumAll[side][h.key].cents;
      if (!d.n) { console.log('    +' + h.key.padEnd(3) + ' n=0 (no samples at this horizon in window)'); continue; }
      console.log('    +' + h.key.padEnd(3) + ' n=' + String(d.n).padStart(4) + '  mean ' + cents(d.mean) + '  median ' + cents(d.median) +
        '  p25 ' + cents(d.p25) + '  p75 ' + cents(d.p75) + '  tail p05 ' + cents(d.p05) + ' / p95 ' + cents(d.p95));
    }
  }

  // ── NET (stale-inclusive AND ws-only) ──
  const netIncl = computeNet(J.byMarket, MO, potByCond, { sizeUsd: args.size, windowHours: J.window.hours, wsOnly: false });
  const MOws = markoutAll(F.fills.filter((f) => f.src === 'ws'), J.byMarket);
  const netWs = computeNet(J.byMarket, MOws, potByCond, { sizeUsd: args.size, windowHours: J.window.hours, wsOnly: true });
  console.log('\nPHASE 3 — NET over the ' + J.window.hours.toFixed(2) + 'h window (gross reward − markout cost), stale-inclusive:');
  const ag = netIncl.aggregate;
  console.log('  markets: ' + ag.markets + ' · fills: ' + ag.fills + ' · gross(window): ' + money(ag.grossWindow));
  for (const h of ['1m', '5m', '30m']) console.log('    at +' + h.padEnd(3) + ' cost ' + money(ag.costWindow[h]) + ' → NET(window) ' + money(ag.netWindow[h]));
  console.log('  ws-only NET(window) at +5m: ' + money(netWs.aggregate.netWindow['5m']) + ' (gross ' + money(netWs.aggregate.grossWindow) + ')');
  console.log('  excluded markets: no pot ' + netIncl.excluded.noPot + ', no depth ' + netIncl.excluded.noDepth);

  // worst markout markets + largest-pot-worst check
  const worst = [...netIncl.rows].filter((r) => r.fills > 0).sort((a, b) => a.netWindow['5m'] - b.netWindow['5m']).slice(0, 5);
  console.log('\n  WORST markets by NET(window,+5m):');
  for (const r of worst) console.log('    pot $' + r.pot + '/day · fills ' + r.fills + ' · gross ' + money(r.grossWindow) + ' · net ' + money(r.netWindow['5m']) + '  ' + (potByCond.get(r.marketId) ? '' : '') + shortId(r.marketId));
  const byPot = [...netIncl.rows].sort((a, b) => b.pot - a.pot).slice(0, 5);
  const bigWorst = byPot.filter((r) => r.netWindow['5m'] < 0).length;
  console.log('  largest-pot markets negative on net(+5m): ' + bigWorst + ' of top ' + byPot.length +
    ' — ' + (bigWorst >= 3 ? 'YES, the big geopolitical pots ARE among the worst (the ceiling\'s predicted failure mode).' : 'not clearly the worst in this short window.'));

  // ── HAND-VERIFY one fill end to end ──
  handVerify(F, MO, J, cfg);

  // ── SUFFICIENCY: refuse to annualise under 48h ──
  console.log('\n' + '─'.repeat(74));
  console.log('PHASE 4 — SUFFICIENCY');
  const suffices = J.window.hours >= MIN_WINDOW_HOURS;
  let annualPct = null;
  if (!suffices) {
    console.log('  REFUSING TO ANNUALISE. Observation window is ' + J.window.hours.toFixed(2) + 'h; ' + MIN_WINDOW_HOURS + 'h is required.');
    console.log('  The ' + J.window.hours.toFixed(2) + 'h sample cannot support extrapolation to a yearly figure — a handful of');
    console.log('  hours captures one regime and a few dozen inferred fills; adverse selection lives in the tail, which');
    console.log('  this window barely samples. Only RAW WINDOW TOTALS above are meaningful.');
    console.log('  NEEDED: ~' + (MIN_WINDOW_HOURS - J.window.hours).toFixed(1) + ' more hours of agent34 uptime. Re-run this tool then.');
  } else {
    // (Only reached once ≥48h exist.) Annualise on the capital required = 2×size per market summed.
    const capital = netIncl.rows.length * 2 * args.size; // total capital across covered markets
    const netPerDay = ag.netWindow['5m'] / (J.window.hours / 24);
    annualPct = capital > 0 ? (netPerDay * 365 / capital) * 100 : null;
    const disp = annualPct > 200 ? '>200%/yr · run-rate, not guaranteed' : annualPct.toFixed(2) + '%/yr';
    console.log('  window ≥ 48h — annualised NET (on $' + capital.toLocaleString() + ' capital): ' + disp +
      '  vs ~' + RISK_FREE_PCT + '% risk-free: ' + (annualPct > RISK_FREE_PCT ? 'CLEARS' : 'FAILS'));
    if (J.staleFrac > STALE_UNTRUST) console.log('  ⚠ but stale fraction ' + (J.staleFrac * 100).toFixed(1) + '% > 20% — do not trust this figure.');
  }

  // ── WRITTEN VERDICT (the conclusion the numbers support, not the one that keeps the lane alive) ──
  console.log('\n' + '─'.repeat(74));
  console.log('VERDICT');
  const mo5 = sumAll.all['5m'].cents;
  const markoutSuspect = mo5.n > 0 && mo5.mean >= -0.05; // mean markout ~non-negative ⇒ suspect, per the task
  if (!suffices) {
    console.log('  UNPROVEN — not a pass, not a fail. Two reasons, both fatal to a conclusion right now:');
    console.log('  1) The window is ' + J.window.hours.toFixed(2) + 'h of the ' + MIN_WINDOW_HOURS + 'h required; annualising is refused.');
    console.log('  2) The measured markout is ' + cents(mo5.mean) + ' (mean, +5m, all fills) — effectively ZERO or slightly');
    console.log('     POSITIVE. Per the task, a non-negative markout is to be DISTRUSTED, not celebrated, and it is:');
    console.log('     a 45s cadence detects the fills where price touched a resting level and BOUNCED BACK (~0 markout),');
    console.log('     while missing the intra-interval gaps that run an order over and keep going — the very tail where');
    console.log('     adverse selection lives. So gross reward looks unopposed here only because the loss is invisible,');
    console.log('     not because it is absent. ' + (markoutSuspect ? '(This run IS in that suspect regime.)' : ''));
    console.log('  Unlike funding (+2.79%/yr) and cash & carry (+2.68%/yr) — both settled on gross arithmetic below');
    console.log('  risk-free — this lane cannot be settled yet. Its gross ceiling clears 4% by a wide margin (prior task),');
    console.log('  and whether the NET does is exactly the adverse-selection question — which needs ≥48h AND a finer feed');
    console.log('  or the real fill tape before any net figure, positive or negative, should be believed.');
  } else {
    const beats = annualPct != null && annualPct > RISK_FREE_PCT;
    console.log('  Net over ≥48h annualises to ' + (annualPct == null ? '—' : annualPct.toFixed(2) + '%/yr') + ' — ' + (beats ? 'CLEARS' : 'FAILS below') + ' ~' + RISK_FREE_PCT + '% risk-free.');
    if (markoutSuspect) console.log('  ⚠ but the mean markout is non-negative (' + cents(mo5.mean) + '); distrust until the fill detection is validated against tape.');
  }

  // ── SWEEP (net frontier) ──
  let sweep = null;
  if (args.sweep) {
    console.log('\n' + '─'.repeat(74));
    console.log('SWEEP — NET(window,+5m) frontier over offsets × sizes (where does the reward stop paying?):');
    const offsets = args.offsets;
    const sizes = [250, 500, 1000, 2000, 5000];
    sweep = [];
    console.log('  offset\\size   ' + sizes.map((s) => ('$' + s).padStart(10)).join(''));
    for (const o of offsets) {
      const cells = [];
      for (const s of sizes) {
        const f = reconstructFills(J.byMarket, { offsetCents: o, sizeUsd: s, maxInventoryUsd: args.maxInventory });
        const mo = markoutAll(f.fills, J.byMarket);
        const nt = computeNet(J.byMarket, mo, potByCond, { sizeUsd: s, windowHours: J.window.hours, wsOnly: false });
        cells.push(nt.aggregate.netWindow['5m']);
        sweep.push({ offset: o, size: s, fills: f.fills, netWindow5m: nt.aggregate.netWindow['5m'], grossWindow: nt.aggregate.grossWindow });
      }
      console.log('  ' + (o + '¢').padEnd(13) + cells.map((c) => money(c).padStart(10)).join(''));
    }
    console.log('  (window totals, NOT annualised — the window is too short to annualise.)');
  }

  writeJson({
    generatedAt: new Date(J.window.toMs).toISOString(),
    window: J.window, staleFrac: J.staleFrac, coverage: cov, placement: cfg,
    fills: F.fills.length, capped: F.capped, excludedIntervals: F.excluded,
    markout: sumAll, net: { stale_inclusive: netIncl.aggregate, ws_only: netWs.aggregate, excluded: netIncl.excluded },
    sufficiency: { windowHours: J.window.hours, minHours: MIN_WINDOW_HOURS, suffices, annualisedNetPct: annualPct },
    sweep,
  });
  console.log('\nwrote ' + path.join(OUT_DIR, 'summary.json'));
}

function shortId(id) { return String(id).slice(0, 10) + '…'; }

function handVerify(F, MO, J, cfg) {
  // pick the first in-band BUY fill that has a +1m and +5m markout sample (fully traceable).
  const idx = F.fills.findIndex((f, i) => f.side === 'buy' && f.inBand && MO[i].horizons['1m'] && MO[i].horizons['5m']);
  if (idx < 0) { console.log('\nHAND-VERIFY: no in-band buy fill with both +1m and +5m samples in this short window.'); return; }
  const f = F.fills[idx], mo = MO[idx];
  const rows = J.byMarket.get(f.marketId);
  const fi = rows.findIndex((r) => r.tsMs === f.tsMs);
  const before = rows[fi - 1], cross = rows[fi];
  console.log('\n' + '─'.repeat(74));
  console.log('HAND-VERIFY ONE FILL (redo by hand; every intermediate number shown):');
  console.log('  market:            ' + shortId(f.marketId));
  console.log('  sample BEFORE:     ts ' + before.ts + '  adjMid ' + before.adjMid + '  tick ' + before.tick + '  bandLow ' + before.bandLow + '  bandHigh ' + before.bandHigh);
  console.log('  placed BUY price  = snapToTick(adjMid − offset/100, tick) = snapToTick(' + before.adjMid + ' − ' + cfg.offsetCents + '/100, ' + before.tick + ') = ' + f.price);
  console.log('  in band?           ' + (f.inBand ? 'yes (' + before.bandLow + ' ≤ ' + f.price + ' ≤ ' + before.bandHigh + ')' : 'no'));
  console.log('  CROSSING sample:   ts ' + cross.ts + '  bestAsk ' + cross.bestAsk + '  → fill because bestAsk ' + cross.bestAsk + ' ≤ our bid ' + f.price);
  console.log('  fill adjMid:       ' + f.adjMidFill + '   size = $' + cfg.sizeUsd + ' / price = ' + f.sizeShares.toFixed(2) + ' shares');
  for (const h of ['1m', '5m', '30m']) {
    const hh = mo.horizons[h];
    if (!hh) { console.log('  +' + h + ': no sample within tolerance (excluded)'); continue; }
    console.log('  +' + h.padEnd(3) + ' markout = (adjMid_later − adjMid_fill)×100 = ' + cents(hh.cents) + '   $ = ' + cents(hh.cents) + '/100 × ' + f.sizeShares.toFixed(2) + ' = ' + money(hh.usd) + '  (sample ' + hh.sampleAgeSec + 's off the exact horizon)');
  }
  console.log('  → this fill contributes ' + money(mo.horizons['5m'] ? mo.horizons['5m'].usd : null) + ' to net at +5m (negative = adverse).');
  console.log('─'.repeat(74));
}

function writeJson(obj) {
  try { fs.mkdirSync(OUT_DIR, { recursive: true }); fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(obj, null, 0)); } catch (e) { console.error('json write failed:', e.message); }
}

main().catch((e) => { console.error('HARD FAIL:', e.message); process.exit(1); });
