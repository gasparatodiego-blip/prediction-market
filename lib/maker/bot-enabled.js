'use strict';
// lib/maker/bot-enabled.js — L'INTERRUTTORE AVVIA/FERMA DEL BOT.
//
// ═══ COSA SIGNIFICA, ESATTAMENTE ═════════════════════════════════════════════════════════════════════
// Questo flag È LA CONFERMA ESPLICITA DELL'OPERATORE. Finché è false nessun piazzamento automatico
// parte, e il primo ordine reale del riallocatore nascerà dal gesto di premere AVVIA sulla dashboard —
// non da un file di configurazione, non da una variabile d'ambiente, non da un riavvio.
//
// Accenderlo NON scavalca niente: ogni piazzamento continua a passare da TUTTE le regole del motore
// (le cinque di motore-unico, il tetto di mercato, il pavimento di profondità, il kill, i cap per
// ordine, la validità al venue). Il flag aggiunge un cancello, non ne toglie nessuno.
//
// ═══ AVVIA / FERMA NON È IL KILL, E LA DIFFERENZA È OPERATIVA ════════════════════════════════════════
//   FERMA (questo flag a false)  ferma i NUOVI piazzamenti e le rotazioni. Le posizioni già aperte
//                                restano gestite: auto-close, riprezzatura, rinnovi continuano. È
//                                l'interruttore di tutti i giorni.
//   KILL (lib/safety/kill-switch) resta separato, invariato e ASSOLUTO: cancella tutto al venue,
//                                pre-esistenti compresi, e blocca ogni corsia. È l'emergenza.
// Chi preme FERMA vuole smettere di aprire; chi preme KILL vuole smettere e basta. Confonderli
// significherebbe o lasciare posizioni scoperte per un fermo di routine, o non avere più un'emergenza.
//
// ═══ FAIL CLOSED, SEMPRE ═════════════════════════════════════════════════════════════════════════════
// File assente, illeggibile, JSON rotto, campo di tipo sbagliato ⇒ **fermo**. «Non ho potuto leggere»
// non è «vai»: il ripiego di un interruttore che autorizza spesa reale è l'unica direzione difendibile.
// Solo un `enabled: true` letto senza ambiguità accende.

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../safety/store');
const { atomicWriteJson } = require('../atomicJsonWrite');

const FILE = path.join(DATA_DIR, 'maker-bot-enabled.json');

// ── LA RAMPA ────────────────────────────────────────────────────────────────────────────────────────
// Nelle prime ore dopo un AVVIA il bot non apre a pieno regime. Non è prudenza generica: è che il primo
// giorno è l'unico in cui nessuno ha ancora visto il motore operare da solo con capitale vero, e cinque
// mercati sono abbastanza per accorgersi che qualcosa non va restando piccoli. Il conteggio è sui
// mercati DISTINTI aperti dall'ultimo AVVIA, non sugli ordini: due gambe sullo stesso mercato sono un
// mercato solo.
const RAMPA_ORE = 24;
const RAMPA_MAX_MERCATI = 5;

function ora() { return Date.now(); }

function vuoto() {
  return { v: 1, enabled: false, at: null, atIso: null, by: null, reason: null, mercatiDallAvvio: [] };
}

/**
 * Lo stato dell'interruttore. Non solleva MAI: qualunque problema di lettura è `enabled:false` con il
 * motivo, perché chi chiama deve poter decidere senza try/catch e la risposta prudente è già quella.
 */
function statoBot({ file = FILE } = {}) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    const mai = !fs.existsSync(file);
    return { ...vuoto(), leggibile: mai, motivo: mai ? 'mai avviato: il flag non è mai stato scritto' : `flag illeggibile (${e.message}) — fermo per prudenza` };
  }
  if (!raw || typeof raw !== 'object' || typeof raw.enabled !== 'boolean') {
    return { ...vuoto(), leggibile: false, motivo: 'flag malformato (enabled non è un booleano) — fermo per prudenza' };
  }
  return {
    v: 1,
    enabled: raw.enabled === true,
    at: Number.isFinite(raw.at) ? raw.at : null,
    atIso: raw.atIso || null,
    by: raw.by || null,
    reason: raw.reason || null,
    mercatiDallAvvio: Array.isArray(raw.mercatiDallAvvio) ? raw.mercatiDallAvvio.filter((x) => x && typeof x === 'object') : [],
    leggibile: true,
    motivo: null,
  };
}

/** Il bot può aprire posizioni nuove adesso? Una riga sola, perché la leggano tutti allo stesso modo. */
function botAttivo({ file = FILE } = {}) {
  return statoBot({ file }).enabled === true;
}

