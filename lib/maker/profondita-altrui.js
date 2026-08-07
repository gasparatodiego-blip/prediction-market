'use strict';
// lib/maker/profondita-altrui.js — QUANTO E' PROFONDO QUESTO MERCATO, TOLTI I NOSTRI ORDINI.
//
// ═══ IL DIFETTO CHE QUESTO MODULO ESISTE PER CHIUDERE ═════════════════════════════════════════════
// Il pavimento di profondita' (Regola 2, `motore-unico.pavimentoDepth`) e' il 10% della liquidita'
// media in banda di quel mercato. Fino al 6 agosto 2026 quella media veniva dal giornale di agent34
// (`bidDepthInBand + askDepthInBand`, lib/rewards/velocita-mercato.depthMedia), che somma il book
// PUBBLICO — i nostri ordini compresi. Il confronto pero' avviene contro la profondita' ALTRUI, che
// `othersLadder` ottiene sottraendo i nostri.
//
// Numeratore e denominatore non erano omogenei, e la direzione dell'errore e' sempre la stessa: piu'
// capitale mettiamo a riposo, piu' alto diventa il pavimento che dobbiamo superare. Un maker che
// quota bene si sbarra la strada da solo. E' cosi' che nasce «$38.75 di profondita' contro un
// pavimento di $90.95» su un book dove buona parte di quei dollari mancanti erano nostri.
//
// ═══ PERCHE' LA MISURA STA QUI E NON IN agent34 ═══════════════════════════════════════════════════
// L'istruzione era: sottrarre la nostra size a OGNI CAMPIONE, con la STESSA fonte di verita' sugli
// ordini nostri usata da `othersLadder` — non una seconda lista. agent34 e' un collettore WebSocket
// che non sa nulla dei nostri ordini: dargliene conoscenza vorrebbe dire creare esattamente quella
// seconda lista, mantenerla allineata attraverso due processi, e avere due risposte possibili alla
// domanda «chi c'e' oltre a noi».
//
// agent40 invece ha gia' tutto nella stessa iterazione: il book (`resolveMarketDepth`), i nostri
// ordini a riposo letti dal venue (`selectOwnedOrders`) e la banda (`inBandPriceBounds`). Quindi il
// campione si misura QUI, con `othersLadder` — la stessa identica funzione che produce il numeratore.
// Numeratore e denominatore non possono piu' divergere: nascono dalla stessa sottrazione.
//
// ═══ LA STORIA VECCHIA NON SI RECUPERA ════════════════════════════════════════════════════════════
// I campioni gia' accumulati nel giornale di agent34 contengono i nostri ordini e non c'e' modo di
// sapere a posteriori quanta size fosse nostra a ciascun istante. Non si correggono: si ricomincia.
// Finche' non ci sono `MIN_CAMPIONI` campioni puliti la media non e' affidabile e `pavimentoDepth`
// usa il suo ripiego (DEPTH_FLOOR_FALLBACK_USD = $15), che e' la rete pensata apposta per i mercati
// senza storico. Mescolare una media sporca e una pulita darebbe un numero che non e' nessuna delle
// due, e la sporca resterebbe a bloccare i rinnovi per tutte e 4 le ore della finestra.
//
// ═══ COSA VIENE MISURATO ══════════════════════════════════════════════════════════════════════════
// La profondita' ALTRUI in banda dei DUE lati, in dollari, nello spazio del token YES:
//   · `yes.bids` meno i nostri BUY su YES e i nostri SELL su NO (specchiati)
//   · `no.bids`  meno i nostri BUY su NO  e i nostri SELL su YES (specchiati)
// `no.bids` E' lo specchio di `yes.asks` (verificato su 12/12 livelli il 6 agosto 2026), quindi i due
// lati coprono il book intero senza contare niente due volte. E' la stessa grandezza che sommava
// agent34 — bid + ask in banda — solo al netto di noi.

const path = require('path');
const fs = require('fs');
const { DATA_DIR } = require('../safety/store');
const { othersLadder } = require('./top-of-book');
const { inBandPriceBounds } = require('./venue-rules');
const { atomicWriteJson } = require('../atomicJsonWrite');

/** Il passo fra due campioni. Uguale alla cadenza del giornale di agent34 (MID_HISTORY_INTERVAL_MS). */
const PASSO_CAMPIONE_MS = 45_000;
/** La finestra su cui si fa la media. Uguale ai `windowMinutes: 240` con cui agent40 leggeva la vecchia. */
const FINESTRA_MS = 4 * 3_600_000;
/** Sotto questo numero di campioni la media non e' affidabile e il pavimento usa il suo ripiego. */
const MIN_CAMPIONI = 5;

