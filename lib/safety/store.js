'use strict';
// lib/safety/store.js — durable, FAIL-CLOSED JSON file persistence for the execution-safety layer.
//
// Venue-agnostic. State lives on disk under data/ so it SURVIVES a pm2 restart (it is NOT process
// memory) and can be set instantly from a shell command without a deploy. Everything the kill switch
// and risk limits read goes through readStore, whose contract encodes the fail-closed rule:
//
//   • file ABSENT (ENOENT)          → { ok:true, value:<empty>, existed:false }  — "nothing set yet",
//                                       a legitimate readable state (permitted). Absent ≠ unreadable.
//   • file present + parseable        → { ok:true, value, existed:true }
//   • file present but UNREADABLE      → { ok:false, error }  — permission denied, I/O error, corrupt
//                                       JSON. The CALLER MUST fail closed (treat as KILLED / refuse).
//
// The distinction absent-vs-unreadable is the whole point: a machine that has never been killed must be
// permitted, but a kill-state file we cannot read must be treated as a kill.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

function readStore(filePath, emptyValue, deps = {}) {
  const rf = deps.readFileSync || fs.readFileSync;
  let raw;
  try {
    raw = rf(filePath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, value: emptyValue, existed: false };
    // EACCES, EIO, EISDIR, … — the file exists in some form we cannot read. FAIL CLOSED.
    return { ok: false, error: `unreadable:${(e && e.code) || (e && e.message) || 'error'}` };
  }
  try {
    return { ok: true, value: JSON.parse(raw), existed: true };
  } catch (_e) {
    // A truncated / corrupt store is indistinguishable from tampering — FAIL CLOSED, never guess.
    return { ok: false, error: 'corrupt-json' };
  }
}

// Atomic write: temp file + rename, so a reader never sees a half-written store.
function writeStoreAtomic(filePath, value, deps = {}) {
  const wf = deps.writeFileSync || fs.writeFileSync;
  const rn = deps.renameSync || fs.renameSync;
  const mk = deps.mkdirSync || fs.mkdirSync;
  mk(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  wf(tmp, JSON.stringify(value, null, 2));
  rn(tmp, filePath);
  return { written: true };
}

module.exports = { readStore, writeStoreAtomic, DATA_DIR };
