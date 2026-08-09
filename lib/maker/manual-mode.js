'use strict';
// lib/maker/manual-mode.js — the PER-MARKET "the operator holds this market by hand" flag.
//
// WHAT IT IS FOR. Più corsie raggiungono lo stesso venue con le stesse credenziali. Senza un proprietario
// dichiarato per mercato si pestano i piedi: qualcuno piazza a mano una quota, un'altra corsia vede un
// ordine che non ha pianificato e lo cancella. Questo flag è la dichiarazione di proprietà — per UN
// mercato per volta dice «qui guida questa corsia, le altre stiano ferme».
//
// NOTA STORICA (9 agosto 2026): il motore automatico agent35-maker, che è il processo per cui questo
// flag era nato, è stato rimosso. Il flag NON è morto con lui — è il gate 1 dell'imbuto manuale e il
// prerequisito che agent40 richiede per gestire un mercato (uscita automatica, riprezzo, tracking):
// il riallocatore lo prende su ogni mercato che apre. Cambia il lettore, non il criterio.
//
// WHAT IT IS NOT. It is NOT the kill switch. It does not stop the engine anywhere else, it does not
// disarm, it does not touch data/safety-kill-switch.json, and clearing it re-enables nothing that was not
// already enabled. The global kill remains the one control that stops everything; this one is a scalpel.
//
// SHAPE, and why it is a file under data/ rather than an env var:
//   • DURABLE — un riavvio pm2 non deve restituire in silenzio un mercato su cui ci sono ordini a
//     riposo. An env var dies with the process; this does not.
//   • READ LIVE at the decision point — chi decide lo rilegge a ogni ciclo, quindi prendere un mercato
//     in gestione vale dal giro dopo senza un riavvio. A control that needs a deploy is not a control.
//   • AUDITED — every set/clear appends a who/when/why line to data/maker-manual-mode-audit.jsonl.
//   • It is tracked exactly like the other critical states (kill switch, market caps): same
//     lib/safety/store durable+atomic reader/writer, same fail-closed contract, same data/ directory.
//
// FAIL CLOSED — IN BOTH DIRECTIONS. If the state cannot be read (corrupt JSON, permission error) we do
// NOT know who owns a market. Both sides then refuse:
//   • chi consulta il flag tratta OGNI mercato come in gestione altrui e non piazza/cancella niente
//     (isManualMarket → manual:true);
//   • the manual endpoints refuse too, because they require readable:true before placing.
// So an unreadable ownership file means nobody places — never "both place". An ABSENT file is a readable
// state meaning "no market is manual", exactly as store.readStore distinguishes absent from unreadable.

const path = require('path');
const { readStore, writeStoreAtomic, DATA_DIR } = require('../safety/store');

const STATE_FILE = path.join(DATA_DIR, 'maker-manual-mode.json');
const AUDIT_FILE = path.join(DATA_DIR, 'maker-manual-mode-audit.jsonl');
const EMPTY = Object.freeze({ markets: {} });

function cfg(deps) {
  return {
    stateFile: deps.stateFile || STATE_FILE,
    auditFile: deps.auditFile || AUDIT_FILE,
    now: deps.now || (() => Date.now()),
    fs: deps.fs || require('fs'),
  };
}

function normId(marketId) {
  return typeof marketId === 'string' ? marketId.trim().toLowerCase() : '';
}

/**
 * Read the whole ownership map. Never throws.
 * @returns {{readable:boolean, error:(string|null), markets:object, marketIds:string[], stateFile:string}}
 */
function readManualMode(deps = {}) {
  const c = cfg(deps);
  const r = readStore(c.stateFile, EMPTY, deps);
  if (!r.ok) return { readable: false, error: r.error, markets: {}, marketIds: [], stateFile: c.stateFile };
  const st = (r.value && typeof r.value === 'object') ? r.value : EMPTY;
  const markets = (st.markets && typeof st.markets === 'object') ? st.markets : {};
  const marketIds = Object.keys(markets).filter((k) => markets[k] && markets[k].manual === true);
  return { readable: true, error: null, markets, marketIds, stateFile: c.stateFile };
}

/**
 * THE DECISION POINT. Is this ONE market under manual control?
 *
 * FAIL CLOSED: an unreadable state answers manual:true with readable:false. agent35 reads `manual` and
 * stands off; the manual endpoints read `readable` and also refuse. Neither side may place on a market
 * whose owner it could not determine.
 *
 * @returns {{manual:boolean, readable:boolean, error:(string|null), record:(object|null), reason:string}}
 */
function isManualMarket(marketId, deps = {}) {
  const st = readManualMode(deps);
  if (!st.readable) {
    return {
      manual: true, readable: false, error: st.error, record: null,
      reason: `manual-mode state ${st.error} — failing CLOSED (treating EVERY market as manual: the engine stands off and the manual panel refuses, because ownership could not be read)`,
    };
  }
  const id = normId(marketId);
  if (!id) return { manual: false, readable: true, error: null, record: null, reason: 'no marketId supplied' };
  const rec = st.markets[id] || null;
  const manual = !!(rec && rec.manual === true);
  return {
    manual, readable: true, error: null, record: rec,
    reason: manual
      ? `manual mode is ACTIVE on ${id}${rec.reason ? ` — ${rec.reason}` : ''}`
      : `manual mode is not active on ${id} — the engine owns this market`,
  };
}