const FILE = path.join(DATA_DIR, 'maker-profondita-altrui.json');

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const specchia = (p) => +(1 - p).toFixed(10);

/**
 * I NOSTRI ordini portati nello spazio BID del book indicato.
 * YES BUY e NO SELL stanno sul lato bid di YES; NO BUY e YES SELL sul lato bid di NO.
 */
function nostriSulLatoBid(ownOrders, book) {
  const out = [];
  const ignoti = [];
  for (const o of ownOrders || []) {
    // `Number(null)` e' 0: un campo vuoto non deve potersi travestire da prezzo.
    const num = (x) => (x === null || x === undefined || x === '' ? NaN : Number(x));
    const p = num(o && o.price);
    const szR = num(o && o.sizeRemaining);
    const sz = fin(szR) && szR > 0 ? szR : num(o && o.size);
    const suo = String((o && o.book) || '').toLowerCase();
    // UN NOSTRO ORDINE CHE NON SI SA COLLOCARE NON SI IGNORA: ignorarlo lo lascerebbe dentro il
    // denominatore travestito da concorrente, che e' il difetto che questo modulo esiste per chiudere.
    if (!fin(p) || !fin(sz) || sz <= 0 || (suo !== 'yes' && suo !== 'no')) {
      ignoti.push((o && o.orderId) || '(senza id)');
      continue;
    }
    const vendita = String(o.side || 'BUY').toUpperCase() === 'SELL';
    // Il lato bid di `book` lo occupano: i BUY su quel book, e i SELL sul book complementare specchiati.
    if (!vendita && suo === book) out.push({ price: p, size: sz });
    else if (vendita && suo !== book) out.push({ price: specchia(p), size: sz });
  }
  out.ignoti = ignoti;
  return out;
}

/** La profondita' altrui in dollari fra `lo` e `hi` su una scala bid gia' ripulita. */
function sommaInBanda(levels, lo, hi) {
  let usd = 0;
  let livelli = 0;
  for (const l of levels || []) {
    if (!l || !fin(l.price) || !fin(l.size)) continue;
    if (l.price < lo - 1e-12 || l.price > hi + 1e-12) continue;
    usd += l.price * l.size;
    livelli += 1;
  }
  return { usd: +usd.toFixed(4), livelli };
}

/**
 * UN CAMPIONE: la profondita' altrui in banda, in dollari, su entrambi i lati.
 * Funzione pura — nessun file, nessun orologio.
 *
 * @returns {{leggibile:boolean, usd:number|null, lati:object, motivo:string|null}}
 *          `leggibile:false` ⇒ non si e' misurato. Non e' «profondita' zero».
 */
function misuraProfonditaAltrui({ rules = null, depth = null, ownOrders = [] } = {}) {
  const nulla = (motivo) => ({ leggibile: false, usd: null, lati: {}, motivo });
  if (!rules || rules.readable !== true) return nulla('regole di venue non leggibili');
  if (!depth) return nulla("profondita' del book non risolta per questo mercato");
  const b = inBandPriceBounds(rules);
  if (!b || b.readable !== true || !fin(b.lo) || !fin(b.hi)) return nulla('banda di reward non calcolabile');

  const lati = {};
  let totale = 0;
  // I due lati bid — quello di YES e quello di NO — con la banda espressa nello spazio di ciascuno.
  for (const [book, lo, hi] of [['yes', b.lo, b.hi], ['no', specchia(b.hi), specchia(b.lo)]]) {
    const lato = depth[book];
    const grezza = lato && Array.isArray(lato.bids) ? lato.bids : null;
    const nostri = nostriSulLatoBid(ownOrders, book);
    if (nostri.ignoti && nostri.ignoti.length) {
      return nulla(`nostri ordini non collocabili sul book (${nostri.ignoti.join(', ')}): resterebbero nel`
        + ' denominatore travestiti da concorrenti');
    }
    const L = othersLadder({ levels: grezza, ownOrders: nostri, tick: rules.tick });
    if (L.readable !== true) return nulla(`lato ${book}: ${L.reason}`);
    const s = sommaInBanda(L.levels, lo, hi);
    lati[book] = { usd: s.usd, livelli: s.livelli, soli: L.alone === true };
    totale += s.usd;
  }
  return { leggibile: true, usd: +totale.toFixed(4), lati, motivo: null };
}

// ── IL DEPOSITO ───────────────────────────────────────────────────────────────────────────────────
// Tenuto in memoria e riscritto su disco a ogni campione (uno ogni 45s per mercato: e' rumore di I/O).
// Il file serve a sopravvivere a un riavvio di agent40: senza, ogni restart azzererebbe lo storico e
// riporterebbe il pavimento al ripiego per qualche minuto.

