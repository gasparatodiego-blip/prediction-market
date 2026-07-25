#!/usr/bin/env node
'use strict';
// scripts/net-rerun-selfcheck.js — proves agent39-net-rerun measures the tape window honestly (continuous
// coverage, not span), never triggers early, never relaxes the 48h guard, reports a fragmented window, and
// sends exactly ONE net-verdict headline with the required fields. Pure + local. node scripts/net-rerun-selfcheck.js

const assert = require('assert');
const http = require('http');
const NR = require('../agents/agent39-net-rerun');
const { measureWindow, decide, formatHeadline } = NR;

let checks = 0;
const ok = (c, m) => { assert(c, m); checks++; console.log(`  ✓ ${m}`); };

const H = 3_600_000; // 1h in ms
const t0 = 1_700_000_000_000;
// build a mid-history timeline every 45s from a→b (the fixed sampler), optionally with an outage removed.
function midline(fromH, toH, outages = []) {
  const out = [];
  for (let t = t0 + fromH * H; t <= t0 + toH * H; t += 45_000) {
    if (outages.some((o) => t >= t0 + o[0] * H && t < t0 + o[1] * H)) continue; // agent34 down here
    out.push(t);
  }
  return out;
}

// ── 1 · measureWindow — continuous coverage, gaps subtracted ─────────────────────
console.log('\n1. measureWindow — span vs continuous coverage');
{
  // a clean 50h window, no outages
  const tape = [t0, t0 + 50 * H];
  const clean = measureWindow(tape, midline(0, 50));
  ok(Math.abs(clean.tapeSpanHours - 50) < 0.01, 'clean: span ≈ 50h');
  ok(Math.abs(clean.coverageHours - 50) < 0.1 && clean.fragmented === false, 'clean: continuous coverage ≈ 50h, not fragmented');

  // a 50h span with a 10h outage in the middle (agent34 down 20h→30h) → ~40h coverage, fragmented
  const frag = measureWindow(tape, midline(0, 50, [[20, 30]]));
  ok(frag.fragmented === true && frag.gaps.length === 1, 'fragmented: one outage detected');
  ok(Math.abs(frag.totalGapHours - 10) < 0.1, 'fragmented: the outage is ~10h');
  ok(Math.abs(frag.coverageHours - 40) < 0.2, 'fragmented: continuous coverage ≈ 40h (span 50h − 10h outage)');

  // a shoulder outage: tape spans 50h but mid-history only starts 8h in → 8h lost at the head
  const shoulder = measureWindow(tape, midline(8, 50));
  ok(shoulder.gaps.length >= 1 && Math.abs(shoulder.coverageHours - 42) < 0.3, 'shoulder: an 8h head gap is counted (coverage ≈ 42h)');

  ok(measureWindow([], midline(0, 10)).hasTape === false, 'no tape rows → hasTape=false (nothing to measure)');
}

// ── 2 · decide — never early, fragmented reported, single-shot via state.ran ─────
console.log('\n2. decide — the trigger gate (never early, never relaxed)');
{
  const tape = [t0, t0 + 50 * H];
  const enough = measureWindow(tape, midline(0, 50));
  ok(decide(enough, {}).action === 'run', 'coverage 50h ≥ 48h → run');

  // 47.9h coverage → WAIT, never run early
  const almost = measureWindow([t0, t0 + 47.9 * H], midline(0, 47.9));
  ok(decide(almost, {}).action === 'wait', 'coverage 47.9h < 48h → WAIT (never triggers early, never relaxes the guard)');

  // span ≥ 48h but coverage < 48h due to a big outage → FRAGMENTED, not run
  const bigFrag = measureWindow([t0, t0 + 55 * H], midline(0, 55, [[10, 20]]));
  ok(bigFrag.coverageHours < 48 && bigFrag.tapeSpanHours >= 48, 'setup: 55h span, ~45h coverage (10h outage)');
  ok(decide(bigFrag, {}).action === 'fragmented', 'span ≥ 48h but only ~45h continuous → FRAGMENTED (a fragmented window is NOT a 48h window)');

  // once it has run, it never runs again (single-shot)
  ok(decide(enough, { ran: true }).action === 'done', 'after a successful run, state.ran → done (single-shot, never re-runs)');

  // the fragmented notice is itself single-shot: the check() guard is `action==='fragmented' && !state.fragAlerted`
  const wouldSendFrag = decide(bigFrag, {}).action === 'fragmented' && !({ fragAlerted: true }).fragAlerted;
  ok(wouldSendFrag === false, 'fragmented notice is single-shot (suppressed once state.fragAlerted is set)');
}

