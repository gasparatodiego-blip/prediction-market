#!/usr/bin/env node
'use strict';
/**
 * IL BANCO DI PROVA DEL CICLO COMPLETO — il bot VERO contro un venue simulato.
 *
 * ═══ PERCHE' ESISTE ══════════════════════════════════════════════════════════════════════════════════
 * Richiesta dell'operatore, 17 agosto 2026: «ieri i test erano verdi e in produzione non funzionava
 * niente, perche' verificavano che una regola ESISTESSE, non che SCATTASSE. Non posso perdere altri
 * soldi per scoprire che un pezzo non era collegato.»
 *
 * ═══ IL SEAM, E PERCHE' E' QUESTO E NON UN ALTRO ═════════════════════════════════════════════════════
 * Il vincolo dichiarato e': «se il simulatore passa da un percorso diverso da quello di produzione non
 * serve a niente». Quindi la sostituzione avviene al livello **piu' profondo possibile** — l'ADAPTER
 * del venue — e tutto cio' che sta sopra gira ESATTAMENTE come in produzione:
 *
 *      agent40 / agent41  ·  auto-close  ·  auto-reprice  ·  manual-order  ·  motore-unico
 *      allocator · presa-di-profitto · urgenza-scoperto · attraversamento-uscita · copertura-gambe
 *      tutti i gate, i tetti, l'idempotenza, la banda, il post-only, gli audit
 *                                    ↑ CODICE VERO, NON TOCCATO
 *      ────────────────────────────────────────────────────────────────────
 *      lib/venues/polymarket-clob-maker/adapter.js        ← SOSTITUITO
 *
 * Si sostituiscono TRE moduli in `require.cache`, e solo tre:
 *   1 · l'adapter del venue        — o servirebbero credenziali vere e la rete;
 *   2 · il giornale (`audit`)      — o la simulazione scriverebbe nel giornale di PRODUZIONE, che e'
 *                                    append-only e da cui si ricostruiscono le giornate vere;
 *   3 · lo snapshot posizioni      — o si riscriverebbe `data/venue-positions.json` vero.
 * Nient'altro. `DATA_DIR` non e' dirottabile (`lib/safety/store.js:32`, risolve su `<repo>/data`),
 * quindi le LETTURE di configurazione restano quelle vere — ed e' un bene: il banco misura anche se la
 * configurazione di oggi lascia scattare le regole.
 *
 * ⚠ COSA QUESTO BANCO NON PUO' DIRE: che il venue vero si comporti come il simulato. Dice che, DATO un
 * venue che si comporta cosi', il nostro codice fa quello che crede di fare. E' la meta' che ieri
 * mancava — l'altra meta' e' il mercato.
 *
 * ═══ IL VERDETTO ════════════════════════════════════════════════════════════════════════════════════
 * Per ogni regola: RAGGIUNTA (il codice ci e' passato) · SCATTATA (ha prodotto il suo esito) ·
 * EFFETTO (ha cambiato qualcosa nel venue). Una regola mai scattata e' ROSSA anche se il suo test
 * unitario e' verde — che e' esattamente il caso che il 16 agosto e' costato soldi.
 *
 * Uso:  node scripts/ricerca/banco-ciclo-completo.js [--verboso]
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..');
const VERBOSO = process.argv.includes('--verboso');
const OUT = path.join(ROOT, 'data', 'ricerca', 'banco-ciclo-completo.json');

// ⚠ SI NEUTRALIZZA L'AMBIENTE PRIMA DI QUALUNQUE `require`. Un modulo che legge `process.env` al
// caricamento (e ce ne sono) deve trovare il banco disarmato, non l'ambiente della shell.
process.env.MAKER_MODE = 'off';
process.env.MAKER_PLACEMENT = '';
process.env.MANUAL_ORDER_PLACEMENT = 'dry-run';
process.env.MAKER_ADAPTER_DRYRUN = 'true';

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// IL VENUE SIMULATO
// ════════════════════════════════════════════════════════════════════════════════════════════════════
//
// Sa fare le sette cose che il 16 agosto sono costate soldi, ognuna accendibile per scenario:
//   book che si muove contro · fill parziali anche sotto il minimo · rifiuto post-only ·
//   avgPrice non pubblicato per un ciclo · feed che tace · merge che fallisce ·
//   ordini che scadono di GTD · una posizione che sparisce senza un nostro ordine.
class VenueSimulato {
  constructor() {
    this.ora = Date.parse('2026-08-18T09:00:00Z');
    this.mercati = new Map();      // conditionId → {tokenId, tokenIdNo, tick, minSize, banda, book:{yes,no}}
    this.ordini = new Map();       // orderId → {..., vivo}
    this.posizioni = new Map();    // tokenId → {size, costoTotale, pubblicaAvgPrice}
    this.saldo = 500;
    this.seq = 0;
    this.eventi = [];
    // Le manopole degli scenari: tutte spente per difetto, si accendono una alla volta.
    this.scenari = {
      rifiutaPostOnlyCheIncrocia: true,   // il venue VERO lo fa sempre: e' il difetto, non uno scenario
      avgPriceNascostoPerCicli: 0,
      mergeFallisce: false,
      feedTace: false,
      sparizioneNonNostra: null,          // {tokenId, size}
    };
  }

  log(tipo, dato) { this.eventi.push({ ora: this.ora, tipo, ...dato }); }
  avanza(ms) { this.ora += ms; this.scadenzeGTD(); }

  mercato(cid) { return this.mercati.get(String(cid).toLowerCase()) || null; }

  creaMercato({ conditionId, mid = 0.40, tick = 0.01, minSize = 50, bandaCents = 4.5 }) {
    const cid = String(conditionId).toLowerCase();
    const m = { conditionId: cid, tokenId: `tok-yes-${cid.slice(2, 8)}`, tokenIdNo: `tok-no-${cid.slice(2, 8)}`,
      tick, minSize, bandaCents, mid, negRisk: false, chiuso: false };
    this.aggiornaBook(m, mid);
    this.mercati.set(cid, m);
    return m;
  }

  /** Il book: due lati complementari, con profondita' vera su piu' livelli. */
  aggiornaBook(m, midYes) {
    const t = m.tick;
    const q = (p) => Math.max(0.001, Math.min(0.999, Math.round(p / t) * t));
    m.mid = midYes;
    m.book = {
      yes: { scoringMid: q(midYes), bestBid: q(midYes - t), bestAsk: q(midYes + t),
        bids: [{ price: q(midYes - t), size: 400 }, { price: q(midYes - 2 * t), size: 700 }],
        asks: [{ price: q(midYes + t), size: 400 }, { price: q(midYes + 2 * t), size: 700 }] },
      no: { scoringMid: q(1 - midYes), bestBid: q(1 - midYes - t), bestAsk: q(1 - midYes + t),
        bids: [{ price: q(1 - midYes - t), size: 400 }, { price: q(1 - midYes - 2 * t), size: 700 }],
        asks: [{ price: q(1 - midYes + t), size: 400 }, { price: q(1 - midYes + 2 * t), size: 700 }] },
    };
  }

  muoviMid(cid, delta) {
    const m = this.mercato(cid); if (!m) return;
    this.aggiornaBook(m, Math.max(0.02, Math.min(0.98, m.mid + delta)));
    this.log('mid-mosso', { conditionId: cid, mid: m.mid });
  }

  latoDi(m, tokenId) { return String(tokenId) === String(m.tokenIdNo) ? 'no' : 'yes'; }

  // ── IL PIAZZAMENTO ────────────────────────────────────────────────────────────────────────────
  postOrder(spec) {
    const m = [...this.mercati.values()].find((x) => x.tokenId === spec.tokenId || x.tokenIdNo === spec.tokenId);
    if (!m) return { ok: false, gate: 'venue', reason: 'token sconosciuto al venue simulato' };
    if (m.chiuso) return { ok: false, gate: 'venue', reason: 'market closed' };
    const lato = this.latoDi(m, spec.tokenId);
    const b = m.book[lato];

    // ⚠ IL RIFIUTO POST-ONLY, ED E' IL COMPORTAMENTO VERO DEL VENUE: un ordine `post-only` che
    // incrocerebbe viene rifiutato, non eseguito. E' il motivo per cui il 16 agosto le uscite non
    // arrivavano mai a esecuzione. Qui si riproduce alla lettera.
    const incrocia = spec.side === 'SELL' ? spec.price <= b.bestBid + 1e-9 : spec.price >= b.bestAsk - 1e-9;
    if (spec.postOnly !== false && incrocia) {
      this.log('rifiuto-post-only', { tokenId: spec.tokenId, side: spec.side, price: spec.price, bestBid: b.bestBid });
      return { ok: false, gate: 'venue', reason: 'invalid post-only order: order crosses book' };
    }
    // Un SELL richiede le share: e' il `not enough balance` visto il 16 agosto.
    if (spec.side === 'SELL') {
      const p = this.posizioni.get(spec.tokenId);
      if (!p || p.size + 1e-9 < spec.size) {
        this.log('rifiuto-saldo', { tokenId: spec.tokenId, richiesto: spec.size, posseduto: p ? p.size : 0 });
        return { ok: false, gate: 'venue', reason: 'not enough balance / allowance' };
      }
    }

    const id = `sim-${++this.seq}`;
    const scadenza = spec.orderType === 'GTC' ? null : this.ora + (Number(spec.expirationSec || 1380) * 1000);
    this.ordini.set(id, { orderId: id, tokenId: spec.tokenId, marketId: m.conditionId, lato,
      side: spec.side, price: spec.price, size: spec.size, sizeMatched: 0, vivo: true,
      nato: this.ora, scadeA: scadenza });
    this.log('ordine-nato', { orderId: id, tokenId: spec.tokenId, side: spec.side, price: spec.price, size: spec.size });
    // Un ordine che ATTRAVERSA si esegue subito contro il book.
    if (spec.postOnly === false && incrocia) this.eseguiSubito(id);
    return { ok: true, orderId: id, status: 'live' };
  }

  cancelOrder(orderId) {
    const o = this.ordini.get(orderId);
    if (!o || !o.vivo) return { ok: true, cancelled: 0, alreadyGone: true };
    o.vivo = false; o.morteMotivo = 'cancellato';
    this.log('ordine-cancellato', { orderId });
    return { ok: true, cancelled: 1 };
  }

  ordiniVivi(cid) {
    return [...this.ordini.values()].filter((o) => o.vivo && (!cid || o.marketId === String(cid).toLowerCase()))
      .map((o) => ({ orderId: o.orderId, marketId: o.marketId, tokenId: o.tokenId, side: o.side,
        price: o.price, size: o.size, sizeMatched: o.sizeMatched,
        sizeRemaining: +(o.size - o.sizeMatched).toFixed(6), source: 'manual-ui',
        secondsToExpiry: o.scadeA ? Math.max(0, Math.round((o.scadeA - this.ora) / 1000)) : null,
        // ⚠ `expiresAtMs` VA ESPOSTO, e la sua assenza rendeva un rilevatore muto per intero.
        // `scaduto-senza-rinnovo` legge `o.expiresAtMs` (auto-reprice.js:936) e senza quel campo esce
        // a `continue` prima di giudicare: la regola risultava rossa per un campo mancante nella
        // FIXTURE, non per un difetto del bot. Sesta volta oggi che una fixture si maschera da regola
        // morta — ed e' il motivo per cui ogni caso di questi va annotato invece che solo corretto.
        expiresAtMs: o.scadeA || null,
        createdMs: o.nato, orderType: o.scadeA ? 'GTD' : 'GTC' }));
  }

  // ── I FILL ────────────────────────────────────────────────────────────────────────────────────
  eseguiSubito(orderId) { this.riempi(orderId, this.ordini.get(orderId).size); }

  /** Riempie `quanto` share di un ordine. Sa fare i PARZIALI, anche sotto il minimo premiante. */
  riempi(orderId, quanto) {
    const o = this.ordini.get(orderId);
    if (!o || !o.vivo) return null;
    const q = Math.min(quanto, o.size - o.sizeMatched);
    if (!(q > 0)) return null;
    o.sizeMatched += q;
    if (o.sizeMatched + 1e-9 >= o.size) { o.vivo = false; o.morteMotivo = 'riempito'; }
    if (o.side === 'BUY') {
      const p = this.posizioni.get(o.tokenId) || { size: 0, costoTotale: 0, nascondiPerCicli: this.scenari.avgPriceNascostoPerCicli };
      p.size += q; p.costoTotale += q * o.price;
      this.posizioni.set(o.tokenId, p);
      this.saldo -= q * o.price;
    } else {
      const p = this.posizioni.get(o.tokenId);
      if (p) { p.size -= q; p.costoTotale -= q * (p.costoTotale / Math.max(p.size + q, 1e-9)); if (p.size <= 1e-9) this.posizioni.delete(o.tokenId); }
      this.saldo += q * o.price;
    }
    this.log('fill', { orderId, tokenId: o.tokenId, side: o.side, quanto: q, price: o.price,
      parziale: o.vivo === true });
    return { orderId, quanto: q, price: o.price };
  }

  scadenzeGTD() {
    for (const o of this.ordini.values()) {
      if (o.vivo && o.scadeA && this.ora >= o.scadeA) {
        o.vivo = false; o.morteMotivo = 'expired';
        this.log('ordine-scaduto-gtd', { orderId: o.orderId, tokenId: o.tokenId });
      }
    }
  }

  /**
   * IL MERGE ON-CHAIN. Rende $1 per coppia: le DUE gambe spariscono insieme e il capitale torna.
   * ⚠ L'EFFETTO E' LA PARTE CHE CONTA. Un simulatore che restituisse `{ok:true}` senza togliere le
   * posizioni farebbe scattare la regola e non proverebbe niente: il banco dichiara «SCATTATA» dove
   * il sistema non ha fatto nulla, cioe' esattamente la bugia che deve impedire.
   */
  merge(conditionId, quanteShare) {
    const m = this.mercato(conditionId);
    if (!m) return { ok: false, reason: 'mercato sconosciuto' };
    if (this.scenari.mergeFallisce) {
      this.log('merge-fallito', { conditionId, quanteShare });
      return { ok: false, reason: 'submit rifiutato dal relayer (HTTP 400)' };
    }
    const y = this.posizioni.get(m.tokenId); const n = this.posizioni.get(m.tokenIdNo);
    const q = Math.min(quanteShare, y ? y.size : 0, n ? n.size : 0);
    if (!(q > 0)) return { ok: false, reason: 'la coppia non e\' completa: niente da fondere' };
    for (const [tok, p] of [[m.tokenId, y], [m.tokenIdNo, n]]) {
      p.size -= q; p.costoTotale = Math.max(0, p.costoTotale - q * (p.costoTotale / Math.max(p.size + q, 1e-9)));
      if (p.size <= 1e-9) this.posizioni.delete(tok);
    }
    this.saldo += q;   // $1 per coppia, per costruzione
    this.log('merge-eseguito', { conditionId, quanteShare: q, saldo: +this.saldo.toFixed(2) });
    return { ok: true, transactionID: `sim-tx-${++this.seq}`, quanteShare: q };
  }

  /**
   * IL RESET FRA UNO SCENARIO E IL SUCCESSIVO — e perche' un banco ne ha bisogno.
   *
   * ⚠ NON E' UNA COMODITA': e' la cintura contro la regressione piu' insidiosa che questo banco abbia
   * prodotto. I due presidi di agent40 hanno smesso di scattare SENZA CHE NULLA NEL BOT FOSSE
   * CAMBIATO, perche' si appoggiavano alle posizioni lasciate dalle fasi precedenti: quando il merge ha
   * smesso di fallire — cioe' quando il banco e' diventato piu' FEDELE — le posizioni sparivano prima e
   * lo scenario perdeva il proprio ingrediente. Uno scenario che dipende dagli avanzi di quello prima
   * non e' uno scenario: e' una coincidenza che passa finche' nessuno migliora niente.
   *
   * Restituisce COSA ha buttato, e serve leggerlo: se un giorno un reset butta via molto, quello e' il
   * peso su cui lo scenario successivo stava per appoggiarsi senza dirlo.
   *
   * ⚠ Gli ordini si marcano MORTI, non si cancellano dalla mappa: il giornale del venue e' il verbale
   * della corsa, e un verbale da cui si tolgono le righe non e' un verbale.
   */
  azzera(motivo = 'reset fra scenari') {
    let ordini = 0;
    for (const o of this.ordini.values()) if (o.vivo) { o.vivo = false; o.morteMotivo = 'azzerato-dal-banco'; ordini += 1; }
    const posizioni = this.posizioni.size;
    const share = [...this.posizioni.values()].reduce((a, p) => a + Number(p.size || 0), 0);
    this.posizioni.clear();
    this.log('banco-azzerato', { motivo, ordiniUccisi: ordini, posizioniButtate: posizioni, shareButtate: +share.toFixed(4) });
    return { ordiniUccisi: ordini, posizioniButtate: posizioni, shareButtate: +share.toFixed(4) };
  }

  /** Una posizione che se ne va senza un nostro ordine: il fatto del 16 agosto alle 19:27. */
  sparizioneEsterna(tokenId, quanto) {
    const p = this.posizioni.get(tokenId);
    if (!p) return;
    p.size -= quanto;
    if (p.size <= 1e-9) this.posizioni.delete(tokenId);
    this.log('sparizione-esterna', { tokenId, quanto });
  }

  /** Lo snapshot delle posizioni, con l'avgPrice che il venue puo' non aver ancora pubblicato. */
  snapshotPosizioni() {
    const out = [];
    for (const [tok, p] of this.posizioni) {
      const m = [...this.mercati.values()].find((x) => x.tokenId === tok || x.tokenIdNo === tok);
      const nascondi = p.nascondiPerCicli > 0;
      if (nascondi) p.nascondiPerCicli -= 1;
      out.push({ tokenId: tok, asset: tok, conditionId: m ? m.conditionId : null, marketId: m ? m.conditionId : null,
        size: +p.size.toFixed(6),
        // ⚠ `avgPrice: 0` quando il venue non l'ha ancora pubblicato — NON `null`. E' esattamente la
        // forma che il 16 agosto ha prodotto «il lato riempito e' costato 0.0c».
        avgPrice: nascondi ? 0 : +(p.costoTotale / Math.max(p.size, 1e-9)).toFixed(6),
        curPrice: m ? m.book[this.latoDi(m, tok)].scoringMid : 0 });
    }
    return out;
  }
}

