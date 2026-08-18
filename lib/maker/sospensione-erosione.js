'use strict';
// lib/maker/sospensione-erosione.js — QUANDO LA PROFONDITÀ DAVANTI CROLLA, SI ESCE DAL LIBRO E SI
// DICHIARA FINO A QUANDO. Decisione PURA + un registro su disco, tenuti separati.
//
// ═══ LA REGOLA (R4, decisa dall'operatore il 18 agosto 2026) ═════════════════════════════════════════
// «Riprezza ANCHE se la profondità davanti scende. Cancella e resta fuori — non l'arretramento di un
//  tick, che sul bordo è una protezione finta. Ma con un tetto: non più di 5 minuti fuori per volta. Se
//  dopo 5 minuti la profondità non è tornata sopra il 60%, rientra comunque sul bordo e lo dichiara.»
//
// Delle quattro cose decise, tre vivono altrove e una qui:
//   · **solo erosione relativa** (niente «è sparito un livello») ⇒ `auto-reprice`, TRIGGER 4;
//   · **freno 60 s** ⇒ `book-erosion.repriceAllowed`, con `minIntervalMs` iniettato;
//   · **SELL esclusi** ⇒ `auto-reprice`, la stessa condizione del TRIGGER 3;
//   · **cancella-e-resta-fuori col tetto** ⇒ QUI.
//
// ═══ PERCHÉ SERVE UN FILE, E NON LA MEMORIA DI PROCESSO ══════════════════════════════════════════════
// A cancellare è **agent40** (`auto-reprice`); a rimettere la gamba a libro è **agent41**
// (`riconciliaCopertura` → `ripristinaGamba`, §5-bis p.171). Sono due processi: una variabile in
// memoria non li mette d'accordo.
//
// ⚠⚠ E SENZA QUESTO REGISTRO LA REGOLA NON ESISTEREBBE AFFATTO. `ripristinaGamba` ha una scala di
// raffreddamento che parte **subito** — il primo tentativo è immediato, perché la GTD è 23 minuti — e
// rimetterebbe l'ordine a libro al ciclo dopo, cioè entro 120 s. «Resta fuori 5 minuti» sarebbe durato
// due minuti, e nessuno se ne sarebbe accorto: il giornale avrebbe mostrato una cancellazione e un
// ripristino, che è esattamente quello che il bot fa già. È la stessa forma del difetto per cui la
// copertura continua «decideva e non agiva»: qui si agirebbe, ma un altro percorso disferebbe.
//
// ═══ COSA NON FA ═════════════════════════════════════════════════════════════════════════════════════
// Non cancella e non piazza: dice se un mercato+lato è sospeso e fino a quando. Chi cancella è
// `auto-reprice`, chi rientra è `ripristinaGamba` — nessuna strada nuova verso il venue.
//
// ⚠ FAIL-**APERTO**, ED È IL VERSO GIUSTO QUI. Registro illeggibile ⇒ NESSUNA sospensione attiva, cioè
// la gamba torna a libro. È l'opposto della regola generale di questo repo, e ha una ragione precisa:
// una sospensione è un'ASTENSIONE dal premio, e un file che non si legge non deve poter tenere il bot
// fuori dal libro per sempre. Il danno di rientrare troppo presto è un fill sfortunato; quello di non
// rientrare mai è il capitale fermo — e §4.5 dice già da che parte sta il rischio grosso.

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../safety/store');
const { atomicWriteJson } = require('../atomicJsonWrite');

/** Il tetto deciso dall'operatore: mai più di 5 minuti fuori per volta.
 *  ⚠ 5 e non 3: «il costo è trascurabile e preferisco dare al libro il tempo di ricostruirsi» — e la
 *  misura del 17 agosto dice che **66 episodi su 97 non recuperano entro 5 minuti**, quindi il tetto
 *  è quasi sempre lui a chiudere l'uscita. Accorciarlo taglierebbe il tempo fuori; allungarlo darebbe
 *  al libro più tempo. La scelta è dell'operatore ed è scritta qui perché non venga cambiata per caso. */
const TETTO_FUORI_MS = 5 * 60_000;

/** Il freno fra due uscite sullo stesso mercato+lato. ⚠ 30 → 60 s per rispettare il rail del venue
 *  (40 invii/60 s con quota 60/40): il sorgente di `book-erosion` lo dice già — «chi vuole che il
 *  freno da solo rispetti il rail deve portarlo a 60 s». */
const FRENO_MS = 60_000;

const FILE = path.join(DATA_DIR, 'sospensioni-erosione.json');

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const norm = (x) => (typeof x === 'string' ? x.trim().toLowerCase() : '');
/** La chiave è mercato+LATO: i due book sono CLOB indipendenti e si erodono in momenti diversi.
 *  Una chiave per solo mercato terrebbe fuori anche la gamba sana. */
