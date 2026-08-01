'use strict';
// lib/maker/market-search.js — SEARCH POLYMARKET WITH NO REWARD FILTER.
//
// THE FILTER THIS FILE EXISTS TO REMOVE. Every market this project could see arrived through
// agents/agent24-liquidity-rewards.js, which fetches Gamma and keeps a market ONLY when
// clobRewards[0].rewardsDailyRate > 0. That is the right rule for a REWARD board — it is a board of
// reward markets — but it silently became the rule for everything downstream: the allocation planner
// scores `fundable` markets (allocator.js: `if (potByCond.has(mid))`), the normalized board carries only
// those rows, and so a market paying no liquidity reward was not merely hidden from a list — it could not
// be looked up, priced, or ordered on anywhere in this repo.
//
// This module answers the venue directly and returns WHATEVER IT FINDS: reward markets and reward-less
// markets alike, each carrying the three facts the operator needs to choose between them —
//   • reward_daily_rate     the published $/day pot, or null when the venue publishes none
//   • spread                the CURRENT book spread, in cents
//   • tick size             the venue's minimum price increment for this market
// plus the close time, which on this venue ranges from months (Ballon d'Or) to five minutes (Bitcoin Up
// or Down). A market with no reward pot is returned WITH `hasRewards:false` so the caller can label it
// rather than drop it: the point is an informed manual choice, not a shorter list.
//
// READ-ONLY. Two GETs against public Polymarket endpoints. It signs nothing, holds no key, places nothing,
// and writes no state — registering a market is a separate, audited act (lib/maker/market-catalog.js).
//
// FIELDS ARE REPORTED, NEVER INFERRED. A missing tick is null, not a guess; a missing reward rate is null
// (no programme published), which is a DIFFERENT fact from 0 and both are different from "not read yet".
// Downstream fails closed on nulls; inventing a plausible value here would defeat every one of those gates.

const https = require('https');
// Il pavimento sotto cui il venue non riesce nemmeno a ESPRIMERE la vita di un ordine — derivato dal
// suo floor GTD, non scelto da noi. La ricerca lo riusa come soglia di operabilità pratica.
const { MIN_SAFE_MINUTES } = require('./market-clock');

const GAMMA = 'gamma-api.polymarket.com';
const UA = 'edgeradar-maker/1.0 (market search; read-only)';
const DEFAULT_TIMEOUT_MS = 12_000;
// Gamma's search returns events; each event holds one or more markets. Enrichment is batched by
// condition id, and the batch is bounded so one search cannot turn into a hundred-id URL.
const MAX_RESULTS = 40;
const ENRICH_BATCH = 20;

function httpGetJson(pathAndQuery, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const req = https.get({ host: GAMMA, path: pathAndQuery, headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ ok: false, error: `HTTP ${res.statusCode}`, data: null });
        try { resolve({ ok: true, error: null, data: JSON.parse(body) }); }
        catch (e) { resolve({ ok: false, error: `risposta non JSON: ${e.message}`, data: null }); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ ok: false, error: e.message, data: null }));
  });
}

// THE LABEL, declared ONCE. Both API routes and the panel show it, and the selfcheck asserts on it — a
// second copy of this string somewhere would be a second answer to "does this market pay anything".
const NO_REWARD_LABEL = 'NESSUN REWARD — solo trading direzionale';

/** How a market's reward status must be shown. Never "$0.00/g": no programme is not an empty pot. */
function rewardLabelFor(m) {
  return m && m.hasRewards ? `reward ${m.rewardsDailyRate}$/g` : NO_REWARD_LABEL;
}

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function isConditionId(s) { return typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s.trim()); }

/** The venue's clobRewards array → the published daily pot, or null when there is no programme. */
function rewardRateOf(m) {
  const cr = Array.isArray(m.clobRewards) ? m.clobRewards : null;
  if (!cr || !cr.length) return null;
  const rate = num(cr[0].rewardsDailyRate);
  return rate == null ? null : rate;
}