const VENUE = new VenueSimulato();

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// LE TRE SOSTITUZIONI IN `require.cache`
// ════════════════════════════════════════════════════════════════════════════════════════════════════
const GIORNALE = [];   // ogni riga d'audit del bot vero finisce qui, e non nel giornale di produzione

function sostituisci(percorsoRelativo, exports) {
  const via = require.resolve(path.join(ROOT, percorsoRelativo));
  require.cache[via] = { id: via, filename: via, loaded: true, exports, children: [], paths: [] };
  return via;
}

// 1 · IL GIORNALE. Prima di ogni altro require, cosi' nessun modulo cattura quello vero.
sostituisci('lib/venues/polymarket-clob-maker/audit.js', {
  appendMakerAudit: (r) => { GIORNALE.push(r); },
  readMakerAudit: () => [], MAKER_AUDIT_FILE: '/dev/null',
});

// 2 · LO SNAPSHOT POSIZIONI.
sostituisci('lib/safety/venue-positions-snapshot.js', {
  writeVenuePositions: () => ({ ok: true }),
  readVenuePositions: () => ({ readable: true, ageMs: 0, positions: VENUE.snapshotPosizioni() }),
  readVenuePositionsConRefresh: async () => ({ readable: true, ageMs: 0, positions: VENUE.snapshotPosizioni() }),
  SNAPSHOT_FILE: '/dev/null', MAX_AGE_MS: 180_000,
});

