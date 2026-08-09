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

// ── IL REGISTRO DELLE APERTURE — ERA UNA RAMPA, ORA È SOLO UN REGISTRO ──────────────────────────────
// Fino al 9 agosto 2026 qui viveva un TETTO: 5 mercati nuovi nelle prime 24 ore dall'AVVIA. Era la
// cautela del primo giorno, e come cautela del primo giorno ha funzionato. Come regola permanente no,
// e la misura lo ha mostrato senza ambiguità: l'8 agosto i cinque posti si sono consumati in trentadue
// minuti (22:43 → 23:15), poi ogni ordine è stato cancellato o riempito, e il conto è rimasto con
// $644,39 liquidi e ZERO ordini a riposo — utilizzo 3,9% contro un obiettivo del 90% — con il trigger
// che ogni dieci minuti ricalcolava un piano valido e lo buttava via per «rampa esaurita». Il tetto
// avrebbe continuato a mordere per altre diciotto ore.
//
// Il difetto non è il numero: è la FORMA. Un contatore giornaliero misura il tempo passato dall'AVVIA,
// che non è una proprietà del rischio. Cinque mercati aperti e subito richiusi consumavano la quota
// esattamente come cinque mercati ancora vivi — cioè il tetto contava le aperture invece del capitale
// esposto, e restava chiuso proprio nel momento in cui il capitale tornava tutto libero.
//
// Al suo posto c'è un vincolo CONTINUO, in `lib/maker/utilizzo-capitale.aperturaNuoviMercati`: si
// aprono mercati nuovi finché l'utilizzo sta sotto l'obiettivo, mai più di N per giro. Si chiude da sé
// quando il capitale è al lavoro e si riapre da sé quando torna libero, senza aspettare un calendario.
//
// Quello che resta QUI è il registro, e resta per due ragioni: è la memoria di cosa ha aperto il bot da
// quando è stato acceso (utile a leggere l'audit), e la sua scrittura è già stata resa sicura rispetto
// a un FERMA premuto nel frattempo. Non limita più niente.

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
 * Commuta l'interruttore. Accendere AZZERA il registro delle aperture: un AVVIA è sempre un ripartire
 * da zero, altrimenti riaccendere dopo una settimana erediterebbe i mercati di allora e il registro
 * racconterebbe una sessione che non è quella in corso.
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
 * IL REGISTRO DELLE APERTURE dall'ultimo AVVIA. **Osservazione, non limite** — non esiste più un
 * residuo da consumare, e questa funzione non può far fallire l'apertura di niente.
 *
 * Chi deve decidere quanti mercati nuovi si possono aprire adesso chiama
 * `utilizzo-capitale.aperturaNuoviMercati`, che guarda l'utilizzo del capitale e non il calendario.
 */
function apertureDallAvvio({ file = FILE, now = ora() } = {}) {
  const s = statoBot({ file });
  if (!s.enabled) return { aperti: 0, mercati: [], dallAvvio: null, dallAvvioIso: null, oreDallAvvio: null, motivo: 'bot fermo' };
  const distinti = [...new Set(s.mercatiDallAvvio.map((m) => String(m.marketId || '').toLowerCase()).filter(Boolean))];
  const ore = Number.isFinite(s.at) ? +((now - s.at) / 3_600_000).toFixed(2) : null;
  return {
    aperti: distinti.length,
    mercati: distinti,
    dallAvvio: Number.isFinite(s.at) ? s.at : null,
    dallAvvioIso: s.atIso,
    oreDallAvvio: ore,
    motivo: `${distinti.length} mercat${distinti.length === 1 ? 'o' : 'i'} apert${distinti.length === 1 ? 'o' : 'i'} dall'AVVIA`
      + (ore != null ? ` di ${ore}h fa` : '')
      + ' — nessun tetto giornaliero: l\'apertura è governata dall\'obiettivo di utilizzo del capitale',
  };
}

/**
 * Registra un mercato aperto dal bot. Idempotente sul marketId: due gambe sullo stesso mercato sono
 * un mercato solo. Da quando il tetto giornaliero è stato rimosso questo conteggio non decide più
 * niente — è memoria, e serve a leggere l'audit.
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
  // ── QUESTA FUNZIONE RISCRIVE L'INTERRUTTORE, NON SOLO IL CONTATORE ───────────────────────────────
  // Il file è uno solo: per aggiungere un mercato al registro delle aperture bisogna riscrivere anche
  // `enabled`. Fra la lettura di poche righe sopra e la scrittura qui c'è una finestra in cui
  // l'operatore può aver premuto FERMA — e riscrivere lo stato letto prima la ANNULLEREBBE, cioè un
  // contatore riaccenderebbe il bot. Non è ipotetico d'ora in poi: dall'8 agosto 2026 il mini-ciclo
  // chiama questa funzione a ogni mercato aperto, mentre prima non la chiamava nessuno.
  //
  // La rilettura chiude la finestra: se l'istante dell'interruttore è cambiato, qualcuno lo ha toccato
  // e questa scrittura non parte. Si perde una riga di registro — che si recupera al giro dopo — e
  // non si perde un FERMA, che non si recupera affatto. I due errori non costano uguale.
  const controllo = statoBot({ file });
  if (controllo.at !== s.at || controllo.enabled !== s.enabled) {
    return { ok: false, motivo: 'l\'interruttore è cambiato mentre si registrava l\'apertura: non lo si sovrascrive' };
  }
  try { atomicWriteJson(file, stato, { pretty: true }); }
  catch (e) { return { ok: false, motivo: `registro aperture non scritto (${e.message})` }; }
  return { ok: true, giaPresente: false, aperti: stato.mercatiDallAvvio.length };
}

module.exports = {
  statoBot, botAttivo, impostaBot, apertureDallAvvio, registraMercatoAperto,
  FILE,
};
