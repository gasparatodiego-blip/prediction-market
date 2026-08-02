'use strict';
// lib/maker/clob-book-rest.js — la PROFONDITÀ del book letta dalla REST del CLOB, per i mercati che
// agent34 non segue. Sola lettura: una GET pubblica, nessuna firma, nessuna credenziale, nessun ordine.
//
// ═══ PERCHÉ QUESTA FONTE, E SOLO COME SECONDA ════════════════════════════════════════════════════════
// La profondità che il pannello mostra viene, quando esiste, dal book live di agent34: è lo STESSO
// snapshot websocket da cui escono mid e tocco, quindi le righe della scala e il mid sopra di esse sono
// per costruzione lo stesso istante — che è esattamente l'invariante che questo lavoro difende. Una
// seconda GET REST darebbe una scala presa in un momento diverso dal mid mostrato accanto: reintrodurrebbe
// il difetto appena chiuso, solo un piano più in basso.
//
// Ma agent34 è sottoscritto al board reward più i mercati abilitati dall'operatore, non a tutto
// Polymarket. Per gli altri l'alternativa non è «una fonte peggiore»: è NESSUNA profondità. Quindi:
//
//   1. book live di agent34  → mid, tocco e 12 livelli per lato dallo stesso snapshot. Sempre preferito.
//   2. REST GET /book        → SOLO quando il mercato non è nel feed. Mid, tocco e scala vengono TUTTI
//                              da questa singola risposta, quindi anche qui restano un solo istante.
//
// In nessun caso i due si mescolano dentro la stessa vista. È la regola che la mancanza di essa aveva
// prodotto «MID 20.0¢ · BID 21.0¢ · ASK 22.0¢».
//
// ═══ UN DETTAGLIO CHE MORDE ══════════════════════════════════════════════════════════════════════════
// `GET /book` restituisce i bid in ordine CRESCENTE e gli ask in ordine DECRESCENTE: in entrambi i casi
// il tocco è l'ULTIMO elemento dell'array. Verificato il 2026-08-02 sul token YES di «2026 F1 Drivers'
// Champion»: bids [0.001 … 0.746], asks [0.999 … 0.747]. Prendere `[0]` darebbe il livello più lontano
// dal mid. L'ordinamento non viene dato per scontato: lo rifà `buildLadder` in lib/maker/book-view.js.

const https = require('https');

const CLOB = 'clob.polymarket.com';
const UA = 'edgeradar-maker/1.0 (order book read; read-only)';
const DEFAULT_TIMEOUT_MS = 6_000;

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const num = (x) => {
  const v = typeof x === 'string' ? parseFloat(x) : x;
  return fin(v) ? v : null;
};

function httpGetJson(pathAndQuery, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const req = https.get(
      { host: CLOB, path: pathAndQuery, headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: timeoutMs },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve({ ok: false, error: `HTTP ${res.statusCode}`, data: null });
          try { resolve({ ok: true, error: null, data: JSON.parse(body) }); }
          catch (e) { resolve({ ok: false, error: `risposta non JSON: ${e.message}`, data: null }); }
        });
      },
    );
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ ok: false, error: e.message, data: null }));
  });
}

/**
 * Il book di UN token. Restituisce la forma che `bookView` consuma, così i due percorsi (feed e REST)
 * entrano nella stessa funzione e non possono divergere nel modo in cui calcolano il mid.
 *
 * @returns {Promise<{ok:boolean, error:string|null, book:null|{
 *   levels:{bids:Array,asks:Array}, tick:number|null, minOrderSize:number|null,
 *   lastTradePrice:number|null, negRisk:boolean|null, fetchedAt:number}}>}
 */
async function fetchTokenBook(tokenId, { timeoutMs = DEFAULT_TIMEOUT_MS, nowMs = Date.now() } = {}) {
  const id = typeof tokenId === 'string' ? tokenId.trim() : '';
  if (!/^\d+$/.test(id)) return { ok: false, error: 'token_id non valido', book: null };
  const r = await httpGetJson(`/book?token_id=${encodeURIComponent(id)}`, { timeoutMs });
  if (!r.ok) return { ok: false, error: r.error, book: null };
  const d = r.data || {};
  return {
    ok: true,
    error: null,
    book: {
      // Non ordinati qui di proposito: l'ordinamento è UNO SOLO, e vive in book-view.buildLadder.
      levels: { bids: Array.isArray(d.bids) ? d.bids : [], asks: Array.isArray(d.asks) ? d.asks : [] },
      // Il tick, che il book live NON pubblica: qui c'è, ed è una regola di venue vera, non un default.
      tick: num(d.tick_size),
      minOrderSize: num(d.min_order_size),
      lastTradePrice: num(d.last_trade_price),
      negRisk: typeof d.neg_risk === 'boolean' ? d.neg_risk : null,
      fetchedAt: nowMs,
    },
  };
}

/** I due lati insieme. Un lato che fallisce non annulla l'altro: si dichiara null e si dice perché. */
async function fetchMarketBooks({ tokenIdYes, tokenIdNo }, opts = {}) {
  const [yes, no] = await Promise.all([
    tokenIdYes ? fetchTokenBook(tokenIdYes, opts) : Promise.resolve({ ok: false, error: 'tokenId YES assente', book: null }),
    tokenIdNo ? fetchTokenBook(tokenIdNo, opts) : Promise.resolve({ ok: false, error: 'tokenId NO assente', book: null }),
  ]);
  return { yes, no };
}

module.exports = { fetchTokenBook, fetchMarketBooks, CLOB };