// 3-bis · LO STATO DI CONFIGURAZIONE — la gestione manuale e la allowlist del riprezzo.
// ⚠ SI SIMULA LO STATO, NON IL GATE. `evaluateManualGate` e `evaluateLiveMinMarketGate` restano i
// gate VERI e continuano a decidere: qui si fornisce loro la configurazione che in produzione
// leggerebbero da `data/maker-manual-mode.json` e `data/maker-auto-reprice.json`. Scrivere quei due
// file vorrebbe dire cambiare lo stato del bot vero per far girare una simulazione — cioe' il
// contrario di un banco di prova. La distinzione e' netta e va tenuta: si simula CIO' CHE IL BOT
// LEGGE, mai CIO' CHE IL BOT DECIDE.
const MERCATI_SIMULATI = new Set();
// Lo stato del riprezzo, in memoria e VIVO fra un giro e l'altro.
const STATO_RIPREZZO = { markets: {}, cycles: 0, lastCycleMs: 0, riprezziQuestOra: 0 };
const vero_mm = require(path.join(ROOT, 'lib/maker/manual-mode'));
sostituisci('lib/maker/manual-mode.js', {
  ...vero_mm,
  readManualMode: () => ({ readable: true, markets: Object.fromEntries([...MERCATI_SIMULATI].map((m) => [m, { manual: true }])) }),
  isManualMarket: (marketId) => ({ manual: MERCATI_SIMULATI.has(String(marketId).toLowerCase()), readable: true,
    reason: 'banco: gestione manuale simulata', record: { manual: true } }),
  setManualMode: () => ({ ok: true }),
});
const vero_arc = require(path.join(ROOT, 'lib/maker/auto-reprice-config'));
sostituisci('lib/maker/auto-reprice-config.js', {
  ...vero_arc,
  // ⚠ IL CAMPO E' `globalEnabled`, NON `global.enabled`: il ciclo legge `cfgState.globalEnabled`
  // (auto-reprice.js:1048) e con la forma sbagliata esce a `disabled-global` senza guardare un solo
  // mercato — cioe' il banco misurava la propria fixture, per la QUARTA volta. Si mettono entrambi:
  // la forma annidata la usano altri lettori.
  readAutoRepriceConfig: () => ({ readable: true, globalEnabled: true, global: { enabled: true },
    enabledMarketIds: [...MERCATI_SIMULATI], liveMinMarketIds: [...MERCATI_SIMULATI],
    markets: Object.fromEntries([...MERCATI_SIMULATI].map((m) => [m, { enabled: true }])) }),
  isAutoRepriceEnabled: (marketId) => ({ enabled: MERCATI_SIMULATI.has(String(marketId).toLowerCase()), readable: true }),
  setAutoReprice: () => ({ ok: true }),
  // ⚠ LO STATO DEL RIPREZZO DEV'ESSERE VERO, non un `{}` che dimentica tutto: il ciclo ci scrive i
  // contatori dei rinnovi, l'istante dell'ultimo riprezzo e il battito, e li RILEGGE al giro dopo per
  // decidere anti-churn, tetto orario e rinnovi dovuti. Con uno stub muto ogni giro credeva di essere
  // il primo — e tre regole sui rinnovi non potevano scattare per costruzione.
  recordAutoRepriceState: (patch = {}) => {
    if (patch.heartbeat) { STATO_RIPREZZO.cycles = (STATO_RIPREZZO.cycles || 0) + 1; STATO_RIPREZZO.lastCycleMs = VENUE.ora; return { ok: true }; }
    const id = String(patch.marketId || '').toLowerCase();
    if (id) STATO_RIPREZZO.markets[id] = { ...(STATO_RIPREZZO.markets[id] || {}), ...patch, at: VENUE.ora };
    return { ok: true };
  },
  readAutoRepriceState: () => ({ readable: true, ...STATO_RIPREZZO }),
  // ⚠ IL CONTEGGIO ORARIO NON SI SOSTITUISCE: il ciclo lo CALCOLA da `marketState.recentAt`
  // (auto-reprice.js:1480), quindi il banco semina lo STATO e lascia fare l'aritmetica a lui.
  // Sostituire la funzione avrebbe scavalcato il calcolo vero — e con esso l'unica cosa che si voleva
  // mettere alla prova.
});

