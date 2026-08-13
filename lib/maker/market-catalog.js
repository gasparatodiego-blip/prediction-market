'use strict';
// lib/maker/market-catalog.js — WHAT THE PANEL KNOWS ABOUT A MARKET IT ADDED BY HAND.
//
// WHY IT EXISTS. Everything the maker could previously quote came from the reward board (agent24 →
// data/liquidity-rewards.json → the normalized /tmp copy), and agent24 fetches Gamma with ONE filter:
// clobRewards[0].rewardsDailyRate > 0. So a market with no reward programme was not "hidden from the UI"
// — it did not exist anywhere in this repo's data, which meant lib/maker/manual-order.resolveMarketRules
// could not read its tick, its token ids or its negRisk flag, and every order on it was refused at
// `rules-unreadable` long before any gate had an opinion.
//
// This is the record that makes a hand-picked market judgeable: the venue's own metadata for it, fetched
// from Gamma/CLOB at the moment the operator adds it, written durably, and read back by resolveMarketRules
// as a FALLBACK — never as an override. A market that is on the reward board keeps using the board (live,
// refreshed every cycle); the catalog only answers for markets the board has never heard of.
//
// IT GRANTS NO AUTHORITY. Being in this catalog does not make a market placeable: the live-min allowlist
// (cfg.enabledMarketIds), manual mode, the caps, the kill switch, venue-rules and validateOrder() all still
// apply and are all elsewhere. This file only answers "what are this market's venue parameters, and when
// did we last read them" — it can make an order REFUSABLE (a stale or missing field fails closed), never
// permissible.
//
// THE AGE IS PART OF THE RECORD. A catalog row carries fetchedAt, and everything downstream reports the
// age of the mid it judged against rather than presenting a snapshot as if it were live. A hand order's
// price is the operator's decision; hiding how old the reference mid is would make that decision worse,
// not safer.
//
// Same shape and discipline as the other durable maker state (lib/maker/auto-reprice-config.js):
// atomic write, fail-closed read, and an append-only audit line for every change.

const path = require('path');
const { readStore, writeStoreAtomic, DATA_DIR } = require('../safety/store');

const CATALOG_FILE = path.join(DATA_DIR, 'maker-manual-markets.json');
const AUDIT_FILE = path.join(DATA_DIR, 'maker-manual-markets-audit.jsonl');

const EMPTY_CATALOG = Object.freeze({ markets: {}, updatedAt: null });

function catDeps(deps = {}) {
  return {
    catalogFile: deps.catalogFile || CATALOG_FILE,
    auditFile: deps.catalogAuditFile || AUDIT_FILE,
    now: deps.now || (() => Date.now()),
    fs: deps.fs || require('fs'),
  };
}

function normId(v) { return typeof v === 'string' ? v.trim().toLowerCase() : ''; }
function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

/**
 * Read the whole catalog. Never throws. An UNREADABLE catalog reports readable:false with NO markets —
 * which downstream means "no fallback metadata", i.e. the same refusal as a market nobody has added.
 * @returns {{readable:boolean, error:(string|null), markets:object, count:number, catalogFile:string}}
 */
function readMarketCatalog(deps = {}) {
  const c = catDeps(deps);
  const r = readStore(c.catalogFile, EMPTY_CATALOG, deps);
  if (!r.ok) return { readable: false, error: r.error, markets: {}, count: 0, catalogFile: c.catalogFile };
  const st = (r.value && typeof r.value === 'object') ? r.value : EMPTY_CATALOG;
  const markets = (st.markets && typeof st.markets === 'object') ? st.markets : {};
  return { readable: true, error: null, markets, count: Object.keys(markets).length, catalogFile: c.catalogFile };
}

/** One market's record, or null. */
function readMarketRecord(marketId, deps = {}) {
  const cat = readMarketCatalog(deps);
  const id = normId(marketId);
  return (id && cat.markets[id]) || null;
}

function appendAudit(rec, c) {
  try {
    c.fs.mkdirSync(path.dirname(c.auditFile), { recursive: true });
    c.fs.appendFileSync(c.auditFile, JSON.stringify(rec) + '\n');
  } catch { /* best-effort: an audit-write failure must never stop the write it describes */ }
}

