'use strict';
// lib/maker/offset-config.js — the TARGET DISTANCE FROM THE MID, per market and per side, plus the
// minimum movement that justifies acting on it.
//
// ─── WHAT CHANGED, AND WHY IT IS A DIFFERENT IDEA ───────────────────────────────────────────────────
// The watcher used to be REACTIVE: it left an order alone until the mid had drifted far enough to push
// it OUT of the reward band, then pulled it back to the edge. That keeps an order earning, but it lets
// the order's relationship to the mid decay all the way to the band edge before doing anything.
//
// This makes it ACTIVE: the order holds a fixed DISTANCE from the mid and follows it.
//     mid 10, orders at 7 and 13  (distance −3 / +3)
//     mid moves to 11             →  orders become 8 and 14
// The DISTANCE is the invariant, not the price. Both mechanisms now coexist and answer different
// questions: this one keeps the order where the operator wanted it RELATIVE to the market; the band
// check (lib/maker/auto-reprice) remains the hard ceiling that no chase may cross.
//
// ─── WHERE THE TARGET COMES FROM ────────────────────────────────────────────────────────────────────
// Keyed by (market, book) — NOT by order id. An order id changes on every re-price, so an id-keyed
// target would be forgotten the first time it was used. (market, book) survives.
//
//   1. an explicit per-market setting from the panel wins;
//   2. otherwise the FIRST OBSERVED distance is adopted and remembered, which makes the default
//      behaviour exactly "stay where you were placed, relative to the mid" with nothing to configure;
//   3. an order on a (market, book) the store has never seen simply seeds itself.
//
// ─── THE MINIMUM MOVEMENT, AND WHY IT IS ONE TICK ───────────────────────────────────────────────────
// Measured on THIS project's own 62.5h of recorded mid history for the pinned market (2,654 samples,
// data/mid-history-*.jsonl), chase re-prices per hour by threshold:
//     0.05¢ (half tick) → 1.60/h      0.3¢ → 0.27/h
//     0.10¢ (one tick)  → 0.93/h      0.5¢ → 0.16/h
//     0.20¢             → 0.46/h      1.0¢ → 0.10/h
//
// The default is ONE TICK, and the reason is not the rate — it is that below one tick the re-price is a
// NO-OP. The new price is the mid plus the target offset, snapped to the venue's tick grid; a mid
// movement smaller than one tick usually snaps to the SAME price the order already has. Re-pricing then
// means cancelling and re-placing at an identical price: a real out-of-book window, a venue round trip,
// and zero benefit. Half a tick would roughly double the rate to buy exactly that.
//
// At one tick this market produces ~0.9 chase re-prices/hour. With the ~3/hour proactive GTD renewals
// that is ~4/hour in total — comfortably under the 20/hour runaway ceiling.

const path = require('path');
const { readStore, writeStoreAtomic, DATA_DIR } = require('../safety/store');

const CONFIG_FILE = path.join(DATA_DIR, 'maker-offsets.json');
const AUDIT_FILE = path.join(DATA_DIR, 'maker-offsets-audit.jsonl');
const EMPTY = Object.freeze({ markets: {}, observed: {} });

// The floor for the minimum-move threshold, in cents. A market with a very fine tick could otherwise be
// configured to chase sub-tick noise; see the header for why that is pure churn.
const MIN_MOVE_FLOOR_CENTS = 0.05;
// Used only when the market's tick is unreadable — one tick on the coarsest common Polymarket grid.
const FALLBACK_MIN_MOVE_CENTS = 0.1;

function cfg(deps) {
  return {
    configFile: deps.offsetConfigFile || CONFIG_FILE,
    auditFile: deps.offsetAuditFile || AUDIT_FILE,
    now: deps.now || (() => Date.now()),
    fs: deps.fs || require('fs'),
  };
}
function normId(m) { return typeof m === 'string' ? m.trim().toLowerCase() : ''; }
function key(marketId, book) { return `${normId(marketId)}:${book === 'no' ? 'no' : 'yes'}`; }
function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

