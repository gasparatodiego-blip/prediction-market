'use strict';
// mm-tracking-config — CHI HA IL TRACKING ATTIVO, E CON QUALI PARAMETRI.
//
// Un mercato in questo file significa: «il motore puo' piazzare e riprezzare ordini REALI qui, in
// automatico, senza chiedermelo ordine per ordine». E' l'unica deroga alla doppia conferma che esista
// in questo progetto, ed e' per questo che vive in un file suo, con un audit suo, e non come un campo
// dentro una configurazione che serve ad altro.
//
// FALLIRE CHIUSO, SEMPRE. File assente, illeggibile, JSON rotto, campo mancante ⇒ NESSUN mercato in
// tracking. L'unico errore che questo modulo puo' commettere e' spegnere qualcosa che era acceso; non
// puo' mai accendere qualcosa che nessuno ha acceso.
//
// OGNI SCRITTURA E' TRACCIATA in data/maker-mm-tracking-audit.jsonl, append-only, con chi e perche'.
// Un motore che piazza da solo deve poter rispondere alla domanda «da quando, e chi lo ha detto».

const path = require('path');
const { readStore, writeStoreAtomic, DATA_DIR } = require('../safety/store');
const fs = require('fs');

const STATE_FILE = path.join(DATA_DIR, 'maker-mm-tracking.json');
const AUDIT_FILE = path.join(DATA_DIR, 'maker-mm-tracking-audit.jsonl');
const EMPTY = { markets: {} };

// ── I LIMITI DEI PARAMETRI ──────────────────────────────────────────────────────────────────────────
// Non sono preferenze: sono il confine oltre il quale un valore smette di descrivere un market maker.
//   offset  ≤ 0        → i due lati si incrociano o stanno sul mid: non e' quotare, e' attraversare.
//   offset  > 45¢      → su un mercato binario porta un lato oltre l'estremo del libro.
//   soglia  ≤ 0        → riprezzerebbe a ogni tick di rumore, cioe' di continuo.
//   size    ≤ 0        → niente da piazzare.
const LIMITS = {
  offsetCents: { min: 0.1, max: 45 },
  minMoveCents: { min: 0.1, max: 25 },
  sizeShares: { min: 1, max: 100_000 },
};

// ── QUALI LATI QUOTA IL MOTORE ──────────────────────────────────────────────────────────────────────
// 'both' quota entrambi i libri (il comportamento di sempre), 'yes' e 'no' un lato solo.
//
// UN LATO SOLO NON MATURA REWARD, e va detto qui perche' e' la conseguenza meno ovvia di questa scelta:
// il punteggio del programma premi prende il MINIMO fra i due lati (Q_min), quindi un mercato quotato da
// una parte sola vale zero per i premi, per quanto bene sia quotato. Resta uno strumento legittimo —
// esposizione direzionale, accumulo su un lato — ma non e' market making che matura, e chi lo accende
// deve saperlo prima, non scoprirlo a fine giornata guardando un totale a zero.
const SIDES = Object.freeze(['both', 'yes', 'no']);
const DEFAULT_SIDES = 'both';

/**
 * Il lato dichiarato da un record, oppure il default.
 *
 * ASSENTE E SBAGLIATO NON SONO LA STESSA COSA, e questa e' l'unica ragione per cui questa funzione
 * distingue due esiti invece di normalizzare tutto a 'both':
 *   · ASSENTE ⇒ 'both'. E' un record scritto prima che questo campo esistesse, e prima di allora il
 *     motore quotava entrambi i lati. Leggerlo come 'both' e' l'unica lettura che NON cambia il
 *     comportamento di un mercato gia' configurato, che e' esattamente quello che si vuole.
 *   · PRESENTE MA NON RICONOSCIUTO ⇒ invalido, e il record viene ESCLUSO a monte come per un parametro
 *     numerico fuori limite. Qualcuno ha scritto qualcosa di preciso e non lo capiamo: sceglierne uno
 *     al posto suo significherebbe quotare un lato che non ha chiesto.
 */
function readSides(raw) {
  if (raw === undefined || raw === null) return { ok: true, sides: DEFAULT_SIDES, defaulted: true };
  if (typeof raw === 'string' && SIDES.includes(raw)) return { ok: true, sides: raw, defaulted: false };
  return { ok: false, sides: null, defaulted: false, reason: `sides = ${JSON.stringify(raw)} non riconosciuto (ammessi: ${SIDES.join(', ')})` };
}