/**
 * FIELDS THAT MUST BE PRESENT before a market can be catalogued. Each one is something the placement path
 * refuses without, so a half-fetched record is rejected HERE — where the operator can see why — instead of
 * becoming a `rules-unreadable` refusal at order time with no explanation of what was missing.
 *   tokenIdYes / tokenIdNo  the two books; a hand order names one of them
 *   tick                    never assumed (0.1 / 0.01 / 0.001 / 0.0001 / 0.0025 all exist on this venue)
 *   negRisk                 decides WHICH exchange contract the order settles against
 * `mid` may be null (an empty book has no mid) — the placement path refuses on a missing mid by itself,
 * and it says which piece was missing.
 */
const REQUIRED_FIELDS = Object.freeze(['tokenIdYes', 'tokenIdNo', 'tick', 'negRisk']);

function missingFields(m) {
  const miss = [];
  if (!m || typeof m !== 'object') return REQUIRED_FIELDS.slice();
  if (!m.tokenIdYes) miss.push('tokenIdYes');
  if (!m.tokenIdNo) miss.push('tokenIdNo');
  if (!fin(m.tick) || !(m.tick > 0)) miss.push('tick');
  if (typeof m.negRisk !== 'boolean') miss.push('negRisk');
  return miss;
}

/**
 * Write (or refresh) ONE market's venue metadata. Read-modify-write on a fresh object, atomic, audited.
 *
 * @param {object} market  the venue snapshot — see REQUIRED_FIELDS. Extra fields are kept verbatim.
 * @param {{by?:string, reason?:string}} who
 * @returns {{ok:boolean, error?:string, marketId:string|null, record?:object, missing?:string[]}}
 */
function upsertMarket(market = {}, { by = null, reason = null } = {}, deps = {}) {
  const c = catDeps(deps);
  const id = normId(market.marketId || market.conditionId);
  if (!id) return { ok: false, error: 'marketId (conditionId) mancante', marketId: null };
  const miss = missingFields(market);
  if (miss.length) {
    return {
      ok: false, marketId: id, missing: miss,
      error: `metadati di venue incompleti per questo mercato (mancano: ${miss.join(', ')}) — rifiuto di registrarlo: un mercato senza tick/token/negRisk letti dal venue produrrebbe soltanto un rifiuto 'rules-unreadable' al momento dell'ordine`,
    };
  }

  const r = readStore(c.catalogFile, EMPTY_CATALOG, deps);
  if (!r.ok) {
    // An unreadable catalog must not be overwritten: we would silently drop every market already in it.
    return { ok: false, marketId: id, error: `catalogo mercati ${r.error} — rifiuto di sovrascriverlo (sistemare il file prima di aggiungere altri mercati)` };
  }
  const base = (r.value && typeof r.value === 'object') ? r.value : {};
  const markets = { ...((base.markets && typeof base.markets === 'object') ? base.markets : {}) };
  const at = c.now();
  const prev = markets[id] || null;

  const record = {
    marketId: id,
    question: market.question ?? (prev ? prev.question : null) ?? null,
    slug: market.slug ?? (prev ? prev.slug : null) ?? null,
    category: market.category ?? (prev ? prev.category : null) ?? null,
    tokenIdYes: String(market.tokenIdYes),
    tokenIdNo: String(market.tokenIdNo),
    tick: market.tick,
    negRisk: market.negRisk === true,
    // Reward programme, as READ, not as assumed. null means "the venue publishes no reward rate for this
    // market" — a market that pays nothing for liquidity, quotable only for directional reasons. 0 and
    // null are kept distinct because they arrive from different answers.
    rewardsDailyRate: fin(market.rewardsDailyRate) ? market.rewardsDailyRate : null,
    rewardsMaxSpreadCents: fin(market.rewardsMaxSpreadCents) ? market.rewardsMaxSpreadCents : null,
    rewardsMinSize: fin(market.rewardsMinSize) ? market.rewardsMinSize : null,
    hasRewards: fin(market.rewardsDailyRate) && market.rewardsDailyRate > 0,
    endDate: typeof market.endDate === 'string' && market.endDate.trim() ? market.endDate : (prev ? prev.endDate : null),
    // The book AT FETCH TIME. Snapshot, never live — every reader reports its age.
    mid: fin(market.mid) ? market.mid : null,
    bestBid: fin(market.bestBid) ? market.bestBid : null,
    bestAsk: fin(market.bestAsk) ? market.bestAsk : null,
    spreadCents: fin(market.spreadCents) ? market.spreadCents : null,
    fetchedAt: fin(market.fetchedAt) ? market.fetchedAt : at,
    addedAt: prev && fin(prev.addedAt) ? prev.addedAt : at,
    updatedAt: at,
    by, reason,
  };
  markets[id] = record;
  writeStoreAtomic(c.catalogFile, { markets, updatedAt: at }, deps);
  appendAudit({
    ts: at, event: prev ? 'market-refreshed' : 'market-added', marketId: id,
    question: record.question, hasRewards: record.hasRewards, rewardsDailyRate: record.rewardsDailyRate,
    tick: record.tick, endDate: record.endDate, by, reason,
  }, c);
  return { ok: true, marketId: id, record, existed: !!prev };
}

