'use strict';

/**
 * carry-first-seen — earliest recorded daysToExpiry per dated contract.
 *
 * Reads the basis snapshots lib/history-logger already writes to data/history/basis/.
 * For each contract it keeps the LARGEST daysToExpiry ever recorded, which is the point
 * furthest from settlement that we actually observed.
 *
 * That value is the only honest denominator available for the convergence bar. Venue
 * listing dates are not in this pipeline, so a contract's true tenor is unknown; using
 * "since first observed" keeps the bar traceable to recorded data and still fills to
 * exactly 100% at expiry. A contract we have never recorded returns null and the UI
 * renders "—" rather than a guessed tenor.
 *
 * Cached in module scope with a TTL because this walks ~15 daily files (~2 MB) and the
 * answer only changes once a day.
 */

const fs   = require('fs');
const path = require('path');

const HIST_DIR = path.join(process.cwd(), 'data', 'history', 'basis');
const TTL_MS   = 10 * 60_000;

let cache = { at: 0, map: null };

/** @returns {Record<string, number>} contract → max observed daysToExpiry */
function firstSeenMap() {
  if (cache.map && Date.now() - cache.at < TTL_MS) return cache.map;

  const map = Object.create(null);
  let files = [];
  try {
    files = fs.readdirSync(HIST_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  } catch {
    cache = { at: Date.now(), map };   // cache the empty answer too — don't retry per request
    return map;
  }

  for (const f of files) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(HIST_DIR, f), 'utf8')); } catch { continue; }
    const snapshots = Array.isArray(doc) ? doc : [];
    for (const snap of snapshots) {
      if (!snap || typeof snap !== 'object') continue;
      for (const row of snap.rows ?? []) {
        if (!row || typeof row !== 'object') continue;
        const key = row.instrument;
        const dte = row.daysToExpiry;
        if (typeof key !== 'string' || typeof dte !== 'number' || !Number.isFinite(dte)) continue;
        if (!(key in map) || dte > map[key]) map[key] = dte;
      }
    }
  }

  cache = { at: Date.now(), map };
  return map;
}

module.exports = { firstSeenMap };
