#!/usr/bin/env node
'use strict';
// scripts/maker-manual-mode-selfcheck.js — repeatable proof that the PER-MARKET manual-mode flag really
// isolates one lane from another, in both directions, and that it is NOT a second kill switch.
//
//   node scripts/maker-manual-mode-selfcheck.js
//
// Pure assertions against TEMP fixtures. No network, no key, no venue call, no order — and it never
// touches the real data/maker-manual-mode.json, data/safety-kill-switch.json or any live state.
//
// Proves:
//   1. round trip — set/clear a market, the flag is durable, per-market, and case-insensitive;
//   2. FAIL CLOSED both ways — an unreadable state makes the engine treat EVERY market as manual AND
//      makes the manual panel refuse (readable:false), so nobody places on an unknown owner;
//   3. absent ≠ unreadable — a fresh install (no file) means "no market is manual", the engine owns all;
//   4. clearing is refused on an unreadable state — handing a market back to the engine needs a state we
//      can actually read; taking one MANUAL is always permitted (the safe direction);
//   5. the cancel filter excludes manual markets from the engine's routine sweeps and only those;
//   6. il KILL non conosce eccezioni — la spazzata non sa cosa sia la gestione manuale (fino al 9
//      agosto 2026 questo punto asseriva anche il cablaggio del motore automatico, ora rimosso);
//   7. it touches NO kill-switch state: setting/clearing manual mode leaves the global kill exactly as
//      it was (this is a scalpel, not a second kill switch);
//   8. the manual placement path refuses a market that is NOT manual (isolation is a precondition).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MM = require('../lib/maker/manual-mode');
const KS = require('../lib/safety/kill-switch');