/** Forget a market. The switch that decides whether it can be QUOTED is elsewhere (auto-reprice config);
 *  this only drops the metadata, and is audited like every other change. */
function removeMarket(marketId, { by = null, reason = null } = {}, deps = {}) {
  const c = catDeps(deps);
  const id = normId(marketId);
  if (!id) return { ok: false, error: 'marketId mancante', marketId: null };
  const r = readStore(c.catalogFile, EMPTY_CATALOG, deps);
  if (!r.ok) return { ok: false, marketId: id, error: `catalogo mercati ${r.error} — rifiuto di riscriverlo` };
  const base = (r.value && typeof r.value === 'object') ? r.value : {};
  const markets = { ...((base.markets && typeof base.markets === 'object') ? base.markets : {}) };
  if (!markets[id]) return { ok: true, marketId: id, existed: false };
  delete markets[id];
  const at = c.now();
  writeStoreAtomic(c.catalogFile, { markets, updatedAt: at }, deps);
  appendAudit({ ts: at, event: 'market-removed', marketId: id, by, reason }, c);
  return { ok: true, marketId: id, existed: true };
}

/**
 * UNA RIGA DEL BOARD REWARD → L'INGRESSO DI `upsertMarket`. Pura: nessuna lettura, nessuna rete.
 *
 * ═══ PERCHE' ESISTE (9 agosto 2026) ═════════════════════════════════════════════════════════════════
 * Fino a oggi questo catalogo lo scriveva SOLO il pannello operatore. La conseguenza si e' vista sui
 * dati vivi: un mercato aperto da agent41 vive sulle regole del board, e quando il board ruota —
 * agent24 lo riscrive ogni 15 minuti e tiene i primi 120 per montepremi — quel mercato perde tick,
 * banda, minSize e negRisk **mentre la posizione resta aperta**. Da li' `resolveMarketRules` risponde
 * `rules-unreadable` e si fermano TUTTI e quattro i percorsi che potrebbero gestirla: chiusura
 * automatica (auto-close.js:78 e :464), riprezzatura (auto-reprice.js:219), tracking
 * (mm-tracking.js:217) e qualunque ordine (manual-order.js:835, gate 2). Una posizione senza via
 * d'uscita, per un motivo che non ha niente a che vedere con la posizione.
 *
 * Misurato il 9 agosto alle 03:40: **10 mercati su 39 in gestione** erano in questo stato, fra cui
 * quattro aperti la sera prima. Il primo `rules-unreadable` sul mercato London 18°C e' delle
 * 02:09:42Z, cioe' il giro di board subito dopo l'ultimo ciclo di auto-close riuscito (02:08:57Z).
 *
 * ═══ IL RIPIEGO ERA GIA' PROGETTATO, MANCAVA CHI LO RIEMPIVA ════════════════════════════════════════
 * `resolveMarketRules` consulta questo catalogo quando il board non conosce il mercato. Il ripiego
 * funziona; semplicemente nessuno lo scriveva per i mercati aperti in automatico. Questa funzione fa
 * quella traduzione, e la fa QUI perche' e' una proprieta' del formato del catalogo, non dello
 * scheduler: un mapper nello scheduler sarebbe la seconda definizione dello stesso record.
 *
 * ═══ COSA NON FA ════════════════════════════════════════════════════════════════════════════════════
 * Non inventa. Un campo che la riga non porta resta assente, e `upsertMarket` RIFIUTA il record se
 * mancano i quattro obbligatori — il verso giusto: meglio nessun ripiego che un ripiego con un tick
 * indovinato, perche' un tick sbagliato produce ordini fuori banda invece di un rifiuto leggibile.
 *
 * @param {object} row  una riga di /tmp/liquidity-rewards.json (il board normalizzato)
 * @param {number} [fetchedAt]  quando la riga e' stata letta; di difetto `row.updatedAt`
 * @returns {object|null} l'ingresso per `upsertMarket`, o null se la riga non e' utilizzabile
 */
