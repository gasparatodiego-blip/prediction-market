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
const { readAutoRepriceConfig, RESTING_GTD_SECONDS, AUTO_REPRICE_SOURCE } = require('./auto-reprice-config');
const { appendMakerAudit } = require('../venues/polymarket-clob-maker/audit');
const { planReconcile, applyReconcile } = require('../safety/reconcile-fills');
const { ordiniNonRisolti } = require('../safety/fills');
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

/**
 * The account's open POSITIONS from the same public, keyless data-api. The SECOND opinion the no-fill
 * conclusion requires, and the one whose absence caused a real fill to be booked as "never filled":
 * /trades lags, /positions does not. Read-only, no credentials, no signing key.
 *
 * Same null-vs-empty contract as the trades read: null means "we could not ask" (and the planner then
 * refuses to conclude anything about a vanished order); an empty array means "we asked and this account
 * holds nothing", which is real evidence.
 */
// ══ IL BACKOFF SU /positions (12 agosto 2026) ═══════════════════════════════════════════════════════
// `data-api /positions` risponde 429 a intermittenza. Un singolo tentativo che fallisce lascia lo
// snapshot fermo, e sopra i 180 s di eta' OGNI piazzamento viene rifiutato: un rate-limit prolungato
// blocca il bot, senza che nulla sia rotto.
//
// ═══ CINQUE TENTATIVI, 1s → 30s, CON JITTER ═════════════════════════════════════════════════════════
// La progressione e' 1·2·4·8·16 s, limitata a 30. Il JITTER (±25%) c'e' per una ragione precisa: agent40
// e ogni altro lettore ripartono dallo stesso istante dopo lo stesso 429, e senza jitter riproverebbero
// TUTTI insieme — che e' il modo di trasformare un rate-limit in un rate-limit permanente.
//
// ⚠ NON SI ALLARGA LA SOGLIA DEI 180 SECONDI, ed e' deliberato: quella non e' un fastidio, e' la
// protezione che impedisce di piazzare su una fotografia vecchia delle posizioni. Il rifiuto per
// snapshot stantio resta identico — arriva solo DOPO che i tentativi sono esauriti, invece che al primo
// singhiozzo.
//
// ═══ 429 E ERRORE GENERICO NON SI CONFONDONO ════════════════════════════════════════════════════════
// Un 429 dice «troppo in fretta» ed e' nostro; un 500 o un timeout dicono che il venue e' in difficolta'.
// Portano entrambi a ritentare, ma nel referto restano distinti — «quante volte siamo stati limitati» e
// «quante volte il venue e' caduto» sono due domande diverse, e con un motivo solo sarebbero la stessa.
const POSIZIONI_TENTATIVI = 5;
const POSIZIONI_BASE_MS = 1_000;
const POSIZIONI_TETTO_MS = 30_000;

/** L'attesa prima del tentativo `n` (1 = il primo ritentativo). Con jitter ±25%, limitata al tetto. */
function attesaPosizioni(n, rnd = Math.random) {
  const base = Math.min(POSIZIONI_TETTO_MS, POSIZIONI_BASE_MS * 2 ** Math.max(0, n - 1));
  const jitter = 1 + (rnd() - 0.5) * 0.5;      // [0.75, 1.25]
  return Math.max(0, Math.min(POSIZIONI_TETTO_MS, Math.round(base * jitter)));
}

/** Come classificare una risposta mancata. `tipo` viaggia nel referto e nel log. */
function classificaPositions(r, err) {
  if (err) {
    const m = String((err && err.message) || err);
    return { tipo: /timeout|ETIMEDOUT|ECONNRESET|socket hang up|network/i.test(m) ? 'rete' : 'errore', dettaglio: m };
  }
  const st = r && r.status;
  if (st === 429) return { tipo: '429', dettaglio: 'rate limit del venue' };
  if (Number.isFinite(st) && st >= 500) return { tipo: '5xx', dettaglio: `il venue ha risposto ${st}` };
  return { tipo: 'errore', dettaglio: `risposta inattesa (${st == null ? 'nessuna' : st})` };
}