/** The default minimum move for a market: ONE TICK, floored. Tick unreadable ⇒ the fallback. */
function defaultMinMoveCents(tick) {
  if (!fin(tick) || !(tick > 0)) return FALLBACK_MIN_MOVE_CENTS;
  return Math.max(MIN_MOVE_FLOOR_CENTS, +(tick * 100).toFixed(4));
}

/** Read the whole store. Unreadable ⇒ readable:false and NO configured targets (the caller then falls
 *  back to the observed distance, which is the "stay where you were placed" default — never a guess). */
function readOffsetConfig(deps = {}) {
  const c = cfg(deps);
  const r = readStore(c.configFile, EMPTY, deps);
  if (!r.ok) return { readable: false, error: r.error, markets: {}, observed: {}, configFile: c.configFile };
  const st = (r.value && typeof r.value === 'object') ? r.value : EMPTY;
  return {
    readable: true, error: null,
    markets: (st.markets && typeof st.markets === 'object') ? st.markets : {},
    observed: (st.observed && typeof st.observed === 'object') ? st.observed : {},
    configFile: c.configFile,
  };
}

/**
 * THE RESOLVED TARGET for one (market, book), in order of precedence:
 *   explicit panel setting → remembered first-observed distance → the distance observed right now.
 *
 * @param {object} args
 *   marketId, book
 *   observedOffsetCents  the order's CURRENT distance from the mid, used to seed when nothing is known
 *   tick                 the market's tick, for the default minimum move
 * @returns {{targetOffsetCents:number|null, minMoveCents:number, source:'configured'|'remembered'|'observed'|'unknown', record:object|null}}
 */
function resolveOffsetFor({ marketId, book, observedOffsetCents = null, tick = null } = {}, deps = {}) {
  const st = readOffsetConfig(deps);
  const id = normId(marketId);
  const rec = st.markets[id] || null;
  const perSide = rec && rec.targetOffsetCents && typeof rec.targetOffsetCents === 'object' ? rec.targetOffsetCents : null;
  const configured = perSide ? perSide[book === 'no' ? 'no' : 'yes'] : null;
  const minMove = rec && fin(rec.minMoveCents) && rec.minMoveCents > 0 ? rec.minMoveCents : defaultMinMoveCents(tick);

  if (fin(configured) && configured > 0) {
    return { targetOffsetCents: configured, minMoveCents: minMove, source: 'configured', record: rec };
  }
  const remembered = st.observed[key(marketId, book)];
  if (fin(remembered) && remembered > 0) {
    return { targetOffsetCents: remembered, minMoveCents: minMove, source: 'remembered', record: rec };
  }
  if (fin(observedOffsetCents) && observedOffsetCents > 0) {
    return { targetOffsetCents: +observedOffsetCents.toFixed(4), minMoveCents: minMove, source: 'observed', record: rec };
  }
  return { targetOffsetCents: null, minMoveCents: minMove, source: 'unknown', record: rec };
}

/**
 * Remember the first distance seen for a (market, book), so "stay where you were placed" survives a
 * re-price (which mints a new order id) and a process restart. Never overwrites an existing memory and
 * never overrides an explicit setting — it only fills a blank.
 */
function rememberObserved({ marketId, book, offsetCents }, deps = {}) {
  const c = cfg(deps);
  if (!fin(offsetCents) || !(offsetCents > 0)) return { ok: false, reason: 'distanza non valida' };
  const r = readStore(c.configFile, EMPTY, deps);
  if (!r.ok) return { ok: false, reason: `store ${r.error}` };
  const base = r.value || {};
  const observed = { ...((base.observed && typeof base.observed === 'object') ? base.observed : {}) };
  const k = key(marketId, book);
  if (fin(observed[k])) return { ok: true, already: true, offsetCents: observed[k] };
  observed[k] = +offsetCents.toFixed(4);
  writeStoreAtomic(c.configFile, {
    markets: (base.markets && typeof base.markets === 'object') ? base.markets : {},
    observed, updatedAt: c.now(),
  }, deps);
  return { ok: true, already: false, offsetCents: observed[k] };
}

/**
 * VALIDATE a proposed setting against the market's real rules. Both checks were asked for explicitly and
 * both are refusals, not warnings:
 *   • the target distance may not exceed the reward band's RADIUS — an order further out than that earns
 *     nothing at all, so configuring it would be configuring a quote that cannot pay;
 *   • the minimum move must be strictly positive — zero or negative would mean "re-price on every cycle",
 *     which is a cancel/replace loop against the venue.
 */
