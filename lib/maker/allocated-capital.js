'use strict';
// lib/maker/allocated-capital.js — THE POSITION CEILING, DERIVED AND NEVER TYPED.
//
// WHAT IT IS. The per-market capital the allocation planner assigned to a market. The fill strategy uses
// it as the maximum inventory it may accumulate on that market, per side. It is NOT a second cap the
// operator sets: there is no writer on this store reachable from any control, and no endpoint accepts a
// value for it. The only writer is the allocation route, which records what the planner ALREADY computed
// (`rows[].capital`) the moment it computes it.
//
// WHY A SNAPSHOT AND NOT A LIVE READ. Recomputing the plan costs ~25s (it rebuilds every market's fill
// curve over the tape). A reaction to a fill cannot wait 25s, and it must not be the thing that triggers
// a 25s recompute either. So the planner writes what it derived, stamped, and this module reads it back
// with its age attached — the age travels everywhere the number does.
//
// FAIL CLOSED, AND LOUDLY. An absent, unreadable or STALE ceiling returns capUsd:null, and every caller
// treats null as "may not add exposure" — never as "unlimited". The two facts "your ceiling is $0" and
// "we could not read your ceiling" are different, and the second must never be allowed to wear the
// clothes of permission. This is the same rule the rest of the maker applies to an unreadable kill state.

const path = require('path');
const { readStore, writeStoreAtomic, DATA_DIR } = require('../safety/store');

const STORE_FILE = path.join(DATA_DIR, 'maker-allocated-capital.json');

// ── IL PROFILO, ACCANTO AL TETTO E NON IN UN ALTRO FILE ───────────────────────────────────────────
// I due profili che un piano può avere. Un record senza profilo è per costruzione 'safe': prima che
// questo campo esistesse, il percorso Safe era l'unico che scrivesse su questo store.
const PROFILI = Object.freeze(['safe', 'risk']);
const PROFILO_DIFETTO = 'safe';
function normProfilo(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return PROFILI.includes(s) ? s : PROFILO_DIFETTO;
}
const EMPTY = Object.freeze({ markets: {}, updatedAt: null, capital: null });

// Past this the snapshot is not trusted as a ceiling. A plan built against yesterday's book and
// yesterday's balance is not a statement about what may be committed now.
const MAX_AGE_MS = 24 * 3_600_000;

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }
function normId(v) { return typeof v === 'string' ? v.trim().toLowerCase() : ''; }
function deps_(deps = {}) {
  return {
    storeFile: deps.allocatedCapitalFile || STORE_FILE,
    now: deps.now || (() => Date.now()),
    fs: deps.fs || require('fs'),
  };
}

/**
 * Record what the planner derived. Called by the allocation route with the plan it just computed.
 * `rows` is the plan's rows: [{ marketId, capital }]. Nothing else on this module writes.
 */
