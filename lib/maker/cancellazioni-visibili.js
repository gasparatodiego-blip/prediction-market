'use strict';
// lib/maker/cancellazioni-visibili.js — QUANDO IL MOTORE CANCELLA UN ORDINE, SI DEVE VEDERE.
//
// ═══ IL BUCO CHE CHIUDE ══════════════════════════════════════════════════════════════════════════════
// 6 agosto 2026: alle 12:28:08 il ciclo cancella la gamba YES di Catalina Lauf per «mai primo sul libro».
// Decisione giusta, motivo scritto, tutto regolare — nell'AUDIT, un file da mezzo gigabyte che nessuno
// apre. La dashboard non ne sapeva niente: `grep` su `app/` per `cancelled-top-of-book` dava zero
// occorrenze. L'operatore se n'è accorto guardando l'app di Polymarket, tre ore dopo.
//
// È lo stesso difetto di [[residui-sotto-soglia]] e [[scadenze-senza-rinnovo]], su un terzo caso: la
// DECISIONE era registrata, il suo ESITO non arrivava a nessuna superficie. E questo esito costa —
// è capitale che smette di lavorare, senza che nessuno lo rimetta in gioco.
//
// ═══ IL MOTIVO NON SI RIASSUME ═══════════════════════════════════════════════════════════════════════
// «Ordine cancellato» non è un avviso: è una notifica. Le cancellazioni del motore hanno cause diverse
// che richiedono reazioni diverse, e mescolarle toglie proprio l'informazione per cui vale la pena
// guardare. Quindi ogni voce porta un `motivo` dichiarato dalla lista qui sotto, mai un testo libero:
//
//   mai-primo-sul-libro    il libro si è mosso e l'ordine era diventato il migliore del suo lato
//   gamba-orfana-scaduta   l'altra gamba non è tornata entro la finestra di tolleranza
//   uscita-di-banda        il prezzo è uscito dalla banda premiante e non era riprezzabile
//   blackout-connessione   il venue è stato irraggiungibile oltre la soglia e si è cancellato al rientro
//   altro                  per i casi che nascono dopo questo file: si vede comunque, e si nomina poi
//
// ═══ NON È UN'AZIONE, È UN REFERTO ═══════════════════════════════════════════════════════════════════
// Questo modulo non cancella, non piazza, non rinnova. L'ordine è già cancellato quando la riga viene
// scritta. Lo scrive agent40 e lo legge la dashboard — la stessa superficie dei residui sotto soglia e
// delle scadenze senza rinnovo, per la stessa ragione.

const fs = require('fs');
const path = require('path');
// La stessa risoluzione di `data/` degli altri moduli maker: questo file lo carica agent40 come node
// semplice E la dashboard dentro il bundle di Next, dove `__dirname` è `.next/server/…`.
const { DATA_DIR } = require('../safety/store');

const CANCELLAZIONI_FILE = path.join(DATA_DIR, 'cancellazioni-motore.json');
// Mezz'ora, come per i residui e le scadenze: abbastanza perché chi apre il pannello dopo veda cos'è
// successo, abbastanza poco perché non diventi un archivio.
const RETENTION_MS = 30 * 60_000;

/** I motivi ammessi. Un motivo fuori lista diventa 'altro' invece di entrare come testo libero. */
const MOTIVI = Object.freeze([
  'mai-primo-sul-libro',
  'gamba-orfana-scaduta',
  'uscita-di-banda',
  'blackout-connessione',
  'altro',
]);
function normMotivo(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return MOTIVI.includes(s) ? s : 'altro';
}

/** Etichette leggibili, perché la dashboard non debba tradurre un codice. */
const ETICHETTA = Object.freeze({
  'mai-primo-sul-libro': 'mai primo sul libro',
  'gamba-orfana-scaduta': 'gamba rimasta sola oltre la tolleranza',
  'uscita-di-banda': 'uscito dalla banda premiante',
  'blackout-connessione': 'blackout di connessione al venue',
  altro: 'altro motivo',
});

const vivo = (r, now) => {
  const base = Date.parse((r && r.at) || '');
  if (!Number.isFinite(base)) return false;
  return now - base <= RETENTION_MS;
};

/**
 * Registra le cancellazioni nuove, tenendo quelle ancora dentro la finestra.
 * FONDE per `orderId`: lo stesso ordine non compare due volte anche se il ciclo lo riporta più volte.
 *
 * @param {Array<object>} nuove  {orderId, marketId, marketTitle, book, price, size, notionalUsd, motivo, dettaglio, at}
 */
function registraCancellazioni(nuove, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const file = deps.cancellazioniFile || CANCELLAZIONI_FILE;
  const t = now();
  const precedenti = leggiGrezzo(file).cancellazioni.filter((r) => vivo(r, t));
  const perId = new Map(precedenti.map((r) => [r.orderId, r]));

  for (const r of Array.isArray(nuove) ? nuove : []) {
    if (!r || !r.orderId || perId.has(r.orderId)) continue;
    const motivo = normMotivo(r.motivo);
    perId.set(r.orderId, {
      ...r,
      motivo,
      motivoLeggibile: ETICHETTA[motivo],
      at: r.at || new Date(t).toISOString(),
    });
  }

  const cancellazioni = [...perId.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ at: t, atIso: new Date(t).toISOString(), cancellazioni }, null, 2));
    fs.renameSync(tmp, file);   // atomico: nessun lettore vede mai un file a metà
    return { ok: true, written: true, count: cancellazioni.length, reason: null };
  } catch (e) {
    return { ok: false, written: false, count: 0, reason: e.message };
  }
}

function leggiGrezzo(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { cancellazioni: Array.isArray(d && d.cancellazioni) ? d.cancellazioni : [], at: d && d.at };
  } catch { return { cancellazioni: [], at: null }; }
}

/**
 * Le cancellazioni ancora dentro la finestra. Il filtro è QUI oltre che nello scrittore: se agent40 si
 * ferma, le voci invecchiano lo stesso invece di restare appese per sempre.
 */
function readCancellazioni(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const file = deps.cancellazioniFile || CANCELLAZIONI_FILE;
  const t = now();
  const g = leggiGrezzo(file);
  const cancellazioni = g.cancellazioni.filter((r) => vivo(r, t));
  return {
    leggibile: true,
    at: g.at || null,
    cancellazioni,
    count: cancellazioni.length,
    perMotivo: cancellazioni.reduce((acc, r) => { acc[r.motivo] = (acc[r.motivo] || 0) + 1; return acc; }, {}),
  };
}

module.exports = {
  registraCancellazioni, readCancellazioni,
  CANCELLAZIONI_FILE, RETENTION_MS, MOTIVI, ETICHETTA, normMotivo,
};