let checks = 0;
const ok = (c, m) => { assert(c, m); checks++; console.log(`  ✓ ${m}`); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-mode-'));
let n = 0;
const tmp = (name) => path.join(TMP, `${name}-${process.pid}-${n++}`);

const MKT_A = '0x12dc2b61723b2a54fc1947a307389b5f32038e7a29a0e936ad1fe410b969d06a';
const MKT_B = '0x6bd56627aa21311850825edb27e53434a0e17a4f782be0086bc07f71eee00d0d';

// ── 1 · ROUND TRIP ──────────────────────────────────────────────────────────────────────────────────
console.log('\n1. round trip — durable, per-market, case-insensitive');
{
  const stateFile = tmp('state.json'), auditFile = tmp('audit.jsonl');
  const deps = { stateFile, auditFile };

  ok(MM.isManualMarket(MKT_A, deps).manual === false, 'a market nobody claimed is NOT manual — the engine owns it');

  const set = MM.setManualMode({ marketId: MKT_A, manual: true, by: 'selfcheck', reason: 'hand test' }, deps);
  ok(set.ok === true && set.manual === true, 'setManualMode takes a market manual and reports it');
  ok(fs.existsSync(stateFile), 'the flag is DURABLE — written to disk, so a pm2 restart cannot clear it');

  const read = MM.isManualMarket(MKT_A, deps);
  ok(read.manual === true && read.readable === true, 'a FRESH read (no cache) sees the flag — the engine binds on its next tick, no restart');
  ok(read.record && read.record.by === 'selfcheck' && read.record.reason === 'hand test', 'the record carries who set it and why');
  ok(MM.isManualMarket(MKT_A.toUpperCase(), deps).manual === true, 'market ids are matched case-insensitively — a 0xAB… and a 0xab… are the same market');

  ok(MM.isManualMarket(MKT_B, deps).manual === false, 'the flag is PER-MARKET: taking A manual leaves B with the engine');

  const audit = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map(JSON.parse);
  ok(audit.length === 1 && audit[0].event === 'manual-mode-on' && audit[0].marketId === MKT_A.toLowerCase(),
    'every change is AUDITED (who/when/why) to data/maker-manual-mode-audit.jsonl');

  const cleared = MM.setManualMode({ marketId: MKT_A, manual: false, by: 'selfcheck' }, deps);
  ok(cleared.ok === true && MM.isManualMarket(MKT_A, deps).manual === false, 'clearing hands the market back to the engine');
  ok(fs.readFileSync(auditFile, 'utf8').trim().split('\n').length === 2, 'the clear is audited too');
}

// ── 2 · FAIL CLOSED, BOTH DIRECTIONS ────────────────────────────────────────────────────────────────
console.log('\n2. fail closed — an unreadable owner means NOBODY places');
{
  const stateFile = tmp('corrupt.json');
  fs.writeFileSync(stateFile, '{ this is not json');
  const deps = { stateFile, auditFile: tmp('audit.jsonl') };

  const r = MM.isManualMarket(MKT_A, deps);
  ok(r.manual === true, 'unreadable state ⇒ manual:true ⇒ AGENT35 STANDS OFF (it must not place on a market whose owner it could not read)');
  ok(r.readable === false && r.error === 'corrupt-json', '…and readable:false ⇒ THE MANUAL PANEL ALSO REFUSES (it requires readable:true) — so neither side places, never both');
  ok(/failing CLOSED/i.test(r.reason), 'the refusal NAMES itself as fail-closed rather than looking like an ordinary "not manual"');

  const block = MM.placementBlockReason(MKT_B, deps);
  ok(typeof block === 'string' && block.includes('manual mode active, skip'),
    'the engine blocks EVERY market (not just the claimed one) while ownership is unreadable');

  const f = MM.filterCancelTargets([MKT_A, MKT_B], deps);
  ok(f.allowed.length === 0 && f.skipped.length === 2 && f.readable === false,
    'the routine cancel sweep is suppressed on every market too — an unreadable owner must not authorise a sweep');
}

// ── 3 · ABSENT ≠ UNREADABLE ─────────────────────────────────────────────────────────────────────────
console.log('\n3. absent ≠ unreadable — a fresh install is engine-owned, not frozen');
{
  const deps = { stateFile: tmp('missing.json'), auditFile: tmp('audit.jsonl') };
  const st = MM.readManualMode(deps);
  ok(st.readable === true && st.marketIds.length === 0, 'an ABSENT file is a READABLE state meaning "no market is manual"');
  ok(MM.placementBlockReason(MKT_A, deps) === null, 'so the engine is NOT blocked on a machine that has never used the panel — the flag is opt-in');
}

// ── 4 · CLEARING IS THE UNSAFE DIRECTION ────────────────────────────────────────────────────────────
console.log('\n4. taking manual always works; handing back needs a readable state');
{
  const stateFile = tmp('corrupt2.json');
  fs.writeFileSync(stateFile, 'not json at all');
  const deps = { stateFile, auditFile: tmp('audit.jsonl') };

  const off = MM.setManualMode({ marketId: MKT_A, manual: false, by: 'selfcheck' }, deps);
  ok(off.ok === false && /unreadable/.test(off.error), 'REFUSED: handing a market back to the engine on an unreadable state would arm the engine blind');

  const on = MM.setManualMode({ marketId: MKT_A, manual: true, by: 'selfcheck' }, deps);
  ok(on.ok === true, 'PERMITTED: taking a market manual is the safe direction and must always succeed, even over a corrupt state');
  ok(MM.isManualMarket(MKT_A, deps).manual === true && MM.isManualMarket(MKT_A, deps).readable === true,
    '…and the write repaired the state, so it is readable again');
}

// ── 5 · THE CANCEL FILTER ───────────────────────────────────────────────────────────────────────────
console.log('\n5. routine cancel sweeps skip manual markets — and only those');
{
  const deps = { stateFile: tmp('cancel.json'), auditFile: tmp('audit.jsonl') };
  MM.setManualMode({ marketId: MKT_A, manual: true, by: 'selfcheck' }, deps);
  const f = MM.filterCancelTargets([MKT_A, MKT_B], deps);
  ok(f.skipped.length === 1 && f.skipped[0] === MKT_A, 'the manual market is EXCLUDED — cancelMarketOrders cannot tell whose order it wipes, so it never runs there');
  ok(f.allowed.length === 1 && f.allowed[0] === MKT_B, 'every other market is still swept exactly as before — the engine keeps cleaning up after itself');
  ok(MM.filterCancelTargets([], deps).allowed.length === 0, 'an empty target list is a valid no-op, not an error');
}

// ── 6 · THE WIRING IS REAL ──────────────────────────────────────────────────────────────────────────
console.log('\n6. il KILL non conosce eccezioni');
{
  // FINO AL 9 AGOSTO 2026 questa sezione leggeva il sorgente di agent35-maker e provava che il motore
  // automatico chiamasse i due gate. Il motore è stato rimosso il 9 agosto 2026 insieme all'ARMING, e
  // la proprietà «il gate della proprietà per mercato è cablato dove si piazza davvero» è oggi
  // asserita, sul percorso vivo, da lib/maker/gestione-manuale-nel-flusso.test.js — che gira nella
  // suite e legge il funnel reale. Qui resta la parte che nessun altro prova: la spazzata del KILL.

  // The KILL path must NOT be filtered: the panic button has no exceptions.
  const killSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'maker', 'cancel-all.js'), 'utf8');
  ok(!/manual-mode/.test(killSrc), 'lib/maker/cancel-all (the KILL sweep) does NOT know about manual mode — the panic button still cancels EVERYTHING, manual included');
}

