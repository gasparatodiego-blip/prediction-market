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

// «Non l'ho letto» non è «non paga», nemmeno sullo schermo. Un mercato il cui montepremi non è stato
// letto mostrava la stessa etichetta di uno tolto dal programma — e quella etichetta è un'affermazione
// sul venue, non sul nostro dato.
const UNREADABLE_REWARD_LABEL = 'MONTEPREMI NON LETTO — il venue non l\'ha pubblicato in questa risposta';

/** How a market's reward status must be shown. Never "$0.00/g": no programme is not an empty pot. */
function rewardLabelFor(m) {
  if (m && m.hasRewards) return `reward ${m.rewardsDailyRate}$/g`;
  if (m && m.rewardsStato === 'illeggibile') return UNREADABLE_REWARD_LABEL;
  return NO_REWARD_LABEL;
}

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function isConditionId(s) { return typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s.trim()); }

// ── IL MONTEPREMI HA TRE STATI, NON DUE ─────────────────────────────────────────────────────────────
// Fino al 5 agosto 2026 questa funzione restituiva un numero oppure `null`, e `null` significava DUE
// cose diverse schiacciate in una: «il venue dice che questo mercato non è nel programma premi» e «il
// venue non me l'ha detto». Da lì `hasRewards: rate != null && rate > 0` produceva `false` in entrambi
// i casi — cioè un'affermazione SUL VENUE che il codice non era in grado di sostenere.
//
// Osservato tre volte quel giorno su mercati che pagavano: «China invade Taiwan» ($50/g) e «Netanyahu
// out by end of 2026» ($30/g) riportati come senza montepremi. Il gate `reward-contraddizione`
// (app/api/maker/markets/enable/route.ts:137) rifiutava l'ingresso in coda dicendo che il venue non
// paga — un motivo falso per un blocco altrimenti corretto.
//
// LO STESSO REPO LA REGOLA CE L'HA GIÀ, e la scrive per esteso in lib/maker/market-validity.js:88-92:
// «è illeggibile, non è zero. Zero significa "tolto dal programma", ed è una conclusione che si può
// trarre solo da un numero davvero letto». Quel modulo restituisce tre stati; questo ne restituiva due.
//
// ── PERCHÉ ANCHE LA FORMA STRINGA ──────────────────────────────────────────────────────────────────
// Gamma serializza alcuni campi JSON come stringhe e non è coerente su quali. In UNA sola risposta,
// misurata: `clobRewards` array, `clobTokenIds` stringa, `outcomes` stringa, `outcomePrices` stringa.
// `tokenIdsOf`, venti righe più sotto, si difende già da questo per i token id — `rewardRateOf` no, e
// con `Array.isArray` falso il mercato risultava senza montepremi. È il meccanismo più probabile
// dell'intermittenza osservata, anche se non l'ho colto sul fatto: la difesa costa tre righe e toglie
// la domanda.

/**
 * Lo stato del montepremi pubblicato dal venue.
 * @returns {{stato:'premiato'|'senza-premio'|'illeggibile', rate:number|null, perche:string}}
 */
function rewardStateOf(m) {
  let cr = m ? m.clobRewards : null;
  // La forma stringa, come per `clobTokenIds`. Una stringa che non si lascia interpretare NON è
  // «nessun programma»: è un dato che non si è letto.
  if (typeof cr === 'string') {
    try { cr = JSON.parse(cr); }
    catch { return { stato: 'illeggibile', rate: null, perche: 'clobRewards è una stringa non interpretabile' }; }
  }
  if (cr === undefined || cr === null) {
    return { stato: 'illeggibile', rate: null, perche: 'il venue non ha pubblicato il campo clobRewards in questa risposta' };
  }
  if (!Array.isArray(cr)) {
    return { stato: 'illeggibile', rate: null, perche: `clobRewards ha una forma inattesa (${typeof cr})` };
  }
  // Array VUOTO: il venue ha parlato e dice che non c'è programma. Questo sì è un «no» letto.
  if (!cr.length) return { stato: 'senza-premio', rate: 0, perche: 'il venue pubblica clobRewards vuoto: nessun programma premi' };
  const rate = num(cr[0].rewardsDailyRate);
  if (rate == null) {
    return { stato: 'illeggibile', rate: null, perche: 'clobRewards c\'è ma rewardsDailyRate non è un numero' };
  }
  if (rate <= 0) return { stato: 'senza-premio', rate, perche: `il venue pubblica un montepremi di ${rate}` };
  return { stato: 'premiato', rate, perche: `montepremi pubblicato: ${rate}$/g` };
}

/** Il montepremi come numero, o null. Compatibile con i chiamanti di sempre: chi deve distinguere
 *  «non c'è programma» da «non l'ho letto» usa `rewardStateOf`, non questa. */