const chiave = (marketId, book) => `${norm(marketId)}|${norm(book) === 'no' ? 'no' : 'yes'}`;

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// LE DECISIONI — PURE, nessun `fs`, nessun orologio proprio
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/** Lo stato vuoto. */
function statoVuoto() { return { versione: 1, sospesi: {} }; }

/** Normalizza qualunque cosa venga dal disco. Un file che non si capisce vale «nessuna sospensione». */
function normalizza(stato) {
  if (!stato || typeof stato !== 'object' || !stato.sospesi || typeof stato.sospesi !== 'object') return statoVuoto();
  const out = statoVuoto();
  for (const [k, v] of Object.entries(stato.sospesi)) {
    if (!v || typeof v !== 'object') continue;
    if (!fin(v.da) || !fin(v.finoA)) continue;   // ⚠ una voce senza istanti non è una sospensione
    out.sospesi[k] = { da: v.da, finoA: v.finoA, marketId: v.marketId || null, book: v.book || null,
      baseline: fin(v.baseline) ? v.baseline : null, ratioPct: fin(v.ratioPct) ? v.ratioPct : null,
      motivo: typeof v.motivo === 'string' ? v.motivo : null };
  }
  return out;
}

/**
 * QUESTO MERCATO+LATO È SOSPESO ADESSO?
 *
 * @returns {{sospeso:boolean, finoA:number|null, restaSec:number|null, scadutoDaSec:number|null,
 *            motivo:string|null, voce:object|null}}
 */
function attiva(stato, { marketId, book, now } = {}) {
  const S = normalizza(stato);
  const k = chiave(marketId, book);
  const v = S.sospesi[k];
  if (!v) return { sospeso: false, finoA: null, restaSec: null, scadutoDaSec: null, motivo: null, voce: null };
  if (!fin(now)) {
    // ⚠ Orologio non leggibile ⇒ NON sospeso. Coerente col fail-aperto dichiarato in testa: senza
    // sapere che ora è non si può affermare che il tetto NON sia scaduto, e l'astensione è l'azione.
    return { sospeso: false, finoA: v.finoA, restaSec: null, scadutoDaSec: null,
      motivo: 'orologio non leggibile: non si tiene fuori dal libro senza poter dire fino a quando', voce: v };
  }
  if (now >= v.finoA) {
    return { sospeso: false, finoA: v.finoA, restaSec: 0, scadutoDaSec: +((now - v.finoA) / 1000).toFixed(1),
      motivo: `tetto di ${Math.round((v.finoA - v.da) / 60000)} minuti scaduto: si rientra sul bordo anche se la profondità non è tornata`, voce: v };
  }
  return { sospeso: true, finoA: v.finoA, restaSec: +((v.finoA - now) / 1000).toFixed(1), scadutoDaSec: null,
    motivo: v.motivo || 'erosione della profondità davanti', voce: v };
}

/**
 * SI ESCE DAL LIBRO. Restituisce lo stato NUOVO — non muta quello passato.
 * ⚠ Una sospensione già attiva NON si rinnova: il tetto è «5 minuti per volta», e rinnovarlo a ogni
 * lettura lo trasformerebbe in «finché dura l'erosione», che è precisamente ciò che l'operatore non
 * vuole. La prima uscita fissa `finoA`, e quella data non si sposta.
 */
function sospendi(stato, { marketId, book, now, baseline = null, ratioPct = null, tettoMs = TETTO_FUORI_MS } = {}) {
  const S = normalizza(stato);
  const k = chiave(marketId, book);
  if (!fin(now)) return { stato: S, applicata: false, motivo: 'orologio non leggibile: nessuna sospensione' };
  if (!norm(marketId)) return { stato: S, applicata: false, motivo: 'mercato non leggibile: nessuna sospensione' };
  const gia = S.sospesi[k];
  if (gia && now < gia.finoA) {
    return { stato: S, applicata: false, motivo: `già sospeso fino a ${new Date(gia.finoA).toISOString()}: il tetto non si rinnova` };
  }
  const tetto = fin(tettoMs) && tettoMs > 0 ? tettoMs : TETTO_FUORI_MS;
  S.sospesi[k] = { da: now, finoA: now + tetto, marketId: norm(marketId), book: norm(book) === 'no' ? 'no' : 'yes',
    baseline: fin(baseline) ? +baseline.toFixed(4) : null, ratioPct: fin(ratioPct) ? ratioPct : null,
    motivo: `profondità davanti erosa al ${fin(ratioPct) ? `${ratioPct}%` : '?'} della baseline`
      + `${fin(baseline) ? ` (${baseline.toFixed(0)} share)` : ''}: fuori dal libro per al più ${Math.round(tetto / 60000)} minuti` };
  return { stato: S, applicata: true, finoA: S.sospesi[k].finoA, motivo: S.sospesi[k].motivo };
}