async function fetchVenuePositions({ address, httpGet, attendi, rnd, tentativiMax } = {}) {
  const get = httpGet || require('../httpGet').httpGet;
  const sleep = typeof attendi === 'function' ? attendi : ((ms) => new Promise((r) => setTimeout(r, ms)));
  const max = Number.isFinite(tentativiMax) && tentativiMax >= 1 ? tentativiMax : POSIZIONI_TENTATIVI;
  if (!address) return { ok: false, positions: null, reason: 'indirizzo del conto non risolvibile' };

  let ultimo = null;
  for (let n = 1; n <= max; n += 1) {
    let r = null; let err = null;
    try {
      r = await get(`${DATA_API}/positions?user=${address}`, { timeoutMs: TRADES_TIMEOUT_MS, headers: { Accept: 'application/json' } });
    } catch (e) { err = e; }
    if (!err && r && r.status === 200 && Array.isArray(r.data)) {
      return { ok: true, positions: r.data, reason: `data-api /positions: ${r.data.length} posizioni aperte`
        + (n > 1 ? ` (al tentativo ${n} di ${max})` : ''), tentativi: n };
    }
    ultimo = classificaPositions(r, err);
    // Un 200 con un corpo che non e' un array non e' un problema transitorio: e' una risposta che non
    // capiamo, e ritentarla darebbe la stessa risposta. Si esce subito.
    if (!err && r && r.status === 200) {
      return { ok: false, positions: null, tentativi: n, tipo: 'formato',
        reason: 'data-api /positions ha risposto 200 con un corpo che non e\' una lista: non si ritenta, la risposta sarebbe la stessa' };
    }
    if (n < max) await sleep(attesaPosizioni(n, rnd || Math.random));
  }
  return { ok: false, positions: null, tentativi: max, tipo: ultimo ? ultimo.tipo : 'errore',
    reason: `data-api /positions non ha risposto dopo ${max} tentativi con backoff`
      + `${ultimo ? ` — ultimo esito: ${ultimo.tipo} (${ultimo.dettaglio})` : ''}` };
}

/**
 * Order ids THIS SYSTEM cancelled, from our own append-only trail. Used to tell "we cancelled it" apart
 * from "someone else did". Reads the same file the attribution cache reads; kept simple because the set
 * is small and this runs only when there is actually something unresolved.
 */
function cancelledOrderIds() {
  const out = new Set();
  // ── LETTURA INCREMENTALE — QUESTA RIGA TENEVA FERMO L'INTERO BOT ────────────────────────────────
  // Qui c'era `readFileSync(file, 'utf8')` sull'intero giornale, con il commento «kept simple because
  // the set is small». L'insieme e' piccolo; il FILE no. Il 9 agosto 2026 ha raggiunto 731 MB, oltre il
  // tetto di ~512 MB che V8 impone a una stringa: la lettura sollevava, il `catch` restituiva un insieme
  // VUOTO, e un insieme vuoto qui significa «non possiamo dimostrare di aver cancellato niente».
  //
  // Conseguenza misurata: i 56 invii della sera, tutti gia' morti sul venue (scaduti, cancellati o
  // superati), restavano NON RICONCILIATI e venivano contati a pieno nozionale nell'esposizione aperta.
  // $2.406 di esposizione fantasma contro un tetto di $600 e una realta' di ~$127 — quindi ogni
  // piazzamento rifiutato con `limit-max-open-notional`, e il mini-ciclo che calcolava «liberi $0,00»
  // su un conto con $548 liquidi. Il bot si e' fermato per una lettura, non per una regola.
  //
  // Stesso meccanismo di `attribuzione-ordini`, ora estratto in `giornale-incrementale`: si tiene
  // l'offset e si legge solo cio' che e' stato appeso. L'insieme e' accumulativo fra le chiamate, il che
  // su un giornale append-only e' corretto per costruzione; rotazione o troncamento lo ricostruiscono.
  try {
    const file = require('path').join(require('../safety/store').DATA_DIR, 'polymarket-maker-audit.jsonl');
    const { scansiona } = require('./giornale-incrementale');
    return scansiona({
      file, chiave: 'manual-reset:cancellati',
      crea: () => out,
      ingest: (line, acc) => {
        if (!line || line.indexOf('cancel') === -1) return;
        let r; try { r = JSON.parse(line); } catch { return; }
        const isCancel = r.op === 'manual-cancel' || r.op === 'cancelOrder' || r.op === 'manual-replace';
        if (!isCancel) return;
        const id = r.orderId || (r.requested && r.requested.orderId);
        if (id) acc.add(String(id));
      },
    });
  } catch { /* unreadable ⇒ empty set ⇒ we simply cannot claim we cancelled anything */ }
  return out;
}

/**
 * WHY did a vanished order vanish? The ledger only needs "filled / not filled", and planReconcile answers
 * that. But the OPERATOR needs to know whether an order they can no longer see was retired by the venue's
 * own clock, cancelled by this system, or cancelled BY THEM from the Polymarket app — the third case used
 * to look identical to the first two and left a silent gap between the panel and reality.
 *
 * Classified from evidence already in hand, and labelled as a HEURISTIC where it is one:
 *   • our own audit shows a cancel for that order id → cancelled by this system (CERTAIN);
 *   • the order is older than the venue window it was placed with → expired (near-certain: nothing else
 *     retires an order at exactly that age);
 *   • otherwise → cancelled OUTSIDE this system, i.e. by the operator in the app.
 * No extra network call: both inputs are files already read.
 */