function tokenIdsOf(m) {
  let ids = m.clobTokenIds;
  if (typeof ids === 'string') { try { ids = JSON.parse(ids); } catch { ids = null; } }
  if (!Array.isArray(ids) || ids.length < 2) return { yes: null, no: null };
  return { yes: String(ids[0]), no: String(ids[1]) };
}

/**
 * ONE Gamma market → the row this project speaks. Everything the placement path will later need is
 * carried here, so registering a market never needs a second, differently-shaped fetch.
 */
function normalizeMarket(m, nowMs = Date.now()) {
  const tokens = tokenIdsOf(m);
  const bestBid = num(m.bestBid);
  const bestAsk = num(m.bestAsk);
  const mid = (bestBid != null && bestAsk != null) ? +(((bestBid + bestAsk) / 2).toFixed(6)) : null;
  // Gamma's own `spread` is in price units; cents is what the band and the panel speak.
  const spreadPrice = num(m.spread);
  const spreadCents = spreadPrice != null
    ? +(spreadPrice * 100).toFixed(3)
    : (bestBid != null && bestAsk != null ? +((bestAsk - bestBid) * 100).toFixed(3) : null);
  const rate = rewardRateOf(m);
  const endMs = typeof m.endDate === 'string' ? Date.parse(m.endDate) : NaN;
  return {
    marketId: typeof m.conditionId === 'string' ? m.conditionId : null,
    question: m.question ?? null,
    slug: m.slug ?? null,
    category: m.category ?? null,
    endDate: m.endDate ?? null,
    minutesToClose: Number.isFinite(endMs) ? +((endMs - nowMs) / 60_000).toFixed(1) : null,
    // ── the three facts the panel must show for EVERY row ──
    rewardsDailyRate: rate,                       // null ⇒ the venue publishes no reward programme
    hasRewards: rate != null && rate > 0,
    spreadCents,                                  // current book spread
    tick: num(m.orderPriceMinTickSize),           // never assumed
    // ── the rest of what a placement needs; each null is a refusal downstream, never a default ──
    rewardsMaxSpreadCents: num(m.rewardsMaxSpread),
    rewardsMinSize: num(m.rewardsMinSize),
    negRisk: typeof m.negRisk === 'boolean' ? m.negRisk : null,
    tokenIdYes: tokens.yes,
    tokenIdNo: tokens.no,
    bestBid, bestAsk, mid,
    active: m.active === true,
    closed: m.closed === true,
    acceptingOrders: m.acceptingOrders === true,
    fetchedAt: nowMs,
  };
}

/** Batch-enrich condition ids through /markets?condition_ids=… (the only response that carries
 *  clobRewards, negRisk and the tick — Gamma's search response does not). */
async function fetchMarketsByConditionIds(ids, { nowMs = Date.now(), timeoutMs } = {}) {
  const out = [];
  const clean = (ids || []).filter(isConditionId);
  for (let i = 0; i < clean.length; i += ENRICH_BATCH) {
    const batch = clean.slice(i, i + ENRICH_BATCH);
    const q = batch.map((c) => `condition_ids=${encodeURIComponent(c)}`).join('&');
    const r = await httpGetJson(`/markets?${q}&limit=${batch.length}`, { timeoutMs });
    if (!r.ok) return { ok: false, error: r.error, markets: out };
    const arr = Array.isArray(r.data) ? r.data : (Array.isArray(r.data && r.data.data) ? r.data.data : []);
    for (const m of arr) {
      const row = normalizeMarket(m, nowMs);
      if (row.marketId) out.push(row);
    }
  }
  return { ok: true, error: null, markets: out };
}

