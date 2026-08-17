#!/usr/bin/env node
'use strict';
/**
 * IL CICLO COMPLETO, CONTRO IL VENUE SIMULATO — e l'inventario delle regole che scattano.
 *
 * Base: `banco-ciclo-completo.js`, che sostituisce TRE moduli (adapter, giornale, snapshot posizioni)
 * e lascia tutto il resto — auto-close, auto-reprice, manual-order, i gate, i tetti — al codice VERO.
 *
 * ═══ COSA MISURA, E PERCHE' E' LA DOMANDA GIUSTA ════════════════════════════════════════════════════
 * Ogni regola di questo sistema si dichiara nel giornale con un `outcome` distinto — e' la disciplina
 * che il repo si e' dato («ogni difesa AGISCE, non segnala soltanto», §5 p.124-127). Quindi:
 *
 *      «la regola e' scattata?»  ≡  «il suo `outcome` compare nel giornale della simulazione?»
 *
 * L'inventario dei possibili `outcome` NON e' scritto a mano: si estrae dal SORGENTE. Una lista
 * compilata a mano direbbe soltanto quali regole mi sono ricordato di elencare — cioe' misurerebbe la
 * mia memoria invece del sistema, ed e' esattamente l'errore che questo banco esiste per non ripetere.
 *
 * ⚠ E LE REGOLE MAI SCATTATE SONO ROSSE ANCHE CON IL TEST UNITARIO VERDE. E' il punto dell'operatore:
 * il 16 agosto ogni regola aveva il suo test verde e in produzione non e' scattato niente.
 *
 * Uso:  node scripts/ricerca/banco-scenari.js [--verboso]
 */
const path = require('path');
const fs = require('fs');

// ⚠ LA BASE VA CARICATA PER PRIMA: sostituisce i moduli in `require.cache` prima che qualunque altro
// modulo li catturi. Invertire queste due righe farebbe girare il banco contro il venue VERO.
const BASE = require('./banco-ciclo-completo');
const { VENUE, GIORNALE, ROOT, VERBOSO, MERCATI_SIMULATI, depsRegole } = BASE;

// Da qui in giu' e' tutto codice di PRODUZIONE.
// ⚠ agent40 SI CARICA COME MODULO, non si avvia: `require` di un agent esegue il suo corpo di
// modulo (caricatore .env, costanti) ma NON il suo `main()`, che sta dietro `require.main === module`.
// Serve perche' due presidi — la sorveglianza sulla valutazione e l'allarme sulle sparizioni non
// nostre — vivono LI' e non in `lib/`: il banco che non li chiama non li puo' vedere scattare, ed e'
// esattamente perche' nella prima corsa risultavano rossi.
const A40 = require(path.join(ROOT, 'agents/agent40-manual-reprice'));
const AC = require(path.join(ROOT, 'lib/maker/auto-close'));
const AR = require(path.join(ROOT, 'lib/maker/auto-reprice'));
const MO = require(path.join(ROOT, 'lib/maker/manual-order'));

const MKT = '0x' + 'a1'.repeat(32);

