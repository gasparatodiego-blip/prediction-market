'use strict';
// lib/safety/venue-orders-snapshot.js — I MERCATI DOVE ABBIAMO ORDINI A RIPOSO, SU DISCO.
//
// ═══ IL GUASTO CHE CHIUDE — 18 agosto 2026, 16:32→16:55, capitale vero ═══════════════════════════════
// Il bot ha piazzato due ordini veri ($55,09 + $1,27) sul mercato 0x1f1c6390. Dieci minuti dopo quel
// mercato e' USCITO DAL BOARD di agent24 (`riga-assente`), la selezione l'ha rilasciato, `setAutoReprice`
// l'ha tolto dalla allowlist e agent40 ha smesso di visitarlo. Alle 16:55:08 la GTD nativa e' scaduta e
// **nessuno ha rinnovato**: bot armato, zero ordini a libro, per 52 minuti. Costo di capitale $0 solo
// perche' a 35 tick dal mid non si era riempito niente.
//
// ═══ PERCHE' LE DUE DIFESE CHE ESISTEVANO NON HANNO RETTO ════════════════════════════════════════════
// ① §4.8 dichiarava il buco: l'unione del perimetro e' `abilitati ∪ mercati con POSIZIONE`, e la meta'
//    «ordine a riposo» non era coperta perche' non esisteva uno snapshot locale degli ordini. La
//    mitigazione scritta era «l'ordine muore per GTD entro 23 minuti o si riempie» — accettabile in
//    dry-run, non con `MANUAL_ORDER_PLACEMENT=send`.
// ② `auto-reprice.scopeRinnovo` aveva GIA' la terza componente (`deps.mercatiConOrdiniVivi`), ed era
//    persino iniettata da agent40. Ma quella memoria e' una CORSA:
//      · si sovrascrive INTERA a ogni giro   (agent40 `mercatiConOrdiniUltimoGiro = new Set(res.…)`);
//      · si popola solo nei giri che superano quattro cancelli — `riprezzo-in-corso`,
//        `manual-mode-*`, **`cadenza-adattiva`**, `rules-unreadable` — che fanno `continue` PRIMA che
//        `owned` venga calcolato.
//    Il mercato batteva su `cadenza-adattiva` («si guarda ogni 10000ms, mancano 4981ms») nella quasi
//    totalita' dei giri. Un solo giro saltato per cadenza lo cancella dalla memoria, e al giro dopo non
//    e' piu' nello scope — quindi non verra' MAI piu' guardato, quindi non tornera' mai in memoria.
//    E' la classe «filtro a monte che svuota l'eccezione scritta a valle»: l'eccezione era scritta, ma
//    la riga non arrivava fin li'.
//
// ═══ LA REGOLA, E PERCHE' LA FUSIONE E' LA PARTE CHE CONTA ═══════════════════════════════════════════
// «Un mercato con capitale a libro non esce mai dal perimetro.»
//
// ⚠⚠ QUESTO SNAPSHOT NON SI SOVRASCRIVE INTERO, SI FONDE PER MERCATO. E' l'unica differenza di
// sostanza rispetto al gemello `venue-positions-snapshot`, e non e' un dettaglio di implementazione:
// e' la correzione. Le posizioni si leggono con UNA chiamata che elenca tutto, quindi «assente
// dall'elenco» e' una PROVA di chiusura. Gli ordini si leggono UN MERCATO PER VOLTA, e solo per i
// mercati che stiamo guardando: «assente da questo giro» non prova niente — nella stragrande
// maggioranza dei casi significa «non ho guardato». Riscrivere l'elenco intero a ogni giro
// riprodurrebbe esattamente la corsa di ② su disco invece che in memoria.
//
// Quindi lo scrittore riceve DUE insiemi e non uno:
//   · `guardati`   — i mercati che questo giro ha davvero interrogato al venue. Solo questi si aggiornano.
//   · `conOrdini`  — quali di quelli avevano ordini nostri a riposo.
// Un mercato non guardato conserva la sua ultima osservazione. Un mercato guardato e trovato vuoto
// viene tolto — perche' li' «vuoto» e' una lettura, non un silenzio.
//
// ═══ LA FRESCHEZZA, SU DUE LIVELLI ═══════════════════════════════════════════════════════════════════
// · FILE: come per le posizioni, oltre `MAX_AGE_MS` l'intero snapshot e' NON LEGGIBILE — mai «nessun
//   ordine». Se chi scrive non gira, la risposta onesta e' «non lo so».
// · VOCE: `ENTRY_MAX_AGE_MS` e' la valvola di sicurezza per il caso opposto — una voce che nessuno
//   rinfresca piu' terrebbe un mercato nel perimetro per sempre. Sta a **30 minuti**, cioe' SOPRA la
//   GTD di 23: un ordine vero non puo' sopravvivere alla propria voce, quindi la valvola non puo'
//   accorciare la vita di niente. E finche' il mercato e' nel perimetro viene guardato ogni ~10 s, per
//   cui una voce viva si rinfresca da sola e non arriva mai vicino ai 30 minuti.
//
// ⚠ NON ALLARGA IL PERIMETRO DI RISCHIO, e va detto con la stessa precisione del gemello: aggiunge solo
// mercati dove il capitale E' GIA' A LIBRO. Non apre un mercato nuovo — tiene aperta la GESTIONE di
// ordini che esistono. Il verso e' quello della riduzione del rischio: senza, l'alternativa non e'
// «meno esposizione», e' «esposizione che nessuno sta guardando».
//
// ⚠ FAIL-CLOSED come le altre tre volte: file illeggibile ⇒ nessuna aggiunta. E resta subordinato
// all'interruttore generale, esattamente come `enabledDaPosizione`.

