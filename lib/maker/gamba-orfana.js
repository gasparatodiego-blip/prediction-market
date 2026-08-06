'use strict';
// lib/maker/gamba-orfana.js — UNA GAMBA SOLA HA DIECI MINUTI PER RITROVARE L'ALTRA.
//
// ═══ IL CASO REALE CHE HA PRODOTTO QUESTO MODULO ═════════════════════════════════════════════════════
// 6 agosto 2026, mercato Catalina Lauf. Alle 12:28:08 la regola «mai primo sul libro» cancella la gamba
// YES: decisione corretta, motivo scritto, nessun difetto. Ma la gamba NO resta sul libro DA SOLA, e il
// ciclo continua a rinnovarla — alle 12:31:28 la rinnova, e poi ancora, per circa due ore.
//
// Per la formula del venue una gamba sola matura ZERO fuori dal range [0,10–0,90] e un TERZO dentro,
// mentre il capitale resta impegnato per intero. Quindi per due ore quel capitale ha lavorato a una
// frazione del dovuto, e nessuno lo sapeva: l'evento di cancellazione esisteva solo nell'audit da
// mezzo gigabyte, e la gamba superstite non aveva nessuno che la guardasse come «superstite».
//
// ═══ COSA FA QUESTA REGOLA, E COSA DELIBERATAMENTE NON FA ════════════════════════════════════════════
// NON tocca «mai primo sul libro»: quella regola ha funzionato ed è giusta com'è. Questa è una regola
// NUOVA e SEPARATA che si occupa di ciò che succede DOPO, e vale per qualunque motivo di cancellazione
// — top-of-book, scadenza, rifiuto del venue, cancellazione manuale. La causa non la guarda nemmeno:
// guarda solo il FATTO che un lato è vuoto e l'altro no.
//
// NON piazza niente. La finestra di tolleranza esiste proprio perché il ciclo normale abbia tempo di
// ritentare l'altra gamba CON LE SUE REGOLE — top-of-book, depth adattiva, profilo Safe o Risk, tutto
// quanto già in vigore. Se le condizioni non lo permettono, il ciclo non ci riesce e il timer scorre.
// Questo modulo non ha una scorciatoia per «richiudere in fretta la coppia», e non deve averla: sarebbe
// esattamente il percorso che salta i controlli per un motivo che suona ragionevole.
//
// ═══ IL TIMER, DETTO CON PRECISIONE ══════════════════════════════════════════════════════════════════
//   · parte quando un mercato passa da DUE gambe a UNA;
//   · si annulla appena torna a due — e se poi si rompe di nuovo, riparte da capo, PIENO. Non è
//     cumulativo: due rotture nella stessa ora sono due finestre da dieci minuti, non una da venti
//     scalata dei tentativi già fatti. Un timer che si accorcia col ripetersi del guasto punirebbe
//     proprio i mercati che stanno faticando di più a richiudere;
//   · alla scadenza si cancella la gamba superstite. Il mercato resta chiuso lato bot, e va bene:
//     meglio zero capitale impegnato che capitale impegnato a maturare un terzo.
//
// ═══ ZERO GAMBE NON È UN'ORFANA ══════════════════════════════════════════════════════════════════════
// Un mercato senza nessuna gamba non ha niente da cancellare e niente da aspettare: il timer si
// spegne. Sembra ovvio e non lo è — trattare «zero» come «meno di due» lascerebbe timer accesi per
// sempre su mercati usciti dal piano.
//
// ═══ PURO, E LO STATO STA FUORI ══════════════════════════════════════════════════════════════════════
// `valutaGambaOrfana` non legge e non scrive niente: riceve lo stato del mercato e l'istante in cui è
// diventato orfano, e risponde. Lo store è separato (sotto), così la decisione si può esercitare senza
// toccare il disco e senza che un mercato possa influenzarne un altro.

