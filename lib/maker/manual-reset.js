'use strict';
// lib/maker/manual-reset.js — THE "RIPRISTINA" SEQUENCE: bring the manual lane back to a provably clean,
// re-armed state after a KILL, and prove it with venue truth rather than with our own optimism.
//
// ─── THE PROBLEM THIS EXISTS TO CLOSE ───────────────────────────────────────────────────────────────
// On 2026-07-31 a hand order was refused by the cap gate for "open exposure $67.04" while the panel's
// "ordini a riposo" table showed ZERO rows. Both numbers were right. They answer different questions:
//
//   • THE TABLE asks the VENUE: adapter.listOpenOrders() → what is resting on the book right now.
//   • THE CAP GATE asks the LEDGER: lib/safety/usage.readUsage → lib/safety/fills.computeExposure, which
//     is built on our own append-only execution audit, NOT on the venue's order list.
//
// computeExposure deliberately counts, at FULL notional, every order that has an INTENT row with no
// resolution in the fill ledger. The rule is stated in fills.js and it is the right rule: "an unknown fill
// assumed unfilled understates exposure, which is the dangerous direction." An order we sent and cannot
// account for is assumed FILLED until the venue proves otherwise.
//
// The gap is what is supposed to do that proving. A resolution is written only by
// lib/safety/reconcile-fills, and there were TWO independent reasons it never resolved these four orders:
//
//   1. IT IS DRIVEN ONLY BY agent35, and only on a live adapter — agent35-maker.js says so in its own
//      comment: "dormant until arming". agent35 is disarmed (and stands off manual markets by design), so
//      the manual lane has NO reconciliation path of its own. The last resolution written to the fill
//      ledger is dated 2026-07-29T19:27:06Z; all four unresolved orders were placed after it.
//   2. EVEN IF IT HAD RUN, IT COULD NOT HAVE CLEARED THEM. reconcileOnce() never fetches the /trades
//      cross-check, so it calls planReconcile() with `venueFills` undefined. Read the planner: an order
//      that has VANISHED from the open-order list can only be recorded as a no-fill inside the
//      `if (Array.isArray(venueFills))` branch. With no trades array that branch is skipped and the order
//      lands in `stillUnknown: 'gone-no-crosscheck'` — forever. The one branch that can clear a vanished
//      order was unreachable in production.
//
// And these orders VANISH by design: they carried a GTD expiry, so the venue retired them by itself. An
// expiry is not a fill, not a cancel, and nothing anywhere was writing it down. Every expired hand order
// therefore left a permanent phantom at full notional, and the phantoms accumulate until the cap refuses
// orders that nothing real is backing. $67.04 = $24.20 + $23.60 + $9.62 + $9.62, four expired orders from
// 2026-07-30 22:07 through 2026-07-31 04:35.
//
// ─── WHAT THIS MODULE DOES, AND WHAT IT REFUSES TO DO ───────────────────────────────────────────────
// It runs the reconciliation the manual lane never had, WITH the cross-check that makes it honest, then
// clears the kill and PROVES the result from both sources. It adds no authority:
//
//   • It never places an order. Its only mutating venue call is cancelManualOrder, through the CANCEL-ONLY
//     adapter (address-only signer: it holds no signing key and structurally cannot place).
//   • It NEVER FABRICATES A RESOLUTION. A no-fill is recorded only when the venue read SUCCEEDED (not a
//     simulated/credential-less read), the order is absent from the open-order list, AND the /trades
//     cross-check succeeded and shows no matching fill. If the trades read fails, `venueFills` is null,
//     the planner leaves the order UNKNOWN, and this sequence reports that it could not clear it. Failing
//     to clear a phantom is an inconvenience; inventing a resolution would corrupt the risk ledger.
//   • It reuses planReconcile/applyReconcile verbatim — the same audited planner agent35 uses. The ONLY
//     thing this module adds is the trades array that planner has always accepted and never been given.
//   • It re-reads BOTH sources afterwards. The point of the whole exercise is that "the table is empty" was
//     never sufficient evidence; so the final proof is the venue AND the cap gate agreeing on zero.

