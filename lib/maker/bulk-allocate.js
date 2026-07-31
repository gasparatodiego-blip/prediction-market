'use strict';
// lib/maker/bulk-allocate.js — place EVERY row of an allocation plan, in sequence, with a cumulative cap.
//
// WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT. It is a loop over placeManualOrder — nothing more. It
// adds no venue surface, no signing, no second placement path. Every order it places runs the identical
// gate chain a hand order runs (manual ownership, the shared venue-rules guard, the per-order cap, the
// global kill switch, the adapter's own chain, and the exchange's validateOrder()), and lands under the
// same watcher management afterwards: mid chase, band ceiling, GTD renewal, reconciliation.
//
// ─── THE CUMULATIVE CAP IS THE POINT ────────────────────────────────────────────────────────────────
// A single order is checked against the per-order cap by the existing chain. A SEQUENCE is different: ten
// orders each individually under the cap can still add up to far more open exposure than the account is
// allowed. So this tracks the running total itself and STOPS the moment the next order would cross the
// open-notional ceiling — it does not attempt it and let a gate refuse it, because a refusal mid-sequence
// is indistinguishable from a failure and leaves the operator guessing which rows are live.
//
// It stops rather than skipping ahead to a smaller row that would still fit. Reordering an allocation
// silently is a different allocation from the one that was reviewed and confirmed.
//
// ─── EVERY ROW GETS A VERDICT ───────────────────────────────────────────────────────────────────────
// placed / refused / skipped, each with its reason, so the report answers "what is live right now"
// exactly. A bulk action whose failure mode is an unclear partial state is worse than no bulk action.

const { placeManualOrder, resolveCaps, readEngineState, OPERATOR_USER } = require('./manual-order');
const { appendMakerAudit } = require('../venues/polymarket-clob-maker/audit');
const killSwitch = require('../safety/kill-switch');

const BULK_SOURCE = 'manual-ui';   // it IS the operator acting, through one button instead of many

/**
 * @param {object} args
 *   rows       [{ marketId, book, side?, price, size, title? }] — exactly the plan's rows, in order
 *   userId
 *   dryRunOnly if true, validate and report WITHOUT calling the placement path at all (the preview)
 * @param {object} deps  every side effect injectable
 * @returns {{ok, at, attempted, placed, refused, skipped, stoppedBy, results, totals}}
 */