/**
 * È OPERABILE? Un verdetto solo, condiviso da ogni ricerca della dashboard.
 *
 * Il filtro `events_status=active` di Gamma e lo scarto dei `closed` coprono il caso normale, ma non la
 * FINESTRA: su un venue che apre un mercato ogni cinque minuti esiste un intervallo, fra la scadenza e
 * il momento in cui Gamma lo marca chiuso, in cui un mercato morto è ancora `closed:false`. In quella
 * finestra la ricerca lo mostrava insieme a quelli vivi, e da fuori i due sono indistinguibili.
 *
 * Quattro condizioni, ognuna un fatto del venue, nessuna dedotta:
 *   closed          risolto
 *   active=false    ritirato dal venue
 *   acceptingOrders non prende ordini adesso
 *   endDate passato scaduto, comunque lo chiami il venue
 *
 * `null` non è mai un rifiuto: un campo che il venue non pubblica lascia il mercato operabile e il
 * motivo lo dice. Scartare per assenza di dato è come scartare per assenza di prova.
 *
 * @returns {{tradable:boolean, reason:string|null}}
 */
function tradability(m) {
  if (!m) return { tradable: false, reason: 'mercato non leggibile' };
  if (m.closed === true) return { tradable: false, reason: 'risolto' };
  if (m.active === false) return { tradable: false, reason: 'ritirato dal venue (active=false)' };
  if (m.acceptingOrders === false) return { tradable: false, reason: 'non accetta ordini in questo momento' };
  if (typeof m.minutesToClose === 'number' && Number.isFinite(m.minutesToClose)) {
    if (m.minutesToClose <= 0) {
      return { tradable: false, reason: `scaduto da ${Math.abs(m.minutesToClose).toFixed(0)} min` };
    }
    // ── IL PAVIMENTO PRATICO, E PERCHÉ È QUESTO ─────────────────────────────────────────────────
    // Sotto MIN_SAFE_MINUTES il venue non può esprimere NESSUNA vita d'ordine: il suo floor GTD è una
    // scadenza dichiarata ad almeno 3 minuti, che scade 60s in anticipo, e la finestra viene firmata
    // al 90% della vita residua (lib/maker/market-clock). Il numero non è scelto qui, è derivato lì.
    //
    // Su un mercato a ciclo di 5 minuti questo conta davvero: fra il momento in cui la riga compare e
    // il momento in cui l'operatore ha premuto anteprima e conferma passano decine di secondi, e un
    // mercato mostrato a 40 secondi dalla fine è un invito a un'azione che non può riuscire. Sopra la
    // soglia resta tutto visibile, con il badge che dice quanto manca: poco tempo è un rischio da
    // mostrare, non un motivo per nascondere — ma sotto il pavimento non c'è più nessuna azione da
    // proporre, e mostrarlo sarebbe proporla lo stesso.
    if (m.minutesToClose < MIN_SAFE_MINUTES) {
      return { tradable: false, reason: `scade fra ${m.minutesToClose.toFixed(1)} min, sotto il minimo di ${MIN_SAFE_MINUTES} che il venue riesce a esprimere` };
    }
  }
  return { tradable: true, reason: null };
}

/** ONE market by condition id (what the "add this market" flow re-reads before writing anything). */
async function fetchMarketByConditionId(conditionId, opts = {}) {
  if (!isConditionId(conditionId)) return { ok: false, error: 'conditionId non valido (atteso 0x + 64 esadecimali)', market: null };
  const r = await fetchMarketsByConditionIds([conditionId], opts);
  if (!r.ok) return { ok: false, error: r.error, market: null };
  const m = r.markets.find((x) => x.marketId && x.marketId.toLowerCase() === conditionId.trim().toLowerCase());
  if (!m) return { ok: false, error: 'mercato non trovato su Gamma per questo conditionId', market: null };
  return { ok: true, error: null, market: m };
}