const { listManualOrders, cancelManualOrder, resolveMarketRules, OPERATOR_USER } = require('./manual-order');
const { readManualMode } = require('./manual-mode');
const { readAutoRepriceConfig } = require('./auto-reprice-config');
const { appendMakerAudit } = require('../venues/polymarket-clob-maker/audit');
const { planReconcile, applyReconcile } = require('../safety/reconcile-fills');
const { readFills, computeExposure } = require('../safety/fills');
const { readUsage } = require('../safety/usage');
const { queryByUser } = require('../safety/execution-audit');
const { sentOrdersFromAudit } = require('../safety/usage');
const killSwitch = require('../safety/kill-switch');
const { resolveFunder, venueAccountAddress } = require('../venues/polymarket-clob-maker/funder');

const DATA_API = 'https://data-api.polymarket.com';
const TRADES_LIMIT = 500;
const TRADES_TIMEOUT_MS = 10_000;

/**
 * The user's recent fills from the PUBLIC, KEYLESS data-api. Read-only, no credentials, no signing key —
 * the same endpoint lib/ondemand-fills.ts already uses, and the same host the maker adapter reads
 * positions from.
 *
 * THIS IS THE CROSS-CHECK THE RECONCILER NEVER HAD. Its absence is why a vanished order could never be
 * cleared. Returns null (NOT an empty array) on any failure: null means "we could not ask", and the
 * planner then leaves orders unknown. An empty ARRAY means "we asked and there are no fills" — a
 * completely different claim, and the only one that may resolve an order to no-fill.
 */
async function fetchVenueTrades({ address, httpGet } = {}) {
  const get = httpGet || require('../httpGet').httpGet;
  if (!address) return { ok: false, trades: null, reason: 'indirizzo del conto non risolvibile — nessun controllo incrociato possibile' };
  try {
    const url = `${DATA_API}/trades?user=${address}&limit=${TRADES_LIMIT}`;
    const r = await get(url, { timeoutMs: TRADES_TIMEOUT_MS, headers: { Accept: 'application/json' } });
    if (!r || r.status !== 200 || !Array.isArray(r.data)) {
      return { ok: false, trades: null, reason: `data-api /trades ha risposto ${r ? r.status : 'nessuna risposta'} — controllo incrociato non disponibile` };
    }
    // Normalise to the shape planReconcile matches on: { tokenId, side, size, price }.
    const trades = r.data.map((t) => ({
      tokenId: String(t.asset ?? t.assetId ?? t.asset_id ?? t.tokenId ?? ''),
      side: String(t.side ?? '').toUpperCase(),
      size: Number(t.size),
      price: Number(t.price),
      ts: Number(t.timestamp ?? t.matchTime ?? 0),
    })).filter((t) => t.tokenId && Number.isFinite(t.size) && Number.isFinite(t.price));
    return { ok: true, trades, reason: `data-api /trades: ${trades.length} esecuzioni lette per questo conto` };
  } catch (e) {
    return { ok: false, trades: null, reason: `lettura /trades fallita (${e.message}) — controllo incrociato non disponibile` };
  }
}

/** Every market this panel manages: those held by hand, plus those opted into auto-reprice. */
function managedMarketIds(deps = {}) {
  const mm = readManualMode(deps.manualDeps || {});
  const ar = readAutoRepriceConfig(deps.autoRepriceDeps || {});
  const ids = new Set();
  for (const id of mm.marketIds || []) ids.add(String(id).toLowerCase());
  for (const id of ar.optedInMarketIds || []) ids.add(String(id).toLowerCase());
  return { ids: [...ids], manualReadable: mm.readable, autoReadable: ar.readable };
}

