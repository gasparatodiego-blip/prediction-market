'use strict';
// lib/maker/residui-sotto-soglia.js — I RESIDUI CHE MUOIONO SOTTO LA SOGLIA MINIMA, DOVE SI VEDONO.
//
// ═══ IL PROBLEMA CHE RISOLVE ═════════════════════════════════════════════════════════════════════════
// Dopo un fill parziale il residuo di un ordine può scendere sotto `min_incentive_size`. A quel punto il
// rinnovo proattivo non può più partire — ripiazzare quella size non passerebbe il guard condiviso — e
// `lib/maker/auto-reprice.js` fa la cosa giusta: lascia scadere l'ordine invece di cancellarlo per un
// rimpiazzo che il venue rifiuterebbe. Ma lo faceva in SILENZIO. Il 5 agosto 2026 l'ordine 0x4c19a7 ha
// prodotto ventiquattro righe di `skip-refresh-invalid` identiche, è morto, e nessuno l'ha saputo.
//
// Il costo non è l'ordine: è il capitale. Fino alla scadenza quei dollari sono immobilizzati su un
// residuo che non maturerà mai un premio, e dopo la scadenza tornano liberi senza che nessuno se ne
// accorga — quindi senza che nessuno li rimetta in gioco.
//
// ═══ COSA FA QUESTO MODULO, E COSA NON FA ═══════════════════════════════════════════════════════════
// Deposita l'avviso dove la dashboard lo può leggere, e basta. NON chiude la posizione già eseguita —
// quella segue la sua uscita a carico+1%, che non c'entra e resta invariata — e NON cancella niente:
// il residuo continua a scadere da solo, come deciso.
//
// ═══ PERCHÉ UN FILE E NON UNA RIGA DI LOG ═══════════════════════════════════════════════════════════
// La riga di log c'era già, ripetuta ventiquattro volte, e non ha avvisato nessuno. Un avviso che per
// essere visto pretende che qualcuno stia guardando i log di un processo non è un avviso. Questo file lo
// scrive agent40-manual-reprice e lo legge `/api/maker/wallet-status`, che lo porta nel pannello «Stato
// wallet e piazzamento» — la stessa superficie che già dice cosa manca prima di piazzare.
//
// ═══ LA FINESTRA DI VISIBILITÀ ══════════════════════════════════════════════════════════════════════
// Un avviso che sparisce nell'istante in cui l'ordine scade è un avviso che si vede solo se si guarda
// nei due minuti giusti — cioè, di nuovo, quasi mai. Ogni voce resta leggibile fino a RETENTION_MS dopo
// la scadenza PREVISTA dell'ordine, e poi se ne va da sola. Il filtro è nel LETTORE, non solo nello
// scrittore: se il processo che scrive si ferma, le voci invecchiano lo stesso invece di restare
// appese lì per sempre a descrivere ordini che non esistono più.

const fs = require('fs');
const path = require('path');
// La stessa risoluzione di `data/` usata da lib/safety/venue-positions-snapshot.js, e per lo stesso
// motivo: questo modulo lo carica agent40 come node semplice E la dashboard dentro il bundle di Next,
// e un `path.join(__dirname, '..', '..')` darebbe due cartelle diverse — lo scrittore scriverebbe in
// data/, il lettore guarderebbe in .next/data/, che non è mai esistita.
const { DATA_DIR } = require('../safety/store');

const RESIDUI_FILE = path.join(DATA_DIR, 'residui-sotto-soglia.json');
// Mezz'ora dopo la scadenza prevista. Abbastanza perché chi apre il pannello dopo pranzo veda cos'è
// successo; abbastanza poco perché il pannello non diventi un archivio di cose finite.
const RETENTION_MS = 30 * 60_000;

const vivo = (r, now) => {
  const fine = r && r.expiresAt ? Date.parse(r.expiresAt) : NaN;
  // Senza una scadenza leggibile si conta dall'istante in cui l'avviso è nato: una voce senza data non
  // deve poter restare eterna solo perché non si sa quando sarebbe dovuta morire.
  const base = Number.isFinite(fine) ? fine : Date.parse((r && r.at) || '');
  if (!Number.isFinite(base)) return false;
  return now - base <= RETENTION_MS;
};

/**
 * Registra gli avvisi nuovi, tenendo quelli ancora dentro la finestra di visibilità.
 *
 * FONDE, non sovrascrive: la deduplica per `orderId` vive qui oltre che nel Set in memoria del processo,
 * così un riavvio di agent40 — che quel Set lo azzera, di proposito — non fa uscire due volte lo stesso
 * avviso per lo stesso ordine.
 *
 * @param {Array<object>} nuovi  eventi `residuo-sotto-soglia` prodotti dal ciclo di auto-reprice
 * @returns {{ok:boolean, written:boolean, count:number, reason:(string|null)}}
 */
function registraResiduiSottoSoglia(nuovi, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const file = deps.residuiFile || RESIDUI_FILE;
  const t = now();
  const precedenti = leggiGrezzo(file).residui.filter((r) => vivo(r, t));
  const perId = new Map(precedenti.map((r) => [r.orderId, r]));
  for (const r of Array.isArray(nuovi) ? nuovi : []) {
    if (!r || !r.orderId || perId.has(r.orderId)) continue;
    perId.set(r.orderId, r);
  }
  const residui = [...perId.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ at: t, atIso: new Date(t).toISOString(), residui }, null, 2));
    fs.renameSync(tmp, file);   // atomico: nessun lettore vede mai un file a metà
    return { ok: true, written: true, count: residui.length, reason: null };
  } catch (e) {
    return { ok: false, written: false, count: residui.length, reason: e.message };
  }
}

function leggiGrezzo(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { at: Number(raw && raw.at), residui: Array.isArray(raw && raw.residui) ? raw.residui : [] };
  } catch {
    return { at: NaN, residui: [] };
  }
}

/**
 * Gli avvisi da mostrare adesso.
 *
 * Un file assente NON è un errore: significa che non è mai morto un residuo sotto soglia, che è lo stato
 * normale. Per questo qui non c'è un `readable:false` da propagare come rifiuto — a differenza dello
 * snapshot delle posizioni, che governa un gate, questo è un avviso e la sua assenza non blocca niente.
 *
 * @returns {{at:(number|null), residui:Array<object>, count:number, capitaleUsd:(number|null)}}
 */
function readResiduiSottoSoglia(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const file = deps.residuiFile || RESIDUI_FILE;
  const t = now();
  const grezzo = leggiGrezzo(file);
  const residui = grezzo.residui
    .filter((r) => r && r.orderId && vivo(r, t))
    .map((r) => ({
      ...r,
      // «È già scaduto?» si risponde qui, una volta, invece di lasciarlo dedurre a ogni pannello che
      // legge questo file — due deduzioni della stessa cosa sono due modi di sbagliarla.
      scaduto: r.expiresAt ? Date.parse(r.expiresAt) <= t : null,
    }));
  const conCapitale = residui.filter((r) => Number.isFinite(r.notionalUsd));
  return {
    at: Number.isFinite(grezzo.at) ? grezzo.at : null,
    residui,
    count: residui.length,
    capitaleUsd: conCapitale.length ? +conCapitale.reduce((s, r) => s + r.notionalUsd, 0).toFixed(2) : null,
  };
}

module.exports = { registraResiduiSottoSoglia, readResiduiSottoSoglia, RESIDUI_FILE, RETENTION_MS };
