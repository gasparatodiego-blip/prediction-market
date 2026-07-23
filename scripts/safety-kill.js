#!/usr/bin/env node
'use strict';
// scripts/safety-kill.js — the operator's shell control for the durable execution kill switch.
//
// Takes effect on the NEXT placement attempt — no deploy, no restart. State is a durable file under data/
// (survives pm2 restart). Every mutation is audited (who/when/scope/reason) to data/safety-kill-audit.jsonl.
//
// USAGE:
//   node scripts/safety-kill.js status
//   node scripts/safety-kill.js global-kill  --reason "..." --by "diego"
//   node scripts/safety-kill.js global-clear --reason "..." --by "diego"
//   node scripts/safety-kill.js user-kill  <userId> --reason "..." --by "diego"
//   node scripts/safety-kill.js user-clear <userId> --reason "..." --by "diego"

const ks = require('../lib/safety/kill-switch');

function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--reason') out.reason = argv[++i];
    else if (a === '--by') out.by = argv[++i];
    else out._.push(a);
  }
  return out;
}

function printStatus() {
  const st = ks.killStatus();
  if (!st.readable) {
    console.log(`kill-switch state: UNREADABLE (${st.error}) → FAIL-CLOSED, placement is treated as KILLED`);
    process.exit(2);
  }
  const g = st.global || { killed: false };
  console.log(`GLOBAL: ${g.killed ? 'KILLED' : 'clear'}${g.killed && g.reason ? ` — ${g.reason}` : ''}${g.killed && g.by ? ` (by ${g.by})` : ''}`);
  const users = st.users || {};
  const killedUsers = Object.entries(users).filter(([, u]) => u && u.killed);
  if (killedUsers.length === 0) console.log('PER-USER: none killed');
  else for (const [uid, u] of killedUsers) console.log(`  user ${uid}: KILLED${u.reason ? ` — ${u.reason}` : ''}${u.by ? ` (by ${u.by})` : ''}`);
  console.log(`(state file: ${st.stateFile})`);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const meta = { reason: flags.reason || null, by: flags.by || 'cli' };
  switch (cmd) {
    case 'status': case undefined: return printStatus();
    case 'global-kill': ks.setGlobalKill(meta); console.log('GLOBAL kill SET.'); return printStatus();
    case 'global-clear': ks.clearGlobalKill(meta); console.log('GLOBAL kill CLEARED.'); return printStatus();
    case 'user-kill': {
      const userId = flags._[0];
      if (!userId) { console.error('user-kill requires <userId>'); process.exit(1); }
      ks.setUserKill({ userId, ...meta }); console.log(`per-user kill SET for ${userId}.`); return printStatus();
    }
    case 'user-clear': {
      const userId = flags._[0];
      if (!userId) { console.error('user-clear requires <userId>'); process.exit(1); }
      ks.clearUserKill({ userId, ...meta }); console.log(`per-user kill CLEARED for ${userId}.`); return printStatus();
    }
    default:
      console.error(`unknown command '${cmd}'. Use: status | global-kill | global-clear | user-kill <userId> | user-clear <userId>`);
      process.exit(1);
  }
}

main();