/**
 * THE EXPOSURE DIAGNOSIS — why the cap gate and the orders table disagree, in numbers.
 *
 * Splits the cap gate's openNotionalUsd into its two contributors, so a discrepancy is never reported as
 * a bare total again:
 *   • `positions`  — CONFIRMED exposure from the fill ledger. Real inventory. The venue's open-order list
 *                    would NOT show these, and it is correct not to: a filled position is not a resting order.
 *   • `unknowns`   — sent orders with no resolution, counted at full notional. THIS is the phantom bucket.
 */
function diagnoseExposure({ userId = OPERATOR_USER, now = Date.now() } = {}, deps = {}) {
  const usage = readUsage({ userId, now }, deps);
  const sentOrders = sentOrdersFromAudit(queryByUser({ userId, fromTs: 0, toTs: now }, deps));
  const exp = computeExposure({ userId, now, sentOrders }, deps);
  const unknowns = (exp.ok && Array.isArray(exp.unknowns)) ? exp.unknowns : [];
  const unknownUsd = unknowns.reduce((s, u) => s + (Number(u.notionalUsd) || 0), 0);
  const positions = (exp.ok && Array.isArray(exp.positions)) ? exp.positions : [];
  const positionUsd = positions.reduce((s, p) => s + (Number(p.exposureUsd) || 0), 0);
  return {
    readable: exp.ok === true,
    openNotionalUsd: usage.openNotionalUsd,
    fromConfirmedPositionsUsd: +positionUsd.toFixed(4),
    fromUnresolvedOrdersUsd: +unknownUsd.toFixed(4),
    positions,
    unknowns,
    sentOrders,
    note: exp.ok !== true
      ? 'il ledger dei fill non è leggibile — l\'esposizione resta sconosciuta e ogni limite che la usa fallisce CHIUSO'
      : unknownUsd > 0
        ? `di $${(usage.openNotionalUsd || 0).toFixed(2)} di esposizione aperta, $${unknownUsd.toFixed(2)} NON vengono da posizioni reali: sono ${unknowns.length} ordini inviati che nessuna riconciliazione ha mai risolto, contati a pieno nozionale per prudenza. La tabella "ordini a riposo" legge il VENUE e giustamente non li mostra: al venue non c'è più niente.`
        : `l'esposizione aperta viene interamente da posizioni confermate da fill ($${positionUsd.toFixed(2)}); nessun ordine inviato è rimasto irrisolto.`,
  };
}

/**
 * RUN THE WHOLE SEQUENCE. Every step is recorded in `steps` with its own evidence, and the caller renders
 * that list — a green tick with no evidence behind it is exactly what this feature exists to stop.
 *
 * @param {object} deps  every side effect injectable for the selfcheck
 * @returns {{ok, at, steps, before, after, cleared, cancelled, resolved, reason}}
 */