const fs = require('fs');
const path = require('path');
// Stessa risoluzione del gemello: la cartella `data/` si chiede a `store`, non si calcola da
// `__dirname` — due modi di trovare la stessa cartella sono due modi di trovarne due.
const { DATA_DIR } = require('./store');

const SNAPSHOT_FILE = path.join(DATA_DIR, 'venue-orders.json');
// agent40 gira ogni pochi secondi. Tre minuti senza NESSUNA scrittura sono un processo fermo, non un
// ritardo — stessa soglia e stessa motivazione delle posizioni.
const MAX_AGE_MS = 180_000;
// Sopra la GTD di 23 minuti, di proposito: v. il commento in testa.
const ENTRY_MAX_AGE_MS = 1_800_000;

const normId = (x) => String(x == null ? '' : x).trim().toLowerCase();

/**
 * Deposita l'osservazione di UN GIRO, fondendola con quella precedente.
 *
 * @param {{guardati:Array<string>, conOrdini:Array<string>}} lettura
 *        `guardati`  i mercati interrogati al venue in questo giro (gli unici che si aggiornano);
 *        `conOrdini` quali di quelli avevano ordini nostri a riposo.
 * @returns {{ok:boolean, written:boolean, mercati?:number, reason?:string}}
 */
function writeVenueOrders(lettura, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  // Iniettabile come nel gemello: senza, l'unico modo di esercitare lo scrittore sarebbe sovrascrivere
  // lo snapshot di produzione — cioe' un test che per girare deve toccare il file da cui dipende il
  // perimetro. Un test cosi' non lo si esegue mai, ed e' il motivo per cui il gemello ne aveva bisogno.
  const file = deps.snapshotFile || SNAPSHOT_FILE;
  if (!lettura || !Array.isArray(lettura.guardati)) {
    return { ok: false, written: false, reason: 'nessun elenco di mercati guardati: senza sapere cosa e stato letto non si puo fondere niente, e lo snapshot precedente resta com era' };
  }
  const guardati = lettura.guardati.map(normId).filter(Boolean);
  const conOrdini = new Set((Array.isArray(lettura.conOrdini) ? lettura.conOrdini : []).map(normId).filter(Boolean));

  // ── LA FUSIONE ────────────────────────────────────────────────────────────────────────────────────
  // Si parte da quello che c'era. Una lettura precedente illeggibile NON e' una ragione per azzerare:
  // sarebbe di nuovo «non ho guardato» trasformato in «non c'e' niente».
  let precedenti = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw.mercati === 'object' && raw.mercati) precedenti = raw.mercati;
  } catch { /* mai scritto, o illeggibile: si riparte da zero voci, non si cancella niente di vivo */ }

  const at = now();
  const mercati = {};
  // ① si conservano le voci NON guardate questo giro, purche' non oltre la valvola di sicurezza
  for (const [id, v] of Object.entries(precedenti)) {
    if (guardati.includes(id)) continue;                  // guardato ⇒ lo decide questo giro, sotto
    const vAt = Number(v && v.at);
    if (!Number.isFinite(vAt)) continue;                  // voce senza data: non se ne giudica l'eta'
    if (at - vAt > ENTRY_MAX_AGE_MS) continue;            // valvola: sopra la GTD, non accorcia niente
    mercati[id] = v;
  }
  // ② i mercati guardati e trovati CON ordini si (ri)scrivono con la data di adesso.
  //    I guardati trovati VUOTI semplicemente non vengono riscritti: li' il vuoto e' una lettura.
  for (const id of guardati) {
    if (conOrdini.has(id)) mercati[id] = { at, atIso: new Date(at).toISOString() };
  }

  const body = { at, atIso: new Date(at).toISOString(), mercati };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
    fs.renameSync(tmp, file);   // atomico: nessun lettore vede mai un file a meta'
    return { ok: true, written: true, mercati: Object.keys(mercati).length, at };
  } catch (e) {
    return { ok: false, written: false, reason: e.message };
  }
}

