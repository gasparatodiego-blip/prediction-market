'use strict';
// lib/maker/accumulo-residui.js — IL REGISTRO DEI LATI SCOPERTI TROPPO PICCOLI PER ESSERE PIAZZATI.
//
// ═══ LA REGOLA GENERALE, DECISA DALL'OPERATORE IL 9 AGOSTO 2026 ══════════════════════════════════════
// Ogni volta che il bot rileva un lato posseduto senza controparte — QUALUNQUE sia la causa: un fill
// originale, il residuo dopo un merge parziale, ciò che la chiusura rapida non ha coperto, o una causa
// che ancora non esiste — deve:
//   1. riposizionare il lato posseduto a +1% dal carico, dentro banda, mai sotto il carico;
//   2. aprire contestualmente il limit uguale e contrario sulla controparte mancante;
//   3. e se la quantità è SOTTO IL MINIMO PIAZZABILE, non lasciarla lì muta: accumularla qui.
// I punti 1 e 2 vivono in `chiusura-rapida.pianificaRiposizionamentoScoperto`. Questo modulo è il 3.
//
// ═══ IL MINIMO È DEL VENUE, ED È PER MERCATO ════════════════════════════════════════════════════════
// Verificato il 9 agosto 2026 sul board vivo (108 mercati): `min_incentive_size` vale **20** su 65
// mercati, **50** su 26, **100** su 4, **200** su 13. Non è una costante nostra e non è configurabile da
// noi: arriva dal catalogo dei premi del venue (`rewardsMinSize` → `manual-order.js:316` → `rules.minSize`).
//
// Nel senso stretto di Polymarket quel numero dice «sotto questa size non maturi reward», non «l'ordine
// viene rifiutato» — `venue-rules.js:86` lo scrive con esattezza: *earns nothing*. Ma nel NOSTRO stack
// `BELOW_MIN_SIZE` è un motivo BLOCCANTE, non un avviso: `splitVerdict` declassa a consiglio soltanto
// `OUT_OF_BAND`, tutto il resto rifiuta. È una scelta deliberata e non la si tocca qui — un ordine sotto
// il minimo immobilizzerebbe capitale per un premio che vale zero. Questo modulo prende quel vincolo per
// come è e risolve il problema che lascia aperto: dove finisce la quantità che non si può piazzare.
//
// ═══ PERCHÉ NON SI SOMMANO LE OSSERVAZIONI ═════════════════════════════════════════════════════════
// «Accumulare» qui NON vuol dire addizionare una riga a ogni giro. Ogni osservazione misura l'INTERA
// quantità scoperta di quel mercato/lato in quel momento — è `sizePosseduta − sizeAltroLato`, non un
// incremento — quindi sommare due osservazioni della stessa cosa la conterebbe due volte, e il registro
// direbbe che siamo scoperti del doppio di quanto siamo. Si tiene quindi l'ULTIMA osservazione come
// verità corrente, e la storia delle `voci` accanto: è lì che si legge che il residuo è cresciuto da 3,4
// a 11,4 share, con quali cause e quando. La somma di residui diversi sullo stesso mercato/lato avviene
// già nel mondo — la posizione li contiene entrambi — e arriva qui dentro come una singola osservazione
// più grande.
//
// ═══ COSA FA SCATTARE IL RILASCIO ══════════════════════════════════════════════════════════════════
// Quando la quantità osservata raggiunge il minimo, la voce diventa `pronto`. Da quel momento non serve
// nessun percorso speciale: il meccanismo generale (`pianificaRiposizionamentoScoperto`) smette da solo
// di rifiutarla, perché il rifiuto era esattamente `size < minSize`. Il registro non piazza niente —
// tiene il conto e lo rende visibile — ed è proprio il fatto che NON piazzi a renderlo sicuro: non
// aggiunge una seconda politica di quando si compra.
//
// ═══ NON È `residui-sotto-soglia.js` ════════════════════════════════════════════════════════════════
// Quel modulo esiste e serve ad altro: registra ORDINI in scadenza il cui residuo è sceso sotto il
// minimo, per mostrarli in dashboard, con chiave `orderId` e una finestra di visibilità di 30 minuti.
// Qui la chiave è `mercato:lato`, non c'è scadenza di visibilità, e l'oggetto non è un ordine che muore
// ma una POSIZIONE scoperta che aspetta di poter essere coperta. Due domande diverse, due registri.

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../safety/store');