/**
 * SI RIENTRA. `causa` distingue i due modi, e la distinzione è il punto: l'operatore ha chiesto che il
 * rientro per TETTO sia **dichiarato**, perché vuol dire che il libro non si è ricostruito.
 * @param {'recupero'|'tetto'|'pulizia'} causa
 */
function rilascia(stato, { marketId, book, causa = 'recupero' } = {}) {
  const S = normalizza(stato);
  const k = chiave(marketId, book);
  const v = S.sospesi[k];
  if (!v) return { stato: S, rilasciata: false, causa, motivo: 'non era sospeso' };
  delete S.sospesi[k];
  return { stato: S, rilasciata: true, causa, voce: v,
    motivo: causa === 'tetto'
      ? `⚠ RIENTRO PER TETTO: la profondità NON è tornata sopra soglia entro ${Math.round((v.finoA - v.da) / 60000)} minuti, si torna sul bordo lo stesso`
      : (causa === 'recupero' ? 'la profondità è risalita sopra la soglia di rientro: si torna sul bordo'
        : 'voce scaduta e ripulita') };
}

/** Toglie le voci scadute da un pezzo: un registro che cresce all'infinito diventa illeggibile, e
 *  §4.10 dice che i registri non si potano — ma questo è uno STATO, non un archivio. La storia degli
 *  episodi vive nel giornale maker, che non si pota. */
