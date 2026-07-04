'use strict';

// Atomic JSON file write — the fix for the exchange-prices.json read/write race.
//
// agent10 rewrites shared /tmp data files every cycle while agent15 / /api/crypto /
// other agents read them concurrently. A plain fs.writeFileSync truncates-then-writes,
// so a reader can catch a half-written file and throw JSON.parse errors (seen at the
// 8192/16384-byte fs chunk boundaries).
//
// This serializes → writes to a SAME-DIRECTORY temp file → fsyncs → rename(2)s over the
// target. rename is atomic on the same filesystem, so a concurrent reader always sees
// either the complete OLD file or the complete NEW file — never a partial one. The temp
// file is unlinked on any failure so orphans can't accumulate.
//
// Pure I/O safety: does not touch, reshape, or recompute any value — the serialized
// content is byte-identical to the previous JSON.stringify(...) call.

const fs   = require('fs');
const path = require('path');

/**
 * Atomically write `obj` as JSON to `targetPath`.
 * @param {string} targetPath
 * @param {*} obj
 * @param {{ pretty?: boolean }} [opts]  pretty:true → JSON.stringify(obj, null, 2)
 */
function atomicWriteJson(targetPath, obj, { pretty = false } = {}) {
  const json = pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj);
  const dir  = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmp  = path.join(dir, `${base}.tmp.${process.pid}.${Date.now()}`);

  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, json);
    fs.fsyncSync(fd);          // flush to disk before the rename
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, targetPath);   // atomic replace — readers never see a partial file
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}   // never leave an orphan temp file behind
    throw e;
  }
}

module.exports = { atomicWriteJson };