const normId = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const isConditionId = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v.trim());
const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/** Un parametro valido, o null con il motivo. Mai un valore di ripiego: un default silenzioso qui
 *  significherebbe piazzare ordini veri con numeri che nessuno ha scelto. */
function checkParam(name, value) {
  const lim = LIMITS[name];
  if (!lim) return { ok: false, reason: `parametro sconosciuto: ${name}` };
  if (!fin(value)) return { ok: false, reason: `${name} deve essere un numero` };
  if (value < lim.min || value > lim.max) {
    return { ok: false, reason: `${name} = ${value} fuori dall'intervallo ammesso ${lim.min}–${lim.max}` };
  }
  return { ok: true, reason: null };
}

/** writeStoreAtomic restituisce `{written:true}` e LANCIA in caso di guaio: non ha un campo `ok`.
 *  Controllarlo come se ce l'avesse faceva fallire ogni scrittura con un errore vuoto. */
function writeState(file, value, deps) {
  try {
    const w = writeStoreAtomic(file, value, deps);
    return w && w.written === true ? { ok: true, error: null } : { ok: false, error: 'scrittura non confermata' };
  } catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
}

function auditAppend(rec, deps = {}) {
  const file = deps.auditFile || AUDIT_FILE;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: new Date(deps.now || Date.now()).toISOString(), ...rec }) + '\n');
  } catch { /* l'audit non deve poter impedire uno SPEGNIMENTO */ }
}

/**
 * Lo stato per intero. `readable:false` ⇒ zero mercati, e il motivo viaggia con la risposta: chi legge
 * deve poter distinguere «nessun mercato in tracking» da «non ho potuto leggere», che sono due fatti
 * diversi e in questo progetto non indossano mai gli stessi panni.
 */
function readTrackingConfig(deps = {}) {
  const file = deps.stateFile || STATE_FILE;
  const r = readStore(file, EMPTY, deps);
  if (!r.ok) {
    return { readable: false, error: r.error, markets: {}, marketIds: [], stateFile: file };
  }
  const st = (r.value && typeof r.value === 'object') ? r.value : EMPTY;
  const raw = (st.markets && typeof st.markets === 'object') ? st.markets : {};
  const markets = {};
  for (const [id, rec] of Object.entries(raw)) {
    if (!isConditionId(id) || !rec || typeof rec !== 'object') continue;
    if (rec.enabled !== true) continue;              // solo l'ON esplicito conta
    // Un record con un parametro fuori limite NON viene corretto: viene ESCLUSO. Correggerlo
    // significherebbe quotare con un numero che l'operatore non ha scelto.
    const bad = ['offsetCents', 'minMoveCents', 'sizeShares']
      .map((k) => ({ k, v: checkParam(k, rec[k]) }))
      .find((x) => !x.v.ok);
    if (bad) continue;
    // Stessa regola dei parametri numerici: un lato dichiarato e non riconosciuto ESCLUDE il record,
    // non viene ricondotto a 'both'. Un campo assente invece e' un record d'epoca precedente e vale
    // 'both', che e' il comportamento che quel record ha sempre avuto.
    const sd = readSides(rec.sides);
    if (!sd.ok) continue;
    markets[normId(id)] = {
      marketId: normId(id),
      enabled: true,
      offsetCents: rec.offsetCents,
      minMoveCents: rec.minMoveCents,
      sizeShares: rec.sizeShares,
      sides: sd.sides,
      /** true ⇒ il record non dichiarava un lato: e' un record scritto prima che il campo esistesse. */
      sidesDefaulted: sd.defaulted,
      at: fin(rec.at) ? rec.at : null,
      atIso: typeof rec.atIso === 'string' ? rec.atIso : null,
      by: typeof rec.by === 'string' ? rec.by : null,
      reason: typeof rec.reason === 'string' ? rec.reason : null,
    };
  }
  return { readable: true, error: null, markets, marketIds: Object.keys(markets), stateFile: file };
}

/** I soli id in tracking. La forma che serve a chi deve escluderli da un'altra corsia. */
function trackedMarketIds(deps = {}) {
  const c = readTrackingConfig(deps);
  return c.readable ? c.marketIds : [];
}

