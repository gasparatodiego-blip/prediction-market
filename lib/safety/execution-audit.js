'use strict';
// lib/safety/execution-audit.js — the APPEND-ONLY audit trail for every order placed on a user's behalf.
// Venue-agnostic. Its purpose is answering "what did the bot do with my money on Tuesday" — so it is
// queryable per user and per time range, and it is reconstructable AFTER the fact.
//
// APPEND-ONLY. Never update-in-place, never delete. A correction is a NEW row referencing the original.
//
// INTENT-BEFORE-SEND + IDEMPOTENCY (the money-safety core):
//   • recordIntent writes the INTENT row (with a caller-stable idempotency key) BEFORE the venue call.
//     If the intent cannot be durably recorded, the caller MUST refuse to place — no evidence, no order.
//   • A crash between send and response therefore ALWAYS leaves an intent row: the classic way to lose
//     money silently is to log only successes.
//   • recordIntent is the idempotency guard: if an intent already exists for this key it returns
//     { recorded:false, duplicate:true } and the caller must NOT place — the same key never places twice,
//     even on a retry after an ambiguous timeout.
//   • recordOutcome writes the OUTCOME row after the venue responds (or throws), referencing the key.
//
// REDACTION: every row passes through the shared redact() (the maker adapter's redactor) — API keys,
// private keys, signatures, and any inline secret value are blanked. Only counts / ids / prices survive.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { redact } = require('../venues/polymarket-clob/redact');
const { DATA_DIR } = require('./store');

const AUDIT_FILE = path.join(DATA_DIR, 'execution-audit.jsonl');

function cfg(deps) {
  return { auditFile: deps.auditFile || AUDIT_FILE, now: deps.now || (() => Date.now()), fs: deps.fs || fs };
}

// Deterministic idempotency key from the order identity, when the caller does not supply one. A retry of
// the SAME intended order produces the SAME key (so it dedups); a re-quote at a new price is a new order
// and a new key. Callers that need cross-price dedup must pass an explicit idempotencyKey.
function deriveIdempotencyKey({ userId, venue, tokenId, side, price, size }) {
  const h = crypto.createHash('sha256')
    .update([userId, venue, tokenId, side, price, size].map(String).join('|'))
    .digest('hex').slice(0, 24);
  return `idem_${h}`;
}

// Scan the append-only trail for an existing INTENT row with this key. The file is the single source of
// truth (not an in-memory index that a restart would lose). O(n) scan — fine at this scale; documented.
function hasIntent(idempotencyKey, deps = {}) {
  const c = cfg(deps);
  let raw;
  try { raw = c.fs.readFileSync(c.auditFile, 'utf8'); }
  catch (e) { if (e && e.code === 'ENOENT') return false; throw e; } // unreadable (non-ENOENT) → throw → caller fails closed
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.indexOf(idempotencyKey) === -1) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row && row.kind === 'intent' && row.idempotencyKey === idempotencyKey) return true;
  }
  return false;
}

// ── A CANCELLED ORDER MUST NOT BURN ITS KEY FOREVER ─────────────────────────────────────────────────
// The economic key above is deterministic on purpose: the same intended order dedups against itself. But
// it has no notion of an order having DIED, and the ledger never knew what a cancel was. So once a leg
// was placed and then cancelled, that exact (token, side, price, size) became unplaceable for good — the
// caller was refused AFTER having already cancelled, and the freed capital had nowhere to go.
//
// Measured on 8 August 2026: the 6h reset placed BUY YES 61.2 @ 0.34 on the HIMS market; two minutes
// later the stale-mid guard cancelled it ("il capitale liberato torna al trigger, che lo rimette al
// lavoro"); the idle-capital trigger then re-proposed the identical leg every ten minutes and was
// refused every time. $608 sat idle against a 90% target.
//
// THE SHAPE OF THE FIX IS NOT NEW — it is the one lib/maker/manual-order.js:1475-1484 already applies to
// replacements: a placement that supersedes a DEAD order is a different order and deserves a different
// key, derived from the id of the order it supersedes. Two attempts that supersede the SAME dead order
// still collide with each other, so the anti-double-send property survives intact.
// ── QUANTO PUÒ ESSERE LUNGA UNA CATENA DI SOSTITUZIONI ──────────────────────────────────────────────
// Era 64, ed era TROPPO POCO: misurato il 9 agosto 2026 alle 08:10, la gamba di uscita su Dallas
// (SELL 39,7 @ 0,54) aveva una catena di ESATTAMENTE 64 anelli — cioè murata contro il tetto. Il
// riposizionamento legittimo del punto 54 la calcolava, la trovava dentro banda e sopra il carico, e
// veniva rifiutato con «catena di sostituzioni oltre 64 anelli».
//
// PERCHÉ CRESCE COSÌ IN FRETTA, e non è un difetto: un'uscita a riposo viene ricancellata e ripiazzata
// a ogni giro di auto-close (~65 s) quando il mid si muove. Ogni sostituzione consuma un anello, quindi
// la catena cresce di circa **un anello al minuto** su una gamba che il mercato tiene viva. 64 anelli
// sono poco più di un'ora: qualunque posizione che duri mezza giornata li esaurisce.
//
// PERCHÉ 20.000 E NON UN NUMERO PIÙ GRANDE. Il tetto non protegge dal costo — un anello è uno sha256 e
// una lettura di Map, e 20.000 anelli si percorrono in **~80 ms**, misurato dal test — ma da un giornale
// corrotto che farebbe girare a vuoto per sempre. 20.000 sono circa **due settimane** di ricambio
// continuo, il che sposta il problema da «ore» a «mai, nella vita utile di una posizione».
//
// IL CONFINE UTILE È 19.999, non 20.000: il ciclo spende un'iterazione per ogni anello TROVATO e gliene
// serve una in più per accertare che la coda sia libera, quindi una catena lunga esattamente quanto il
// tetto viene ancora rifiutata. È il verso giusto in cui sbagliare, ma va scritto invece che scoperto.
//
// COSA NON CAMBIA, ED È IL PUNTO: superare il tetto continua a RIFIUTARE. Il tetto non è la protezione
// anti-doppio-invio — quella è la verifica che l'ordine precedente sia MORTO sul venue, e resta intatta
// a ogni singolo anello. Alzare il tetto non rende ripiazzabile niente che prima non lo fosse: rende
// solo raggiungibile la fine di una catena che era diventata troppo lunga per essere percorsa.
//
// LA RISPOSTA DUREVOLE NON È UN NUMERO PIÙ GRANDE, e va detto: è la rotazione del giornale (o un indice
// della coda per chiave economica), così la catena riparte invece di allungarsi all'infinito. Non è
// stata fatta qui perché tocca il formato del giornale, che è la fonte di verità dell'idempotenza.
const MAX_CATENA = 20_000;

