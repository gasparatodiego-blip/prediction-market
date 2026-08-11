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
function writeAllocatedCapital({ rows, capital, by = 'allocation-plan' } = {}, deps = {}) {
  const c = deps_(deps);
  const list = Array.isArray(rows) ? rows : [];
  const markets = {};

  // ── SI SOSTITUISCE TUTTO, E ADESSO VA BENE ────────────────────────────────────────────────────
  // Dal 6 al 6 agosto 2026 questa funzione ha fuso PER PROFILO: serviva perche' due piani (Safe e
  // Risk) scrivevano sulla stessa mappa e quello Risk avrebbe cancellato i tetti dei mercati Safe —
  // e a valle un tetto assente vale «niente nuova esposizione».
  //
  // I profili non esistono piu': c'e' un piano solo, e un piano dice esattamente «questi sono i
  // mercati e il loro capitale». Sostituire e' quindi la semantica giusta, ed e' anche quella
  // originale. Tenere la fusione avrebbe lasciato in giro tetti di piani vecchi che nessuno rinnova.
  for (const r of list) {
    const id = normId(r && r.marketId);
    if (!id || !fin(r.capital) || r.capital <= 0) continue;
    markets[id] = { capitalUsd: r.capital };
  }

  const at = c.now();
  const value = {
    markets, updatedAt: at, updatedAtIso: new Date(at).toISOString(),
    capital: fin(capital) ? capital : null, by,
  };
  const w = writeStoreAtomic(c.storeFile, value, deps);
  return { ok: w !== false, marketCount: Object.keys(markets).length, at };
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
    // ── IL PIANO ∪ LE POSIZIONI APERTE — terza volta che serve questa unione ──────────────────────
    // Un mercato puo' avere del NOSTRO capitale gia' esposto e non comparire nel piano: il ciclo da 6h
    // ruota, e chi esce perde il tetto. Fino al 10 agosto 2026 quel mercato restava senza tetto, e a
    // valle un tetto assente vale «nessuna esposizione nuova» — quindi il riposizionamento dopo un fill
    // (Lavoro B punto d) non poteva MAI partire proprio dove serviva.
    //
    // Misurato nelle 8 ore fino alle 06:50 del 10 agosto: **238 tentativi su 238 falliti**, tutti con
    // `riposizionamento-niente: tetto per mercato non leggibile`, su 5 mercati — Houston, Ankara,
    // London 18°C e 19°C, Chengdu — TUTTI con una posizione aperta e nessuno nel piano.
    //
    // E' la stessa disciplina gia' stabilita due volte (§5 punti 62 e 69, `liveMinMarketIds`): «piano ∪
    // mercati con posizione aperta». Qui la si applica al TETTO, e il tetto per un mercato dove il
    // capitale e' gia' esposto e' quello standard — `MARKET_CAP_FIXED_USD`, la stessa unica costante di
    // `concentration.js`, non un numero nuovo.
    //
    // NON ALLARGA IL PERIMETRO: si concede un tetto solo dove il capitale e' GIA' dentro, ed e' lo
    // stesso tetto che quel mercato avrebbe avuto standoci. Un mercato senza posizione resta senza
    // tetto, esattamente come prima. FAIL-CLOSED invariato: se le posizioni non si leggono non si
    // concede niente, e il ripiego resta `capUsd: null`.
    const conPosizione = (() => {
      try {
        const leggi = deps.posizioni !== undefined
          ? () => deps.posizioni
          : () => require('../safety/venue-positions-snapshot').readVenuePositions();
        const snap = leggi();
        if (!snap || snap.readable !== true || !Array.isArray(snap.positions)) return false;
        return snap.positions.some((pos) => {
          const cid = normId(pos && (pos.conditionId || pos.marketId));
          return cid === id && Number(pos.size) > 0;
        });
      } catch { return false; }
    })();
    if (conPosizione) {
      const { MARKET_CAP_FIXED_USD } = require('../rewards/concentration');
      return { capUsd: MARKET_CAP_FIXED_USD, readable: true, stale: false, ageSec, daPosizione: true,
        reason: `fuori dal piano di allocazione, ma con una POSIZIONE APERTA: vale il tetto standard di ${MARKET_CAP_FIXED_USD} USD — il capitale e' gia' esposto qui, e senza tetto non sarebbe gestibile` };
    }
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
  writeAllocatedCapital, readAllocatedCapital, readAllocatedCapitalAll,
  STORE_FILE, MAX_AGE_MS,
};
