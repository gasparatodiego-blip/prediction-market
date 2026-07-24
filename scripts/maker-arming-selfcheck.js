#!/usr/bin/env node
'use strict';
// scripts/maker-arming-selfcheck.js — repeatable, measured proof of the maker ARMING + KILL infrastructure.
// Pure assertions + printed measurements. NO order is placed, NO fund is moved, NO live venue is reached
// (every venue-touching call is injected with a spy). Run after any change to the arming/kill/preflight path.
//
//   node scripts/maker-arming-selfcheck.js
//
// Sections are added per commit: [1] KILL. ([2] preflight, [3] arm, [4] ttl, [5] auto-disarm follow.)

const assert = require('assert');
let checks = 0;
const ok = (c, m) => { assert(c, m); checks++; };

async function main() {
  // ───────────────────────────────────────────────────────────────────────────────────────────────────
  // [1] KILL — durably disarm + cancel every resting order, and PROVE the cancel is wired (not simulated).
  // ───────────────────────────────────────────────────────────────────────────────────────────────────
  const { killMaker } = require('../lib/maker/kill');
  const { cancelAllOrders } = require('../lib/maker/cancel-all');

  console.log('\n[1] KILL — disarm + cancel-all');

  // A SPY cancel-only adapter: it has the real adapter's shape (listOpenOrders/cancelMarketOrders) and is
  // NOT a dry-run stub — so simulated is false and every cancelMarketOrders call is observable. It reports
  // two resting orders across two markets, so we can print EXACTLY what a KILL would cancel.
  const cancelCalls = [];
  function spyAdapter() {
    return {
      dryRun: false,
      async listOpenOrders() {
        return { ok: true, simulated: false, count: 2, orders: [
          { id: 'ord-A1', market: '0xmarketA' },
          { id: 'ord-B1', market: '0xmarketB' },
        ] };
      },
      async cancelMarketOrders(market) {
        cancelCalls.push(market);
        // venue-shaped response with a canceled list → countCancelled returns a real number, simulated false
        return { ok: true, simulated: false, response: { canceled: [`ord-for-${market}`] } };
      },
    };
  }

  // Drive killMaker with an injected setGlobalKill spy (so no real kill-switch file is written) and the real
  // cancelAllOrders, but force cancelAllOrders to build the SPY adapter (buildAdapter injection) with creds
  // present (so it takes the LIVE branch, not the dry-run stub).
  const killSet = [];
  const wiredCreds = { polymarket: async () => ({ creds: { key: 'k', secret: 's', passphrase: 'p' }, address: '0xfunder' }) };
  const res = await killMaker(
    { by: 'selfcheck', reason: 'proof', credsProviders: wiredCreds },
    {
      setGlobalKill: (arg) => { killSet.push(arg); },
      cancelAllOrders: (a) => cancelAllOrders({ ...a, buildAdapter: spyAdapter }),
      now: () => 1_753_000_000_000,
    },
  );

  ok(killSet.length === 1 && killSet[0].by === 'selfcheck', 'KILL: sets the DURABLE global kill (disarm) exactly once');
  ok(res.killed === true, 'KILL: durable disarm reported SET');
  // WIRED, not simulated: cancelMarketOrders was actually invoked for each market with resting orders.
  ok(cancelCalls.length === 2 && cancelCalls.includes('0xmarketA') && cancelCalls.includes('0xmarketB'),
    'KILL: cancelMarketOrders is WIRED — invoked once per market that had resting orders (0xmarketA, 0xmarketB)');
  ok(res.simulated === false, 'KILL: the cancel sweep is NOT simulated:true when creds are present (live cancel path)');
  ok(res.cancelledTotal === 2, 'KILL: reports venue-counted cancellations (2), from the venue response — never fabricated');
  const pmVenue = res.cancel.find((r) => r.venue === 'polymarket');
  ok(pmVenue && pmVenue.venueOpenBefore === 2, 'KILL: venue-reported open-before is authoritative (2)');
  console.log(`    would cancel: ${cancelCalls.map((m) => `${m}`).join(', ')}  → wired at lib/maker/cancel-all.js:${'cancelMarketOrders'}`);
  console.log('    cancel call site: lib/maker/cancel-all.js line ~65  `const r = await adapter.cancelMarketOrders(m)`');

  // FAIL-SAFE no-op: maker already off, NOTHING resting → still sets the kill and runs a real (empty) sweep.
  cancelCalls.length = 0;
  const emptyAdapter = () => ({ dryRun: false, async listOpenOrders() { return { ok: true, simulated: false, count: 0, orders: [] }; }, async cancelMarketOrders() { return { ok: true }; } });
  const res2 = await killMaker(
    { by: 'selfcheck', reason: 'quiet', credsProviders: wiredCreds },
    { setGlobalKill: () => {}, cancelAllOrders: (a) => cancelAllOrders({ ...a, buildAdapter: emptyAdapter }), now: () => 1_753_000_000_000 },
  );
  ok(res2.killed === true && res2.cancelledTotal === 0 && cancelCalls.length === 0 && !res2.cancelError,
    'KILL: fail-safe — with the maker off and nothing resting, KILL is a safe no-op that still sets the kill and runs a real (empty) sweep');

  // DRY-RUN honesty: with NO creds ({}), the real cancel path builds a dry-run adapter → simulated:true and
  // zero cancelled — the ONLY way simulated:true is reachable (creds genuinely absent).
  const resDry = await killMaker(
    { by: 'selfcheck', reason: 'dry', credsProviders: {} },
    { setGlobalKill: () => {}, now: () => 1_753_000_000_000 },
  );
  ok(resDry.simulated === true, 'KILL: with NO cancel creds the sweep is honestly simulated:true (disarmed build) — never a claimed live cancel');

  // ───────────────────────────────────────────────────────────────────────────────────────────────────
  // [2] PREFLIGHT — the arming gate. all six pass ⇒ go; any single red ⇒ no-go (no override), red value shown.
  // ───────────────────────────────────────────────────────────────────────────────────────────────────
  const { runPreflight, CHECK_ORDER } = require('../lib/maker/preflight');
  console.log('\n[2] PREFLIGHT — arming gate');

  const passAll = {
    signing: async () => ({ pass: true, value: 'MATCH', detail: '' }),
    balance: async () => ({ pass: true, value: '$77.84 pUSD', detail: '' }),
    approvals: async () => ({ pass: true, value: '3/3 present', detail: '' }),
    cancel: async () => ({ pass: true, value: 'live', detail: '' }),
    guard: async () => ({ pass: true, value: 'active', detail: '' }),
    kill: async () => ({ pass: true, value: 'reachable', detail: '' }),
  };
  const green = await runPreflight({}, passAll);
  ok(green.go === true && green.checks.length === 6, 'PREFLIGHT: all six checks pass ⇒ go=true');
  ok(JSON.stringify(green.checks.map((c) => c.key)) === JSON.stringify(CHECK_ORDER), 'PREFLIGHT: reports every check in the fixed order');

  for (const key of CHECK_ORDER) {
    const one = { ...passAll, [key]: async () => ({ pass: false, value: 'RED-VALUE', detail: 'forced red' }) };
    const res = await runPreflight({}, one);
    ok(res.go === false, `PREFLIGHT: a single red check (${key}) ⇒ go=false — there is no override`);
    const red = res.checks.find((c) => c.key === key);
    ok(red && red.pass === false && red.value === 'RED-VALUE', `PREFLIGHT: the red check (${key}) is identified with its REAL value in the table`);
  }

  // The REAL guard + kill defaults run IN-PROCESS (no network, no key) — prove the live checks actually work.
  const realGK = await runPreflight({}, {
    signing: async () => ({ pass: true, value: 'skip' }), balance: async () => ({ pass: true, value: 'skip' }),
    approvals: async () => ({ pass: true, value: 'skip' }), cancel: async () => ({ pass: true, value: 'skip' }),
  });
  const g = realGK.checks.find((c) => c.key === 'guard');
  const k = realGK.checks.find((c) => c.key === 'kill');
  ok(g.pass === true, `PREFLIGHT: the REAL guard check passes in-process — "${g.value}"`);
  ok(k.pass === true, `PREFLIGHT: the REAL kill check is reachable — "${k.value}"`);

  console.log(`\nmaker-arming selfcheck: ${checks} assertions passed.`);
}

main().catch((e) => { console.error('arming selfcheck FAILED:', e && e.message ? e.message : e); process.exit(1); });