// ── 7 · IT IS NOT A SECOND KILL SWITCH ──────────────────────────────────────────────────────────────
console.log('\n7. manual mode touches no kill-switch state');
{
  const killFile = tmp('kill.json'), killAudit = tmp('kill-audit.jsonl');
  const kdeps = { stateFile: killFile, auditFile: killAudit };
  KS.setGlobalKill({ reason: 'pre-existing', by: 'selfcheck' }, kdeps);
  const before = JSON.stringify(KS.killStatus(kdeps));

  const deps = { stateFile: tmp('nokill.json'), auditFile: tmp('audit.jsonl') };
  MM.setManualMode({ marketId: MKT_A, manual: true, by: 'selfcheck' }, deps);
  MM.setManualMode({ marketId: MKT_A, manual: false, by: 'selfcheck' }, deps);

  ok(JSON.stringify(KS.killStatus(kdeps)) === before, 'setting AND clearing manual mode leaves the kill switch bit-for-bit unchanged — it is a scalpel, not a second kill');
  ok(KS.checkKill({ userId: 'operator' }, kdeps).killed === true, 'a global kill that was active stays active throughout — manual mode can never lift it');

  const mmSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'maker', 'manual-mode.js'), 'utf8');
  // Prose may DISCUSS the kill switch (the header explains it is not one); what matters is that no
  // kill-switch surface is REQUIREd and no mutator is CALLED.
  const codeOnly = mmSrc.replace(/^\s*\/\/.*$/gm, '');
  ok(!/require\([^)]*kill-switch[^)]*\)/.test(codeOnly), 'lib/maker/manual-mode requires NO kill-switch module — it structurally cannot reach one');
  ok(!/(setGlobalKill|clearGlobalKill|setUserKill|clearUserKill)\s*\(/.test(codeOnly), '…and calls no kill mutator anywhere in its code');
}

// ── 8 · MANUAL PLACEMENT REQUIRES MANUAL OWNERSHIP ──────────────────────────────────────────────────
console.log('\n8. the manual path refuses a market the engine still owns');
{
  const { evaluateManualGate } = require('../lib/maker/manual-order');
  const deps = { stateFile: tmp('gate.json'), auditFile: tmp('audit.jsonl') };

  const notMine = evaluateManualGate({ marketId: MKT_A }, deps);
  ok(notMine.allow === false && notMine.gate === 'manual-mode-inactive',
    'placing by hand on an ENGINE-owned market is REFUSED — two writers on one market is the bug this whole flag exists to prevent');

  MM.setManualMode({ marketId: MKT_A, manual: true, by: 'selfcheck' }, deps);
  ok(evaluateManualGate({ marketId: MKT_A }, deps).allow === true, 'once the operator holds the market, the manual gate opens');

  const corrupt = tmp('gate-corrupt.json');
  fs.writeFileSync(corrupt, '{{{');
  const unreadable = evaluateManualGate({ marketId: MKT_A }, { stateFile: corrupt, auditFile: tmp('a.jsonl') });
  ok(unreadable.allow === false && unreadable.gate === 'manual-mode-unreadable',
    'and an unreadable owner refuses the MANUAL side too — the same fail-closed read that stands the engine off');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nmaker manual-mode selfcheck: ${checks} assertions passed — the flag is durable, per-market, audited, fail-closed in BOTH directions; agent35 places nothing and sweeps nothing on a manual market; the KILL still cancels everything; no kill-switch state is touched.`);