function validateOffset({ targetOffsetCents, minMoveCents, bandRadiusCents, tick }) {
  const errors = [];
  if (targetOffsetCents != null) {
    if (!fin(targetOffsetCents) || targetOffsetCents <= 0) {
      errors.push({ field: 'targetOffsetCents', detail: 'la distanza target deve essere un numero maggiore di zero' });
    } else if (fin(bandRadiusCents) && targetOffsetCents > bandRadiusCents + 1e-9) {
      errors.push({ field: 'targetOffsetCents', detail: `la distanza target ${targetOffsetCents}¢ supera il raggio della banda premiante ±${bandRadiusCents}¢: un ordine li fuori non matura nulla` });
    } else if (fin(tick) && tick > 0 && targetOffsetCents < tick * 100 - 1e-9) {
      errors.push({ field: 'targetOffsetCents', detail: `la distanza target ${targetOffsetCents}¢ è sotto un tick (${(tick * 100).toFixed(2)}¢): non è esprimibile sulla griglia del venue` });
    }
  }
  if (minMoveCents != null) {
    if (!fin(minMoveCents) || minMoveCents <= 0) {
      errors.push({ field: 'minMoveCents', detail: 'la soglia minima di movimento deve essere maggiore di zero: a zero il sistema riprezzerebbe a ogni ciclo' });
    } else if (minMoveCents < MIN_MOVE_FLOOR_CENTS - 1e-9) {
      errors.push({ field: 'minMoveCents', detail: `la soglia minima ${minMoveCents}¢ è sotto il pavimento di ${MIN_MOVE_FLOOR_CENTS}¢: sotto un tick il riprezzo ricalcola lo STESSO prezzo, quindi sarebbe churn puro` });
    }
  }
  return { valid: errors.length === 0, errors };
}

/** Write a per-market setting. Audited. Validation is the caller's to run first (the route does). */
function setMarketOffset({ marketId, targetOffsetCents = undefined, minMoveCents = undefined, book = null, by = null, reason = null }, deps = {}) {
  const c = cfg(deps);
  const id = normId(marketId);
  if (!id) return { ok: false, error: 'marketId obbligatorio' };
  const r = readStore(c.configFile, EMPTY, deps);
  const base = (r.ok && r.value) ? r.value : {};
  const markets = { ...((base.markets && typeof base.markets === 'object') ? base.markets : {}) };
  const prev = markets[id] || {};
  const prevTargets = (prev.targetOffsetCents && typeof prev.targetOffsetCents === 'object') ? prev.targetOffsetCents : {};
  const targets = { ...prevTargets };
  if (targetOffsetCents !== undefined) {
    if (book === 'yes' || book === 'no') targets[book] = targetOffsetCents;
    else { targets.yes = targetOffsetCents; targets.no = targetOffsetCents; }
  }
  const at = c.now();
  markets[id] = {
    targetOffsetCents: targets,
    minMoveCents: minMoveCents !== undefined ? minMoveCents : (fin(prev.minMoveCents) ? prev.minMoveCents : undefined),
    at, atIso: new Date(at).toISOString(), by, reason,
  };
  writeStoreAtomic(c.configFile, {
    markets,
    observed: (base.observed && typeof base.observed === 'object') ? base.observed : {},
    updatedAt: at,
  }, deps);
  try {
    c.fs.mkdirSync(path.dirname(c.auditFile), { recursive: true });
    c.fs.appendFileSync(c.auditFile, JSON.stringify({ ts: at, event: 'offset-set', marketId: id, book, targetOffsetCents, minMoveCents, by, reason }) + '\n');
  } catch { /* best-effort */ }
  return { ok: true, marketId: id, record: markets[id] };
}

module.exports = {
  readOffsetConfig, resolveOffsetFor, rememberObserved, validateOffset, setMarketOffset,
  defaultMinMoveCents, CONFIG_FILE, AUDIT_FILE, MIN_MOVE_FLOOR_CENTS, FALLBACK_MIN_MOVE_CENTS,
};
