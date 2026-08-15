'use strict';
// lib/maker/selezione-stato.js — DOVE VIVE LA SCELTA DEI MERCATI, e chi puo' accenderla.
//
// La decisione e' in `selezione-mercati.js` ed e' pura. Qui c'e' solo la persistenza, separata apposta:
// un modulo che decide e un modulo che scrive sono due cose che si rompono in modi diversi, e mescolarle
// significa non poter provare la prima senza toccare il disco.
//
// ═══ STESSA FORMA DEGLI ALTRI TRE INTERRUTTORI, DELIBERATAMENTE ══════════════════════════════════
// auto-reprice, auto-close e fill-strategy hanno tutti la stessa forma: un file durevole sotto `data/`,
// scritto in modo atomico, con un giornale accanto e il difetto a SPENTO. Questo e' il quarto, e
// somiglia ai primi tre perche' un operatore che ne ha imparato uno li ha imparati tutti.
//
// ⚠ IL DIFETTO E' SPENTO, E IL FILE ILLEGGIBILE VALE SPENTO. La selezione automatica non e' un
// automatismo qualunque: e' l'atto che AUTORIZZA il capitale su un mercato che nessuno ha guardato
// (`mercati.js` lo dice della lista, e questo modulo scrive quella lista da solo). Un file che non si
// legge non puo' autorizzare niente — e' la stessa regola del kill switch, al contrario.
//
// ⚠ NON E' UN SECONDO INTERRUTTORE DI AVVIO. `attiva:true` non fa piazzare niente: servono ancora, e
// indipendentemente, AVVIA (`bot-enabled`), il KILL spento, l'interruttore generale del riprezzo e
// `MAKER_MODE` a mano nel `.env`. Questo decide SU QUALI mercati, non SE.

const path = require('path');
const fs = require('fs');
const { readStore, writeStoreAtomic, DATA_DIR } = require('../safety/store');
const SEL = require('./selezione-mercati');

const STATO_FILE = path.join(DATA_DIR, 'selezione-mercati.json');
const AUDIT_FILE = path.join(DATA_DIR, 'selezione-mercati-audit.jsonl');

/**
 * Lo stato, sempre in forma normalizzata.
 * `leggibile:false` ⇒ il chiamante deve trattarlo come SPENTO e non scrivere niente sopra: riscrivere
 * un file che non si e' riusciti a leggere cancellerebbe la memoria di quali mercati sono in uscita,
 * e con essa la regola «lo slot si libera solo a posizione chiusa».
 */
function leggiStato(deps = {}) {
  const file = deps.statoFile || STATO_FILE;
  const r = readStore(file, SEL.statoVuoto(), deps);
  if (!r.ok) {
    return { leggibile: false, esisteva: null, error: r.error, stato: SEL.statoVuoto(), attiva: false };
  }
  const stato = SEL.normalizzaStato(r.value);
  return { leggibile: true, esisteva: r.existed === true, error: null, stato, attiva: stato.attiva === true };
}

function giornale(rec, deps = {}) {
  const file = deps.auditFile || AUDIT_FILE;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), tsIso: new Date().toISOString(), ...rec }) + '\n');
  } catch { /* un giornale non scritto non deve poter fermare una decisione gia' presa */ }
}

/** Salva lo stato dopo un giro di selezione. Rifiuta su uno stato illeggibile: vedi `leggiStato`. */
function scriviStato(stato, { by, reason } = {}, deps = {}) {
  const file = deps.statoFile || STATO_FILE;
  const attuale = leggiStato(deps);
  if (!attuale.leggibile) {
    return { ok: false, error: `stato della selezione illeggibile (${attuale.error}): non lo si sovrascrive, o si perde la memoria di chi e' in uscita` };
  }
  const nuovo = SEL.normalizzaStato(stato);
  // L'interruttore NON si cambia da qui: lo cambia solo `impostaAttiva`. Un giro di selezione che
  // riscrivesse anche il proprio interruttore potrebbe riaccendersi da solo dopo essere stato spento.
  nuovo.attiva = attuale.stato.attiva === true;
  try {
    writeStoreAtomic(file, { ...nuovo, aggiornatoAlIso: nuovo.aggiornatoAl ? new Date(nuovo.aggiornatoAl).toISOString() : null, by: by || null, reason: reason || null }, deps);
  } catch (e) {
    return { ok: false, error: `stato della selezione non scritto: ${e.message}` };
  }
  return { ok: true, stato: nuovo };
}

/** L'interruttore. L'unica funzione che tocca `attiva`, e ogni passaggio finisce nel giornale. */
function impostaAttiva({ attiva, by, reason } = {}, deps = {}) {
  const file = deps.statoFile || STATO_FILE;
  const attuale = leggiStato(deps);
  if (!attuale.leggibile) {
    return { ok: false, error: `stato della selezione illeggibile (${attuale.error}): non si accende un automatismo sopra uno stato che non si e' letto` };
  }
  const prima = attuale.stato.attiva === true;
  const dopo = attiva === true;
  const nuovo = { ...attuale.stato, attiva: dopo, aggiornatoAl: Date.now() };
  try {
    writeStoreAtomic(file, { ...nuovo, aggiornatoAlIso: new Date(nuovo.aggiornatoAl).toISOString(), by: by || null, reason: reason || null }, deps);
  } catch (e) {
    return { ok: false, error: `interruttore della selezione non scritto: ${e.message}` };
  }
  giornale({ op: 'interruttore', prima, dopo, by: by || null, reason: reason || null,
    selezionati: Object.keys(nuovo.selezionati || {}) }, deps);
  return { ok: true, prima, dopo, stato: nuovo };
}

module.exports = { leggiStato, scriviStato, impostaAttiva, giornale, STATO_FILE, AUDIT_FILE };