/**
 * I mercati con ordini nostri a riposo, se lo snapshot e' abbastanza fresco.
 * @returns {{readable:boolean, marketIds:Array<string>, ageMs:number|null, reason:string|null}}
 *          `readable:false` ⇒ NON si sa dove abbiamo ordini. Non e' «non ne abbiamo».
 */
function readVenueOrders(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const file = deps.snapshotFile || SNAPSHOT_FILE;
  const maxAge = Number.isFinite(deps.maxAgeMs) ? deps.maxAgeMs : MAX_AGE_MS;
  const entryMaxAge = Number.isFinite(deps.entryMaxAgeMs) ? deps.entryMaxAgeMs : ENTRY_MAX_AGE_MS;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { readable: false, marketIds: [], ageMs: null, reason: `snapshot degli ordini non leggibile (${e.code === 'ENOENT' ? 'mai scritto' : e.message})` }; }
  const at = Number(raw && raw.at);
  if (!Number.isFinite(at)) return { readable: false, marketIds: [], ageMs: null, reason: 'snapshot senza data: non se ne puo giudicare la freschezza' };
  const ageMs = now() - at;
  if (ageMs > maxAge) {
    return { readable: false, marketIds: [], ageMs, reason: `snapshot degli ordini vecchio di ${Math.round(ageMs / 1000)}s (limite ${Math.round(maxAge / 1000)}s): chi lo scrive non sta girando` };
  }
  const mercati = (raw && typeof raw.mercati === 'object' && raw.mercati) ? raw.mercati : {};
  const marketIds = [];
  for (const [id, v] of Object.entries(mercati)) {
    const vAt = Number(v && v.at);
    if (!Number.isFinite(vAt)) continue;
    if (now() - vAt > entryMaxAge) continue;
    const k = normId(id);
    if (k && !marketIds.includes(k)) marketIds.push(k);
  }
  return { readable: true, marketIds, ageMs, reason: null };
}

module.exports = { writeVenueOrders, readVenueOrders, SNAPSHOT_FILE, MAX_AGE_MS, ENTRY_MAX_AGE_MS };