function potaScadute(stato, { now, grazia = 60 * 60_000 } = {}) {
  const S = normalizza(stato);
  if (!fin(now)) return { stato: S, tolte: 0 };
  let tolte = 0;
  for (const [k, v] of Object.entries(S.sospesi)) {
    if (now - v.finoA > grazia) { delete S.sospesi[k]; tolte += 1; }
  }
  return { stato: S, tolte };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// IL REGISTRO SU DISCO — l'unica parte che tocca `fs`
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/** ⚠ FAIL-APERTO: file assente o illeggibile ⇒ stato vuoto ⇒ nessuna sospensione. Vedi la testa. */
function leggiStato(file = FILE) {
  try { return { leggibile: true, stato: normalizza(JSON.parse(fs.readFileSync(file, 'utf8'))), error: null }; }
  catch (e) {
    return { leggibile: false, stato: statoVuoto(),
      error: e && e.code === 'ENOENT' ? 'assente (nessuna sospensione, ed è lo stato sano)' : (e && e.message) || String(e) };
  }
}

function scriviStato(stato, file = FILE) {
  try { atomicWriteJson(file, { ...normalizza(stato), aggiornatoAl: Date.now() }); return { ok: true }; }
  catch (e) { return { ok: false, motivo: (e && e.message) || String(e) }; }
}

/** Prove interne. Girano con `node lib/maker/sospensione-erosione.js`. */
function selfcheck() {
  let pass = 0; let fail = 0;
  const ok = (n, c, x) => { if (c) { pass += 1; console.log(`  ok  ${n}`); } else { fail += 1; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };
  const T = 1_000_000_000;
  const M = '0xabc';

  // ── SOSPENDI / ATTIVA / RILASCIA ──────────────────────────────────────────────────────────────
  let s = statoVuoto();
  ok('stato vuoto: niente è sospeso', attiva(s, { marketId: M, book: 'yes', now: T }).sospeso === false);
  const r1 = sospendi(s, { marketId: M, book: 'yes', now: T, baseline: 900, ratioPct: 22 });
  s = r1.stato;
  ok('dopo `sospendi` il lato è sospeso', r1.applicata === true && attiva(s, { marketId: M, book: 'yes', now: T }).sospeso === true);
  ok('  e il tetto è di 5 minuti', r1.finoA === T + TETTO_FUORI_MS);
  ok('  e il motivo porta il rapporto e la baseline', /22%/.test(r1.motivo) && /900/.test(r1.motivo));
  ok('un minuto dopo è ancora sospeso', attiva(s, { marketId: M, book: 'yes', now: T + 60_000 }).sospeso === true);
  ok('  e dichiara quanto resta', attiva(s, { marketId: M, book: 'yes', now: T + 60_000 }).restaSec === 240);

  // ⚠ IL TETTO NON SI RINNOVA: è la proprietà che distingue «5 minuti per volta» da «finché dura».
  const r2 = sospendi(s, { marketId: M, book: 'yes', now: T + 120_000, baseline: 900, ratioPct: 15 });
  ok('una seconda sospensione mentre la prima è attiva NON rinnova il tetto',
    r2.applicata === false && attiva(r2.stato, { marketId: M, book: 'yes', now: T + TETTO_FUORI_MS }).sospeso === false);

  // ── LA SCADENZA ───────────────────────────────────────────────────────────────────────────────
  const dopo = attiva(s, { marketId: M, book: 'yes', now: T + TETTO_FUORI_MS });
  ok('al minuto 5 esatto NON è più sospeso', dopo.sospeso === false);
  ok('  e dichiara che è il tetto ad averlo chiuso', /tetto di 5 minuti scaduto/.test(dopo.motivo || ''));
  ok('  e da quanto è scaduto', attiva(s, { marketId: M, book: 'yes', now: T + TETTO_FUORI_MS + 30_000 }).scadutoDaSec === 30);

  // ── IL LATO È PARTE DELLA CHIAVE ──────────────────────────────────────────────────────────────
  // ⚠ I due book sono CLOB indipendenti: sospendere YES non deve togliere dal libro la gamba NO.
  ok('sospendere YES non sospende NO', attiva(s, { marketId: M, book: 'no', now: T }).sospeso === false);
  ok('  né un altro mercato', attiva(s, { marketId: '0xdef', book: 'yes', now: T }).sospeso === false);
  const sNo = sospendi(s, { marketId: M, book: 'no', now: T }).stato;
  ok('  e i due lati convivono', attiva(sNo, { marketId: M, book: 'yes', now: T }).sospeso === true
    && attiva(sNo, { marketId: M, book: 'no', now: T }).sospeso === true);

  // ── IL RILASCIO, E LE DUE CAUSE ───────────────────────────────────────────────────────────────
  const rec = rilascia(s, { marketId: M, book: 'yes', causa: 'recupero' });
  ok('rilascio per recupero: non è più sospeso', rec.rilasciata === true
    && attiva(rec.stato, { marketId: M, book: 'yes', now: T + 1000 }).sospeso === false);
  const tet = rilascia(s, { marketId: M, book: 'yes', causa: 'tetto' });
  ok('rilascio per TETTO: il motivo lo DICHIARA', /RIENTRO PER TETTO/.test(tet.motivo));
  ok('  e dice che la profondità non è tornata', /NON è tornata/.test(tet.motivo));
  ok('rilasciare qualcosa che non c\'era non è un errore', rilascia(statoVuoto(), { marketId: M, book: 'yes' }).rilasciata === false);

  // ── FAIL-APERTO, IN TUTTE LE FORME ────────────────────────────────────────────────────────────
  for (const cattivo of [null, undefined, 0, 'boh', [], { sospesi: null }, { sospesi: 'x' }]) {
    ok(`stato "${JSON.stringify(cattivo)}" ⇒ nessuna sospensione (fail-APERTO)`,
      attiva(cattivo, { marketId: M, book: 'yes', now: T }).sospeso === false);
  }
  ok('una voce senza istanti non è una sospensione',
    attiva({ versione: 1, sospesi: { '0xabc|yes': { motivo: 'x' } } }, { marketId: M, book: 'yes', now: T }).sospeso === false);
  ok('orologio non leggibile ⇒ NON sospeso, e lo dichiara', (() => {
    const a = attiva(s, { marketId: M, book: 'yes', now: null });
    return a.sospeso === false && /orologio non leggibile/.test(a.motivo || '');
  })());
  ok('mercato non leggibile ⇒ nessuna sospensione applicata',
    sospendi(statoVuoto(), { marketId: '', book: 'yes', now: T }).applicata === false);
  ok('orologio non leggibile ⇒ nessuna sospensione applicata',
    sospendi(statoVuoto(), { marketId: M, book: 'yes', now: null }).applicata === false);

  // ── LA POTATURA ───────────────────────────────────────────────────────────────────────────────
  const p = potaScadute(s, { now: T + TETTO_FUORI_MS + 2 * 60 * 60_000 });
  ok('le voci scadute da oltre un\'ora si potano', p.tolte === 1 && Object.keys(p.stato.sospesi).length === 0);
  ok('  ma non quelle ancora vive', potaScadute(s, { now: T + 1000 }).tolte === 0);

  // ── I DUE NUMERI DELL'OPERATORE ───────────────────────────────────────────────────────────────
  ok('il tetto è 5 minuti, come deciso', TETTO_FUORI_MS === 5 * 60_000);
  ok('il freno è 60 s, come deciso per rispettare il rail', FRENO_MS === 60_000);

  console.log(`\nsospensione erosione: ${pass} passati, ${fail} falliti\n`);
  return fail === 0;
}

if (require.main === module) process.exit(selfcheck() ? 0 : 1);

module.exports = {
  TETTO_FUORI_MS, FRENO_MS, FILE,
  statoVuoto, normalizza, attiva, sospendi, rilascia, potaScadute,
  leggiStato, scriviStato, chiave,
};