function writeAllocatedCapital({ rows, capital, by = 'allocation-plan', profile = PROFILO_DIFETTO } = {}, deps = {}) {
  const c = deps_(deps);
  const list = Array.isArray(rows) ? rows : [];
  const prof = normProfilo(profile);

  // ── SI FONDE PER PROFILO, NON SI SOSTITUISCE TUTTO ────────────────────────────────────────────
  //
  // IL DIFETTO CHE QUESTO RISOLVE. Fino al 6 agosto 2026 questa funzione riscriveva `markets` per
  // intero. Con un solo scrittore (il piano Safe) era innocuo. Appena un secondo piano — quello Risk,
  // che per costruzione sceglie mercati DIVERSI — avesse scritto, avrebbe cancellato i tetti dei
  // mercati Safe; e a valle un tetto assente vale «non aggiungere esposizione» (fail closed). Una
  // simulazione nella tab Risk avrebbe fermato l'accumulo sul capitale vero, in silenzio.
  //
  // Per questo la rotta di allocazione scriveva SOLO sul percorso Safe: era la toppa giusta finché il
  // profilo non esisteva nel record. Adesso esiste, quindi la fusione si può fare bene:
  //
  //     un piano di profilo P sostituisce ESATTAMENTE i mercati di profilo P, e non tocca gli altri.
  //
  // Che è ciò che un piano dice davvero: «questi sono i mercati P e il loro capitale», non «questo è
  // tutto ciò che esiste al mondo».
  const precedente = readStore(c.storeFile, EMPTY, deps);
  const vecchi = (precedente.ok && precedente.value && typeof precedente.value.markets === 'object')
    ? precedente.value.markets : {};

  const markets = {};
  for (const [id, rec] of Object.entries(vecchi || {})) {
    if (!rec || typeof rec !== 'object') continue;
    // I record scritti PRIMA che il profilo esistesse non ne hanno uno. Sono Safe per costruzione —
    // il percorso Safe era l'unico che scrivesse — e vengono trattati come tali invece di sparire.
    if (normProfilo(rec.profile) === prof) continue;   // stesso profilo ⇒ lo rifà il piano nuovo
    markets[id] = { capitalUsd: rec.capitalUsd, profile: normProfilo(rec.profile) };
  }

  let nuovi = 0;
  for (const r of list) {
    const id = normId(r && r.marketId);
    if (!id || !fin(r.capital) || r.capital <= 0) continue;
    markets[id] = { capitalUsd: r.capital, profile: prof };
    nuovi += 1;
  }

  const at = c.now();
  const value = {
    markets, updatedAt: at, updatedAtIso: new Date(at).toISOString(),
    capital: fin(capital) ? capital : null, by, profile: prof,
  };
  const w = writeStoreAtomic(c.storeFile, value, deps);
  return { ok: w !== false, marketCount: Object.keys(markets).length, profileCount: nuovi, profile: prof, at };
}

/**
 * IL PROFILO DI UN MERCATO — la domanda che il motore fa a ogni giro del ciclo da 5 s.
 *
 * ═══ PERCHÉ QUI E NON IN UNO STORE NUOVO ═════════════════════════════════════════════════════════
 * Perché è lo stesso fatto. «Questo mercato sta nel piano, con questo capitale» e «questo mercato è
 * Safe o Risk» sono due letture della STESSA riga: le scrive lo stesso piano, nello stesso istante,
 * e separarle vorrebbe dire poterle far divergere — un mercato col tetto di un piano e il profilo di
 * un altro. Una seconda mappa avrebbe anche una seconda età, e due età sono due verità.
 *
 * ═══ PROFILO SCONOSCIUTO NON SCEGLIE ═════════════════════════════════════════════════════════════
 * `profile: null` quando il mercato non è nel piano, quando il piano è più vecchio di MAX_AGE_MS, o
 * quando lo store non è leggibile. NON ricade su 'safe': un difetto comodo farebbe attraversare a un
 * mercato Risk i controlli dell'altro percorso. A valle `valutaPiazzamento` rifiuta un profilo che
 * non riconosce, quindi null si traduce in «nessun ordine nuovo», che è la direzione prudente e la
 * stessa che il tetto applica già da sempre.
 *
 * NESSUNA CACHE: si rilegge il file a ogni chiamata, come `readAllocatedCapital`. La freschezza è
 * quella del file, e l'età viaggia col verdetto.
 *
 * @returns {{profile:'safe'|'risk'|null, readable:boolean, stale:boolean, ageSec:number|null, reason:string}}
 */