const REGISTRO_FILE = path.join(DATA_DIR, 'residui-scoperti.json');

// Una voce che non viene più osservata è una posizione che non c'è più: chiusa, risolta, o coperta da
// un percorso che non passa di qui. Dopo 48 h senza conferme se ne va da sola, invece di restare a
// descrivere per sempre uno scoperto che non esiste. È lungo di proposito — un residuo può aspettare
// giorni la fusione che lo assorbe, e sparire troppo presto vorrebbe dire perdere la storia.
const SCADENZA_MS = 48 * 3_600_000;
// Quante voci di storia si tengono per residuo. Serve a leggere COME è cresciuto, non a fare da archivio.
const MAX_VOCI = 12;

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const normId = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/** La chiave di un residuo: un mercato e un lato. Due lati dello stesso mercato sono due residui. */
function chiaveResiduo(marketId, book) {
  const m = normId(marketId);
  const b = normId(book);
  return m && (b === 'yes' || b === 'no') ? `${m}:${b}` : null;
}

const REGISTRO_VUOTO = Object.freeze({ at: null, residui: {} });

function normalizzaRegistro(r) {
  const residui = (r && typeof r.residui === 'object' && r.residui) || {};
  return { at: fin(r && r.at) ? r.at : null, residui };
}

/**
 * REGISTRA un'osservazione di lato scoperto, e dice se adesso è piazzabile. Puro: niente disco.
 *
 * @param a.registro      il registro corrente (da `leggiRegistroResidui`)
 * @param a.sizeScoperta  l'INTERA quantità scoperta adesso, non un incremento
 * @param a.minSize       il minimo del venue per QUESTO mercato (mai una costante)
 * @param a.causa         'merge-parziale' | 'fill' | 'chiusura-rapida' | … — perché è scoperto
 * @returns {{ok:boolean, registro:object, chiave:string|null, voce:object|null, pronto:boolean,
 *            azione:'accumulato'|'pronto'|'chiuso'|'ignorato', motivo:string}}
 */
function registraResiduoScoperto({
  registro = null, marketId = null, book = null, sizeScoperta = null, minSize = null,
  causa = 'ignota', prezzoCarico = null, marketTitle = null, now = Date.now(),
} = {}) {
  const reg = normalizzaRegistro(registro);
  const chiave = chiaveResiduo(marketId, book);
  const no = (motivo) => ({ ok: false, registro: reg, chiave, voce: null, pronto: false, azione: 'ignorato', motivo });

  if (!chiave) return no(`mercato o lato non utilizzabili (${marketId} / ${book})`);
  if (!fin(sizeScoperta)) return no('quantità scoperta non leggibile: un residuo non si indovina');

  const residui = { ...reg.residui };

  // Scoperto rientrato: la voce si chiude invece di restare a mentire. È il caso normale quando la
  // controparte viene finalmente comprata, o quando la posizione si chiude per altra via.
  if (sizeScoperta <= 0) {
    if (!residui[chiave]) return { ok: true, registro: reg, chiave, voce: null, pronto: false, azione: 'ignorato', motivo: 'niente di scoperto, e non c\'era niente a registro' };
    delete residui[chiave];
    return { ok: true, registro: { at: now, residui }, chiave, voce: null, pronto: false,
      azione: 'chiuso', motivo: 'lo scoperto è rientrato: la voce esce dal registro' };
  }

  const precedente = residui[chiave] || null;
  const voci = (precedente && Array.isArray(precedente.voci) ? precedente.voci : []).slice(-(MAX_VOCI - 1));
  voci.push({ at: now, atIso: new Date(now).toISOString(), size: +sizeScoperta.toFixed(6), causa });

  const pronto = fin(minSize) && minSize > 0 ? sizeScoperta >= minSize - 1e-9 : true;
  const voce = {
    marketId: normId(marketId), book: normId(book), marketTitle: marketTitle || (precedente && precedente.marketTitle) || null,
    // L'ULTIMA osservazione, non una somma — vedi l'intestazione: sommarle conterebbe due volte.
    size: +sizeScoperta.toFixed(6),
    minSize: fin(minSize) ? minSize : null,
    manca: fin(minSize) && minSize > 0 ? +Math.max(0, minSize - sizeScoperta).toFixed(6) : 0,
    prezzoCarico: fin(prezzoCarico) ? prezzoCarico : (precedente && precedente.prezzoCarico) || null,
    notionalUsd: fin(prezzoCarico) ? +(prezzoCarico * sizeScoperta).toFixed(4) : null,
    causa,
    primoAt: (precedente && fin(precedente.primoAt)) ? precedente.primoAt : now,
    ultimoAt: now,
    ultimoAtIso: new Date(now).toISOString(),
    pronto,
    voci,
  };
  residui[chiave] = voce;

  return {
    ok: true, registro: { at: now, residui }, chiave, voce, pronto,
    azione: pronto ? 'pronto' : 'accumulato',
    motivo: pronto
      ? `${voce.size} share scoperte su ${voce.book.toUpperCase()}: hanno raggiunto il minimo del venue (${voce.minSize ?? 'nessuno'}), il riposizionamento può piazzarle`
      : `${voce.size} share scoperte su ${voce.book.toUpperCase()}, sotto il minimo del venue (${voce.minSize}): mancano ${voce.manca} — accumulate, non perse`,
  };
}