function appendManualAudit(rec, c) {
  try {
    c.fs.mkdirSync(path.dirname(c.auditFile), { recursive: true });
    c.fs.appendFileSync(c.auditFile, JSON.stringify(rec) + '\n');
  } catch (_e) { /* best-effort: an audit-write failure must never stop the flag from being set */ }
}

/**
 * Take a market manual (manual=true) or hand it back to the engine (manual=false). Audited.
 *
 * Read-modify-write on a FRESH object (readStore may hand back the frozen EMPTY singleton). We write even
 * when the prior state was unreadable IF we are SETTING manual — taking a market away from the engine is
 * the safe direction and must always succeed. CLEARING (handing back to the engine) on an unreadable
 * state is REFUSED: that would hand control to the engine on the strength of a state we cannot read.
 *
 * @returns {{ok:boolean, error?:string, marketId:string, manual:boolean, record?:object}}
 */
function setManualMode({ marketId, manual, by = null, reason = null }, deps = {}) {
  const c = cfg(deps);
  const id = normId(marketId);
  if (!id) return { ok: false, error: 'marketId required', marketId: '', manual: false };
  if (typeof manual !== 'boolean') return { ok: false, error: 'manual must be a boolean', marketId: id, manual: false };

  const r = readStore(c.stateFile, EMPTY, deps);
  if (!r.ok && manual === false) {
    return {
      ok: false, marketId: id, manual: false,
      error: `manual-mode state ${r.error} — refusing to hand ${id} back to the engine while ownership is unreadable (fix the file first; taking a market MANUAL is still permitted)`,
    };
  }
  const base = (r.ok && r.value) ? r.value : {};
  const st = { markets: { ...((base.markets && typeof base.markets === 'object') ? base.markets : {}) } };
  const at = c.now();
  const record = { manual, at, atIso: new Date(at).toISOString(), by, reason };
  st.markets[id] = record;
  st.updatedAt = at;
  writeStoreAtomic(c.stateFile, st, deps);
  appendManualAudit({ ts: at, event: manual ? 'manual-mode-on' : 'manual-mode-off', marketId: id, by, reason }, c);
  return { ok: true, marketId: id, manual, record };
}

// ── LE DUE DECISIONI, ESTRATTE DAL MOTORE. Vivono qui e non dentro un agent, così un selfcheck può
//    provarle senza avviare niente. Le chiamava agent35-maker, rimosso il 9 agosto 2026: oggi nessun
//    processo le invoca: restano l'espressione canonica del criterio di proprietà, per la corsia che un
//    domani debba applicarlo. Il gate vivo sul piazzamento è `isManualMarket`, interrogato dall'imbuto
//    della corsia manuale prima di qualunque invio.
//    ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Il gate di piazzamento per UN mercato. Returns the human-readable block reason, or null to proceed.
 * The string deliberately contains "manual mode active, skip" — that phrase is what the operator greps
 * for in the process logs to prove the isolation is real.
 */
function placementBlockReason(marketId, deps = {}) {
  const m = isManualMarket(marketId, deps);
  if (!m.manual) return null;
  return m.readable
    ? 'manual mode active, skip — the operator holds this market by hand (data/maker-manual-mode.json)'
    : `manual mode active, skip — ownership unreadable (${m.error}), failing closed for every market`;
}

/**
 * Il gate di cancellazione. Un mercato in gestione va ESCLUSO dalle spazzate di routine di un motore
 * (uscita dall'universo, stand-down) — quelle esistono per ripulire gli ordini DEL MOTORE, e
 * cancelMarketOrders is indiscriminate: it would wipe the operator's hand-placed orders too.
 *
 * DELIBERATE SCOPE. This filters ROUTINE sweeps only. The operator's KILL (POST /api/maker/kill
 * → lib/maker/cancel-all, the cancel-only adapter) is untouched and still cancels EVERYTHING on every
 * market, manual included. The panic button must never have an exception; a housekeeping sweep must.
 *
 * @returns {{allowed:string[], skipped:string[], readable:boolean}}
 */
function filterCancelTargets(marketIds, deps = {}) {
  const list = Array.isArray(marketIds) ? marketIds : [];
  const st = readManualMode(deps);
  if (!st.readable) return { allowed: [], skipped: list.slice(), readable: false };
  const manualSet = new Set(st.marketIds);
  const allowed = [], skipped = [];
  for (const id of list) (manualSet.has(normId(id)) ? skipped : allowed).push(id);
  return { allowed, skipped, readable: true };
}

module.exports = {
  readManualMode, isManualMarket, setManualMode, placementBlockReason, filterCancelTargets,
  STATE_FILE, AUDIT_FILE,
};