function readMarketProfile(marketId, deps = {}) {
  const c = deps_(deps);
  const r = readStore(c.storeFile, EMPTY, deps);
  if (!r.ok) {
    return { profile: null, readable: false, stale: false, ageSec: null,
      reason: `piano di allocazione non leggibile (${r.error}) — profilo sconosciuto, quindi nessun percorso applicabile` };
  }
  const st = (r.value && typeof r.value === 'object') ? r.value : EMPTY;
  const at = fin(st.updatedAt) ? st.updatedAt : null;
  const ageSec = at != null ? Math.max(0, Math.round((c.now() - at) / 1000)) : null;
  const id = normId(marketId);
  if (!id) return { profile: null, readable: true, stale: false, ageSec, reason: 'nessun marketId indicato' };
  if (at == null) {
    return { profile: null, readable: true, stale: false, ageSec: null,
      reason: 'nessun piano registrato — nessun mercato ha un profilo' };
  }
  if (c.now() - at > MAX_AGE_MS) {
    return { profile: null, readable: true, stale: true, ageSec,
      reason: `piano vecchio di ${Math.round(ageSec / 3600)} h — oltre le 24 h il profilo non è più affidabile` };
  }
  const rec = (st.markets && st.markets[id]) || null;
  if (!rec) {
    return { profile: null, readable: true, stale: false, ageSec,
      reason: 'questo mercato non compare nel piano corrente — nessun profilo, quindi nessun ordine nuovo' };
  }
  const prof = normProfilo(rec.profile);
  return { profile: prof, readable: true, stale: false, ageSec,
    reason: `profilo ${prof}, dal piano di ${Math.round(ageSec / 60)} min fa` };
}

/**
 * The ceiling for ONE market. Always returns a verdict object; `capUsd` is null whenever the number may
 * not be trusted, and `reason` says which of the several different "null"s this is.
 *
 * @returns {{capUsd:number|null, readable:boolean, stale:boolean, ageSec:number|null, reason:string}}
 */
function readAllocatedCapital(marketId, deps = {}) {
  const c = deps_(deps);
  const r = readStore(c.storeFile, EMPTY, deps);
  if (!r.ok) {
    return { capUsd: null, readable: false, stale: false, ageSec: null,
      reason: `piano di allocazione non leggibile (${r.error}) — nessun tetto, quindi nessuna esposizione nuova` };
  }
  const st = (r.value && typeof r.value === 'object') ? r.value : EMPTY;
  const at = fin(st.updatedAt) ? st.updatedAt : null;
  const ageSec = at != null ? Math.max(0, Math.round((c.now() - at) / 1000)) : null;
  const id = normId(marketId);
  if (!id) return { capUsd: null, readable: true, stale: false, ageSec, reason: 'nessun marketId indicato' };
  if (at == null) {
    return { capUsd: null, readable: true, stale: false, ageSec: null,
      reason: 'nessun piano di allocazione registrato — apri la tab Alloca e calcola un piano' };
  }
  if (c.now() - at > MAX_AGE_MS) {
    return { capUsd: null, readable: true, stale: true, ageSec,
      reason: `piano di allocazione vecchio di ${Math.round(ageSec / 3600)} h — oltre le 24 h non vale come tetto` };
  }
  const rec = (st.markets && st.markets[id]) || null;
  if (!rec || !fin(rec.capitalUsd) || rec.capitalUsd <= 0) {
    return { capUsd: null, readable: true, stale: false, ageSec,
      reason: 'questo mercato non compare nel piano di allocazione corrente — nessun capitale assegnato, quindi nessun tetto' };
  }
  return { capUsd: rec.capitalUsd, readable: true, stale: false, ageSec,
    reason: `tetto ${rec.capitalUsd} USD, dal piano di allocazione di ${Math.round(ageSec / 60)} min fa` };
}

/** The whole snapshot, for the read-only UI display. */
function readAllocatedCapitalAll(deps = {}) {
  const c = deps_(deps);
  const r = readStore(c.storeFile, EMPTY, deps);
  if (!r.ok) return { readable: false, error: r.error, markets: {}, updatedAt: null, ageSec: null, capital: null };
  const st = (r.value && typeof r.value === 'object') ? r.value : EMPTY;
  const at = fin(st.updatedAt) ? st.updatedAt : null;
  return {
    readable: true, error: null, markets: st.markets || {}, updatedAt: at,
    ageSec: at != null ? Math.max(0, Math.round((c.now() - at) / 1000)) : null,
    capital: fin(st.capital) ? st.capital : null,
  };
}

module.exports = {
  writeAllocatedCapital, readAllocatedCapital, readAllocatedCapitalAll, readMarketProfile,
  STORE_FILE, MAX_AGE_MS, PROFILI, PROFILO_DIFETTO,
};