function rewardRateOf(m) {
  const s = rewardStateOf(m);
  return s.stato === 'premiato' ? s.rate : (s.stato === 'senza-premio' ? s.rate : null);
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
  const reward = rewardStateOf(m);
  const rate = reward.stato === 'illeggibile' ? null : reward.rate;
  const endMs = typeof m.endDate === 'string' ? Date.parse(m.endDate) : NaN;
  return {
    marketId: typeof m.conditionId === 'string' ? m.conditionId : null,
    question: m.question ?? null,
    slug: m.slug ?? null,
    category: m.category ?? null,
    endDate: m.endDate ?? null,
    minutesToClose: Number.isFinite(endMs) ? +((endMs - nowMs) / 60_000).toFixed(1) : null,
    // ── the three facts the panel must show for EVERY row ──
    rewardsDailyRate: rate,                       // null ⇒ non letto; 0 ⇒ letto e non premiato
    // `hasRewards` resta un booleano perché è quello che i chiamanti leggono da sempre, ma vuol dire
    // «il venue ha detto che paga» — non «il venue non ha detto che paga». Le due cose si distinguono
    // con `rewardsStato`, e chi decide sul capitale deve guardare QUELLO.
    hasRewards: reward.stato === 'premiato',
    rewardsStato: reward.stato,                   // 'premiato' | 'senza-premio' | 'illeggibile'
    rewardsPerche: reward.perche,                 // la frase da mostrare quando non è 'premiato'
    spreadCents,                                  // current book spread
    tick: num(m.orderPriceMinTickSize),           // never assumed
    // ── the rest of what a placement needs; each null is a refusal downstream, never a default ──
    rewardsMaxSpreadCents: num(m.rewardsMaxSpread),
    rewardsMinSize: num(m.rewardsMinSize),
    // ⚠ IL SECONDO MINIMO, E QUI IL CAMPO SI CHIAMA `orderMinSize` — questa e' Gamma, non il CLOB, e i
    // due endpoint gli danno due nomi diversi per lo stesso numero (`minimum_order_size` sul CLOB).
    // NON e' `rewardsMinSize` qui sopra: quello e' il pavimento PREMIANTE e dice «reward zero», questo
    // e' il MINIMO D'ORDINE e dice «il venue rifiuta». Vedi `lib/maker/minimi-del-venue.js`.
    // ⚠ Assente ⇒ `null`, mai 0 e mai un ripiego sull'altro: a valle il percorso d'uscita si ferma
    // dichiarando il conditionId invece di indovinare.
    minOrderSize: num(m.orderMinSize),
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
async function fetchMarketsByConditionIds(ids, { nowMs = Date.now(), timeoutMs, get } = {}) {
  const chiedi = typeof get === 'function' ? get : httpGetJson;
  const out = [];
  const clean = (ids || []).filter(isConditionId);
  const mancanti = [];
  for (let i = 0; i < clean.length; i += ENRICH_BATCH) {
    const batch = clean.slice(i, i + ENRICH_BATCH);
    const q = batch.map((c) => `condition_ids=${encodeURIComponent(c)}`).join('&');
    // ── `limit` NON SI LEGA AL NUMERO DI ID CHIESTI ────────────────────────────────────────────────
    // Era `limit=${batch.length}`, cioè esattamente quanti id si stavano chiedendo, e finché Gamma
    // risponde una riga per condition_id i due numeri coincidono. Ma il limite è sulle RIGHE della
    // risposta, non sugli id: basta che una risposta ne porti una in più — una qualunque forma di
    // duplicato, oggi o dopo un cambio lato venue — perché l'ultima venga tagliata via.
    //
    // E il taglio è la parte pericolosa, perché non somiglia a un errore: il mercato tagliato non
    // torna, chi legge non lo trova, e «non me l'hanno mandato» diventa indistinguibile da «non ha
    // montepremi». È esattamente il modo in cui un mercato che paga viene scartato dal gate
    // `reward-contraddizione` con un motivo falso — lo stesso guasto del 5 agosto 2026, per un'altra
    // strada. Un tetto generoso non costa niente: gli id sono già il filtro.
    const tetto = Math.max(100, batch.length * 2);
    const r = await chiedi(`/markets?${q}&limit=${tetto}`, { timeoutMs });
    if (!r.ok) return { ok: false, error: r.error, markets: out, missing: mancanti.concat(batch) };
    const arr = Array.isArray(r.data) ? r.data : (Array.isArray(r.data && r.data.data) ? r.data.data : []);
    const visti = new Set();
    for (const m of arr) {
      const row = normalizeMarket(m, nowMs);
      if (!row.marketId) continue;
      visti.add(row.marketId.toLowerCase());
      out.push(row);
    }
    // ── UNA RISPOSTA CORTA SI DICHIARA ────────────────────────────────────────────────────────────
    // Se un id chiesto non torna, la sua assenza viene NOMINATA invece di essere lasciata dedurre.
    // Chi chiama può così distinguere «il venue dice che non paga» da «il venue non me l'ha mandato»,
    // che è la stessa distinzione che rewardStateOf fa sul montepremi — qui applicata alla riga intera.
    for (const c of batch) if (!visti.has(c.toLowerCase())) mancanti.push(c);
  }
  return { ok: true, error: null, markets: out, missing: mancanti };
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

    // Giro tondo, ma il giro si COMPLETA prima di fermarsi: interrompere a meta' del primo giro
    // significava rappresentare solo i primi `cap` eventi e lasciar fuori tutti gli altri. Con 50
    // eventi e un budget di 25 righe, gli eventi dal 26 al 50 non contribuivano mai — ed e' proprio
    // li' che la rilevanza di Gamma mette i cicli brevi. Misurato: il venue aveva mercati a 11 e 16
    // minuti mentre la lista si fermava a 22.
    const pool = [];
    for (let round = 0; round < deepest; round++) {
      for (const list of lists) {
        const m = list[round];
        if (!m) continue;
        const cid = typeof m.conditionId === 'string' ? m.conditionId : null;
        if (!cid || seen.has(cid.toLowerCase())) continue;
        if (!includeClosed && m.closed === true) continue;
        seen.add(cid.toLowerCase());
        const t = typeof m.endDate === 'string' ? Date.parse(m.endDate) : NaN;
        pool.push({ cid, endMs: Number.isFinite(t) ? t : null });
      }
      // Fermarsi a giro finito, non a meta': cosi' ogni evento ha contribuito il suo n-esimo mercato
      // prima che si decida che il campione basta.
      if (pool.length >= cap) break;
    }

    // ── LA SELEZIONE È PER TEMPO, PERCHÉ LA VISUALIZZAZIONE LO È ────────────────────────────────
    // Il taglio a `cap` decide QUALI mercati sopravvivono, e finora lo decideva l'ordine di
    // rilevanza di Gamma. Ma la lista viene poi ordinata per tempo residuo, quindi selezionare per
    // rilevanza e mostrare per tempo sono due criteri diversi applicati in fila: il risultato e' che
    // un mercato a 11 minuti veniva scartato in selezione da uno a 35 ore.
    // L'endDate e' gia' nel payload della ricerca — nessuna richiesta in piu' per averlo.
    pool.sort((a, b) => {
      if (a.endMs == null && b.endMs == null) return 0;
      if (a.endMs == null) return 1;   // scadenza ignota in fondo: non e' urgenza, e' assenza di dato
      if (b.endMs == null) return -1;
      return a.endMs - b.endMs;
    });
    ids = pool.slice(0, cap).map((x) => x.cid);
    if (!ids.length) return { ...empty, ok: true, error: null };
  }

  const en = await fetchMarketsByConditionIds(ids, { nowMs, timeoutMs });
  if (!en.ok && !en.markets.length) return { ...empty, ok: false, error: `lettura dei mercati fallita: ${en.error}` };
  // ══ SECONDA FETCH MIRATA PER I MONTEPREMI NON LETTI (12 agosto 2026) ═══════════════════════════
  // `clobRewards` a volte non arriva — una riga tagliata dal `limit`, una risposta parziale, un campo
  // omesso. `rewardStateOf` risponde gia' `illeggibile` invece di `senza-premio`, ma il verdetto
  // restava tratto da UNA sola lettura, e a valle il gate scartava un mercato che magari paga.
  // Adesso ogni riga illeggibile viene richiesta una seconda volta per condition_id, con cache a TTL
  // 10 minuti e un tetto di richieste per ciclo. `require` differito: chi non ha righe illeggibili
  // non carica nemmeno il modulo.
  let riprova = null;
  const daRiprovare = en.markets.filter((m) => m && m.rewardsStato === 'illeggibile').length;
  if (daRiprovare > 0) {
    try {
      const RR = require('./reward-riprova');
      riprova = await RR.risolviPremiMancanti({
        righe: en.markets, nowMs,
        fetchOne: (cid) => fetchMarketByConditionId(cid, { nowMs, timeoutMs }),
      });
      en.markets = riprova.righe;
    } catch { riprova = null; /* una riprova che fallisce lascia il verdetto di prima, mai peggio */ }
  }
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
    // Gli id chiesti che il venue non ha restituito. Zero è il caso normale; un numero diverso da zero
    // vuol dire che quella ricerca è INCOMPLETA, e chi la mostra deve poterlo dire invece di
    // presentare una lista corta come se fosse tutto ciò che esiste.
    missing: Array.isArray(en.missing) ? en.missing : [],
    // ── LA SECONDA LETTURA, DICHIARATA ──────────────────────────────────────────────────────────
    // Senza questo blocco «il montepremi era gia' li'» e «ce lo siamo andati a riprendere» sarebbero
    // lo stesso risultato, e non ci sarebbe modo di misurare quanto spesso la prima lettura sbaglia.
    rewardRiprova: riprova
      ? { riprovate: riprova.riprovate, risolte: riprova.risolte, sconosciute: riprova.sconosciute,
        daCache: riprova.daCache, oltreIlTetto: riprova.oltreIlTetto, tetto: riprova.tetto }
      : null,
    fetchedAt: nowMs,
  };
}

module.exports = {
  tradability,
  searchMarkets, fetchMarketByConditionId, fetchMarketsByConditionIds,
  normalizeMarket, isConditionId, rewardRateOf, rewardStateOf, rewardLabelFor,
  MAX_RESULTS, NO_REWARD_LABEL, UNREADABLE_REWARD_LABEL,
};