// ── 3 · formatHeadline — the exact required fields; honest — vs a fabricated number ──
console.log('\n3. formatHeadline — required fields + honest — when under threshold');
{
  const summarySufficient = {
    fills: 812,
    markout: { all: { '5m': { cents: { mean: -0.34, median: -0.10 } } } },
    net: { stale_inclusive: { grossWindow: 402.5, costWindow: { '5m': 88.2 }, netWindow: { '5m': 314.3 } } },
    sufficiency: { windowHours: 49.2, suffices: true, annualisedNetPct: 6.1 },
  };
  const h = formatHeadline(summarySufficient, { fragmented: false });
  for (const [label, needle] of [['window', '49.20h'], ['fills', '812'], ['markout mean', '-0.34¢'], ['markout median', '-0.10¢'], ['gross', '$402.50'], ['cost', '$88.20'], ['net', '$314.30']]) {
    ok(h.includes(needle), `headline carries ${label} (${needle})`);
  }
  ok(/CLEARS ~4%/.test(h) && /6.10%\/yr/.test(h) && /run-rate, not guaranteed/.test(h), 'headline states it CLEARS ~4% with the run-rate caveat');

  const fails = formatHeadline({ ...summarySufficient, sufficiency: { windowHours: 49.2, suffices: true, annualisedNetPct: 2.3 } }, { fragmented: false });
  ok(/FAILS ~4%/.test(fails), 'a sub-4% annualised net reads FAILS, not CLEARS');

  // when the replay refused to annualise, the verdict is —, NEVER a fabricated percentage
  const refused = formatHeadline({ ...summarySufficient, sufficiency: { windowHours: 30, suffices: false, annualisedNetPct: null } }, { fragmented: false });
  ok(/verdict:<\/b> —/.test(refused), 'when annualisation was refused, verdict renders — (no fabricated number)');

  // fragmented window annotates the headline with the gaps
  const fragHead = formatHeadline(summarySufficient, { fragmented: true, gaps: [{}, {}], totalGapHours: 6.2, tapeSpanHours: 55, coverageHours: 48.8 });
  ok(/window integrity:/.test(fragHead) && /6.20h lost/.test(fragHead), 'a fragmented window is annotated with gaps + lost hours');
}

// ── 4 · END-TO-END verdict path: a real POST at a local stub, exactly one message ──
(async () => {
  console.log('\n4. end-to-end verdict PATH (real POST at a local stub) + mute semantics');
  const received = [];
  const server = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { received.push(JSON.parse(b)); } catch { received.push({ raw: b }); } res.writeHead(200); res.end('{"ok":true}'); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${port}`;
  process.env.TELEGRAM_BOT_TOKEN = 'tok'; process.env.TELEGRAM_CHAT_ID = 'chat';
  delete process.env.TELEGRAM_ALERTS_ENABLED; delete process.env.NET_RERUN_TELEGRAM_MUTED;

  const summary = { fills: 900, markout: { all: { '5m': { cents: { mean: -0.2, median: 0 } } } }, net: { stale_inclusive: { grossWindow: 500, costWindow: { '5m': 100 }, netWindow: { '5m': 400 } } }, sufficiency: { windowHours: 48.5, suffices: true, annualisedNetPct: 5.5 } };
  await NR.sendTelegram(formatHeadline(summary, { fragmented: false }));
  ok(received.length === 1, 'exactly ONE verdict POST reached the stub');
  ok(/Rewards NET verdict/.test(received[0].text) && /48.50h/.test(received[0].text) && /CLEARS/.test(received[0].text), 'the verdict message carries the headline (window + clears-4%)');

  process.env.TELEGRAM_ALERTS_ENABLED = 'false';
  const before = received.length;
  const muted = await NR.sendTelegram('muted');
  ok(muted === false && received.length === before, 'TELEGRAM_ALERTS_ENABLED=false → suppressed, no POST (global mute honoured)');

  await new Promise((r) => server.close(r));
  console.log(`\nnet-rerun selfcheck: ${checks} assertions passed — continuous coverage (not span) gates the trigger; it never fires early nor relaxes the 48h guard; a fragmented window is reported with its gaps; the verdict is single-shot and carries the required fields (— when annualisation is refused, never a fabricated number).`);
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
