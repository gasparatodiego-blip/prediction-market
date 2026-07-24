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

  // ───────────────────────────────────────────────────────────────────────────────────────────────────
  // [3] ARM CONTROL — preflight-gated, two-step, collateral-capped, fail-closed. Temp files: no real state.
  // ───────────────────────────────────────────────────────────────────────────────────────────────────
  const os = require('os'), fsm = require('fs'), pathm = require('path');
  const { arm, disarm, readArming } = require('../lib/maker/arming');
  console.log('\n[3] ARM CONTROL');
  const tdir = fsm.mkdtempSync(pathm.join(os.tmpdir(), 'maker-arm-'));
  let clock = 1_753_000_000_000;
  const D = { stateFile: pathm.join(tdir, 'arm.json'), auditFile: pathm.join(tdir, 'arm-audit.jsonl'), now: () => clock };
  const GO = { go: true, at: 'now', checks: [{ key: 'signing', pass: true, value: 'MATCH' }] };
  const NOGO = { go: false, at: 'now', checks: [{ key: 'cancel', pass: false, value: 'simulated only' }, { key: 'signing', pass: true, value: 'MATCH' }] };

  // starts DISARMED (absent file ⇒ fail-closed disarmed)
  ok(readArming(D).armed === false, 'ARM: absent state ⇒ DISARMED (fail closed)');

  // refuse when preflight is NO-GO — arming impossible while a check is red (no override)
  const r1 = arm({ totalSizeUsd: 400, typedSizeConfirm: 400, ttlSeconds: 3600 }, { preflight: NOGO, deps: D });
  ok(r1.ok === false && r1.refusedBy === 'preflight', 'ARM: refused while preflight is NO-GO (a red check) — no override');
  ok(readArming(D).armed === false, 'ARM: a refused arm leaves the record DISARMED');

  // refuse on the two-step: typed size ≠ total
  const r2 = arm({ totalSizeUsd: 400, typedSizeConfirm: 399, ttlSeconds: 3600 }, { preflight: GO, deps: D });
  ok(r2.ok === false && r2.refusedBy === 'size-confirm', 'ARM: refused when the typed size ≠ total (two-step)');

  // refuse over the collateral cap
  const r3 = arm({ totalSizeUsd: 400, typedSizeConfirm: 400, ttlSeconds: 3600, collateralCapUsd: 300 }, { preflight: GO, deps: D });
  ok(r3.ok === false && r3.refusedBy === 'collateral-cap', 'ARM: refused when total exceeds the collateral cap');

  // refuse invalid size + refuse over-long TTL (no arm-forever)
  ok(arm({ totalSizeUsd: 0, typedSizeConfirm: 0 }, { preflight: GO, deps: D }).refusedBy === 'invalid-size', 'ARM: refused on size ≤ 0');
  ok(arm({ totalSizeUsd: 10, typedSizeConfirm: 10, ttlSeconds: 999999 }, { preflight: GO, deps: D }).refusedBy === 'ttl-too-long', 'ARM: refused on a TTL beyond the 24h ceiling (renew re-runs preflight)');

  // SUCCEED — go + exact size + within cap + valid TTL
  const rok = arm({ totalSizeUsd: 250, typedSizeConfirm: 250, ttlSeconds: 4 * 3600, collateralCapUsd: 1000, universeMarketIds: ['0xA', '0xB'], by: 'selfcheck' }, { preflight: GO, deps: D });
  ok(rok.ok === true && rok.arming.armed === true, 'ARM: arms when GO + exact size + within cap + valid TTL');
  const rs = readArming(D);
  ok(rs.armed === true && rs.record.totalSizeUsd === 250 && rs.record.universeMarketIds.length === 2, 'ARM: readArming reflects the armed record (size, universe)');
  ok(rs.record.preflightAtArm && rs.record.preflightAtArm.go === true, 'ARM: the arming record persists the preflight snapshot it was gated on');

  // manual disarm
  disarm('selfcheck-manual', D);
  ok(readArming(D).armed === false, 'ARM: disarm() clears the record');

  // the audit trail carries a reason for every arm + disarm + refusal
  const audit = fsm.readFileSync(D.auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok(audit.some((a) => a.event === 'arm') && audit.some((a) => a.event === 'disarm') && audit.some((a) => a.event === 'arm-refused' && a.refusedBy === 'preflight'),
    'ARM: every arm / disarm / refusal is AUDITED with its reason');

  // ── ARM PREVIEW — "what you're about to arm": real numbers or "—" + block ──
  const { buildArmPreview } = require('../lib/maker/arm-preview');
  const good = buildArmPreview({ markets: { '0xA': { title: 'T', mid: 0.5, legs: [{ side: 'BUY', targetPrice: 0.49, notionalUsd: 100 }, { side: 'SELL', targetPrice: 0.51, notionalUsd: 100 }] } } }, { perSideSizeUsd: 100 });
  ok(good.readable === true && good.markets[0].bid === 0.49 && good.markets[0].ask === 0.51 && good.totalCollateralUsd === 200, 'ARM PREVIEW: real bid/ask/size → total collateral computed (2 sides × $100 = $200)');
  const noMid = buildArmPreview({ markets: { '0xA': { title: 'T', mid: null, legs: [] } } }, { perSideSizeUsd: 100 });
  ok(noMid.readable === false && noMid.blockedReason, 'ARM PREVIEW: a market missing a readable mid/bid/ask → "—" and BLOCKED (never a fabricated preview)');
  ok(buildArmPreview(null, {}).readable === false, 'ARM PREVIEW: unreadable maker state → blocked');

  // ───────────────────────────────────────────────────────────────────────────────────────────────────
  // [4] MANDATORY TTL — auto-disarm the instant it expires; renew re-runs preflight; no arm-forever.
  // ───────────────────────────────────────────────────────────────────────────────────────────────────
  const { renew } = require('../lib/maker/arming');
  console.log('\n[4] MANDATORY TTL');
  const T = { stateFile: pathm.join(tdir, 'ttl.json'), auditFile: pathm.join(tdir, 'ttl-audit.jsonl'), now: () => clock };

  // arm for 4h, then jump the clock past expiry → readArming AUTO-DISARMS on read (+ audits ttl-expiry).
  clock = 2_000_000_000_000;
  ok(arm({ totalSizeUsd: 100, typedSizeConfirm: 100, ttlSeconds: 4 * 3600 }, { preflight: GO, deps: T }).ok === true, 'TTL: armed with a 4h expiry');
  ok(readArming(T).armed === true, 'TTL: armed before expiry');
  clock += 4 * 3600 * 1000 + 1;               // one ms past the 4h expiry
  const expired = readArming(T);
  ok(expired.armed === false && expired.source === 'ttl-expiry', 'TTL: an expired arm AUTO-DISARMS the instant it is read (no arm-forever)');
  const tAudit = fsm.readFileSync(T.auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok(tAudit.some((a) => a.event === 'auto-disarm' && a.reason === 'ttl-expiry'), 'TTL: the expiry auto-disarm writes an audit record (reason ttl-expiry)');

  // RENEW extends when preflight is GO, and re-runs it (persists a fresh snapshot).
  clock += 1000;
  ok(arm({ totalSizeUsd: 100, typedSizeConfirm: 100, ttlSeconds: 3600 }, { preflight: GO, deps: T }).ok === true, 'TTL: re-armed for renew test');
  const before = readArming(T).record.expiresAtMs;
  clock += 1800 * 1000;                        // 30 min later
  const rn = renew({ ttlSeconds: 3600 }, { preflight: GO, deps: T });
  ok(rn.ok === true && readArming(T).record.expiresAtMs > before, 'TTL: RENEW extends the expiry (explicit, re-runs preflight)');

  // RENEW while a check has gone RED → DISARMS instead of extending (the safe direction).
  const rnRed = renew({ ttlSeconds: 3600 }, { preflight: NOGO, deps: T });
  ok(rnRed.ok === false && rnRed.refusedBy === 'preflight' && readArming(T).armed === false, 'TTL: RENEW while a preflight check is RED DISARMS (never extends past a failed condition)');
  ok(renew({}, { preflight: GO, deps: T }).refusedBy === 'not-armed', 'TTL: RENEW on a disarmed record is refused (arm() again to re-confirm)');

  // ───────────────────────────────────────────────────────────────────────────────────────────────────
  // [5] AUTO-DISARM — the per-cycle invariant re-check disarms (with an audited reason) when a condition
  //     goes false WHILE armed: heartbeat failed, collateral cap exceeded, a preflight check gone red.
  // ───────────────────────────────────────────────────────────────────────────────────────────────────
  const { checkArmedInvariants } = require('../lib/maker/arming');
  console.log('\n[5] AUTO-DISARM (per-cycle recheck)');
  const mkArmed = (deps, cap) => { arm({ totalSizeUsd: 100, typedSizeConfirm: 100, ttlSeconds: 3600, collateralCapUsd: cap }, { preflight: GO, deps }); };

  // healthy → stays armed
  const A = { stateFile: pathm.join(tdir, 'inv-a.json'), auditFile: pathm.join(tdir, 'inv-a.jsonl'), now: () => clock };
  mkArmed(A, 1000);
  ok(checkArmedInvariants({ preflight: GO, collateralUsedUsd: 200, heartbeatOk: true }, A).armed === true, 'AUTO-DISARM: a healthy armed record (GO, under cap, heartbeat ok) STAYS armed');

  // a preflight check went red while armed → disarm(preflight-red:*)
  const B = { stateFile: pathm.join(tdir, 'inv-b.json'), auditFile: pathm.join(tdir, 'inv-b.jsonl'), now: () => clock };
  mkArmed(B, 1000);
  const invB = checkArmedInvariants({ preflight: NOGO, collateralUsedUsd: 0, heartbeatOk: true }, B);
  ok(invB.armed === false && /^preflight-red:/.test(invB.disarmedReason) && invB.disarmedReason.includes('cancel'), 'AUTO-DISARM: a preflight check gone RED while armed disarms (reason names the red check)');

  // collateral ceiling breached → disarm(collateral-cap-exceeded)
  const C = { stateFile: pathm.join(tdir, 'inv-c.json'), auditFile: pathm.join(tdir, 'inv-c.jsonl'), now: () => clock };
  mkArmed(C, 300);
  const invC = checkArmedInvariants({ preflight: GO, collateralUsedUsd: 301, heartbeatOk: true }, C);
  ok(invC.armed === false && invC.disarmedReason === 'collateral-cap-exceeded', 'AUTO-DISARM: collateral used past the cap disarms (collateral-cap-exceeded)');

  // heartbeat failed → disarm(heartbeat-failed)
  const E = { stateFile: pathm.join(tdir, 'inv-e.json'), auditFile: pathm.join(tdir, 'inv-e.jsonl'), now: () => clock };
  mkArmed(E, 1000);
  const invE = checkArmedInvariants({ preflight: GO, collateralUsedUsd: 0, heartbeatOk: false }, E);
  ok(invE.armed === false && invE.disarmedReason === 'heartbeat-failed', 'AUTO-DISARM: a failed heartbeat disarms (heartbeat-failed)');

  // each auto-disarm wrote an audited reason
  for (const [dep, reason] of [[B, 'preflight-red'], [C, 'collateral-cap-exceeded'], [E, 'heartbeat-failed']]) {
    const lines = fsm.readFileSync(dep.auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    ok(lines.some((a) => a.event === 'disarm' && String(a.reason).includes(reason.split(':')[0])), `AUTO-DISARM: the ${reason} disarm is AUDITED with its reason`);
  }

  try { fsm.rmSync(tdir, { recursive: true, force: true }); } catch { /* temp cleanup */ }

  console.log(`\nmaker-arming selfcheck: ${checks} assertions passed.`);
}

main().catch((e) => { console.error('arming selfcheck FAILED:', e && e.message ? e.message : e); process.exit(1); });