// ── L'INVENTARIO DELLE REGOLE, ESTRATTO DAL SORGENTE ───────────────────────────────────────────────
// Si cercano i letterali `outcome: '...'` e `outcome: \`...\`` nei moduli che decidono. Un `outcome`
// costruito a runtime (`outcome: \`skip-${d.gate}\``) non e' estraibile come stringa: si registra la
// sua FORMA, e a fine corsa si dice quante forme dinamiche hanno prodotto valori concreti.
function inventarioRegole() {
  const file = [
    'lib/maker/auto-close.js', 'lib/maker/auto-reprice.js', 'lib/maker/manual-order.js',
    'lib/maker/bulk-allocate.js', 'agents/agent41-realloc-scheduler.js',
    // ⚠ agent40 VA INCLUSO: e' il processo che ospita i due presidi nuovi — la sorveglianza sulla
    // valutazione e l'allarme sulle sparizioni non nostre. Lasciarlo fuori avrebbe prodotto un
    // referto che NON elenca due regole scritte ieri, cioe' un inventario che rassicura per omissione.
    'agents/agent40-manual-reprice.js',
  ];
  const statiche = new Map();   // outcome → [file]
  const dinamiche = [];
  for (const f of file) {
    let src; try { src = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    // I commenti non sono codice: un `outcome` NOMINATO in un commento non e' una regola che esiste.
    const codice = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    // ⚠ SI PRENDE TUTTA L'ESPRESSIONE DI `outcome:`, NON IL SOLO LETTERALE ATTACCATO AL DUE PUNTI.
    // Un `outcome: cond ? 'a' : 'b'` — e ce ne sono — sfuggiva a una regex ancorata a `outcome:\s*'`,
    // quindi DUE regole vere (`posizione-mai-valutata`, `posizione-non-valutata`) non erano nemmeno
    // inventariate: il banco non poteva dichiararle rosse ne' verdi, semplicemente non le vedeva.
    // Un inventario che non vede una regola e' peggio di un inventario che la dichiara rossa.
    for (const m of codice.matchAll(/outcome:\s*([^,\n]+)/g)) {
      for (const q of String(m[1]).matchAll(/'([a-z0-9-]{3,})'/g)) {
        if (!statiche.has(q[1])) statiche.set(q[1], []);
        if (!statiche.get(q[1]).includes(f)) statiche.get(q[1]).push(f);
      }
    }
    for (const m of codice.matchAll(/outcome:\s*`([^`]+)`/g)) dinamiche.push({ file: f, forma: m[1] });
  }
  return { statiche, dinamiche };
}

// ── IL CABLAGGIO DEI CICLI VERI ───────────────────────────────────────────────────────────────────
// ⚠ Ogni dep punta al venue simulato, e NESSUNA sostituisce una decisione: le funzioni che decidono
// (`decideClose`, `decideReprice`, il motore, la scala) restano quelle di produzione.
const regolePer = (cid) => {
  const m = VENUE.mercato(cid);
  if (!m || VENUE.scenari.feedTace) return { readable: false, missing: ['feed'] };
  return { readable: true, title: 'banco', tick: m.tick, minSize: m.minSize, maxSpreadCents: m.bandaCents,
    tokenId: m.tokenId, tokenIdNo: m.tokenIdNo, negRisk: m.negRisk,
    mid: m.book.yes.scoringMid, midSource: 'live-book', midAgeSec: 1, feedAgeSec: 1,
    books: m.book, feedVitality: { assetsRecenti: 200, finestraSec: 30 } };
};

const depsChiusura = (registri) => ({
  marketIds: [MKT],
  now: () => VENUE.ora,
  killStatus: () => ({ effectivelyKilled: false, readable: true, killed: false }),
  isEnabled: () => ({ enabled: true }),
  isManual: () => ({ manual: true, readable: true }),
  resolveRules: regolePer,
  readVenue: async (cid) => { const m = VENUE.mercato(cid);
    return { readable: true, closed: !!(m && m.chiuso), acceptingOrders: !(m && m.chiuso),
      bestBid: m ? m.book.yes.bestBid : null, bestAsk: m ? m.book.yes.bestAsk : null }; },
  readPositions: async () => ({ ok: true, positions: VENUE.snapshotPosizioni() }),
  listOrders: async ({ marketId } = {}) => ({ ok: true, orders: VENUE.ordiniVivi(marketId) }),
  readDepth: (cid) => { const m = VENUE.mercato(cid); if (!m) return { readable: false };
    return { readable: true, ageMs: 0, live: true,
      yes: { bids: m.book.yes.bids, asks: m.book.yes.asks }, no: { bids: m.book.no.bids, asks: m.book.no.asks } }; },
  attesaMerge: registri.merge, chiusura: registri.chiusura,
  // ⚠ IL MERGE PASSA DALLA DEP CHE `fondiCoppia` GIA' ACCETTA (`deps.mergeOnChain`): la decisione di
  // fondere — `decidiLivello` che risponde `azione:'merge'` — resta quella di produzione, e qui si
  // sostituisce solo la catena on-chain, che senza rete non e' esercitabile.
  // ⚠ LA FORMA DELLA RISPOSTA E' UN CONTRATTO, E VA RISPETTATA ALLA LETTERA: `fondiCoppia` accetta
  // il merge solo se `r.eseguito === true` (auto-close.js:597), non se `r.ok`. Con la forma sbagliata
  // il merge AVVIENE — il capitale torna, le posizioni spariscono — ma il bot lo registra come
  // `merge-onchain-non-eseguito`: effetto giusto, verbale sbagliato. E' il tipo di divergenza che un
  // banco deve prendere, e l'ha presa.
  mergeOnChain: async ({ marketId, size }) => {
    const r = VENUE.merge(marketId, size);
    if (!r.ok) throw new Error(r.reason);
    return { eseguito: true, transactionID: r.transactionID, transactionHash: `0x${'ab'.repeat(32)}`,
      stato: 'CONFIRMED', size: r.quanteShare };
  },
  // ⚠ `placeOrder` PASSA DAL `placeManualOrder` VERO — con tutti i suoi gate — e non dal venue diretto.
  // E' la differenza fra provare il ciclo e provare il simulatore.
  placeOrder: (spec) => MO.placeManualOrder({ ...spec, userId: 'operator' }, depsRegole()),
  cancelOrder: ({ orderId }) => MO.cancelManualOrder({ orderId }, 'banco'),
  segnaValutazione: () => {},
  audit: (r) => GIORNALE.push(r),
});

const registroMem = () => { const m = new Map();
  return { leggi: (k) => m.get(k) || null, segna: (k, v) => m.set(k, v), pulisci: (k) => m.delete(k), _m: m }; };

const registroChiusura = () => { const m = new Map();
  return {
    entra: ({ marketId, book, tipoFill, sizeFillata, ora }) => {
      const k = `${marketId}:${book}`;
      if (m.has(k)) return { nuova: false, voce: m.get(k) };
      const v = { da: ora, daIso: new Date(ora).toISOString(), tipoFill, sizeFillata, regoleAttive: true };
      m.set(k, v); return { nuova: true, voce: v };
    },
    leggi: (marketId, book) => { const v = m.get(`${marketId}:${book}`);
      return v ? { attiva: true, daMin: Math.round((VENUE.ora - v.da) / 60000), daIso: v.daIso } : null; },
    esci: (marketId, book) => m.delete(`${marketId}:${book}`),
    _dump: () => Object.fromEntries(m),
  }; };

// ════════════════════════════════════════════════════════════════════════════════════════════════════
(async () => {
  const t0 = Date.now();
  const inv = inventarioRegole();
  const registri = { merge: registroMem(), chiusura: registroChiusura() };
  const passi = [];
  const passo = (n, d = {}) => { passi.push({ ora: new Date(VENUE.ora).toISOString().slice(11, 19), n, ...d });
    if (VERBOSO) console.log(`  ${new Date(VENUE.ora).toISOString().slice(11, 19)}  ${n}`); };

  console.log('\n════ BANCO DEL CICLO COMPLETO — il bot vero, venue simulato ════\n');

  // ── FASE 1 · IL MERCATO E LE DUE GAMBE ──────────────────────────────────────────────────────────
  VENUE.creaMercato({ conditionId: MKT, mid: 0.40, tick: 0.01, minSize: 50, bandaCents: 4.5 });
  // Il mercato entra nella gestione manuale e nella allowlist SIMULATE: e' la precondizione che in
  // produzione crea `preparaMercatoNuovo`, e senza la quale il primo gate rifiuta tutto.
  MERCATI_SIMULATI.add(MKT.toLowerCase());
  passo('mercato creato: mid 0.40, banda ±4.5c, minSize 50');

  // Le due gambe di liquidita', piazzate dalla corsia VERA.
  for (const [book, price] of [['yes', 0.38], ['no', 0.58]]) {
    const r = await MO.placeManualOrder({ marketId: MKT, book, side: 'BUY', price, size: 60,
      userId: 'operator', inCoda: true }, depsRegole());
    passo(`gamba ${book} @ ${price}`, { ok: r.ok, gate: r.gate || null, reason: (r.reason || '').slice(0, 80) });
  }

  // ── FASE 2 · IL MID SI MUOVE E IL RIPREZZO INSEGUE ──────────────────────────────────────────────
  for (let i = 0; i < 3; i++) {
    VENUE.avanza(60_000); VENUE.muoviMid(MKT, -0.01);
    const res = await AR.runAutoRepriceCycle({
      now: () => VENUE.ora,
      configDeps: { }, killStatus: () => ({ effectivelyKilled: false, readable: true }),
      listOrders: async () => ({ ok: true, orders: VENUE.ordiniVivi(MKT) }),
      resolveRules: () => regolePer(MKT),
      readVenue: async () => ({ readable: true, closed: false, acceptingOrders: true }),
      replaceOrder: async (s) => MO.replaceManualOrder(s, depsRegole()),
      cancelOrder: async (s) => MO.cancelManualOrder(s, 'banco'),
      audit: (r) => GIORNALE.push(r),
    }).catch((e) => ({ errore: e.message }));
    passo(`riprezzo #${i + 1} · mid ${VENUE.mercato(MKT).mid.toFixed(2)}`, { errore: res && res.errore });
  }

  // ── FASE 3 · IL FILL, PARZIALE E SOTTO IL MINIMO ────────────────────────────────────────────────
  // ⚠ Il primo fill e' di 1,82 share, cioe' esattamente il caso del 16 agosto: sotto `minSize 50`,
  // quindi il completamento non e' un ordine valido e tutte le vie si chiudono insieme.
  VENUE.scenari.avgPriceNascostoPerCicli = 1;   // il venue non pubblica ancora l'avgPrice
  const gambaYes = VENUE.ordiniVivi(MKT).find((o) => o.tokenId === VENUE.mercato(MKT).tokenId && o.side === 'BUY');
  if (gambaYes) { VENUE.riempi(gambaYes.orderId, 1.82); passo('FILL PARZIALE 1.82 share (sotto minSize 50)'); }

  VENUE.avanza(60_000);
  await AC.runAutoCloseCycle(depsChiusura(registri)).catch((e) => passo('auto-close errore', { e: e.message }));
  passo('ciclo di chiusura #1 (avgPrice NON pubblicato)');

  // ── FASE 4 · IL RESTO DEL FILL, E LA GAMBA OPPOSTA ──────────────────────────────────────────────
  const g2 = VENUE.ordiniVivi(MKT).find((o) => o.tokenId === VENUE.mercato(MKT).tokenId && o.side === 'BUY');
  if (g2) { VENUE.riempi(g2.orderId, 58); passo('FILL del resto (58 share)'); }
  VENUE.avanza(60_000);
  await AC.runAutoCloseCycle(depsChiusura(registri)).catch((e) => passo('auto-close errore', { e: e.message }));
  passo('ciclo di chiusura #2 (avgPrice pubblicato)');

  // ── FASE 5 · IL TEMPO PASSA: LA SCALA D'URGENZA ─────────────────────────────────────────────────
  for (const min of [35, 70, 130, 250]) {
    VENUE.avanza(min * 60_000 - (VENUE.ora - VENUE.ora));   // avanza in blocchi
    VENUE.muoviMid(MKT, -0.005);
    await AC.runAutoCloseCycle(depsChiusura(registri)).catch(() => {});
    passo(`ciclo di chiusura a +${min} min di scopertura`);
  }

  // ── FASE 6 · LA COPPIA SI COMPLETA, E IL MERGE ──────────────────────────────────────────────────
  const gambaNo = VENUE.ordiniVivi(MKT).find((o) => o.tokenId === VENUE.mercato(MKT).tokenId + 'X'
    || (o.tokenId === VENUE.mercato(MKT).tokenIdNo && o.side === 'BUY'));
  if (gambaNo) { VENUE.riempi(gambaNo.orderId, gambaNo.sizeRemaining); passo('la gamba NO si riempie: coppia COMPLETA'); }
  VENUE.avanza(60_000);
  // ⚠ PRIMA IL MERGE CHE FALLISCE, POI QUELLO CHE RIESCE: i due esiti sono regole diverse
  // (`merge-onchain-fallito` e `merge-onchain-eseguito`) e vanno entrambi raggiunti. Provare solo il
  // fallimento — com'era la prima corsa — lascia rossa la regola che conta davvero, cioe' quella che
  // riporta il capitale.
  VENUE.scenari.mergeFallisce = true;
  await AC.runAutoCloseCycle(depsChiusura(registri)).catch(() => {});
  passo('ciclo con coppia completa · merge che FALLISCE', { saldo: +VENUE.saldo.toFixed(2) });

  VENUE.scenari.mergeFallisce = false;
  VENUE.avanza(60_000);
  const saldoPrima = VENUE.saldo; const posPrima = VENUE.posizioni.size;
  await AC.runAutoCloseCycle(depsChiusura(registri)).catch(() => {});
  passo('ciclo con coppia completa · merge che RIESCE',
    { saldoPrima: +saldoPrima.toFixed(2), saldoDopo: +VENUE.saldo.toFixed(2),
      posizioniPrima: posPrima, posizioniDopo: VENUE.posizioni.size });

  // ── FASE 7 · GLI SCENARI CATTIVI ────────────────────────────────────────────────────────────────
  VENUE.scenari.feedTace = true;
  VENUE.avanza(60_000);
  await AC.runAutoCloseCycle(depsChiusura(registri)).catch(() => {});
  passo('ciclo con il FEED CHE TACE');
  VENUE.scenari.feedTace = false;

  VENUE.avanza(25 * 60_000);   // oltre la GTD di 23 minuti
  passo('avanzato oltre la GTD: gli ordini scadono');
  await AC.runAutoCloseCycle(depsChiusura(registri)).catch(() => {});

  // ── I DUE PRESIDI DI agent40 ───────────────────────────────────────────────────────────────────
  // ⚠ VANNO CHIAMATI, e la prima corsa non lo faceva: `sorveglianzaTask` e `sparizioneTask` girano sul
  // giro principale di agent40, FUORI da `closeTask`, e il banco guidava solo i cicli di `lib/`.
  // Un presidio che il banco non chiama risulta rosso per colpa del banco, non del bot — che e'
  // esattamente il tipo di bugia che questo banco esiste per non raccontare.
  //
  // ① LA SORVEGLIANZA: si fa passare una posizione aperta senza mai valutarla per due cicli.
  await A40.sparizioneTask({ now: () => VENUE.ora }).catch(() => {});   // primo giro: fotografa lo stato di partenza
  await A40.sorveglianzaTask({ now: () => VENUE.ora }).catch(() => {});
  VENUE.avanza(3 * 60_000);                      // oltre i 2 cicli da 60 s di tolleranza
  const rs = await A40.sorveglianzaTask({ now: () => VENUE.ora }).catch((e) => ({ errore: e.message }));
  passo('sorveglianza: posizione aperta e non valutata per oltre due cicli',
    { posizioni: VENUE.posizioni.size, anomalie: rs && rs.anomalie ? rs.anomalie.length : null,
      motivo: rs && rs.motivo });

  // ② LA SPARIZIONE NON NOSTRA: la posizione se ne va senza un nostro ordine.
  const tokPos = [...VENUE.posizioni.keys()][0];
  if (tokPos) { VENUE.sparizioneEsterna(tokPos, VENUE.posizioni.get(tokPos).size); passo('SPARIZIONE NON NOSTRA'); }
  VENUE.avanza(60_000);
  await A40.sparizioneTask({ now: () => VENUE.ora }).catch((e) => passo('sparizioneTask errore', { e: e.message }));
  passo('ciclo dopo la sparizione');
  await AC.runAutoCloseCycle(depsChiusura(registri)).catch(() => {});

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // IL VERDETTO
  // ════════════════════════════════════════════════════════════════════════════════════════════════
  const visti = new Map();
  for (const r of GIORNALE) { const o = String(r.outcome || ''); if (!o) continue; visti.set(o, (visti.get(o) || 0) + 1); }

  const scattate = []; const mai = [];
  for (const [regola, file] of [...inv.statiche].sort()) {
    (visti.has(regola) ? scattate : mai).push({ regola, file, volte: visti.get(regola) || 0 });
  }
  // Gli `outcome` visti che NON sono nell'inventario statico: sono le forme dinamiche che hanno
  // prodotto un valore concreto. Contano come scattate, e vanno mostrate perche' sono regole vere.
  const dinamicheScattate = [...visti.keys()].filter((o) => !inv.statiche.has(o));

  const referto = {
    generatoIl: new Date().toISOString(), durataMs: Date.now() - t0,
    eventiVenue: VENUE.eventi.length, righeGiornale: GIORNALE.length,
    passi,
    regoleInventariate: inv.statiche.size,
    regoleScattate: scattate.length,
    regoleMaiScattate: mai.length,
    formeDinamiche: inv.dinamiche.length,
    dinamicheConcretizzate: dinamicheScattate.length,
    scattate, mai, dinamicheScattate,
    eventiVenueRiassunti: [...VENUE.eventi.reduce((m, e) => m.set(e.tipo, (m.get(e.tipo) || 0) + 1), new Map())]
      .map(([tipo, n]) => ({ tipo, n })),
  };
  fs.mkdirSync(path.dirname(BASE.OUT), { recursive: true });
  fs.writeFileSync(BASE.OUT, JSON.stringify(referto, null, 1));
  // ⚠ IL GIORNALE INTERO SI SCRIVE A PARTE, e serve piu' del referto: quando una regola NON scatta, la
  // domanda e' «dove si e' fermato il codice», e la risposta sta nelle righe che ha scritto invece.
  // Senza questo file si finisce a indovinare, che e' il modo in cui si aggira un banco.
  fs.writeFileSync(BASE.OUT.replace(/\.json$/, '-giornale.jsonl'),
    GIORNALE.map((r) => JSON.stringify(r)).join('\n') + '\n');

  console.log('── il ciclo percorso ──');
  for (const p of passi) console.log(`  ${p.ora}  ${p.n}${p.gate ? `  ⟨${p.gate}⟩` : ''}`);
  console.log('\n── cosa ha fatto il venue simulato ──');
  for (const e of referto.eventiVenueRiassunti) console.log(`  ${String(e.n).padStart(4)}  ${e.tipo}`);
  console.log(`\n── regole ──`);
  console.log(`  inventariate dal sorgente : ${inv.statiche.size}`);
  console.log(`  SCATTATE nella simulazione: ${scattate.length}`);
  console.log(`  MAI SCATTATE (rosse)      : ${mai.length}`);
  console.log(`  forme dinamiche concrete  : ${dinamicheScattate.length}`);
  console.log(`\nreferto → ${path.relative(ROOT, BASE.OUT)}`);
})();