function classifyVanished(order, now, cancelledSet, windowSec = RESTING_GTD_SECONDS) {
  const o = order || {};
  if (o.orderId && cancelledSet && cancelledSet.has(String(o.orderId))) {
    return { how: 'cancelled-by-system', certain: true, detail: 'il nostro audit registra una cancellazione per questo orderId' };
  }
  const ageSec = Number.isFinite(o.ts) ? Math.round((now - o.ts) / 1000) : null;
  if (ageSec != null && ageSec >= windowSec) {
    return { how: 'expired', certain: false, detail: `l'ordine ha ${ageSec}s, oltre la finestra di ${windowSec}s con cui era stato piazzato: quasi certamente scaduto da solo` };
  }
  return {
    how: 'cancelled-externally', certain: false,
    detail: `sparito dopo ${ageSec != null ? ageSec + 's' : 'un tempo non leggibile'}, ben prima della scadenza di ${windowSec}s, e senza che questo sistema l'abbia cancellato: cancellazione fatta FUORI dal pannello (tipicamente dall'app Polymarket)`,
  };
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
  // ── LE POSIZIONI DEL VENUE VANNO PASSATE, ALTRIMENTI LA FUSIONE È CODICE MORTO ─────────────────
  // `computeExposure` sa da sempre fondere ledger e venue, ma questa chiamata NON gli passava lo
  // snapshot: qui l'esposizione veniva quindi dal solo ledger locale, che si chiude unicamente se la
  // riconciliazione riesce a scrivere la riga di uscita. Misurato il 12 agosto 2026: **$16.960,06 su
  // 14 posizioni** che al venue NON esistevano — 26 volte il tetto di $600, quindi ogni gamba di ogni
  // giro veniva saltata e il bot non poteva piazzare niente.
  // Lo snapshot si legge oltre `MAX_AGE_MS` come NON leggibile, quindi passarlo non introduce nessun
  // dato stantio: o è fresco, o `computeExposure` lo ignora e si comporta come prima.
  const posVenue = deps.venuePositions !== undefined
    ? deps.venuePositions
    : (() => { try { return require('../safety/venue-positions-snapshot').readVenuePositions(); } catch { return null; } })();
  const exp = computeExposure({ userId, now, sentOrders, venuePositions: posVenue }, deps);
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
  const posRes = await (deps.fetchVenuePositions || fetchVenuePositions)({ address });
  step('positions-crosscheck', posRes.ok, 'controllo incrociato sulle POSIZIONI reali (seconda fonte indipendente)', {
    ok: posRes.ok, count: posRes.positions ? posRes.positions.length : null, reason: posRes.reason,
    perche: '/trades e\' in ritardo rispetto a /positions: il 2026-07-31 un ordine eseguito e\' stato registrato come NON eseguito perche\' le esecuzioni non erano ancora visibili mentre la posizione lo era. Servono due fonti concordi.',
  });
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
      venuePositions: posRes.ok ? posRes.positions : null,
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

  const ledger = readFills({ userId }, deps);
  if (!ledger.ok) return { ran: false, reason: 'fill-ledger-unreadable', fills: 0, nofills: 0, stillUnknown: 0, checked: 0 };

  // ── IL CANCELLO ECONOMICO — E LA RIGA CHE LO TENEVA CHIUSO PER SEMPRE ──────────────────────────
  // Qui c'era `if (!diag.unknowns.length) return 'nothing-unresolved'`. `diagnoseExposure` prende
  // `unknowns` da `computeExposure`, che dal 2 agosto 2026 lo restituisce VUOTO PER COSTRUZIONE — su
  // richiesta esplicita dell'operatore, che aveva tolto il conteggio anticipato degli ordini non
  // riconciliati DALL'ESPOSIZIONE. Scelta legittima e ancora in vigore; ma questo cancello leggeva
  // quella lista per una domanda diversa, e con la lista sempre vuota usciva SEMPRE.
  //
  // Effetto: la riconciliazione automatica di agent40 non ha piu' girato dal 2 agosto, e senza lasciare
  // traccia — agent40 logga solo quando qualcosa e' stato risolto, e qui non si risolveva mai niente.
  // Gli unici fill finiti nel ledger da allora li ha scritti `runOperatorReset`, cioe' i reset che
  // l'operatore lancia a mano dal pannello.
  //
  // Misurato il 10 agosto 2026: 1.826 ordini inviati, **1.294 senza nessuna riga nel ledger**, e
  // `unknowns.length === 0`. Otto ore di attivita' reale con ZERO fill registrati.
  //
  // Adesso il cancello chiede al LEDGER, che e' la fonte giusta per «questo ordine e' stato risolto?».
  // `computeExposure` non e' stata toccata: `unknowns` resta vuoto e l'esposizione continua a contare
  // solo cio' che e' riconciliato.
  const daRisolvere = ordiniNonRisolti(diag.sentOrders, ledger.rows);
  if (!daRisolvere.length) return { ran: false, reason: 'nothing-unresolved', fills: 0, nofills: 0, stillUnknown: 0, checked: 0 };

  // ── ACCOUNT-WIDE venue read. marketId omitted ON PURPOSE — see the note above. ──
  let venue;
  try { venue = await listOrders({ marketId: null }); }
  catch (e) { return { ran: false, reason: `venue-read-failed: ${e.message}`, fills: 0, nofills: 0, stillUnknown: 0, checked: daRisolvere.length }; }
  if (!venue || venue.ok === false || venue.simulated === true) {
    return { ran: false, reason: venue && venue.simulated ? 'venue-not-queried (no credentials)' : `venue-read-failed: ${(venue && venue.error) || 'unknown'}`,
      fills: 0, nofills: 0, stillUnknown: 0, checked: daRisolvere.length };
  }

  const funder = deps.funder || resolveFunder(process.env);
  const address = deps.address || venueAccountAddress(funder, null);
  const trades = await fetchTrades({ address });
  const positions = await (deps.fetchVenuePositions || fetchVenuePositions)({ address });

  const plan = planReconcile({
    userId,
    sentOrders: diag.sentOrders,
    ledgerRows: ledger.rows,
    venueReachable: true,
    venueOrders: (venue.orders || []).map((o) => ({ id: o.orderId, asset_id: o.tokenId, side: o.side, price: o.price, original_size: o.size, size_matched: o.sizeMatched })),
    venueFills: trades.ok ? trades.trades : null,
    venuePositions: positions.ok ? positions.positions : null,
    now,
    source: 'agent40-manual-reconcile',
  });
  const applied = applyReconcile(plan, deps);

  // Audit one line per vanished order, saying WHICH of the three things happened. The panel reads the
  // trail; without this an externally-cancelled order simply stopped existing with no record anywhere.
  const vanished = [];
  for (const n of plan.toNoFill) {
    const order = diag.sentOrders.find((o) => o.idempotencyKey === n.idempotencyKey) || {};
    const c = classifyVanished(order, now, (deps.cancelledByUs instanceof Set) ? deps.cancelledByUs : cancelledOrderIds());
    vanished.push({ idempotencyKey: n.idempotencyKey, orderId: order.orderId || null, how: c.how, certain: c.certain, detail: c.detail, notionalUsd: order.notionalUsd ?? null });
    try {
      (deps.audit || appendMakerAudit)({
        ts: now, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'order-vanished',
        outcome: c.how, certain: c.certain, orderId: order.orderId || null,
        idempotencyKey: n.idempotencyKey, reason: c.detail,
        marketRef: order.tokenId ? `token_${String(order.tokenId).slice(0, 12)}` : null,
      });
    } catch { /* audit is best-effort; the ledger resolution above already happened */ }
  }

  return {
    ran: true,
    vanished,
    externallyCancelled: vanished.filter((v) => v.how === 'cancelled-externally').length,
    reason: (trades.ok && positions.ok)
      ? 'reconciled against venue truth, with BOTH the /trades and /positions cross-checks'
      : `cross-check incomplete (trades: ${trades.reason}; positions: ${positions.reason}) — vanished orders left UNKNOWN rather than guessed`,
    ...applied,
    // `diag.unknowns` e' vuoto per costruzione (vedi il cancello sopra): il conto di cosa e' stato
    // esaminato e quanto valeva viene dagli ordini NON RISOLTI secondo il ledger, che e' la stessa
    // lista su cui la riconciliazione ha appena lavorato.
    checked: daRisolvere.length,
    resolvedUsd: +(plan.toNoFill.reduce((sum, n) => {
      const o = daRisolvere.find((u) => u.idempotencyKey === n.idempotencyKey);
      return sum + (o ? Number(o.notionalUsd) || 0 : 0);
    }, 0)).toFixed(2),
  };
}

module.exports = { attesaPosizioni, classificaPositions, POSIZIONI_TENTATIVI, POSIZIONI_TETTO_MS, runOperatorReset, diagnoseExposure, managedMarketIds, fetchVenueTrades, fetchVenuePositions, reconcileManualLane };