const path = require('path');
const { readStore, writeStoreAtomic, DATA_DIR } = require('../safety/store');

const STORE_FILE = path.join(DATA_DIR, 'maker-gambe-orfane.json');
const EMPTY = Object.freeze({ markets: {}, updatedAt: null });

/** La finestra di tolleranza, in minuti. Sempre questa, senza eccezioni e senza accorciamenti. */
const ORPHAN_LEG_TOLERANCE_MIN = 10;
const ORPHAN_LEG_TOLERANCE_MS = ORPHAN_LEG_TOLERANCE_MIN * 60_000;

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const normId = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/**
 * LA DECISIONE, PURA.
 *
 * @param {object} a
 *   marketId     il mercato (solo per il referto)
 *   bookAttivi   quali lati hanno ordini a riposo adesso: es. ['no'] oppure ['yes','no'] oppure []
 *   orfanaDa     epoch ms in cui il mercato è diventato orfano, o null se non lo era
 *   now          epoch ms
 * @returns {{stato:'coppia'|'vuoto'|'orfana', azione:'nessuna'|'avvia'|'annulla'|'cancella',
 *            bookSuperstite:string|null, orfanaDa:number|null, scadeAms:number|null,
 *            restaMs:number|null, restaSec:number|null, motivo:string}}
 */
function valutaGambaOrfana({ marketId = null, bookAttivi = [], orfanaDa = null, now = Date.now() } = {}) {
  const lati = Array.isArray(bookAttivi)
    ? [...new Set(bookAttivi.map((b) => String(b || '').trim().toLowerCase()).filter((b) => b === 'yes' || b === 'no'))]
    : [];
  const base = { marketId, bookSuperstite: null, orfanaDa: null, scadeAms: null, restaMs: null, restaSec: null };

  // ── DUE GAMBE: la coppia è intera. Se un timer era acceso, si spegne. ──────────────────────────
  if (lati.length >= 2) {
    return {
      ...base, stato: 'coppia',
      azione: orfanaDa != null ? 'annulla' : 'nessuna',
      motivo: orfanaDa != null
        ? 'la coppia è tornata intera entro la finestra: il timer si annulla'
        : 'coppia intera',
    };
  }

  // ── ZERO GAMBE: niente da cancellare, niente da attendere. ─────────────────────────────────────
  if (lati.length === 0) {
    return {
      ...base, stato: 'vuoto',
      azione: orfanaDa != null ? 'annulla' : 'nessuna',
      motivo: orfanaDa != null
        ? 'non è rimasta nessuna gamba: non c\'è più niente da cancellare, il timer si spegne'
        : 'nessuna gamba a riposo',
    };
  }

  // ── UNA GAMBA SOLA ────────────────────────────────────────────────────────────────────────────
  const superstite = lati[0];

  if (!fin(orfanaDa)) {
    // Prima volta che la si vede sola: il timer parte adesso.
    return {
      ...base, stato: 'orfana', azione: 'avvia', bookSuperstite: superstite,
      orfanaDa: now, scadeAms: now + ORPHAN_LEG_TOLERANCE_MS,
      restaMs: ORPHAN_LEG_TOLERANCE_MS, restaSec: Math.round(ORPHAN_LEG_TOLERANCE_MS / 1000),
      motivo: `la gamba ${superstite.toUpperCase()} è rimasta sola: ${ORPHAN_LEG_TOLERANCE_MIN} minuti per ritrovare l'altra`,
    };
  }

  const scadeA = orfanaDa + ORPHAN_LEG_TOLERANCE_MS;
  const resta = scadeA - now;

  if (resta > 0) {
    return {
      ...base, stato: 'orfana', azione: 'nessuna', bookSuperstite: superstite,
      orfanaDa, scadeAms: scadeA, restaMs: resta, restaSec: Math.ceil(resta / 1000),
      motivo: `gamba ${superstite.toUpperCase()} sola da ${Math.round((now - orfanaDa) / 1000)}s`
        + ` — restano ${Math.ceil(resta / 1000)}s prima della cancellazione automatica`,
    };
  }

  return {
    ...base, stato: 'orfana', azione: 'cancella', bookSuperstite: superstite,
    orfanaDa, scadeAms: scadeA, restaMs: 0, restaSec: 0,
    motivo: `la gamba ${superstite.toUpperCase()} è rimasta sola per ${ORPHAN_LEG_TOLERANCE_MIN} minuti interi`
      + ' senza che l\'altra tornasse: si cancella anche questa — meglio zero capitale impegnato che'
      + ' capitale impegnato a maturare un terzo',
  };
}