async function runOperatorReset({ userId = OPERATOR_USER, by = 'operator · pannello ordini manuali', reason = null } = {}, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const t0 = now();
  const steps = [];
  const step = (key, ok, label, evidence = null) => { steps.push({ key, ok, label, evidence, at: new Date(now()).toISOString() }); return ok; };
  const listOrders = deps.listOrders || listManualOrders;
  const cancelOrder = deps.cancelOrder || cancelManualOrder;
  const clearKill = deps.clearGlobalKill || killSwitch.clearGlobalKill;
  const killStatusFn = deps.killStatus || killSwitch.killStatus;
  const audit = deps.audit || appendMakerAudit;
  const diagnose = deps.diagnoseExposure || ((a) => diagnoseExposure(a, deps));
  const fetchTrades = deps.fetchVenueTrades || fetchVenueTrades;

  // ── STEP 0 — what we are starting from, on both sources ──────────────────────────────────────────
  const killBefore = killStatusFn(deps.killDeps || {});
  const managed = managedMarketIds(deps);
  step('kill-before', true, 'stato del kill-switch prima del ripristino', {
    killed: killBefore.effectivelyKilled, readable: killBefore.readable,
    reason: (killBefore.global && killBefore.global.reason) || null,
  });
  step('managed-markets', managed.ids.length > 0 || managed.manualReadable, 'mercati gestiti da questo pannello', {
    marketIds: managed.ids, manualModeReadable: managed.manualReadable, autoRepriceReadable: managed.autoReadable,
  });

  // ── STEP a — THE VENUE, ASKED DIRECTLY, ACROSS EVERY MANAGED MARKET ──────────────────────────────
  // marketId omitted on purpose: that lists the account's open orders on ALL markets, so an order resting
  // somewhere the panel has since stopped tracking cannot hide from this sweep.
  let venueBefore;
  try { venueBefore = await listOrders({ marketId: null }); }
  catch (e) { venueBefore = { ok: false, error: e.message, simulated: false, count: 0, orders: [] }; }
  const venueReadable = venueBefore.ok !== false && venueBefore.simulated !== true;
  step('venue-read-before', venueReadable, 'lettura degli ordini a riposo DAL VENUE (tutti i mercati)', {
    ok: venueBefore.ok, simulated: venueBefore.simulated, count: venueBefore.count,
    orders: (venueBefore.orders || []).map((o) => ({ orderId: o.orderId, marketId: o.marketId, side: o.side, price: o.price, sizeRemaining: o.sizeRemaining, source: o.source, orderType: o.orderType, secondsToExpiry: o.secondsToExpiry })),
    note: venueBefore.simulated ? 'nessuna credenziale: il venue NON è stato interrogato — questa non è una lista vuota' : null,
  });

  // ── STEP b — THE DIAGNOSIS: why the two numbers disagree ─────────────────────────────────────────
  const before = diagnose({ userId, now: t0 });
  step('exposure-diagnosis', before.readable, 'da dove viene l\'esposizione che vede il gate cap', {
    openNotionalUsd: before.openNotionalUsd,
    daPosizioniConfermate: before.fromConfirmedPositionsUsd,
    daOrdiniIrrisolti: before.fromUnresolvedOrdersUsd,
    ordiniIrrisolti: before.unknowns,
    ordiniARiposoSulVenue: venueBefore.count,
    spiegazione: before.note,
  });

  // ── STEP c — CANCEL ANY REAL RESIDUAL. Panel-owned orders only; agent35's are not ours to touch. ──
  const ours = (venueBefore.orders || []).filter((o) => o.orderId && o.source === 'manual-ui');
  const cancelled = [];
  for (const o of ours) {
    let res;
    try { res = await cancelOrder({ orderId: o.orderId, marketId: o.marketId }); }
    catch (e) { res = { ok: false, reason: e.message }; }
    cancelled.push({ orderId: o.orderId, marketId: o.marketId, ok: res.ok === true, cancelled: res.cancelled === true, alreadyGone: res.alreadyGone === true, reason: res.reason || null });
  }
  const foreign = (venueBefore.orders || []).filter((o) => o.source !== 'manual-ui').length;
  step('cancel-residuals', cancelled.every((c) => c.ok), ours.length ? `cancellazione dei ${ours.length} ordini residui del pannello` : 'nessun ordine residuo del pannello da cancellare', {
    cancelled, nonPanelOrdersLeftAlone: foreign,
    note: foreign > 0 ? `${foreign} ordini NON attribuiti a questo pannello sono stati lasciati intatti — non sono nostri da cancellare` : null,
  });

  // ── STEP c2 — RECONCILE THE PHANTOMS, with the cross-check that makes it honest ───────────────────
  const funder = deps.funder || resolveFunder(process.env);
  const address = deps.address || venueAccountAddress(funder, null);
  const tradesRes = await fetchTrades({ address });
  step('trades-crosscheck', tradesRes.ok, 'controllo incrociato sulle esecuzioni reali (data-api pubblica, senza credenziali)', {
    ok: tradesRes.ok, count: tradesRes.trades ? tradesRes.trades.length : null, address, reason: tradesRes.reason,
    perche: 'senza questo controllo un ordine sparito dal book non è distinguibile fra "eseguito" e "scaduto/cancellato", e la regola del progetto è di NON risolverlo mai a indovinare',
  });

  // Re-read the venue AFTER the cancels so the planner judges against the current book.
  let venueMid;
  try { venueMid = await listOrders({ marketId: null }); }
  catch (e) { venueMid = { ok: false, error: e.message, simulated: false, count: 0, orders: [] }; }
  const midReadable = venueMid.ok !== false && venueMid.simulated !== true;

  let resolved = { fills: 0, nofills: 0, stillUnknown: 0, ran: false };
  const ledger = readFills({ userId }, deps);
  if (!ledger.ok) {
    step('reconcile', false, 'riconciliazione NON eseguita: il ledger dei fill non è leggibile', { error: ledger.error });
  } else if (!midReadable) {
    step('reconcile', false, 'riconciliazione NON eseguita: il venue non è stato raggiunto', { simulated: venueMid.simulated, error: venueMid.error || null });
  } else {
    // venueFills is the array ONLY when the trades read succeeded. null ⇒ the planner leaves vanished
    // orders UNKNOWN rather than resolving them — the fail-closed direction, deliberately.
    const plan = planReconcile({
      userId,
      sentOrders: before.sentOrders,
      ledgerRows: ledger.rows,
      venueReachable: true,
      venueOrders: (venueMid.orders || []).map((o) => ({ id: o.orderId, asset_id: o.tokenId, side: o.side, price: o.price, original_size: o.size, size_matched: o.sizeMatched })),
      venueFills: tradesRes.ok ? tradesRes.trades : null,
      now: t0,
      source: 'operator-reset',
    });
    const applied = applyReconcile(plan, deps);
    resolved = { ...applied, ran: true };
    step('reconcile', true, 'riconciliazione degli ordini inviati contro la verità del venue', {
      risolti_come_eseguiti: applied.fills,
      risolti_come_NON_eseguiti: applied.nofills,
      ancora_sconosciuti: applied.stillUnknown,
      dettaglio_non_eseguiti: plan.toNoFill,
      dettaglio_ancora_sconosciuti: plan.stillUnknown,
      note: tradesRes.ok
        ? 'un ordine è stato marcato NON eseguito solo perché è assente dal book E le esecuzioni reali non ne mostrano traccia'
        : 'controllo incrociato non disponibile: nessun ordine sparito è stato risolto (mai per supposizione)',
    });
  }

  // ── STEP d — CLEAR THE KILL, durably and audited ─────────────────────────────────────────────────
  let clearRes = null;
  try {
    clearRes = clearKill({ reason: reason || 'ripristino operatore dal pannello ordini manuali', by }, deps.killDeps || {});
    step('kill-clear', true, 'kill-switch disattivato (scrittura durevole e tracciata)', { record: clearRes });
  } catch (e) {
    step('kill-clear', false, 'kill-switch NON disattivato', { error: e.message });
  }
  const killAfter = killStatusFn(deps.killDeps || {});
  step('kill-verify', killAfter.effectivelyKilled === false && killAfter.readable === true, 'verifica dello stato del kill-switch RILETTO dal file durevole', {
    killed: killAfter.effectivelyKilled, readable: killAfter.readable,
  });

  // ── STEP e — THE VENUE AGAIN, AFTER everything. Never trust the cancel command alone. ────────────
  let venueAfter;
  try { venueAfter = await listOrders({ marketId: null }); }
  catch (e) { venueAfter = { ok: false, error: e.message, simulated: false, count: 0, orders: [] }; }
  const afterReadable = venueAfter.ok !== false && venueAfter.simulated !== true;
  const venueClean = afterReadable && venueAfter.count === 0;
  step('venue-read-after', afterReadable, venueClean ? 'RILETTO dal venue: nessun ordine a riposo' : 'RILETTO dal venue: ci sono ancora ordini', {
    ok: venueAfter.ok, simulated: venueAfter.simulated, count: venueAfter.count,
    orders: (venueAfter.orders || []).map((o) => ({ orderId: o.orderId, marketId: o.marketId, source: o.source, price: o.price })),
  });

  // ── STEP f — THE CAP GATE AGAIN. This is the real test that the discrepancy is closed. ───────────
  const after = diagnose({ userId, now: now() });
  const capClean = after.readable && Number(after.openNotionalUsd) === 0;
  step('cap-gate-verify', capClean, capClean
    ? 'verifica sul GATE CAP: esposizione aperta $0,00'
    : `verifica sul GATE CAP: esposizione aperta ancora $${Number(after.openNotionalUsd || 0).toFixed(2)}`, {
    openNotionalUsd: after.openNotionalUsd,
    daPosizioniConfermate: after.fromConfirmedPositionsUsd,
    daOrdiniIrrisolti: after.fromUnresolvedOrdersUsd,
    ordiniIrrisoltiRimasti: after.unknowns,
    perche: 'la tabella vuota non basta: se il gate cap non legge $0, il prossimo ordine verrebbe comunque rifiutato',
  });

  const ok = venueClean && capClean && killAfter.effectivelyKilled === false;

  // ── STEP g — ONE audit event carrying every sub-step ─────────────────────────────────────────────
  try {
    audit({
      ts: t0, venue: 'polymarket', source: 'operator-reset', op: 'operator-reset',
      outcome: ok ? 'clean' : 'incomplete',
      by, userId,
      before: { killed: killBefore.effectivelyKilled, venueOrders: venueBefore.count, openNotionalUsd: before.openNotionalUsd, unresolvedUsd: before.fromUnresolvedOrdersUsd, unresolvedCount: before.unknowns.length },
      after: { killed: killAfter.effectivelyKilled, venueOrders: venueAfter.count, openNotionalUsd: after.openNotionalUsd, unresolvedCount: after.unknowns.length },
      cancelled, resolved,
      steps: steps.map((s) => ({ key: s.key, ok: s.ok, label: s.label })),
      latencyMs: now() - t0,
    });
  } catch { /* an audit failure must not change the outcome we already achieved */ }

  return {
    ok, at: new Date(t0).toISOString(), latencyMs: now() - t0,
    steps, before, after, cancelled, resolved,
    killCleared: killAfter.effectivelyKilled === false,
    venueOrdersAfter: venueAfter.count,
    openNotionalAfter: after.openNotionalUsd,
    reason: ok ? null
      : !afterReadable ? 'il venue non è stato riletto: lo stato finale non è dimostrato'
        : !venueClean ? `restano ${venueAfter.count} ordini a riposo sul venue`
          : !capClean ? `il gate cap legge ancora $${Number(after.openNotionalUsd || 0).toFixed(2)} di esposizione aperta${after.unknowns.length ? ` (${after.unknowns.length} ordini inviati non risolvibili senza controllo incrociato)` : ''}`
            : 'il kill-switch non risulta disattivato',
  };
}