function chiaveDopoOrdineMorto(idempotencyKey, orderIdMorto) {
  const h = crypto.createHash('sha256')
    .update([idempotencyKey, String(orderIdMorto)].join('|'))
    .digest('hex').slice(0, 20);
  return `idem_dopo_${h}`;
}

/** Every row of the trail, parsed once. Unparseable lines are skipped, never guessed at. */
function leggiRighe(deps = {}) {
  const c = cfg(deps);
  let raw;
  try { raw = c.fs.readFileSync(c.auditFile, 'utf8'); }
  catch (e) { if (e && e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    out.push(row);
  }
  return out;
}

/**
 * Can this duplicate be superseded, because the order it collides with is provably gone from the venue?
 *
 * THE VERDICT ON LIFE IS NOT TAKEN HERE. This module knows the ledger, not the venue: the caller passes
 * `vivi`, the set of order ids the venue currently reports as resting. That keeps the rule testable
 * without a network and keeps venue knowledge out of the audit trail.
 *
 * FAILS CLOSED IN EVERY DIRECTION THAT MATTERS. No set (the read failed, or was simulated) ⇒ not
 * superseded. An outcome without an order id ⇒ not superseded: an ambiguous send may be resting under an
 * id we never saw, and that is exactly the case the idempotency guard exists for. Only a positive
 * "this id is NOT among the venue's open orders" releases the key.
 *
 * @param {Set<string>|null} vivi order ids the venue reports open right now
 * @returns {{superabile: boolean, chiave: string|null, motivo: string}}
 */
function risolviDuplicato(idempotencyKey, { vivi = null } = {}, deps = {}) {
  if (!(vivi instanceof Set)) {
    return { superabile: false, chiave: null,
      motivo: 'gli ordini vivi sul venue non sono accertati: un duplicato non si supera su un dato che non si e letto' };
  }
  const righe = leggiRighe(deps);
  const intenti = new Set();
  const esiti = new Map();   // ultimo esito per chiave: il file e in ordine cronologico, quindi vince l ultimo
  for (const r of righe) {
    if (!r || !r.idempotencyKey) continue;
    if (r.kind === 'intent') intenti.add(r.idempotencyKey);
    else if (r.kind === 'outcome') esiti.set(r.idempotencyKey, r);
  }
  let chiave = idempotencyKey;
  for (let i = 0; i < MAX_CATENA; i++) {
    if (!intenti.has(chiave)) {
      return { superabile: true, chiave,
        motivo: i === 0 ? 'nessun intent per questa chiave' : `l ordine precedente non e piu sul venue: si piazza sotto una chiave che lo supera (${i} anello/i)` };
    }
    const esito = esiti.get(chiave);
    const orderId = esito && esito.ok === true && esito.orderId != null ? String(esito.orderId) : null;
    if (!orderId) {
      return { superabile: false, chiave: null,
        motivo: 'l intent precedente non ha un esito con orderId: l invio resta ambiguo e l ordine potrebbe essere a riposo' };
    }
    if (vivi.has(orderId)) {
      return { superabile: false, chiave: null,
        motivo: `l ordine ${orderId.slice(0, 12)}… e ancora VIVO sul venue: questo sarebbe un doppio invio` };
    }
    chiave = chiaveDopoOrdineMorto(chiave, orderId);
  }
  return { superabile: false, chiave: null,
    motivo: `catena di sostituzioni oltre ${MAX_CATENA} anelli: si rifiuta invece di continuare a cercare`
      + ' — a questo punto il giornale va ruotato, non il tetto alzato di nuovo' };
}

function append(row, deps = {}) {
  const c = cfg(deps);
  c.fs.mkdirSync(path.dirname(c.auditFile), { recursive: true });
  // Synchronous append — the intent must be on disk before the venue call returns. Throws on failure so
  // the caller can refuse to place (no durable intent ⇒ no order).
  c.fs.appendFileSync(c.auditFile, JSON.stringify(redact(row)) + '\n');
}

/**
 * Record an INTENT row iff no intent exists for this key. THROWS if it cannot durably write (caller must
 * treat a throw as "do not place"). Returns { recorded, duplicate, idempotencyKey, row }.
 *
 * intent fields: { idempotencyKey?, userId, venue, market, side, price, size, notionalUsd, decision,
 *                  gates, mode }  — decision = what the engine believed (signal/strategy); gates = the
 *                  gate results that were evaluated.
 */
function recordIntent(intent, deps = {}) {
  const c = cfg(deps);
  const key = intent.idempotencyKey || deriveIdempotencyKey(intent);
  if (hasIntent(key, deps)) return { recorded: false, duplicate: true, idempotencyKey: key };
  const row = {
    kind: 'intent',
    ts: c.now(),
    idempotencyKey: key,
    userId: intent.userId || null,
    venue: intent.venue || null,
    market: intent.market || null,
    side: intent.side || null,
    price: intent.price != null ? intent.price : null,
    size: intent.size != null ? intent.size : null,
    notionalUsd: intent.notionalUsd != null ? intent.notionalUsd : null,
    decision: intent.decision != null ? intent.decision : null, // engine belief: signal/strategy/what it thought
    gates: intent.gates != null ? intent.gates : null,          // which gates were evaluated + their results
    mode: intent.mode || null,
    // ── DUE FATTI CHE VENIVANO CALCOLATI E BUTTATI VIA (12 agosto 2026) ─────────────────────────
    // `inCoda` e' cosa ha deciso la regola «mai primo sul libro» (quale prezzo, contro quale
    // concorrente, se saremmo finiti in cima); `priceAdjusted` e' SE e DI QUANTO il prezzo scritto
    // dall'operatore e' stato spostato prima di partire. Entrambi arrivavano fino al giornale maker
    // ma NON a questo registro, che e' quello su cui si ricostruisce cosa e' successo a un ordine.
    //
    // CAMPI PROPRI E NON DENTRO `decision`: `decision` e' «cosa credeva il motore», ed e' testo
    // libero per costruzione. Questi due sono fatti misurati sull'ordine esatto, e devono poter
    // essere contati — «quante volte la politica della coda ha spostato un prezzo» e' una domanda
    // che si risponde con un `grep`, non leggendo prosa.
    //
    // ASSENTI ⇒ `null`, non un oggetto vuoto: un chiamante che non li calcola (l'uscita automatica,
    // il riprezzo) non deve sembrare uno che li ha calcolati e non ha trovato niente.
    inCoda: intent.inCoda != null ? intent.inCoda : null,
    priceAdjusted: intent.priceAdjusted != null ? intent.priceAdjusted : null,
  };
  append(row, deps);
  return { recorded: true, duplicate: false, idempotencyKey: key, row };
}

/**
 * Record the OUTCOME row after the venue responds or throws. References the intent's idempotency key.
 * outcome: { idempotencyKey, userId, venue, market, ok, orderId, response, error }
 */
function recordOutcome(outcome, deps = {}) {
  const c = cfg(deps);
  const row = {
    kind: 'outcome',
    ts: c.now(),
    idempotencyKey: outcome.idempotencyKey || null,
    userId: outcome.userId || null,
    venue: outcome.venue || null,
    market: outcome.market || null,
    ok: outcome.ok === true,
    orderId: outcome.orderId != null ? outcome.orderId : null,
    response: outcome.response != null ? outcome.response : null,
    error: outcome.error != null ? outcome.error : null,
  };
  try { append(row, deps); return { recorded: true }; }
  catch (_e) { return { recorded: false }; } // an outcome-write failure must not mask the (already sent) order
}

/**
 * Query the trail per user and time range — this is what makes the trail auditable after the fact.
 * @returns rows (intent + outcome) for userId within [fromTs, toTs].
 */
function queryByUser({ userId, fromTs = 0, toTs = Infinity }, deps = {}) {
  const c = cfg(deps);
  let raw;
  try { raw = c.fs.readFileSync(c.auditFile, 'utf8'); }
  catch (e) { if (e && e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (userId && row.userId !== userId) continue;
    if (row.ts < fromTs || row.ts > toTs) continue;
    out.push(row);
  }
  return out;
}

module.exports = { recordIntent, recordOutcome, hasIntent, queryByUser, deriveIdempotencyKey,
  risolviDuplicato, chiaveDopoOrdineMorto, MAX_CATENA, AUDIT_FILE };
