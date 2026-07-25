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

// DATA_DIR must be the ONE data/ directory, whether this module is require()d by a pm2 agent from
// lib/safety/ or bundled by Next into .next/server/app/api/. `path.join(__dirname, '..', '..', 'data')`
// silently produced .next/server/app/api/data/ in the bundled case — so a dashboard route wrote its
// state to a directory no agent ever reads, and the two sides of a control (the UI that sets it, the
// engine that obeys it) quietly disagreed. Anchor on the package root instead: walk up from __dirname
// to the nearest package.json, which is the project root from BOTH locations. cwd is the last resort
// (pm2 and next both run from the project root), never a bundled path.
// NOTE: Next writes its own .next/package.json ({"type":"commonjs"}), so a naive "nearest package.json"
// walk stops there and yields .next/data — the same class of bug, one level up. Build directories are
// skipped explicitly; only a real source root counts.
const BUILD_DIRS = new Set(['.next', 'dist', 'build', 'out', 'node_modules']);

function resolveDataDir() {
  let dir = __dirname;
  for (let i = 0; i < 12; i++) {
    if (!BUILD_DIRS.has(path.basename(dir)) && fs.existsSync(path.join(dir, 'package.json'))) {
      return path.join(dir, 'data');
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.join(process.cwd(), 'data');
}

const DATA_DIR = resolveDataDir();

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