/**
 * THE STANDING RECONCILIATION FOR THE MANUAL LANE — what agent35 was never going to do for it.
 *
 * runOperatorReset() above is a BUTTON: it clears the phantoms that have already accumulated. This is the
 * thing that stops them accumulating in the first place, and agent40 calls it on a throttle every cycle.
 * Without it, every hand order that reaches its venue-side expiry leaves a permanent phantom at full
 * notional, and the cap gate slowly refuses orders that nothing real is backing.
 *
 * IT DOES NOTHING, AND COSTS NOTHING, IN THE NORMAL CASE. The first thing it does is a cheap local check:
 * are there any sent orders the ledger has not resolved? Those are two small file reads (~2ms; the
 * execution audit is kilobytes, NOT the 80 MB maker trail). If the answer is no — the steady state — it
 * returns immediately having made ZERO venue calls. Only an actual phantom triggers the network work.
 *
 * IT IS NOT GATED ON THE KILL SWITCH OR ON THE AUTO-REPRICE SWITCHES, deliberately. It places nothing and
 * cancels nothing: it reads the venue and writes resolutions to our own ledger. A killed system is exactly
 * when an operator most needs the cap gate to read the truth, so switching this off with everything else
 * would leave the phantoms in place precisely when they hurt.
 *
 * THE HONESTY RULES ARE THE SAME AS THE BUTTON'S, because it is the same planner:
 *   • the venue order list is read ACCOUNT-WIDE (marketId omitted). This is load-bearing: judging "gone
 *     from the book" against ONE market's orders would mark every order on every OTHER market as vanished,
 *     and — with a trades read that shows no fills — resolve live orders to no-fill. Account-wide or not
 *     at all;
 *   • a no-fill needs the venue reached AND the order absent AND a successful /trades read showing nothing.
 *     A failed trades read means venueFills stays null and nothing is resolved.
 *
 * @returns {{ran:boolean, reason:string, fills:number, nofills:number, stillUnknown:number, checked:number}}
 */