/**
 * Commuta l'interruttore. Accendere AZZERA il conteggio della rampa: un AVVIA è sempre un ripartire da
 * zero, altrimenti riaccendere dopo una settimana erediterebbe i mercati di allora e la rampa non
 * proteggerebbe più niente.
 */
function impostaBot({ enabled, by = 'operatore', reason = null, file = FILE, now = ora() } = {}) {
  if (typeof enabled !== 'boolean') return { ok: false, motivo: 'enabled deve essere un booleano esplicito' };
  const prima = statoBot({ file });
  const stato = {
    v: 1, enabled, at: now, atIso: new Date(now).toISOString(), by, reason,
    // Spegnendo si conserva l'elenco: serve a leggere il registro dopo, e alla prossima accensione
    // viene comunque azzerato.
    mercatiDallAvvio: enabled ? [] : prima.mercatiDallAvvio,
  };
  try { atomicWriteJson(file, stato, { pretty: true }); }
  catch (e) { return { ok: false, motivo: `flag non scritto (${e.message}): l'interruttore NON è cambiato` }; }
  return { ok: true, prima: prima.enabled, ora: enabled, stato };
}

/**
 * LA RAMPA. Quanti mercati nuovi restano aperti nelle prime `RAMPA_ORE` dall'ultimo AVVIA.
 *
 * Fuori dalla finestra la rampa non limita più niente e lo dice. Dentro, il residuo è
 * `RAMPA_MAX_MERCATI` meno i mercati distinti già aperti da quell'AVVIA.
 */
function rampa({ file = FILE, now = ora() } = {}) {
  const s = statoBot({ file });
  if (!s.enabled) return { attiva: false, residuo: 0, aperti: 0, motivo: 'bot fermo' };
  if (!Number.isFinite(s.at)) return { attiva: true, residuo: 0, aperti: 0, motivo: 'istante di avvio non leggibile — rampa chiusa per prudenza' };
  const scadenza = s.at + RAMPA_ORE * 3_600_000;
  const distinti = new Set(s.mercatiDallAvvio.map((m) => String(m.marketId || '').toLowerCase()).filter(Boolean));
  if (now >= scadenza) {
    return { attiva: false, residuo: Infinity, aperti: distinti.size, scadenza,
      motivo: `rampa conclusa: sono passate più di ${RAMPA_ORE}h dall'avvio` };
  }
  const residuo = Math.max(0, RAMPA_MAX_MERCATI - distinti.size);
  return {
    attiva: true, residuo, aperti: distinti.size, scadenza,
    oreRimaste: +((scadenza - now) / 3_600_000).toFixed(2),
    motivo: residuo > 0
      ? `rampa: ${distinti.size}/${RAMPA_MAX_MERCATI} mercati aperti nelle prime ${RAMPA_ORE}h, ne restano ${residuo}`
      : `rampa: raggiunti i ${RAMPA_MAX_MERCATI} mercati delle prime ${RAMPA_ORE}h — nessun mercato nuovo fino alle ${new Date(scadenza).toISOString()}`,
  };
}

/**
 * Registra un mercato aperto dal bot, per il conteggio della rampa. Idempotente sul marketId: due
 * gambe sullo stesso mercato non consumano due posti.
 */
function registraMercatoAperto({ marketId, file = FILE, now = ora() } = {}) {
  const id = String(marketId || '').trim();
  if (!id) return { ok: false, motivo: 'marketId assente' };
  const s = statoBot({ file });
  if (!s.enabled) return { ok: false, motivo: 'bot fermo: non si registra niente' };
  if (s.mercatiDallAvvio.some((m) => String(m.marketId || '').toLowerCase() === id.toLowerCase())) {
    return { ok: true, giaPresente: true, aperti: new Set(s.mercatiDallAvvio.map((m) => String(m.marketId).toLowerCase())).size };
  }
  const stato = {
    v: 1, enabled: s.enabled, at: s.at, atIso: s.atIso, by: s.by, reason: s.reason,
    mercatiDallAvvio: [...s.mercatiDallAvvio, { marketId: id, at: now, atIso: new Date(now).toISOString() }],
  };
  try { atomicWriteJson(file, stato, { pretty: true }); }
  catch (e) { return { ok: false, motivo: `registro rampa non scritto (${e.message})` }; }
  return { ok: true, giaPresente: false, aperti: stato.mercatiDallAvvio.length };
}

module.exports = {
  statoBot, botAttivo, impostaBot, rampa, registraMercatoAperto,
  FILE, RAMPA_ORE, RAMPA_MAX_MERCATI,
};