// 3 · L'ADAPTER DEL VENUE. E' il seam vero: tutto cio' che sta sopra e' produzione.
function adapterSimulato(opts = {}) {
  const audit = opts.auditSink || (() => {});
  return {
    kind: 'maker', mode: opts.mode || 'live-min', dryRun: false, canWrite: true,
    placement: 'send', liveMinCapUsd: opts.liveMinCapUsd, liveMinMarket: opts.liveMinMarket || '',
    orderTtlSeconds: opts.orderTtlSeconds,
    get allowedMarketIds() {
      try { return require(path.join(ROOT, 'lib/maker/auto-reprice-config')).readAutoRepriceConfig({}).liveMinMarketIds || []; }
      catch { return []; }
    },
    async postOrder(s) {
      // ⚠ SI CHIAMANO I GATE VERI DELL'ADAPTER PRIMA DI ACCETTARE. Il banco non deve poter far passare
      // un ordine che in produzione sarebbe stato rifiutato dall'adapter: sarebbe un banco che mente
      // nella direzione peggiore. Si importa il modulo VERO e si usano le sue funzioni pure.
      // ⚠ IL RIFERIMENTO E' DIRETTO, NON UN `require` SU UN PERCORSO FINTO: `require()` RISOLVE il
      // percorso prima di consultare `require.cache`, quindi registrare la cache su un file che non
      // esiste fallisce con `Cannot find module` — e il fallimento arriva mascherato da
      // `gate: adapter-threw`, cioe' una diagnosi che punta al posto sbagliato.
      const g = ADAPTER_VERO.evaluateLiveMinMarketGate({ mode: 'live-min', liveMinMarket: opts.liveMinMarket,
        allowedMarketIds: this.allowedMarketIds, marketId: s.marketId, side: s.side, size: s.size,
        heldSize: (VENUE.posizioni.get(s.tokenId) || {}).size });
      if (!g.allow) {
        audit({ op: 'postOrder', outcome: g.gate, requested: s, reason: g.reason });
        return { ok: false, gate: g.gate, reason: g.reason };
      }
      const r = VENUE.postOrder(s);
      audit({ op: 'postOrder', outcome: r.ok ? 'ok' : `reject-${r.gate || 'venue'}`,
        requested: s, response: r, reason: r.reason || null });
      return r.ok ? { ok: true, sent: true, orderId: r.orderId, status: r.status } : r;
    },
    async cancelOrder({ orderId }) {
      const r = VENUE.cancelOrder(orderId);
      audit({ op: 'cancelOrder', outcome: 'ok', requested: { orderId }, response: r });
      return r;
    },
    async listOpenOrders({ marketId } = {}) {
      return { ok: true, orders: VENUE.ordiniVivi(marketId), simulated: false };
    },
    async getBalance() { return { ok: true, usd: VENUE.saldo }; },
  };
}