async function reconcileManualLane({ userId = OPERATOR_USER, now = Date.now() } = {}, deps = {}) {
  const listOrders = deps.listOrders || listManualOrders;
  const fetchTrades = deps.fetchVenueTrades || fetchVenueTrades;

  // ── THE CHEAP GATE. Local file reads only; no venue, no network. ──
  const diag = (deps.diagnoseExposure || ((a) => diagnoseExposure(a, deps)))({ userId, now });
  if (!diag.readable) return { ran: false, reason: 'fill-ledger-unreadable', fills: 0, nofills: 0, stillUnknown: 0, checked: 0 };
  if (!diag.unknowns.length) return { ran: false, reason: 'nothing-unresolved', fills: 0, nofills: 0, stillUnknown: 0, checked: 0 };

  const ledger = readFills({ userId }, deps);
  if (!ledger.ok) return { ran: false, reason: 'fill-ledger-unreadable', fills: 0, nofills: 0, stillUnknown: 0, checked: diag.unknowns.length };

  // ── ACCOUNT-WIDE venue read. marketId omitted ON PURPOSE — see the note above. ──
  let venue;
  try { venue = await listOrders({ marketId: null }); }
  catch (e) { return { ran: false, reason: `venue-read-failed: ${e.message}`, fills: 0, nofills: 0, stillUnknown: 0, checked: diag.unknowns.length }; }
  if (!venue || venue.ok === false || venue.simulated === true) {
    return { ran: false, reason: venue && venue.simulated ? 'venue-not-queried (no credentials)' : `venue-read-failed: ${(venue && venue.error) || 'unknown'}`,
      fills: 0, nofills: 0, stillUnknown: 0, checked: diag.unknowns.length };
  }

  const funder = deps.funder || resolveFunder(process.env);
  const address = deps.address || venueAccountAddress(funder, null);
  const trades = await fetchTrades({ address });

  const plan = planReconcile({
    userId,
    sentOrders: diag.sentOrders,
    ledgerRows: ledger.rows,
    venueReachable: true,
    venueOrders: (venue.orders || []).map((o) => ({ id: o.orderId, asset_id: o.tokenId, side: o.side, price: o.price, original_size: o.size, size_matched: o.sizeMatched })),
    venueFills: trades.ok ? trades.trades : null,
    now,
    source: 'agent40-manual-reconcile',
  });
  const applied = applyReconcile(plan, deps);
  return {
    ran: true,
    reason: trades.ok ? 'reconciled against venue truth with the /trades cross-check' : `no cross-check available (${trades.reason}) — vanished orders left UNKNOWN rather than guessed`,
    ...applied,
    checked: diag.unknowns.length,
    resolvedUsd: +(plan.toNoFill.reduce((sum, n) => {
      const o = diag.unknowns.find((u) => u.idempotencyKey === n.idempotencyKey);
      return sum + (o ? Number(o.notionalUsd) || 0 : 0);
    }, 0)).toFixed(2),
  };
}

module.exports = { runOperatorReset, diagnoseExposure, managedMarketIds, fetchVenueTrades, reconcileManualLane };