/** La configurazione di UN mercato, o null. */
function trackingFor(marketId, deps = {}) {
  const c = readTrackingConfig(deps);
  if (!c.readable) return null;
  return c.markets[normId(marketId)] || null;
}

/**
 * ACCENDE il tracking su un mercato. Ogni parametro e' obbligatorio e validato: qui non esistono
 * default, perche' un default significherebbe piazzare ordini reali con numeri che nessuno ha scelto.
 */
function setTracking({ marketId, enabled, offsetCents, minMoveCents, sizeShares, sides, by, reason }, deps = {}) {
  const id = normId(marketId);
  if (!isConditionId(marketId)) return { ok: false, error: 'marketId non valido (atteso 0x + 64 esadecimali)' };
  const file = deps.stateFile || STATE_FILE;
  const now = deps.now || Date.now();

  const cur = readStore(file, EMPTY, deps);
  // Uno SPEGNIMENTO deve riuscire anche su uno stato illeggibile: e' la direzione sicura, e non poterlo
  // fare sarebbe il difetto peggiore che questo file possa avere.
  if (!cur.ok && enabled !== false) {
    return { ok: false, error: `stato del tracking non leggibile (${cur.error}) — non accendo nulla su uno stato che non so leggere` };
  }
  const st = (cur.ok && cur.value && typeof cur.value === 'object') ? cur.value : EMPTY;
  const markets = (st.markets && typeof st.markets === 'object') ? { ...st.markets } : {};

  if (enabled === false) {
    const had = !!markets[id];
    delete markets[id];
    const w = writeState(file, { ...st, markets }, deps);
    if (!w.ok) return { ok: false, error: w.error };
    auditAppend({ event: 'tracking-off', marketId: id, was: had, by: by || null, reason: reason || null }, deps);
    return { ok: true, error: null, enabled: false, was: had, record: null };
  }

  for (const [k, v] of [['offsetCents', offsetCents], ['minMoveCents', minMoveCents], ['sizeShares', sizeShares]]) {
    const c = checkParam(k, v);
    if (!c.ok) return { ok: false, error: c.reason };
  }
  // Omettere `sides` e' permesso e vale 'both' — la stessa lettura che ricevono i record scritti prima
  // che il campo esistesse, quindi un chiamante che non lo conosce ottiene il comportamento di sempre.
  // Un valore SBAGLIATO invece rifiuta: e' diverso da non averlo detto.
  const sd = readSides(sides);
  if (!sd.ok) return { ok: false, error: sd.reason };

  // Cosa c'era prima, per poter dire in audit se il lato e' CAMBIATO. Un cambio di lato su un tracking
  // gia' acceso lascia ordini orfani sul lato ritirato, ed e' un fatto che deve essere ritrovabile.
  const prev = markets[id] && markets[id].enabled === true ? readSides(markets[id].sides) : null;
  const prevSides = prev && prev.ok ? prev.sides : null;

  const record = {
    enabled: true,
    offsetCents, minMoveCents, sizeShares,
    sides: sd.sides,
    at: now, atIso: new Date(now).toISOString(),
    by: by || 'operatore',
    reason: reason || null,
  };
  markets[id] = record;
  const w = writeState(file, { ...st, markets }, deps);
  if (!w.ok) return { ok: false, error: w.error };
  auditAppend({
    event: 'tracking-on', marketId: id, offsetCents, minMoveCents, sizeShares,
    sides: sd.sides, prevSides, sidesChanged: prevSides != null && prevSides !== sd.sides,
    by: by || 'operatore', reason: reason || null,
  }, deps);
  return { ok: true, error: null, enabled: true, record, prevSides };
}

/** I lati che il motore deve davvero quotare, dalla configurazione di un mercato. Una sola definizione,
 *  cosi' il motore, la route e il pannello non possono darne tre interpretazioni. */
function activeSides(sides) {
  const sd = readSides(sides);
  const v = sd.ok ? sd.sides : DEFAULT_SIDES;
  return v === 'both' ? ['yes', 'no'] : [v];
}

module.exports = {
  STATE_FILE, AUDIT_FILE, LIMITS, SIDES, DEFAULT_SIDES,
  readTrackingConfig, trackedMarketIds, trackingFor, setTracking, checkParam, isConditionId,
  readSides, activeSides,
};