function recordDaRigaBoard(row, fetchedAt = null) {
  if (!row || typeof row !== 'object') return null;
  const id = normId(row.marketId || row.conditionId);
  if (!id) return null;
  const letto = fin(fetchedAt) ? fetchedAt
    : (typeof row.updatedAt === 'string' && Number.isFinite(Date.parse(row.updatedAt)) ? Date.parse(row.updatedAt) : null);
  const out = {
    marketId: id,
    question: row.title || row.question || null,
    slug: row.marketSlug || row.slug || null,
    category: row.category || null,
    tokenIdYes: row.tokenId ? String(row.tokenId) : null,
    tokenIdNo: row.tokenIdNo ? String(row.tokenIdNo) : null,
    tick: fin(row.tickSize) ? row.tickSize : (fin(row.tick) ? row.tick : null),
    negRisk: typeof row.negRisk === 'boolean' ? row.negRisk : null,
    rewardsDailyRate: fin(row.dailyPool) ? row.dailyPool : null,
    rewardsMaxSpreadCents: fin(row.maxSpread) ? row.maxSpread : null,
    rewardsMinSize: fin(row.minSize) ? row.minSize : null,
    mid: fin(row.midpoint) ? row.midpoint : (fin(row.mid) ? row.mid : null),
    bestBid: fin(row.bestBid) ? row.bestBid : null,
    bestAsk: fin(row.bestAsk) ? row.bestAsk : null,
    // ── LA SCADENZA, CHE QUESTO MAPPER NON COPIAVA (corretto il 13 agosto 2026) ──────────────────
    //
    // ⚠ IL DIFETTO, e costava la chiusura forzata. Il ripiego esiste perché un mercato che esce dal
    // board resti gestibile, e `scadenzaMercato` (agent40) legge board → RIPIEGO proprio per quello.
    // Ma questa funzione, che è l'unica a costruire il record dal board, **non mappava `endDate`**:
    // `upsertMarket` scriveva quindi `endDate: null` su ogni mercato mai preso in carico da agent41.
    // Misurato il 13 agosto: cinque posizioni aperte su cinque mercati fuori dal board, tutte con
    // `endDate: null` nel catalogo ⇒ `scadenzaMercato` risponde `null` ⇒ `chiusuraForzataPreScadenza`
    // risponde `forza:false` ⇒ **la regola «entro 3 ore si chiude a qualunque prezzo» non poteva
    // scattare su nessuna di loro.** La seconda metà della copertura era scritta e non veniva nutrita.
    //
    // Si copia la data GIÀ UNIFICATA del board (`endDate`, l'esito di `scadenzaUnificata`), non le
    // due grezze: il ripiego deve contenere lo stesso numero su cui il mercato è stato giudicato.
    // `endDateFonte` viaggia accanto perché in un audit «l'ora vera di Gamma» e «la data del venue»
    // non devono diventare indistinguibili una volta finite nel ripiego.
    endDate: typeof row.endDate === 'string' && row.endDate.trim() ? row.endDate : null,
    endDateFonte: typeof row.endDateFonte === 'string' && row.endDateFonte.trim() ? row.endDateFonte : null,
  };
  if (fin(letto)) out.fetchedAt = letto;
  return out;
}

module.exports = {
  readMarketCatalog, readMarketRecord, upsertMarket, removeMarket, missingFields,
  recordDaRigaBoard,
  CATALOG_FILE, AUDIT_FILE, REQUIRED_FIELDS,
};