// ── LO STORE DEI TIMER ────────────────────────────────────────────────────────────────────────────
// Un timestamp per mercato, e nient'altro. Sta su file e non in memoria perché un riavvio di agent40
// non deve regalare dieci minuti nuovi a una gamba che era sola da nove: sarebbe un modo di non
// scadere mai, su un processo che si riavvia spesso.

function deps_(deps = {}) {
  return {
    storeFile: deps.gambeOrfaneFile || STORE_FILE,
    now: deps.now || (() => Date.now()),
    fs: deps.fs || require('fs'),
  };
}

/** L'istante in cui il mercato è diventato orfano, o null. Riletto dal file a ogni chiamata. */
function leggiOrfanaDa(marketId, deps = {}) {
  const c = deps_(deps);
  const r = readStore(c.storeFile, EMPTY, deps);
  if (!r.ok) return null;
  const st = (r.value && typeof r.value === 'object') ? r.value : EMPTY;
  const rec = (st.markets && st.markets[normId(marketId)]) || null;
  return rec && fin(rec.orfanaDa) ? rec.orfanaDa : null;
}

/** Tutti i timer accesi, per la dashboard. */
function leggiOrfaneTutte(deps = {}) {
  const c = deps_(deps);
  const r = readStore(c.storeFile, EMPTY, deps);
  if (!r.ok) return { leggibile: false, error: r.error, markets: {} };
  const st = (r.value && typeof r.value === 'object') ? r.value : EMPTY;
  return { leggibile: true, error: null, markets: st.markets || {}, updatedAt: st.updatedAt || null };
}

/**
 * Applica l'azione decisa al timer di UN mercato. Gli altri mercati non vengono toccati: la scrittura
 * fonde, non sostituisce — due mercati che diventano orfani nello stesso giro non possono cancellarsi
 * il timer a vicenda.
 */
function aggiornaTimer({ marketId, azione, orfanaDa = null, bookSuperstite = null }, deps = {}) {
  const c = deps_(deps);
  const id = normId(marketId);
  if (!id || azione === 'nessuna') return { ok: true, scritto: false };

  const r = readStore(c.storeFile, EMPTY, deps);
  const st = (r.ok && r.value && typeof r.value === 'object') ? r.value : EMPTY;
  const markets = { ...(st.markets || {}) };

  if (azione === 'annulla' || azione === 'cancella') {
    // Dopo la cancellazione della superstite il mercato non ha più gambe: il timer non serve più.
    delete markets[id];
  } else if (azione === 'avvia') {
    markets[id] = { orfanaDa: fin(orfanaDa) ? orfanaDa : c.now(), bookSuperstite };
  }

  const at = c.now();
  const w = writeStoreAtomic(c.storeFile, { markets, updatedAt: at, updatedAtIso: new Date(at).toISOString() }, deps);
  return { ok: w !== false, scritto: true, marketCount: Object.keys(markets).length };
}

module.exports = {
  valutaGambaOrfana, leggiOrfanaDa, leggiOrfaneTutte, aggiornaTimer,
  ORPHAN_LEG_TOLERANCE_MIN, ORPHAN_LEG_TOLERANCE_MS, STORE_FILE,
};