// Chiavata sul PERCORSO del file, non una sola per processo: due depositi diversi sono due storie
// diverse, e una cache condivisa fra loro risponderebbe a una domanda con i dati dell'altra.
const memoria = new Map();   // file -> { mercati: { id: [[ts, usd], ...] } }

function carica(file) {
  if (memoria.has(file)) return memoria.get(file);
  const mem = { mercati: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const m = raw && raw.mercati && typeof raw.mercati === 'object' ? raw.mercati : {};
    for (const [k, v] of Object.entries(m)) {
      if (Array.isArray(v)) mem.mercati[k] = v.filter((c) => Array.isArray(c) && fin(c[0]) && fin(c[1]));
    }
  } catch { /* mai scritto o illeggibile: si riparte da zero campioni, che e' il ripiego onesto */ }
  memoria.set(file, mem);
  return mem;
}

function potaESalva(file, now) {
  const mem = carica(file);
  const cutoff = now - FINESTRA_MS;
  for (const [k, v] of Object.entries(mem.mercati)) {
    const vivi = v.filter((c) => c[0] >= cutoff);
    if (vivi.length) mem.mercati[k] = vivi; else delete mem.mercati[k];
  }
  try { atomicWriteJson(file, { v: 1, aggiornatoIl: new Date(now).toISOString(), mercati: mem.mercati }); }
  catch { /* un campione non depositato non deve poter fermare il ciclo che sorveglia ordini veri */ }
}

/**
 * Misura e deposita un campione, non piu' spesso di `PASSO_CAMPIONE_MS` per mercato.
 * @returns {{registrato:boolean, usd:number|null, campioni:number, motivo:string|null}}
 */
function campionaProfonditaAltrui({ marketId, rules, depth, ownOrders = [], now = Date.now(), file = FILE } = {}) {
  const id = typeof marketId === 'string' ? marketId.trim().toLowerCase() : '';
  if (!id) return { registrato: false, usd: null, campioni: 0, motivo: 'marketId assente' };
  const mem = carica(file);
  const serie = mem.mercati[id] || [];
  const ultimo = serie.length ? serie[serie.length - 1][0] : null;
  if (ultimo != null && now - ultimo < PASSO_CAMPIONE_MS) {
    return { registrato: false, usd: null, campioni: serie.length, motivo: 'passo di campionamento non ancora trascorso' };
  }
  const m = misuraProfonditaAltrui({ rules, depth, ownOrders });
  // Un campione non misurato NON entra: una lacuna nella serie e' onesta, uno zero inventato no.
  if (!m.leggibile) return { registrato: false, usd: null, campioni: serie.length, motivo: m.motivo };
  serie.push([now, m.usd]);
  mem.mercati[id] = serie;
  potaESalva(file, now);
  return { registrato: true, usd: m.usd, campioni: mem.mercati[id] ? mem.mercati[id].length : 0, motivo: null };
}

/**
 * La media dei campioni puliti sulla finestra.
 * @returns {{mediaUsd:number|null, campioni:number, coperturaMin:number|null, sufficiente:boolean, motivo:string|null}}
 */
function mediaProfonditaAltrui({ marketId, now = Date.now(), file = FILE } = {}) {
  const id = typeof marketId === 'string' ? marketId.trim().toLowerCase() : '';
  const vuoto = (motivo) => ({ mediaUsd: null, campioni: 0, coperturaMin: null, sufficiente: false, motivo });
  if (!id) return vuoto('marketId assente');
  const mem = carica(file);
  const cutoff = now - FINESTRA_MS;
  const serie = (mem.mercati[id] || []).filter((c) => c[0] >= cutoff);
  if (!serie.length) return vuoto('nessun campione pulito per questo mercato nella finestra');
  const somma = serie.reduce((s, c) => s + c[1], 0);
  const copertura = (serie[serie.length - 1][0] - serie[0][0]) / 60_000;
  return {
    mediaUsd: +(somma / serie.length).toFixed(4),
    campioni: serie.length,
    coperturaMin: +copertura.toFixed(2),
    sufficiente: serie.length >= MIN_CAMPIONI,
    motivo: serie.length >= MIN_CAMPIONI ? null
      : `solo ${serie.length} campioni puliti (ne servono ${MIN_CAMPIONI}): la media non e' ancora affidabile`,
  };
}

/** Solo per i test: dimentica la memoria di processo, cosi' il prossimo accesso rilegge il file. */
function scordaProfonditaAltrui() { memoria.clear(); }

module.exports = {
  campionaProfonditaAltrui, mediaProfonditaAltrui, misuraProfonditaAltrui,
  nostriSulLatoBid, scordaProfonditaAltrui,
  PASSO_CAMPIONE_MS, FINESTRA_MS, MIN_CAMPIONI, FILE,
};
