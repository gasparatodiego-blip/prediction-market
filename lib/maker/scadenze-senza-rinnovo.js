'use strict';
// lib/maker/scadenze-senza-rinnovo.js — GLI ORDINI CHE MUOIONO DI SCADENZA, DOVE SI VEDONO.
//
// ═══ IL PROBLEMA CHE RISOLVE ═════════════════════════════════════════════════════════════════════════
// Il 5 agosto 2026 le due gambe di Eric Barlow sono morte così: alle 20:40:44 il tetto orario è stato
// toccato, dalle ~20:59:34 il rinnovo proattivo della scadenza era dovuto e non è mai partito, alle
// ~21:02:34 la GTD è scaduta, alle 21:03:09 gli ordini non erano più al venue. L'audit conteneva 21
// riprezzi e 540 skip identiche; della MORTE, niente. Nessuna cancellazione, nessun fill, nessun evento.
//
// È lo stesso buco di [[residui-sotto-soglia]] su un caso diverso: la DECISIONE era registrata, il suo
// ESITO no. E l'esito è la parte che costa — due gambe da 39$ e 20$ smettono di maturare premi, il
// capitale torna libero, e nessuno lo sa, quindi nessuno lo rimette in gioco.
//
// ═══ COSA FA QUESTO MODULO, E COSA NON FA ═══════════════════════════════════════════════════════════
// Deposita l'avviso dove la dashboard lo può leggere, e basta. Non piazza, non cancella, non rinnova:
// l'ordine è già morto quando questo file viene scritto. È un referto, non un'azione.
//
// ═══ PERCHÉ UN FILE E NON UNA RIGA DI LOG ═══════════════════════════════════════════════════════════
// Perché la riga di log c'era già, cinquecentoquaranta volte, e non ha avvisato nessuno. Un avviso che
// per essere visto pretende che qualcuno stia guardando i log di un processo non è un avviso. Questo file
// lo scrive agent40-manual-reprice e lo legge `/api/maker/wallet-status`, che lo porta nel pannello
// «Stato wallet e piazzamento» — la stessa superficie dei residui sotto soglia, e per la stessa ragione:
// è lì che si guarda prima di rimettere capitale in gioco.
//
// ═══ LA DEDUPLICA, E DOVE VIVE ══════════════════════════════════════════════════════════════════════
// Una volta per ordine. In memoria il ciclo dimentica l'ordine appena lo dichiara morto (un id non viene
// mai riusato), e qui la fusione per `orderId` regge il caso che quella memoria non copre: un riavvio di
// agent40 fra la morte e la lettura del pannello. Stesso pattern di residui-sotto-soglia.
//
// ═══ LA FINESTRA DI VISIBILITÀ ══════════════════════════════════════════════════════════════════════
// Una morte è un fatto passato: si conta da quando è avvenuta, non da una scadenza futura. Mezz'ora,
// come per i residui — abbastanza perché chi apre il pannello dopo pranzo veda cos'è successo, abbastanza
// poco perché il pannello non diventi un archivio. Il filtro è nel LETTORE oltre che nello scrittore: se
// il processo che scrive si ferma, le voci invecchiano lo stesso invece di restare appese lì per sempre.

const fs = require('fs');
const path = require('path');
// La stessa risoluzione di `data/` usata dagli altri moduli maker, e per lo stesso motivo: questo file lo
// carica agent40 come node semplice E la dashboard dentro il bundle di Next, e un
// `path.join(__dirname, '..', '..')` darebbe due cartelle diverse.
const { DATA_DIR } = require('../safety/store');

const SCADENZE_FILE = path.join(DATA_DIR, 'scadenze-senza-rinnovo.json');
const RETENTION_MS = 30 * 60_000;

// Si conta dall'istante in cui l'avviso è nato, cioè dal ciclo che ha constatato l'assenza dell'ordine.
// Senza una data leggibile la voce non è tenibile: una riga che non sa quando è nata non deve poter
// restare eterna.
const vivo = (r, now) => {
  const base = Date.parse((r && r.at) || '');
  if (!Number.isFinite(base)) return false;
  return now - base <= RETENTION_MS;
};

/**
 * Registra le morti nuove, tenendo quelle ancora dentro la finestra di visibilità.
 *
 * FONDE, non sovrascrive: la deduplica per `orderId` vive qui oltre che nella memoria del processo.
 *
 * @param {Array<object>} nuovi  eventi `scaduto-senza-rinnovo` prodotti dal ciclo di auto-reprice
 * @returns {{ok:boolean, written:boolean, count:number, reason:(string|null)}}
 */
function registraScadenzeSenzaRinnovo(nuovi, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const file = deps.scadenzeFile || SCADENZE_FILE;
  const t = now();
  const precedenti = leggiGrezzo(file).scadenze.filter((r) => vivo(r, t));
  const perId = new Map(precedenti.map((r) => [r.orderId, r]));
  for (const r of Array.isArray(nuovi) ? nuovi : []) {
    if (!r || !r.orderId || perId.has(r.orderId)) continue;
    perId.set(r.orderId, r);
  }
  const scadenze = [...perId.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ at: t, atIso: new Date(t).toISOString(), scadenze }, null, 2));
    fs.renameSync(tmp, file);   // atomico: nessun lettore vede mai un file a metà
    return { ok: true, written: true, count: scadenze.length, reason: null };
  } catch (e) {
    return { ok: false, written: false, count: scadenze.length, reason: e.message };
  }
}

function leggiGrezzo(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { at: Number(raw && raw.at), scadenze: Array.isArray(raw && raw.scadenze) ? raw.scadenze : [] };
  } catch {
    return { at: NaN, scadenze: [] };
  }
}

/**
 * Le morti da mostrare adesso.
 *
 * Un file assente NON è un errore: significa che nessun ordine gestito è morto di scadenza, che è lo
 * stato normale e desiderato. Questo è un avviso, non un gate: la sua assenza non blocca niente.
 *
 * @returns {{at:(number|null), scadenze:Array<object>, count:number, capitaleUsd:(number|null)}}
 */
function readScadenzeSenzaRinnovo(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const file = deps.scadenzeFile || SCADENZE_FILE;
  const t = now();
  const grezzo = leggiGrezzo(file);
  const scadenze = grezzo.scadenze.filter((r) => r && r.orderId && vivo(r, t));
  const conCapitale = scadenze.filter((r) => Number.isFinite(r.notionalUsd));
  return {
    at: Number.isFinite(grezzo.at) ? grezzo.at : null,
    scadenze,
    count: scadenze.length,
    capitaleUsd: conCapitale.length ? +conCapitale.reduce((s, r) => s + r.notionalUsd, 0).toFixed(2) : null,
  };
}

module.exports = { registraScadenzeSenzaRinnovo, readScadenzeSenzaRinnovo, SCADENZE_FILE, RETENTION_MS };