/**
 * SEARCH. `q` is either a condition id (exact lookup) or free text (Gamma's own search, then enrichment).
 *
 * NO FILTER IS APPLIED ON REWARDS — that is the whole point of the module. Two filters that ARE applied,
 * and why they are not the same thing:
 *   • `closed` markets are dropped unless includeClosed — a resolved market cannot be quoted at all, and
 *     showing it as an option would be offering something that does not exist.
 *   • NON-OPERABLE markets are dropped unless includeNonTradable (see tradability): resolved, withdrawn,
 *     not accepting orders, or past their end date. `notTradableDropped` reports how many, so a shorter
 *     list never passes for a search that found less.
 *   • nothing else. A market with no reward pot, an empty book, a wide spread or five minutes of life left
 *     is RETURNED, labelled with exactly that, and left to the operator: «poco tempo» is a risk to show,
 *     not a reason to hide.
 *
 * @returns {{ok:boolean, error:string|null, query:string, count:number, markets:object[],
 *            withRewards:number, withoutRewards:number, fetchedAt:number}}
 */
async function searchMarkets({ q = '', limit = 25, includeClosed = false, includeNonTradable = false, nowMs = Date.now(), timeoutMs } = {}) {
  const query = typeof q === 'string' ? q.trim() : '';
  const cap = Math.max(1, Math.min(MAX_RESULTS, Number(limit) || 25));
  const empty = { ok: true, error: null, query, count: 0, markets: [], withRewards: 0, withoutRewards: 0, notTradableDropped: 0, fetchedAt: nowMs };
  if (!query) return { ...empty, ok: false, error: 'nessun termine di ricerca' };

  let ids = [];
  if (isConditionId(query)) {
    ids = [query];
  } else {
    // events_status=active is NOT optional: without it Gamma's search happily ranks long-resolved events
    // first (measured: 8/8 results closed for "bitcoin up or down"), so a search for a recurring
    // short-dated market returns yesterday's copies of it and nothing quotable.
    const statusQ = includeClosed ? '' : '&events_status=active';
    // ── LA LARGHEZZA DELLA PESCA NON È IL NUMERO DI RISULTATI ────────────────────────────────────
    // `limit_per_type` limita gli EVENTI che Gamma restituisce, non i mercati. Legarlo a `cap` (il
    // numero di righe che il chiamante vuole vedere) significava chiedere 25 eventi per mostrare 25
    // righe — e i mercati a ciclo breve vivono in eventi che la rilevanza di Gamma mette PIÙ IN BASSO,
    // perché sono eventi da un mercato solo con un titolo pieno di orari.
    //
    // Misurato su «bitcoin» (2026-08-01 16:22 UTC), con un mercato reale a 17 minuti dalla scadenza:
    //   limit_per_type=25  → 25 eventi, 211 mercati, il più vicino a 36.8m, il 12:35-12:40 ASSENTE
    //   limit_per_type=40  → 40 eventi, 226 mercati, il più vicino a 16.8m, PRESENTE
    //   limit_per_type=100 → 50 eventi (Gamma si ferma lì), stesso esito di 40
    // Quindi si chiede sempre la larghezza massima utile, indipendentemente da quante righe servono:
    // è UNA richiesta, lo stesso costo di prima, e i mercati brevi entrano nel campione. Il taglio a
    // `cap` avviene dopo, sui mercati, dove è il posto giusto per farlo.
    const EVENT_FETCH_WIDTH = 50; // il tetto di Gamma: oltre, restituisce comunque 50
    const r = await httpGetJson(`/public-search?q=${encodeURIComponent(query)}&limit_per_type=${EVENT_FETCH_WIDTH}${statusQ}`, { timeoutMs });
    if (!r.ok) return { ...empty, ok: false, error: `ricerca Gamma fallita: ${r.error}` };
    const events = Array.isArray(r.data && r.data.events) ? r.data.events : [];

    // ── UN MERCATO PER EVENTO, POI IL SECONDO, POI IL TERZO ──────────────────────────────────────
    // Gamma restituisce EVENTI, e un evento può contenere un mercato o trenta. Raccogliere in
    // profondità — tutti i mercati dell'evento 1, poi quelli dell'evento 2 — esaurisce il budget sui
    // primi eventi e non arriva mai agli altri.
    //
    // Misurato su «ethereum» (2026-08-01): 25 eventi, 169 mercati. I primi due eventi
    // («What price will Ethereum hit July 27-August 2?» e «…in August?») ne portano 34 da soli, cioè
    // già più del budget di 25. Risultato: TUTTI e 25 i risultati venivano da quei due eventi e
    // condividevano la stessa scadenza (2139 minuti), mentre i 12 eventi «Ethereum Up or Down» —
    // uno per ciclo da 5, 15 o 60 minuti, un mercato ciascuno — erano nella risposta e non venivano
    // mai raggiunti. Il difetto colpisce esattamente i mercati brevi, perché sono eventi da UN
    // mercato: in profondità arrivano sempre dopo, in ampiezza arrivano subito.
    //
    // A giro tondo ogni evento contribuisce il suo primo mercato prima che qualsiasi evento
    // contribuisca il secondo. Nessuna richiesta in più al venue: è lo stesso payload, letto in un
    // ordine diverso.
    const lists = events.map((ev) => (Array.isArray(ev.markets) ? ev.markets : []));
    const deepest = lists.reduce((m, l) => Math.max(m, l.length), 0);
    const seen = new Set();
    outer:
    for (let round = 0; round < deepest; round++) {
      for (const list of lists) {
        const m = list[round];
        if (!m) continue;
        const cid = typeof m.conditionId === 'string' ? m.conditionId : null;
        if (!cid || seen.has(cid.toLowerCase())) continue;
        if (!includeClosed && m.closed === true) continue;
        seen.add(cid.toLowerCase());
        ids.push(cid);
        if (ids.length >= cap) break outer;
      }
    }
    if (!ids.length) return { ...empty, ok: true, error: null };
  }

  const en = await fetchMarketsByConditionIds(ids, { nowMs, timeoutMs });
  if (!en.ok && !en.markets.length) return { ...empty, ok: false, error: `lettura dei mercati fallita: ${en.error}` };
  // OGNI riga porta il proprio verdetto, così un chiamante che li voglia tutti (includeNonTradable)
  // può mostrarli SAPENDO quali sono, invece di doverlo ridedurre.
  const judged = en.markets.map((m) => { const t = tradability(m); return { ...m, tradable: t.tradable, notTradableReason: t.reason }; });
  const dropped = judged.filter((m) => !m.tradable).length;
  const markets = judged
    .filter((m) => includeNonTradable || m.tradable)
    .slice(0, cap)
    // Soonest to close first: on a venue that runs 5-minute markets alongside multi-month ones, the
    // remaining life is the single most decision-relevant field, so it drives the order.
    .sort((a, b) => {
      const av = a.minutesToClose == null ? Number.POSITIVE_INFINITY : a.minutesToClose;
      const bv = b.minutesToClose == null ? Number.POSITIVE_INFINITY : b.minutesToClose;
      return av - bv;
    });

  return {
    ok: true, error: en.ok ? null : `alcuni mercati non sono stati letti: ${en.error}`,
    query, count: markets.length, markets,
    withRewards: markets.filter((m) => m.hasRewards).length,
    withoutRewards: markets.filter((m) => !m.hasRewards).length,
    // Quanti ne sono stati tolti perché non operabili — dichiarato, non silenzioso: una lista che si
    // accorcia senza dirlo è indistinguibile da una ricerca che non trova.
    notTradableDropped: dropped,
    fetchedAt: nowMs,
  };
}

module.exports = {
  tradability,
  searchMarkets, fetchMarketByConditionId, fetchMarketsByConditionIds,
  normalizeMarket, isConditionId, rewardRateOf, rewardLabelFor,
  MAX_RESULTS, NO_REWARD_LABEL,
};
