'use strict';
// lib/rewards/pool-trend.js — is a market's reward pot GROWING, FLAT, or SHRINKING?
//
// WHY THIS EXISTS. Every $/day estimate in this project multiplies the market's CURRENT published pot by a
// modelled share. That treats an instantaneous number as a run rate: if Polymarket halved the pot six hours
// ago, the estimate still quotes the pre-cut figure as "per day" until the next snapshot happens to be read.
// The pot is the single largest multiplier in the whole estimate, so an unexamined one is the easiest way to
// be confidently wrong.
//
// THE SOURCE IS DATA WE ALREADY COLLECT. data/history/rewards-poly/YYYY-MM-DD.json is the board archive the
// rewards lane already writes — ~34 snapshots a day, each row carrying `dailyPool` per conditionId. Nothing
// new is fetched, nothing new is stored: this module only reads back what is on disk.
//
// HONEST-ENGINE CONTRACT, and it matters more here than usual because a trend is easy to fake:
//   • fewer than MIN_SAMPLES observations in the window ⇒ measurable:false, ratio null. The caller applies
//     NO correction and SAYS the trend could not be measured. It never silently becomes 1.0.
//   • the ratio only ever DISCOUNTS. A pot that grew is not a promise that it will stay grown, so
//     `discountFactor` is clamped at 1 — an increase is reported (`ratio` > 1, `direction:'up'`) and
//     deliberately not banked.
//   • the window is the LAST 48 HOURS of snapshots, which is the horizon the operator was asking about.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ARCHIVE_DIR = path.join(ROOT, 'data', 'history', 'rewards-poly');
const WINDOW_MS = 48 * 3_600_000;
// Below this many snapshots the "trend" is one or two readings and a ratio would be noise wearing a suit.
const MIN_SAMPLES = 6;
// A pot that moved less than this either way is reported as FLAT: venue rounding and snapshot timing produce
// small wobbles that are not a policy change, and discounting for them would be false precision.
const FLAT_BAND = 0.05;

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

/**
 * Read every archived snapshot inside the window and index dailyPool by conditionId.
 *
 * Returns a Map conditionId → { samples:[{t, pool}], first, last, mean }. Files that are missing or
 * unparseable are SKIPPED (an archive gap is a normal fact of a rotating log, not an error) — but a
 * market with too few surviving samples is reported unmeasurable downstream rather than smoothed over.
 *
 * @param {number} nowMs
 * @param {object} deps  { dir } — tests point this at a fixture directory
 */
function loadPoolHistory(nowMs = Date.now(), deps = {}) {
  const dir = deps.dir || ARCHIVE_DIR;
  const readdir = deps.readdirSync || fs.readdirSync;
  const readFile = deps.readFileSync || fs.readFileSync;
  const fromMs = nowMs - WINDOW_MS;
  const byCond = new Map();

  let files;
  try { files = readdir(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); }
  catch { return { readable: false, byCond, files: 0, reason: `archive directory unreadable (${dir})` }; }

  // Only the days that can possibly intersect a 48h window — the archive holds weeks and parsing all of it
  // on every allocation would cost seconds for data we would immediately discard.
  const keep = files.slice(-4);
  let used = 0;
  for (const f of keep) {
    let snapshots;
    try { snapshots = JSON.parse(readFile(path.join(dir, f), 'utf8')); }
    catch { continue; }                                   // a truncated day is skipped, never guessed at
    if (!Array.isArray(snapshots)) continue;
    used++;
    for (const snap of snapshots) {
      const t = fin(snap && snap.t) ? snap.t : (snap && snap.iso ? Date.parse(snap.iso) : NaN);
      if (!fin(t) || t < fromMs || t > nowMs) continue;
      for (const row of (snap.rows || [])) {
        const id = row && row.id;
        const pool = row && Number(row.dailyPool);
        if (!id || !fin(pool) || pool <= 0) continue;
        let e = byCond.get(id);
        if (!e) { e = []; byCond.set(id, e); }
        e.push({ t, pool });
      }
    }
  }
  for (const arr of byCond.values()) arr.sort((a, b) => a.t - b.t);
  return { readable: true, byCond, files: used, windowFromMs: fromMs, windowToMs: nowMs };
}

/**
 * The trend for ONE market.
 *
 * `ratio` compares the pot NOW (the most recent archived reading) against the MEAN over the window. The mean,
 * not the oldest reading: a single stale outlier at the window edge should not define the baseline, and the
 * mean is what "what has this pot actually been paying lately" means.
 *
 * @returns {{measurable:boolean, ratio:number|null, discountFactor:number, direction:'up'|'flat'|'down'|null,
 *            samples:number, currentPool:number|null, meanPool:number|null, note:string}}
 */
function poolTrendFor(history, conditionId, currentPool = null) {
  const arr = history && history.byCond ? history.byCond.get(conditionId) : null;
  const unmeasured = (note) => ({
    measurable: false, ratio: null, discountFactor: 1, direction: null,
    samples: arr ? arr.length : 0, currentPool: fin(currentPool) ? currentPool : null, meanPool: null, note,
  });

  if (!history || history.readable === false) return unmeasured('archivio dei montepremi non leggibile — nessuna correzione di trend applicata');
  if (!arr || arr.length < MIN_SAMPLES) {
    return unmeasured(`solo ${arr ? arr.length : 0} rilevazioni del montepremi nelle ultime 48h (ne servono ${MIN_SAMPLES}) — trend NON misurato, nessuna correzione applicata`);
  }

  const mean = arr.reduce((s, x) => s + x.pool, 0) / arr.length;
  const now = fin(currentPool) && currentPool > 0 ? currentPool : arr[arr.length - 1].pool;
  if (!(mean > 0)) return unmeasured('media del montepremi non calcolabile');

  const ratio = now / mean;
  const direction = ratio > 1 + FLAT_BAND ? 'up' : ratio < 1 - FLAT_BAND ? 'down' : 'flat';
  // ONLY a discount. A pot that grew is reported but never banked — "it went up recently" is not a
  // commitment that it stays up, and an estimate that rides a rise is the same mistake in the other direction.
  const discountFactor = direction === 'down' ? Math.max(0, Math.min(1, ratio)) : 1;

  return {
    measurable: true,
    ratio: +ratio.toFixed(4),
    discountFactor: +discountFactor.toFixed(4),
    direction,
    samples: arr.length,
    currentPool: +now.toFixed(2),
    meanPool: +mean.toFixed(2),
    note: direction === 'down'
      ? `il montepremi è sceso: ora $${now.toFixed(0)}/g contro una media di $${mean.toFixed(0)}/g nelle ultime 48h (${arr.length} rilevazioni) — la stima è scontata del ${Math.round((1 - discountFactor) * 100)}%`
      : direction === 'up'
        ? `il montepremi è salito ($${now.toFixed(0)}/g contro $${mean.toFixed(0)}/g di media 48h) — rilevato ma NON incassato nella stima: un aumento recente non è una promessa`
        : `montepremi stabile ($${now.toFixed(0)}/g contro $${mean.toFixed(0)}/g di media 48h, ${arr.length} rilevazioni) — nessuna correzione`,
  };
}

module.exports = { loadPoolHistory, poolTrendFor, WINDOW_MS, MIN_SAMPLES, FLAT_BAND, ARCHIVE_DIR };
