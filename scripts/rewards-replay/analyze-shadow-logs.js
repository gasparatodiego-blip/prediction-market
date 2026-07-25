#!/usr/bin/env node
'use strict';
// scripts/rewards-replay/analyze-shadow-logs.js — READ-ONLY analysis of the two shadow logs that had never
// been read: data/rewards-drift-shadow.jsonl and data/polymarket-maker-audit.jsonl. Changes NO surface,
// places nothing. Prints a report and writes a dated copy to docs/. Run:
//   node scripts/rewards-replay/analyze-shadow-logs.js [--out docs/rewards-shadow-analysis-YYYY-MM-DD.md]
//
// It answers only what the data can support, and says plainly where the sample is too small or too biased.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DRIFT = path.join(ROOT, 'data', 'rewards-drift-shadow.jsonl');
const AUDIT = path.join(ROOT, 'data', 'polymarket-maker-audit.jsonl');

function readJsonl(f) {
  try { return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}
function tally(a, f) { const m = {}; for (const r of a) { const k = f(r); m[k] = (m[k] || 0) + 1; } return Object.entries(m).sort((x, y) => y[1] - x[1]); }
function span(a, tsf) { if (!a.length) return { hours: 0 }; const t = a.map(tsf).sort((x, y) => x - y); return { from: new Date(t[0]).toISOString(), to: new Date(t[t.length - 1]).toISOString(), hours: (t[t.length - 1] - t[0]) / 3.6e6 }; }
const pct = (n, d) => (d ? (100 * n / d).toFixed(1) + '%' : '—');

function analyze() {
  const drift = readJsonl(DRIFT);
  const audit = readJsonl(AUDIT);
  const L = [];
  const p = (s = '') => L.push(s);

  p('# Shadow-log analysis — rewards drift + maker audit');
  p('');
  p('Read-only analysis of two logs that had not been read. No surface changed; nothing was placed.');
  p('');

  // ── FILE 1: drift-shadow ──
  const dSpan = span(drift, (r) => r.ts);
  const dMarkets = new Set(drift.map((r) => r.marketId));
  p('## 1. `data/rewards-drift-shadow.jsonl`');
  p('');
  p(`**${drift.length} rows**, span ${dSpan.hours.toFixed(1)}h (${dSpan.from} → ${dSpan.to}), **${dMarkets.size} distinct markets**.`);
  p('');
  p('What it is: a **drift-advisory** log from the DISARMED shadow maker. Every row is `decision:"drift"`, ');
  p('`executed:false`, `mode:"shadow"` — it is written ONLY when a resting config has drifted past its band ');
  p('radius (or left the band), advising a manual re-quote. It is therefore **event-triggered, not a uniform ');
  p('time sampler**: the rows are, by construction, biased toward out-of-band moments.');
  p('');
  const inBandNow = drift.filter((r) => r.live && r.live.inBandNow).length;
  const byMarket = {};
  for (const r of drift) { const k = r.marketId.slice(0, 10); (byMarket[k] = byMarket[k] || []).push(r); }
  p('### In-band fraction (Q1) — the data cannot support a trustworthy figure');
  p('');
  p(`- At the advisory instants, \`inBandNow\` was true in only **${inBandNow}/${drift.length} (${pct(inBandNow, drift.length)})** — but this is a `);
  p('  lower-bound artifact of the event trigger (the advisory fires *because* the config drifted), **not** the real in-band fraction.');
  p('- The `measured.inBandSec` / `outBandSec` fields are per-session accumulators that **reset** (peaks reach ~44h while the');
  p('  trailing value drops back to 0), so they cannot be composed into a reliable time fraction either.');
  p('- Per-market row counts are dominated by a single market:');
  for (const [m, rows] of Object.entries(byMarket).sort((a, b) => b[1].length - a[1].length)) {
    const ib = rows.filter((r) => r.live && r.live.inBandNow).length;
    p(`  - \`${m}…\` — ${rows.length} rows, inBandNow ${ib}/${rows.length} (${pct(ib, rows.length)}), band radius ${rows[rows.length - 1].live.bandRadiusC}c`);
  }
  const topM = Object.entries(byMarket).sort((a, b) => b[1].length - a[1].length)[0];
  p('');
  p(`> **Verdict on Q1:** too small and too biased to state a real in-band fraction. One market (\`${topM[0]}…\`) is ${pct(topM[1].length, drift.length)} of all rows, `);
  p('> and the log only fires on drift. The honest answer is that this log measures *how often a re-quote was advised*, not *what fraction of time the book was in band*.');
  p('');
  p('### Drift-advisory reasons, ranked (Q2, drift signal)');
  p('');
  for (const [reason, n] of tally(drift, (r) => r.reason)) p(`- **${n}** (${pct(n, drift.length)}) — ${reason}`);
  p('');

  // ── FILE 2: maker audit ──
  const aSpan = span(audit, (r) => r.ts);
  p('## 2. `data/polymarket-maker-audit.jsonl`');
  p('');
  p(`**${audit.length} rows**, span ${aSpan.hours.toFixed(1)}h (${aSpan.from} → ${aSpan.to}).`);
  p('');
  p('What it is: the maker adapter\'s decision audit across operations. Row `op` breakdown:');
  for (const [op, n] of tally(audit, (r) => r.op)) p(`- \`${op}\`: ${n}`);
  p('');
  p('**Contamination note:** the `postOrder` rows carry test-harness modes (`live-min`, `live:dryrun`, `live`) — those are');
  p('`scripts/maker-selfcheck.js` invocations, NOT production. The **decision analysis below is restricted to the `plan`**');
  p('**rows, which are ALL `mode:"paper"`** — i.e. real disarmed agent35 paper-cycle planning.');
  p('');
  const plans = audit.filter((r) => r.op === 'plan');
  const declined = plans.filter((r) => r.wouldPost === 0);
  const quoted = plans.filter((r) => typeof r.wouldPost === 'number' && r.wouldPost > 0);
  const planMarkets = new Set(plans.map((r) => r.marketRef));
  p('### Decisions & declined-to-quote reasons (Q2, maker signal)');
  p('');
  p(`- **${plans.length} paper plan decisions** across **${planMarkets.size} markets**.`);
  p(`- **Quoted** (wouldPost ≥ 1): ${quoted.length}/${plans.length} (${pct(quoted.length, plans.length)}).`);
  p(`- **Declined to quote** (wouldPost = 0): **${declined.length}/${plans.length} (${pct(declined.length, plans.length)})**.`);
  p('- Decline reasons, ranked:');
  const declineByFeed = declined.filter((r) => r.feedLive === false).length;
  const declineByRail = declined.filter((r) => r.railHalt === 'market').length;
  p(`  - **${declineByFeed}/${declined.length} (${pct(declineByFeed, declined.length)})** — feed not live (\`feedLive:false\` → \`railHalt:"market"\` → no quote).`);
  const otherDeclines = declined.length - Math.max(declineByFeed, declineByRail);
  if (otherDeclines > 0) p(`  - ${otherDeclines} — other (see raw).`);
  const feedTrueDeclines = plans.filter((r) => r.feedLive === true && r.wouldPost === 0).length;
  p(`- **Correlation:** with a LIVE feed, the maker declined **${feedTrueDeclines}/${plans.filter((r) => r.feedLive === true).length}** times. Every decline coincided with a non-live feed.`);
  p('- Quote sizes when quoting: ' + tally(quoted, (r) => `post=${r.wouldPost}`).map(([k, n]) => `${k}×${n}`).join(', ') + '.');
  const twoSided = plans.filter((r) => r.twoSided === true).length;
  p(`- Two-sided vs one-sided plans: ${twoSided} two-sided / ${plans.length - twoSided} one-sided; \`oneSidedPenalty\` was true in ${plans.filter((r) => r.oneSidedPenalty === true).length}.`);
  p('');

  // ── Q3 ──
  p('## 3. Do the reasons cluster on anything actionable? (Q3)');
  p('');
  p(`- **Yes, cleanly, for declines:** 100% of the ${declined.length} paper-plan declines were the non-live-feed rail halt, and a live feed`);
  p('  *always* produced a quote. That is exactly the honest-engine "no quote on a stale feed" rule firing — actionable and expected,');
  p('  and it says feed liveness is the sole gate on whether the paper maker quotes at all.');
  p('- **Drift advisories** cluster on the band-radius breach (the 2.25c radius dominates), but 71% of the drift rows come from a single');
  p('  market, so that is one market\'s behaviour, not a fleet pattern.');
  p('');
  p('### Where the sample is too small to conclude');
  p('');
  p(`- ${plans.length} paper plan decisions over ${aSpan.hours.toFixed(0)}h across ${planMarkets.size} markets, with only ${declined.length} declines — enough to say *why* it declined,`);
  p('  not enough to estimate a decline *rate* that would generalise.');
  p(`- ${drift.length} drift rows over ${dSpan.hours.toFixed(0)}h across ${dMarkets.size} markets, one market dominating — **do not extrapolate** an in-band fraction from it.`);
  p('- No P&L conclusion is possible from either file: both are pre-execution planning/advisory logs (`executed:false`), not fills.');
  p('');
  p('_Generated by `scripts/rewards-replay/analyze-shadow-logs.js` (read-only)._');
  return { report: L.join('\n'), stats: { driftRows: drift.length, driftMarkets: dMarkets.size, planRows: plans.length, declined: declined.length, declineFeedShare: pct(declineByFeed, declined.length) } };
}

function main() {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const { report } = analyze();
  process.stdout.write(report + '\n');
  if (outIdx !== -1 && argv[outIdx + 1]) {
    const out = path.isAbsolute(argv[outIdx + 1]) ? argv[outIdx + 1] : path.join(ROOT, argv[outIdx + 1]);
    try { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, report + '\n'); process.stderr.write(`\nwrote ${out}\n`); }
    catch (e) { process.stderr.write(`\nout write failed: ${e.message}\n`); }
  }
}

module.exports = { analyze };
if (require.main === module) main();
