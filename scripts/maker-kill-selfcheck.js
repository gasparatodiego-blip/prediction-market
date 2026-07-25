#!/usr/bin/env node
'use strict';
// scripts/maker-kill-selfcheck.js — proves the ONE-TAP KILL path the dashboard control and the shell
// script share. Pure + offline: injected temp state file, stubbed cancel sweep. NO network, NO venue call,
// NO key decryption, NO order. Run:  node scripts/maker-kill-selfcheck.js
//
// It exists because the kill ORCHESTRATION (lib/maker/kill.killMaker) and the "one code path" property —
// the KILL MAKER button (MakerKillClient.tsx), the shell script (scripts/kill-maker.sh) and the endpoint
// (app/api/maker/kill/route.ts) all trip the SAME durable switch through the SAME route — were not covered
// by scripts/maker-selfcheck.js (which covers the kill-switch LIB, not the kill orchestration or the UI).
//
// EXIT 0 = every assertion held. Any failure exits 1 with the assertion that broke.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
let checks = 0;
const ok = (c, m) => { assert(c, m); checks++; console.log(`  ✓ ${m}`); };

const { killMaker } = require('../lib/maker/kill');
const KS = require('../lib/safety/kill-switch');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kill-sc-')), 'state.json');

// ── 1 · killMaker sets the DURABLE global kill, and it survives a fresh read (post-restart) ──────────────
console.log('\n1. killMaker — durable disarm');
{
  const stateFile = tmp();
  const auditFile = stateFile.replace('state.json', 'audit.jsonl');
  // real setGlobalKill/checkKill against a throwaway file (NOT the live data/safety-kill-switch.json)
  const setGlobalKill = (a) => KS.setGlobalKill(a, { stateFile, auditFile });
  let cancelCalled = false;
  const cancelAllOrders = async () => { cancelCalled = true; return [{ venue: 'polymarket', ok: true, error: null, cancelled: 0, venueOpenBefore: 0, simulated: true }]; };

  // BEFORE: absent state → not killed (absent ≠ killed; that is the readable "never killed" state).
  ok(KS.checkKill({}, { stateFile }).killed === false, 'before: an absent durable state reads NOT killed');

  return (async () => {
    const res = await killMaker({ by: 'selfcheck', reason: 'kill selfcheck' }, { setGlobalKill, cancelAllOrders, now: () => 1_700_000_000_000 });

    ok(res.killed === true, 'killMaker reports killed:true when setGlobalKill succeeds');
    ok(res.killError === null, 'killMaker carries NO killError on success');
    ok(cancelCalled === true, 'killMaker runs the cancel sweep (independent of agent35)');
    // THE LOAD-BEARING PROOF: the durable file genuinely flipped, and a FRESH read (a simulated pm2 restart) still sees it.
    ok(KS.checkKill({}, { stateFile }).killed === true, 'AFTER: the durable state file genuinely flipped to killed');
    ok(KS.checkKill({}, { stateFile }).gate === 'kill-global', 'AFTER: a fresh read (simulated post-restart) still sees the GLOBAL kill — durable, a restart cannot clear it');

    // the exact shape the dashboard control (MakerKillClient KillResponse) renders — every field present.
    for (const k of ['at', 'killed', 'killError', 'armingDisarmed', 'cancel', 'cancelError', 'simulated', 'cancelledTotal']) {
      ok(Object.prototype.hasOwnProperty.call(res, k), `killMaker returns the client-rendered field "${k}"`);
    }
    ok(Array.isArray(res.cancel), 'killMaker.cancel is the per-venue array the UI maps over');

    // ── 2 · arming record is withdrawn too (best-effort), and reported honestly ──
    console.log('\n2. killMaker — arming withdrawal + honest cancel flags');
    {
      let disarmed = false;
      const res2 = await killMaker(
        { by: 'sc', reason: 'r', disarmArming: () => { disarmed = true; } },
        { setGlobalKill: (a) => KS.setGlobalKill(a, { stateFile: tmp() }), cancelAllOrders, now: () => 1 },
      );
      ok(disarmed === true && res2.armingDisarmed === true, 'killMaker withdraws the arming authorization and reports armingDisarmed:true');
      ok(res2.simulated === true, 'a fully dry-run cancel sweep (no creds) is reported simulated:true — the honest "no live cancel attempted" signal');
    }

    // ── 3 · a LIVE (non-dry-run) sweep is NOT flagged simulated, and cancelledTotal sums venue figures ──
    {
      const liveCancel = async () => ([
        { venue: 'polymarket', ok: true, error: null, cancelled: 3, venueOpenBefore: 3, simulated: false },
        { venue: 'kalshi', ok: true, error: null, cancelled: 2, venueOpenBefore: 2, simulated: false },
      ]);
      const res3 = await killMaker({ by: 'sc' }, { setGlobalKill: (a) => KS.setGlobalKill(a, { stateFile: tmp() }), cancelAllOrders: liveCancel, now: () => 1 });
      ok(res3.simulated === false, 'a sweep with real creds is simulated:false (live cancel attempted)');
      ok(res3.cancelledTotal === 5, 'cancelledTotal sums the venue-reported figures (3+2=5), never invented');
    }

    // ── 4 · FAIL-CLOSED REPORTING: if the durable set THROWS, killMaker reports killed:false, never a false success ──
    console.log('\n3. killMaker — never claims a kill it did not achieve');
    {
      const boom = () => { throw new Error('state unwritable'); };
      const res4 = await killMaker({ by: 'sc' }, { setGlobalKill: boom, cancelAllOrders, now: () => 1 });
      ok(res4.killed === false && /unwritable/.test(res4.killError || ''), 'killMaker reports killed:false + the error when the durable set fails — it NEVER reports a kill it did not achieve');
      // and the cancel sweep STILL runs even when the durable set failed (belt-and-braces: stop the orders too).
      ok(Array.isArray(res4.cancel) && res4.cancel.length > 0, 'even when the durable set fails, killMaker STILL runs the cancel sweep (orders are stopped regardless)');
    }

    // ── 5 · ONE CODE PATH — the button, the script, and the endpoint trip the SAME switch through the SAME route ──
    console.log('\n4. one code path — button ≡ script ≡ endpoint');
    {
      const client = fs.readFileSync(path.join(ROOT, 'app', 'dashboard', 'maker', 'MakerKillClient.tsx'), 'utf8');
      ok(/fetch\(\s*['"]\/api\/maker\/kill['"]/.test(client), 'MakerKillClient.tsx POSTs /api/maker/kill (the durable-disarm endpoint)');
      ok(!/fetch\(\s*['"]\/api\/maker\/cancel['"]/.test(client), 'MakerKillClient.tsx does NOT call /api/maker/cancel (cancel-without-disarm would let the engine re-quote)');

      const script = fs.readFileSync(path.join(ROOT, 'scripts', 'kill-maker.sh'), 'utf8');
      ok(/\/api\/maker\/kill/.test(script), 'scripts/kill-maker.sh POSTs the SAME /api/maker/kill endpoint');
      ok(/safety-kill-switch\.json/.test(script), 'scripts/kill-maker.sh confirms by RE-READING the durable state file (not by trusting the HTTP response)');

      const route = fs.readFileSync(path.join(ROOT, 'app', 'api', 'maker', 'kill', 'route.ts'), 'utf8');
      ok(/killMaker/.test(route) && /from '@\/lib\/maker\/kill'/.test(route), 'app/api/maker/kill/route.ts drives the SAME killMaker orchestration — one implementation, no drift');
      // structural guarantee: judged on the IMPORT lines only (not comments) — the kill route pulls in NO
      // placement/signer surface, so it can STOP orders but structurally cannot START one.
      const imports = route.split('\n').filter((l) => /^\s*import\b/.test(l)).join('\n');
      ok(!/createMakerAdapter|signerProvider|maker-adapter|\/placement/i.test(imports), 'the kill route IMPORTS no placement/signer surface — it can STOP orders but structurally cannot START one');
    }

    console.log(`\nmaker-kill selfcheck: ${checks} assertions passed — killMaker durably disarms (survives a fresh read), withdraws arming, reports cancel flags honestly, NEVER claims an unachieved kill; the button, the shell script and the endpoint are ONE code path to ONE durable switch.`);
  })().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
}
