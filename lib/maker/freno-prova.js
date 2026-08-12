'use strict';
// lib/maker/freno-prova.js — IL FRENO DI PROVA DI agent41, CHE FINO A OGGI NON ESISTEVA.
//
// ═══ COSA C'ERA PRIMA: NIENTE ══════════════════════════════════════════════════════════════════════
// `REALLOC_SCHEDULER_DRY_RUN=1` è nell'ambiente del processo agent41 dal 7 agosto 2026. Per due giorni
// l'operatore ha creduto che agent41 fosse «in prova». **Non lo era**: verificato con `grep` su tutto
// il repo, quella variabile non era letta da NESSUNA riga di codice — solo commenti storici, test che
// ne vietano il ritorno, e il rilevatore D4 dell'audit, che esiste proprio per segnalare i flag che
// nessuno legge più e che cita questo caso come esempio. Il flag era decorativo, e chi ispezionava
// l'ambiente ne deduceva un comportamento che non esisteva.
//
// Da oggi il freno è vero: quando è inserito, agent41 CALCOLA il piano per intero, lo registra e lo
// espone al pannello, e **non manda nessun ordine al venue**.
//
// ═══ FAIL-CLOSED, E LA CONSEGUENZA VA DETTA ═══════════════════════════════════════════════════════
// Assente, vuoto, illeggibile o ambiguo ⇒ **freno INSERITO**, cioè non si piazza. La conseguenza è
// grossa e deliberata: **il difetto del sistema diventa «non piazzare»**. Per far piazzare agent41
// bisogna dichiararlo esplicitamente con uno dei valori di spegnimento riconosciuti — non basta più
// togliere la variabile, e non basta scriverci dentro qualcosa a caso.
// È la direzione giusta per questo specifico flag: il suo unico difetto storico è stato far credere a
// una persona che il capitale fosse al sicuro quando non lo era.
//
// ═══ QUESTO NON SOSTITUISCE KILL E FERMA ══════════════════════════════════════════════════════════
// È un TERZO presidio, non un rimpiazzo. KILL ferma ogni percorso della flotta, FERMA governa se il
// bot apre posizioni da sé, questo dice se agent41 è in prova. Sono ortogonali, e il freno è il più
// stretto dei tre perché vale anche a bot AVVIATO e a kill spento.
//
// Run dei test: node lib/maker/freno-prova.test.js

const FLAG = 'REALLOC_SCHEDULER_DRY_RUN';

/** I soli valori che SPENGONO il freno. Tutto il resto lo lascia inserito. */
const SPENTO = Object.freeze(['0', 'false', 'off', 'no', 'spento']);
/** Riconosciuti come «inserito» — elencati per poterlo dire nel motivo, non per decidere. */
const INSERITO = Object.freeze(['1', 'true', 'on', 'yes', 'acceso']);

/**
 * Lo stato del freno.
 *
 * @param {object} [env] l'ambiente da leggere (difetto `process.env`)
 * @returns {{attivo:boolean, valore:string|null, riconosciuto:boolean, motivo:string}}
 *          `attivo:true` ⇒ NON si piazza.
 */
function statoFreno(env = process.env) {
  let grezzo;
  try { grezzo = env ? env[FLAG] : undefined; }
  catch { return { attivo: true, valore: null, riconosciuto: false, motivo: `ambiente illeggibile: freno INSERITO per sicurezza` }; }

  if (grezzo === undefined || grezzo === null) {
    return { attivo: true, valore: null, riconosciuto: false,
      motivo: `${FLAG} assente: freno INSERITO (fail-closed). Per piazzare serve ${FLAG}=0` };
  }
  const v = String(grezzo).trim().toLowerCase();
  if (v === '') {
    return { attivo: true, valore: '', riconosciuto: false,
      motivo: `${FLAG} vuoto: freno INSERITO (fail-closed)` };
  }
  if (SPENTO.includes(v)) {
    return { attivo: false, valore: v, riconosciuto: true,
      motivo: `${FLAG}=${v}: freno DISINSERITO — agent41 può inviare ordini al venue` };
  }
  if (INSERITO.includes(v)) {
    return { attivo: true, valore: v, riconosciuto: true,
      motivo: `${FLAG}=${v}: freno INSERITO — il piano si calcola, nessun ordine parte` };
  }
  return { attivo: true, valore: v, riconosciuto: false,
    motivo: `${FLAG}=${v} non riconosciuto: freno INSERITO (fail-closed). Valori di spegnimento: ${SPENTO.join(', ')}` };
}

/** La riga da scrivere nel log d'avvio e a ogni giro: una persona deve capirlo senza aprire il codice. */
function rigaLog(s = statoFreno()) {
  return s.attivo
    ? `🧪 FRENO DI PROVA INSERITO — il piano si calcola e si registra, NESSUN ordine raggiunge il venue. ${s.motivo}`
    : `🔴 FRENO DI PROVA DISINSERITO — agent41 può piazzare con capitale reale. ${s.motivo}`;
}

module.exports = { statoFreno, rigaLog, FLAG, SPENTO, INSERITO };