/** Toglie le voci non più confermate da SCADENZA_MS. Una posizione chiusa smette di essere osservata. */
function potaScadute(registro, now = Date.now(), scadenzaMs = SCADENZA_MS) {
  const reg = normalizzaRegistro(registro);
  const residui = {};
  const scadute = [];
  for (const [k, v] of Object.entries(reg.residui)) {
    const ultimo = v && fin(v.ultimoAt) ? v.ultimoAt : null;
    if (ultimo == null || now - ultimo > scadenzaMs) { scadute.push(k); continue; }
    residui[k] = v;
  }
  return { registro: { at: reg.at, residui }, scadute };
}

/** Le voci che hanno raggiunto il minimo e che il meccanismo generale può ora piazzare. */
function residuiPronti(registro) {
  return Object.values(normalizzaRegistro(registro).residui).filter((v) => v && v.pronto === true);
}

/** Quanto capitale sta fermo in residui non ancora piazzabili. Null se nessun carico è leggibile. */
function capitaleFermoUsd(registro) {
  const con = Object.values(normalizzaRegistro(registro).residui).filter((v) => v && v.pronto !== true && fin(v.notionalUsd));
  return con.length ? +con.reduce((s, v) => s + v.notionalUsd, 0).toFixed(4) : null;
}

// ── PERSISTENZA ─────────────────────────────────────────────────────────────────────────────────────

function leggiRegistroResidui(deps = {}) {
  const file = deps.registroResiduiFile || REGISTRO_FILE;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return normalizzaRegistro(raw);
  } catch {
    // Un file assente non è un errore: vuol dire che non c'è mai stato un residuo scoperto, che è lo
    // stato normale. A differenza di un tetto o di un kill, qui l'assenza non governa nessun gate.
    return { ...REGISTRO_VUOTO, residui: {} };
  }
}

function scriviRegistroResidui(registro, deps = {}) {
  const file = deps.registroResiduiFile || REGISTRO_FILE;
  const reg = normalizzaRegistro(registro);
  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: now, atIso: new Date(now).toISOString(), residui: reg.residui }, null, 2));
    fs.renameSync(tmp, file);   // atomico: nessun lettore vede mai un file a metà
    return { ok: true, count: Object.keys(reg.residui).length, reason: null };
  } catch (e) {
    return { ok: false, count: Object.keys(reg.residui).length, reason: e.message };
  }
}

module.exports = {
  registraResiduoScoperto, potaScadute, residuiPronti, capitaleFermoUsd, chiaveResiduo,
  leggiRegistroResidui, scriviRegistroResidui,
  REGISTRO_FILE, SCADENZA_MS, MAX_VOCI,
};