// L'adapter VERO si tiene in una variabile: il banco ne usa le funzioni PURE (i gate), non la rete.
let ADAPTER_VERO = null;
{
  const via = require.resolve(path.join(ROOT, 'lib/venues/polymarket-clob-maker/adapter.js'));
  ADAPTER_VERO = require(via);
  require.cache[via] = { id: via, filename: via, loaded: true, children: [], paths: [],
    exports: { ...ADAPTER_VERO, createMakerAdapter: adapterSimulato, createCancelOnlyAdapter: adapterSimulato } };
}

// ── LE REGOLE DI MERCATO, NELLA FORMA CHE `resolveMarketRules` LEGGE ──────────────────────────────
// ⚠ SI PASSANO COME `deps`, NON SI SOSTITUISCE LA FUNZIONE: `resolveMarketRules(marketId, deps)`
// accetta gia' `deps.books` e `deps.norm`, e `placeManualOrder(spec, deps)` glieli inoltra. Quindi la
// funzione che compone le regole — con il suo ripiego sul catalogo, la sua preferenza per il book
// vivo e la sua eta' del mid — resta quella VERA. Si simula la FONTE, non la lettura.
function depsRegole() {
  const markets = {};
  const norm = [];
  for (const m of VENUE.mercati.values()) {
    markets[m.conditionId] = { marketId: m.conditionId, tokenId: m.tokenId, tokenIdNo: m.tokenIdNo,
      mid: m.book.yes.scoringMid, updatedMs: VENUE.ora, maxSpread: m.bandaCents,
      tickSize: m.tick, minSize: m.minSize, negRisk: m.negRisk,
      books: { yes: m.book.yes, no: m.book.no } };
    norm.push({ marketId: m.conditionId, conditionId: m.conditionId, question: 'banco',
      tokenId: m.tokenId, tokenIdNo: m.tokenIdNo, tickSize: m.tick, minSize: m.minSize,
      // ⚠ IL CAMPO SI CHIAMA `maxSpread`, NON `rewardsMaxSpread`: `resolveMarketRules:380` legge
      // `bm.maxSpread ?? nm.maxSpread`. Col nome sbagliato le regole escono `readable:false` con
      // `missing:['maxSpread']` e OGNI ordine muore a `rules-unreadable` — cioe' il banco misurerebbe
      // il proprio fixture invece del bot. E' la stessa classe «nome sbagliato ⇒ valore di difetto».
      maxSpread: m.bandaCents,
      rewardsMinSize: m.minSize, rewardsMaxSpread: m.bandaCents, negRisk: m.negRisk,
      rewardsDailyRate: 100, mid: m.book.yes.scoringMid, bestBid: m.book.yes.bestBid,
      bestAsk: m.book.yes.bestAsk, rewardProgramme: 'active' });
  }
  return { books: { markets, updatedMs: VENUE.ora }, norm: { markets: norm, updatedMs: VENUE.ora } };
}

module.exports = { VenueSimulato, VENUE, GIORNALE, sostituisci, ROOT, OUT, VERBOSO, MERCATI_SIMULATI, depsRegole, STATO_RIPREZZO };

if (require.main === module) {
  console.log('Questo file e\' la base del banco. Lo scenario si lancia con:');
  console.log('  node scripts/ricerca/banco-scenari.js');
}