async function runBulkAllocation({ rows = [], userId = OPERATOR_USER, dryRunOnly = false } = {}, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const t0 = now();
  const place = deps.placeOrder || placeManualOrder;
  const audit = deps.audit || appendMakerAudit;
  const killStatusFn = deps.killStatus || killSwitch.killStatus;
  const capsOf = deps.resolveCaps || ((a, d) => resolveCaps(a, d));
  const results = [];

  const report = (stoppedBy, reason) => {
    const placed = results.filter((r) => r.status === 'placed');
    const refused = results.filter((r) => r.status === 'refused');
    const skipped = results.filter((r) => r.status === 'skipped');
    return {
      ok: refused.length === 0 && stoppedBy == null,
      at: new Date(t0).toISOString(), latencyMs: now() - t0,
      attempted: placed.length + refused.length,
      placed: placed.length, refused: refused.length, skipped: skipped.length,
      stoppedBy, reason, results,
      totals: {
        requestedUsd: +rows.reduce((s, r) => s + (Number(r.price) * Number(r.size) || 0), 0).toFixed(2),
        placedUsd: +placed.reduce((s, r) => s + (r.notionalUsd || 0), 0).toFixed(2),
        rows: rows.length,
      },
    };
  };

  if (!rows.length) return report('no-rows', 'nessuna riga da eseguire');

  // ── GATE 0 — the kill switch, once, up front. Checking it per row would let a kill set mid-sequence
  //    leave half an allocation live with no record of why the rest never happened. ──
  const kill = killStatusFn(deps.killDeps || {});
  if (kill.effectivelyKilled === true || kill.readable === false) {
    for (const r of rows) results.push({ ...rowRef(r), status: 'skipped', reason: 'kill-switch attivo' });
    return report('kill', kill.readable === false
      ? 'stato del kill-switch NON leggibile — trattato come attivo: nessun ordine viene piazzato'
      : 'kill-switch ATTIVO — nessun ordine viene piazzato');
  }

  const engine = deps.engine || readEngineState();
  const caps = capsOf({ userId, engine }, deps.limitDeps || {});
  if (!caps || caps.readable !== true || !Number.isFinite(caps.maxOpenNotionalUsd)) {
    for (const r of rows) results.push({ ...rowRef(r), status: 'skipped', reason: 'limiti di rischio non leggibili' });
    return report('caps-unreadable', 'i limiti di rischio non sono leggibili — rifiuto l\'intera sequenza (limite assente ≠ illimitato)');
  }

  // The cumulative budget starts from exposure ALREADY open, not from zero: a bulk run must not be able
  // to add a full cap's worth on top of positions that are already there.
  const alreadyOpen = Number.isFinite(deps.openNotionalUsd) ? deps.openNotionalUsd : 0;
  const ceiling = caps.maxOpenNotionalUsd;
  let running = alreadyOpen;

  audit({ ts: t0, venue: 'polymarket', source: BULK_SOURCE, op: 'bulk-allocate', outcome: 'start',
    userId, rows: rows.length,
    requestedUsd: +rows.reduce((s, r) => s + (Number(r.price) * Number(r.size) || 0), 0).toFixed(2),
    openBefore: alreadyOpen, ceiling });

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const price = Number(r.price);
    const size = Number(r.size);
    const notional = (Number.isFinite(price) && Number.isFinite(size)) ? +(price * size).toFixed(4) : NaN;

    if (!Number.isFinite(notional) || notional <= 0) {
      results.push({ ...rowRef(r), index: i, status: 'refused', reason: 'prezzo o size non validi', notionalUsd: null });
      continue;
    }

    // ── THE CUMULATIVE CEILING. Checked BEFORE attempting, so a stop is a clean stop. ──
    if (running + notional > ceiling + 1e-9) {
      results.push({ ...rowRef(r), index: i, status: 'skipped', notionalUsd: notional,
        reason: `il cap cumulativo di esposizione aperta ($${ceiling}) sarebbe superato: già impegnati $${running.toFixed(2)}, questa riga ne aggiungerebbe $${notional.toFixed(2)}` });
      for (let j = i + 1; j < rows.length; j++) {
        results.push({ ...rowRef(rows[j]), index: j, status: 'skipped', reason: 'sequenza fermata al raggiungimento del cap cumulativo' });
      }
      audit({ ts: now(), venue: 'polymarket', source: BULK_SOURCE, op: 'bulk-allocate', outcome: 'stopped-cap',
        userId, atRow: i, placed: results.filter((x) => x.status === 'placed').length, running: +running.toFixed(2), ceiling });
      return report('cap-cumulativo', `fermata alla riga ${i + 1} di ${rows.length}: il cap cumulativo di $${ceiling} sarebbe superato`);
    }

    if (dryRunOnly) {
      results.push({ ...rowRef(r), index: i, status: 'skipped', notionalUsd: notional, reason: 'anteprima: nulla è stato inviato' });
      running += notional;
      continue;
    }

    let res;
    try {
      res = await place({ marketId: r.marketId, book: r.book, side: r.side === 'SELL' ? 'SELL' : 'BUY',
        price, size, userId, source: BULK_SOURCE, note: `allocazione in blocco, riga ${i + 1}/${rows.length}` });
    } catch (e) {
      results.push({ ...rowRef(r), index: i, status: 'refused', notionalUsd: notional, reason: `errore: ${e.message}` });
      continue;
    }

    if (res && res.ok === true) {
      results.push({ ...rowRef(r), index: i, status: 'placed', notionalUsd: notional,
        sent: res.sent === true, orderId: res.orderId || null,
        reason: res.sent ? 'inviato al venue' : 'costruito, firmato e validato — non inviato (dry-run)' });
      running += notional;
    } else {
      // A refusal does NOT stop the sequence: one market's rules failing says nothing about the next.
      // Only the cumulative cap stops it, because that is the one condition that is about the WHOLE run.
      results.push({ ...rowRef(r), index: i, status: 'refused', notionalUsd: notional,
        gate: (res && res.gate) || null, reason: (res && res.reason) || 'rifiutato' });
    }
  }

  const out = report(null, null);
  audit({ ts: now(), venue: 'polymarket', source: BULK_SOURCE, op: 'bulk-allocate', outcome: out.refused ? 'partial' : 'complete',
    userId, placed: out.placed, refused: out.refused, skipped: out.skipped, placedUsd: out.totals.placedUsd });
  return out;
}

function rowRef(r) {
  return { marketId: r.marketId, title: r.title || null, book: r.book, side: r.side === 'SELL' ? 'SELL' : 'BUY', price: Number(r.price), size: Number(r.size) };
}

module.exports = { runBulkAllocation, BULK_SOURCE };
