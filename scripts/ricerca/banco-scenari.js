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
// ⚠ agent40 NON si carica QUI, e non e' una dimenticanza: si carica alla FASE 7, dopo il reset, cosi'
// che la sua memoria di modulo sia vuota quando i due presidi che ospita vengono messi alla prova.
// (Che si possa caricare senza avviarlo resta vero: `require` di un agent esegue il suo corpo di modulo
// — caricatore .env, costanti — ma NON il suo `main()`, che sta dietro `require.main === module`.)
const AC = require(path.join(ROOT, 'lib/maker/auto-close'));
const AR = require(path.join(ROOT, 'lib/maker/auto-reprice'));
const MO = require(path.join(ROOT, 'lib/maker/manual-order'));
const LOCK = require(path.join(ROOT, 'lib/maker/lock-mercato'));

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
      const espr = String(m[1]);
      // ⚠ NON TUTTE LE STRINGHE SU UNA RIGA `outcome:` SONO UN OUTCOME, e prenderle tutte gonfia
      // l'inventario di regole che non esistono — che e' il modo di rendere illeggibile la lista da
      // guardare a mano. Si scartano due forme:
      //   · l'operando di un confronto — `(rp && rp.action === 'rimpiazza') ? …` : e' un'AZIONE, non
      //     un esito, e il suo nome finisce nella riga solo perche' la decide;
      //   · il ripiego dentro un template — `` `reject-${gate || 'place'}` `` : «place» non e' un
      //     outcome, e' il pezzo che si usa quando il gate non si legge. L'outcome vero e' dinamico.
      const senzaConfronti = espr.replace(/[!=]==?\s*'[^']*'/g, ' ');
      const senzaRipieghi = senzaConfronti.replace(/\$\{[^}]*\}/g, ' ');
      for (const q of senzaRipieghi.matchAll(/'([a-z0-9-]{3,})'/g)) {
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
  // ⚠ SCENARIO SU UN SLATE PULITO, DICHIARATO E VERIFICATO — e la ragione e' una regressione vera che
  // il banco ha preso: finche' questi due presidi si appoggiavano alle posizioni lasciate dalle fasi
  // precedenti, funzionavano per caso. Quando il merge ha smesso di fallire — cioe' quando ho reso il
  // banco piu' FEDELE — le posizioni sparivano prima e i due presidi tornavano rossi senza che nulla
  // nel bot fosse cambiato. Uno scenario che dipende dagli avanzi di quello prima non e' uno scenario.
  //
  // Un mercato proprio non basta: gli avanzi da cui questi due presidi dipendono sono TRE, e vivono in
  // tre posti diversi.
  //   ① le POSIZIONI del venue — un'altra posizione aperta produce l'anomalia al posto della nostra,
  //      e lo scenario passa senza aver provato niente;
  //   ② la MEMORIA DEI MODULI di agent40 — `posizioniPrecedenti` (la fotografia da cui si giudica una
  //      sparizione), `statoSorveglianza` (da quanto una posizione e' muta) e `nostriInvii` (gli invii
  //      che SPIEGANO una sparizione). Un invio di una fase precedente ancora in finestra spiegherebbe
  //      la sparizione e SPEGNEREBBE l'allarme: qui l'avanzo produce un falso rosso, non un falso verde;
  //   ③ gli ORDINI VIVI, che possono riempirsi da soli e cambiare le posizioni sotto i piedi.
  // Quindi si azzerano tutti e tre — il venue con `azzera()`, la memoria dei moduli RICARICANDO agent40
  // da `require.cache`, che e' l'unico modo di ottenere uno stato virgine senza aggiungere al codice di
  // produzione una funzione di reset che in produzione non serve a nessuno.
  const daQui = GIORNALE.length;   // ⚠ il verbale si guarda DA QUI IN GIU', o si conterebbero le fasi prima
  const buttato = VENUE.azzera('prima dei due presidi di agent40');
  const via40 = require.resolve(path.join(ROOT, 'agents/agent40-manual-reprice'));
  delete require.cache[via40];
  const A40F = require(via40);   // stesso modulo, memoria vuota
  // Lo stato del slate si FOTOGRAFA qui, non si rilegge in fondo: fra qui e la verifica passano i cicli
  // dei due presidi, e un controllo fatto dopo misurerebbe il loro effetto invece del punto di partenza.
  const slate = { posizioni: VENUE.posizioni.size, ordini: VENUE.ordiniVivi().length };
  passo('RESET prima dei due presidi: venue svuotato e agent40 ricaricato', { ...buttato, ...slate });

  const M5 = '0x' + 'e5'.repeat(32);
  const m5 = VENUE.creaMercato({ conditionId: M5, mid: 0.40, tick: 0.01, minSize: 50, bandaCents: 4.5 });
  MERCATI_SIMULATI.add(M5.toLowerCase());
  VENUE.posizioni.set(m5.tokenId, { size: 60, costoTotale: 60 * 0.38, nascondiPerCicli: 0 });

  // ① LA SORVEGLIANZA: si fa passare una posizione aperta senza mai valutarla per due cicli.
  await A40F.sparizioneTask({ now: () => VENUE.ora }).catch(() => {});   // primo giro: fotografa lo stato di partenza
  await A40F.sorveglianzaTask({ now: () => VENUE.ora }).catch(() => {});
  VENUE.avanza(3 * 60_000);                      // oltre i 2 cicli da 60 s di tolleranza
  const rs = await A40F.sorveglianzaTask({ now: () => VENUE.ora }).catch((e) => ({ errore: e.message }));
  passo('sorveglianza: posizione aperta e non valutata per oltre due cicli',
    { posizioni: VENUE.posizioni.size, anomalie: rs && rs.anomalie ? rs.anomalie.length : null,
      motivo: rs && rs.motivo });

  // ② LA SPARIZIONE NON NOSTRA: la posizione se ne va senza un nostro ordine.
  // ⚠ SI LEGGE LA POSIZIONE PRIMA DI USARLA. Provando il reset con un `sed` che toglieva la posizione
  // seminata, questa riga moriva di `TypeError` invece di lasciare cadere la verifica: un banco che
  // esplode punta al posto sbagliato, mentre una verifica rossa dice quale scenario si e' svuotato.
  const tokPos = m5.tokenId;
  const posM5 = tokPos ? VENUE.posizioni.get(tokPos) : null;
  if (posM5) { VENUE.sparizioneEsterna(tokPos, posM5.size); passo('SPARIZIONE NON NOSTRA'); }
  else passo('SPARIZIONE NON NOSTRA saltata: nessuna posizione da far sparire');
  VENUE.avanza(60_000);
  await A40F.sparizioneTask({ now: () => VENUE.ora }).catch((e) => passo('sparizioneTask errore', { e: e.message }));
  passo('ciclo dopo la sparizione');

  // ⚠ LA PROVA DEL RESET, e non e' una formalita': i due esiti si cercano SOLO nelle righe scritte
  // DOPO l'azzeramento. Cercarli nel giornale intero li troverebbe comunque — le fasi precedenti ne
  // producono — e il banco direbbe «verde» misurando avanzi, cioe' ripeterebbe esattamente l'errore
  // che questo reset esiste per non fare mai piu'.
  const dopoIlReset = new Set(GIORNALE.slice(daQui).map((r) => String(r.outcome || '')));
  // ⚠ QUESTE TRE VERIFICHE SANNO CADERE, ed e' stato provato invece che promesso — un'asserzione che
  // non sa diventare rossa non prova niente. Due controprove, riproducibili copiando i due file del
  // banco in una cartella a parte (con `ROOT` a un livello in piu' di `..`) e patchando la copia:
  //   · NEG A — si toglie la riga che semina la posizione su M5: cadono la 2 e la 3, exit 1;
  //   · NEG B — si chiama `registraNostroInvio` sul token di M5 prima della sparizione, cioe' si
  //     ricrea l'AVANZO che il reset esiste per cancellare (un invio di una fase precedente ancora in
  //     finestra SPIEGA la sparizione): cade la 3 e resta verde la 2, exit 1.
  // La seconda e' quella che conta: e' la forma esatta della regressione del 17 agosto, e la verifica
  // la vede.
  const verifiche = [
    { nome: 'il reset lascia il venue davvero vuoto',
      atteso: '0 posizioni e 0 ordini vivi al momento del reset',
      visto: slate, ok: slate.posizioni === 0 && slate.ordini === 0 },
    { nome: 'posizione-mai-valutata scatta DOPO il reset, su stato virgine',
      atteso: "outcome 'posizione-mai-valutata' fra le righe successive all'azzeramento",
      ok: dopoIlReset.has('posizione-mai-valutata') },
    { nome: 'posizione-uscita-senza-nostro-ordine scatta DOPO il reset, su stato virgine',
      atteso: "outcome 'posizione-uscita-senza-nostro-ordine' fra le righe successive all'azzeramento",
      ok: dopoIlReset.has('posizione-uscita-senza-nostro-ordine') },
  ];

  await AC.runAutoCloseCycle(depsChiusura(registri)).catch(() => {});

  // ── FASE 8 · GLI SCENARI MIRATI ─────────────────────────────────────────────────────────────────
  // ⚠ NON SONO UN AGGIRAMENTO DEL BANCO: sono le CONDIZIONI DI MERCATO che il ciclo principale non
  // produce mai. Una regola che richiede «il bid arriva al pavimento» non e' raggiungibile in uno
  // scenario in cui il mid cade sempre di piu' del pavimento — e non perche' la regola sia morta, ma
  // perche' quel mercato non e' mai capitato. Aggiungere lo scenario e' completare il banco;
  // ammorbidire la regola sarebbe aggirarlo.

  // ① L'ATTRAVERSAMENTO. Serve: uscita a libro, gradino ≥ 1, e il bid AL pavimento o sopra.
  //    Nel ciclo principale il mid cade di 3-5 tick e il pavimento (carico − 1 tick) resta sopra il
  //    bid: il prezzo non incrocia e il permesso non serve. Qui il mercato scende di UN tick solo,
  //    che e' il caso piu' comune di tutti.
  {
    const M2 = '0x' + 'b2'.repeat(32);
    const m2 = VENUE.creaMercato({ conditionId: M2, mid: 0.50, tick: 0.01, minSize: 50, bandaCents: 4.5 });
    // ⚠ LA CONTROPARTE DEV'ESSERE TROPPO CARA, o non si arriva mai all'uscita. Nella prima stesura di
    // questo scenario il Livello 1 completava la coppia col taker (`merge-livello-1-piazzato`) e la
    // gamba non restava MAI nuda: l'uscita non veniva proposta e l'attraversamento non poteva
    // scattare. Non era un difetto del bot — era uno scenario che si risolveva da solo prima di
    // arrivare al punto che voleva misurare.
    // Si alza l'ask del NO sopra il tetto della coppia (101c − carico 48c = 53c): a 60c il Livello 1
    // e il Livello 2 non possono comprare, e la posizione resta scoperta come nel caso vero.
    m2.book.no.asks = [{ price: 0.60, size: 500 }];
    m2.book.no.bestAsk = 0.60;
    MERCATI_SIMULATI.add(M2.toLowerCase());
    const r = await MO.placeManualOrder({ marketId: M2, book: 'yes', side: 'BUY', price: 0.48, size: 60,
      userId: 'operator', inCoda: true }, depsRegole());
    if (r.ok) {
      const o = VENUE.ordiniVivi(M2).find((x) => x.side === 'BUY');
      VENUE.riempi(o.orderId, 60);                       // posizione a carico 0,48
      const reg2 = { merge: registroMem(), chiusura: registroChiusura() };
      VENUE.avanza(60_000);
      await AC.runAutoCloseCycle({ ...depsChiusura(reg2), marketIds: [M2] }).catch(() => {});
      // ⚠ SI AVANZA A PASSI CON I CICLI IN MEZZO, non in un salto solo. Un `avanza(90 min)` fa scadere
      // TUTTI gli ordini di GTD (1380 s = 23 min): al ciclo dopo non c'e' nessuna uscita a libro,
      // quindi non c'e' il ramo `already-covered` che insegue il bid, e l'attraversamento non puo'
      // scattare. E' come funziona la produzione — il ciclo gira ogni minuto e rinnova — e saltarlo
      // avrebbe misurato uno stato che in produzione non esiste.
      for (let k = 0; k < 9; k++) {
        VENUE.avanza(10 * 60_000);
        // ⚠ IL MID SI MUOVE DOPO CHE L'USCITA RIPOSA, e non prima. L'inseguimento del bid vive SOLO nel
        // ramo `already-covered`/`uscita-da-abbassare`, cioe' quando un'uscita esiste gia' e va
        // riprezzata: il PRIMO piazzamento e' una quotazione all'obiettivo e non insegue. Muovere il
        // mid prima significa misurare il ramo che non insegue, e concludere «non attraversa» per la
        // ragione sbagliata.
        // Due tick, non uno: serve che il bid scenda AL pavimento (carico 48c − 1 tick = 47c).
        if (k === 4) { VENUE.muoviMid(M2, -0.02); }
        // `muoviMid` ricostruisce il book: l'ask caro va rimesso, o il Livello 1 torna a completare.
        m2.book.no.asks = [{ price: 0.60, size: 500 }]; m2.book.no.bestAsk = 0.60;
        await AC.runAutoCloseCycle({ ...depsChiusura(reg2), marketIds: [M2] }).catch(() => {});
      }
      passo('scenario ATTRAVERSAMENTO: bid al pavimento', { bid: VENUE.mercato(M2).book.yes.bestBid });
    } else passo('scenario attraversamento non avviato', { gate: r.gate });
  }

  // ② LA DEROGA SOTTO IL MINIMO. Serve una posizione PICCOLA — sotto `minSize` — che l'uscita provi a
  //    vendere. E' il residuo da 1,82 share del 16 agosto, quello che chiudeva tutte le vie insieme.
  {
    const M3 = '0x' + 'c3'.repeat(32);
    const m3 = VENUE.creaMercato({ conditionId: M3, mid: 0.50, tick: 0.01, minSize: 50, bandaCents: 4.5 });
    MERCATI_SIMULATI.add(M3.toLowerCase());
    // La posizione si crea direttamente: un ordine da 1,82 share sarebbe rifiutato in APERTURA dal
    // minimo premiante, ed e' giusto cosi' — il residuo nasce da un fill parziale, non da un ordine.
    VENUE.posizioni.set(m3.tokenId, { size: 1.82, costoTotale: 1.82 * 0.48, nascondiPerCicli: 0 });
    const reg3 = { merge: registroMem(), chiusura: registroChiusura() };
    VENUE.avanza(60_000);
    await AC.runAutoCloseCycle({ ...depsChiusura(reg3), marketIds: [M3] }).catch(() => {});
    VENUE.avanza(90 * 60_000);
    await AC.runAutoCloseCycle({ ...depsChiusura(reg3), marketIds: [M3] }).catch(() => {});
    passo('scenario DEROGA SOTTO IL MINIMO: posizione da 1,82 share (minSize 50)',
      { restaInPosizione: (VENUE.posizioni.get(m3.tokenId) || {}).size || 0 });
  }

  // ── FASE 9 · I RINNOVI, CON LO STATO E IL LOCK VERI ─────────────────────────────────────────────
  // ⚠ LA RAGIONE PER CUI QUESTO SCENARIO ESISTE: il 16 agosto 12 ordini sono scaduti di GTD senza
  // rinnovo, ed e' il difetto che ha lasciato le gambe spaiate. Nel banco nessuna regola del rinnovo
  // scattava — non perche' fossero morte, ma perche' il ciclo di riprezzo veniva guidato senza lo
  // stato (contatori, ultimo riprezzo, battito) e senza il lucchetto. Un ciclo che crede di essere
  // sempre il primo non puo' accorgersi di un rinnovo dovuto.
  {
    const M4 = '0x' + 'd4'.repeat(32);
    const m4 = VENUE.creaMercato({ conditionId: M4, mid: 0.40, tick: 0.01, minSize: 50, bandaCents: 4.5 });
    MERCATI_SIMULATI.add(M4.toLowerCase());
    const r = await MO.placeManualOrder({ marketId: M4, book: 'yes', side: 'BUY', price: 0.38, size: 60,
      userId: 'operator', inCoda: true }, depsRegole());
    passo('rinnovi: gamba piazzata', { ok: r.ok, gate: r.gate || null });

    const cicloRiprezzo = async () => AR.runAutoRepriceCycle({
      now: () => VENUE.ora,
      configDeps: {},
      killStatus: () => ({ effectivelyKilled: false, readable: true }),
      listOrders: async () => ({ ok: true, orders: VENUE.ordiniVivi(M4) }),
      resolveRules: () => regolePer(M4),
      readVenue: async () => ({ readable: true, closed: false, acceptingOrders: true }),
      // ⚠ LA PROFONDITA' VA INIETTATA, o il pavimento non e' nemmeno valutabile e l'esenzione sul
      // rinnovo (`rinnovo-esente-dal-tetto`) non ha niente da esentare.
      readDepth: () => { const m = VENUE.mercato(M4);
        return { readable: true, ageMs: 0, live: true,
          yes: { bids: m.book.yes.bids, asks: m.book.yes.asks }, no: { bids: m.book.no.bids, asks: m.book.no.asks } }; },
      replaceOrder: async (spec) => MO.replaceManualOrder(spec, depsRegole()),
      cancelOrder: async (spec) => MO.cancelManualOrder(spec, 'banco'),
      audit: (x) => GIORNALE.push(x),
    }).catch((e) => ({ errore: e.message }));

    // ① IL LUCCHETTO GIA' PRESO: e' la corsa del 16 agosto, due cicli sovrapposti sullo stesso mercato.
    LOCK.prendi(M4, { da: 'banco-altro-percorso', ora: VENUE.ora });
    await cicloRiprezzo();
    passo('rinnovi: ciclo con il LUCCHETTO gia\' preso');
    LOCK.rilascia(M4);

    // ② IL RINNOVO DOVUTO: si avanza fino a dentro il margine di rinnovo (180 s dalla scadenza GTD),
    //    con un ciclo a ogni passo — come in produzione, dove il ciclo gira e vede il conto alla
    //    rovescia scendere. Il mid si muove di poco, o il riprezzo lo tratterebbe come uscita di banda.
    for (let k = 0; k < 14; k++) {
      VENUE.avanza(100_000);
      if (k % 5 === 4) VENUE.muoviMid(M4, -0.005);
      // ⚠ DAL SESTO GIRO IL LIBRO SI ASSOTTIGLIA. E' la condizione che il 16 agosto ha prodotto 2.100
      // blocchi (`profondita-insufficiente`) e 12 ordini morti di GTD: dentro la banda premiante resta
      // UN solo livello popolato, e il pavimento di profondita' rifiuta. L'esenzione sui rinnovi
      // (§5.2 p.21, `63c10a0`) esiste proprio per questo — un RINNOVO non aggiunge esposizione, la
      // mantiene — e senza un libro sottile non c'e' niente da esentare.
      if (k >= 5) {
        const mm = VENUE.mercato(M4);
        mm.book.yes.bids = [{ price: mm.book.yes.bestBid, size: 5 }];
        mm.book.no.bids = [{ price: mm.book.no.bestBid, size: 5 }];
      }
      await cicloRiprezzo();
    }
    const vivi = VENUE.ordiniVivi(M4);
    passo('rinnovi: dopo 14 cicli attraverso la finestra di rinnovo',
      { ordiniVivi: vivi.length, scadenzaSec: vivi[0] ? vivi[0].secondsToExpiry : null,
        cicli: BASE.STATO_RIPREZZO.cycles });
  }

  // ── FASE 10 · IL PAVIMENTO DI PROFONDITA' E IL TETTO ORARIO SUI RINNOVI ─────────────────────────
  // ⚠ E' IL PUNTO IN CUI IL 16 AGOSTO SI SONO PERSI 12 ORDINI. Ci si arriva solo con una sequenza
  // precisa, e ognuno dei tre ingredienti serve:
  //   · un ordine che ha GIA' superato l'intervallo anti-churn, o `decideReprice` esce a
  //     `rate-limited` prima di guardare qualunque altra cosa;
  //   · una vita residua DENTRO il margine di rinnovo (180 s), o il ramo del rinnovo non si apre;
  //   · un libro cosi' sottile che il motore rifiuti, o non c'e' niente da fermare.
  {
    const M6 = '0x' + 'f6'.repeat(32);
    const m6 = VENUE.creaMercato({ conditionId: M6, mid: 0.40, tick: 0.01, minSize: 50, bandaCents: 4.5 });
    MERCATI_SIMULATI.add(M6.toLowerCase());
    await MO.placeManualOrder({ marketId: M6, book: 'yes', side: 'BUY', price: 0.38, size: 60,
      userId: 'operator', inCoda: true }, depsRegole());

    // ⚠ LA MEMORIA DEGLI ORDINI VISTI E' UNA DEP, e senza di lei il rilevatore non puo' esistere:
    // `scaduto-senza-rinnovo` confronta gli id di IERI con quelli di OGGI, e con una `new Map()` a
    // ogni chiamata non ha nessun ieri con cui confrontare. Era il motivo per cui restava rossa.
    const visti = new Map();
    const ciclo6 = async () => AR.runAutoRepriceCycle({
      now: () => VENUE.ora, configDeps: {}, ordiniVisti: visti,
      killStatus: () => ({ effectivelyKilled: false, readable: true }),
      listOrders: async () => ({ ok: true, orders: VENUE.ordiniVivi(M6) }),
      resolveRules: () => regolePer(M6),
      readVenue: async () => ({ readable: true, closed: false, acceptingOrders: true }),
      readDepth: () => { const m = VENUE.mercato(M6);
        return { readable: true, ageMs: 0, live: true,
          yes: { bids: m.book.yes.bids, asks: m.book.yes.asks }, no: { bids: m.book.no.bids, asks: m.book.no.asks } }; },
      replaceOrder: async (spec) => MO.replaceManualOrder(spec, depsRegole()),
      cancelOrder: async (spec) => MO.cancelManualOrder(spec, 'banco'),
      audit: (x) => GIORNALE.push(x),
    }).catch((e) => ({ errore: e.message }));

    // ① IL TETTO ORARIO. Si semina lo STATO — `recentAt`, cioe' gli istanti dei riprezzi recenti — e
    //    il ciclo ne CALCOLA il conteggio da solo (auto-reprice.js:1480). Venticinque riprezzi
    //    nell'ultima ora contro un tetto di 20: il rinnovo deve passare COMUNQUE e dichiararlo.
    BASE.STATO_RIPREZZO.markets[M6.toLowerCase()] = {
      recentAt: Array.from({ length: 25 }, (_, i) => VENUE.ora - (i + 1) * 60_000),
      lastRepriceAt: VENUE.ora - 10 * 60_000,   // ben oltre l'intervallo anti-churn
    };
    // Si porta la vita residua dentro il margine di rinnovo (180 s su una GTD di 1380 s).
    VENUE.avanza(1240 * 1000);
    const vivo = VENUE.ordiniVivi(M6)[0];
    passo('rinnovi: vita residua dentro il margine', { sec: vivo ? vivo.secondsToExpiry : null });
    await ciclo6();
    passo('rinnovi: ciclo con TETTO ORARIO raggiunto (25 su 20)');

    // ② IL PAVIMENTO DI PROFONDITA'. Libro ridotto a un solo livello sottilissimo dentro la banda: il
    //    motore non trova un prezzo conforme, il rinnovo dovuto viene FERMATO, e l'ordine muore.
    const M7 = '0x' + 'a7'.repeat(32);
    const m7 = VENUE.creaMercato({ conditionId: M7, mid: 0.40, tick: 0.01, minSize: 50, bandaCents: 4.5 });
    MERCATI_SIMULATI.add(M7.toLowerCase());
    await MO.placeManualOrder({ marketId: M7, book: 'yes', side: 'BUY', price: 0.38, size: 60,
      userId: 'operator', inCoda: true }, depsRegole());
    const visti7 = new Map();
    const ciclo7 = async () => AR.runAutoRepriceCycle({
      now: () => VENUE.ora, configDeps: {}, ordiniVisti: visti7,
      killStatus: () => ({ effectivelyKilled: false, readable: true }),
      listOrders: async () => ({ ok: true, orders: VENUE.ordiniVivi(M7) }),
      resolveRules: () => regolePer(M7),
      readVenue: async () => ({ readable: true, closed: false, acceptingOrders: true }),
      readDepth: () => { const m = VENUE.mercato(M7);
        return { readable: true, ageMs: 0, live: true,
          yes: { bids: m.book.yes.bids, asks: m.book.yes.asks }, no: { bids: m.book.no.bids, asks: m.book.no.asks } }; },
      replaceOrder: async (spec) => MO.replaceManualOrder(spec, depsRegole()),
      cancelOrder: async (spec) => MO.cancelManualOrder(spec, 'banco'),
      audit: (x) => GIORNALE.push(x),
    }).catch((e) => ({ errore: e.message }));
    await ciclo7();                       // primo giro: il rilevatore impara l'id
    VENUE.avanza(1240 * 1000);            // dentro il margine di rinnovo
    // ⚠ UN SOLO LIVELLO, e sottile: «mai primo sul libro» cerca dal SECONDO in giu', quindi con un
    // livello solo non esiste un prezzo conforme. E' la forma esatta di `profondita-insufficiente`.
    m7.book.yes.bids = [{ price: 0.39, size: 3 }];
    m7.book.no.bids = [{ price: 0.59, size: 3 }];
    await ciclo7();
    passo('rinnovi: ciclo con PAVIMENTO che morde (un livello da 3 share)',
      { vivi: VENUE.ordiniVivi(M7).length });

    // ⚠ E QUI IL BANCO INSEGNA UNA COSA CHE NON MI ASPETTAVO: il pavimento di profondita' NON ferma
    // piu' un rinnovo. E' la correzione del 16 agosto (`63c10a0`, §5.2 p.21, `esenzione-rinnovo`) che
    // funziona — il rinnovo ripiazza allo STESSO prezzo e non passa dal motore, quindi il pavimento
    // non lo puo' rifiutare. `anomalia-rinnovo-fermato` per profondita' e' quindi diventata
    // difficilmente raggiungibile PER COSTRUZIONE: la causa che segnalava e' stata rimossa.
    //
    // Per far morire un ordine senza successore serve un'altra strada, e questa e' reale: il FEED
    // TACE nel momento del rinnovo. Il ciclo salta (`mid-stale`), l'ordine non viene rinnovato, e
    // muore di GTD — che e' esattamente la firma di `scaduto-senza-rinnovo`.
    const M8 = '0x' + 'b8'.repeat(32);
    const m8 = VENUE.creaMercato({ conditionId: M8, mid: 0.40, tick: 0.01, minSize: 50, bandaCents: 4.5 });
    MERCATI_SIMULATI.add(M8.toLowerCase());
    await MO.placeManualOrder({ marketId: M8, book: 'yes', side: 'BUY', price: 0.38, size: 60,
      userId: 'operator', inCoda: true }, depsRegole());
    const visti8 = new Map();
    let feedMuto8 = false;
    const ciclo8 = async () => AR.runAutoRepriceCycle({
      now: () => VENUE.ora, configDeps: {}, ordiniVisti: visti8,
      killStatus: () => ({ effectivelyKilled: false, readable: true }),
      listOrders: async () => ({ ok: true, orders: VENUE.ordiniVivi(M8) }),
      // Il mid invecchia: `midAgeSec` oltre il limite ⇒ `mid-stale`, e il rinnovo non parte.
      resolveRules: () => ({ ...regolePer(M8), midAgeSec: feedMuto8 ? 600 : 1, feedAgeSec: feedMuto8 ? 600 : 1 }),
      readVenue: async () => ({ readable: true, closed: false, acceptingOrders: true }),
      readDepth: () => { const m = VENUE.mercato(M8);
        return { readable: true, ageMs: 0, live: true,
          yes: { bids: m.book.yes.bids, asks: m.book.yes.asks }, no: { bids: m.book.no.bids, asks: m.book.no.asks } }; },
      replaceOrder: async (spec) => MO.replaceManualOrder(spec, depsRegole()),
      cancelOrder: async (spec) => MO.cancelManualOrder(spec, 'banco'),
      audit: (x) => GIORNALE.push(x),
    }).catch(() => ({}));
    await ciclo8();                        // il rilevatore impara l'id
    VENUE.avanza(1240 * 1000);
    feedMuto8 = true;
    await ciclo8();                        // rinnovo dovuto, ma il mid e' stantio: si salta
    passo('rinnovi: feed muto nel momento del rinnovo', { vivi: VENUE.ordiniVivi(M8).length });
    VENUE.avanza(200 * 1000);              // l'ordine muore di GTD, senza successore
    feedMuto8 = false;
    await ciclo8();
    passo('rinnovi: ciclo dopo la morte per GTD senza successore', { vivi: VENUE.ordiniVivi(M8).length });
  }

  // ── FASE 11 · LE CONDIZIONI STRETTE DEL RIPREZZO ────────────────────────────────────────────────
  // Le tre del gruppo 1 che dipendono da un BOOK particolare, non da uno stato nostro.
  {
    const scenarioRiprezzo = async (nome, cid, prepara, cancella) => {
      const m = VENUE.creaMercato({ conditionId: cid, mid: 0.40, tick: 0.01, minSize: 50, bandaCents: 4.5 });
      MERCATI_SIMULATI.add(cid.toLowerCase());
      await MO.placeManualOrder({ marketId: cid, book: 'yes', side: 'BUY', price: 0.38, size: 60,
        userId: 'operator', inCoda: true }, depsRegole());
      const visti = new Map();
      const giro = async () => AR.runAutoRepriceCycle({
        now: () => VENUE.ora, configDeps: {}, ordiniVisti: visti,
        killStatus: () => ({ effectivelyKilled: false, readable: true }),
        listOrders: async () => ({ ok: true, orders: VENUE.ordiniVivi(cid) }),
        resolveRules: () => regolePer(cid),
        readVenue: async () => ({ readable: true, closed: false, acceptingOrders: true }),
        readDepth: () => ({ readable: true, ageMs: 0, live: true,
          yes: { bids: m.book.yes.bids, asks: m.book.yes.asks }, no: { bids: m.book.no.bids, asks: m.book.no.asks } }),
        replaceOrder: async (spec) => MO.replaceManualOrder(spec, depsRegole()),
        cancelOrder: cancella || (async (spec) => MO.cancelManualOrder(spec, 'banco')),
        audit: (x) => GIORNALE.push(x),
      }).catch(() => ({}));
      await giro();
      VENUE.avanza(120_000);
      prepara(m);
      await giro();
      passo(`riprezzo: ${nome}`, { vivi: VENUE.ordiniVivi(cid).length });
    };

    // ① SOLI SUL LIBRO: senza concorrenti «mai primo sul libro» non ha un secondo livello dietro cui
    //    mettersi, e la decisione diventa una cancellazione (`top-of-book`).
    await scenarioRiprezzo('soli sul libro (top-of-book)', '0x' + 'c9'.repeat(32), (m) => {
      m.book.yes.bids = []; m.book.no.bids = [];
      m.book.yes.bestBid = null; m.book.no.bestBid = null;
    });

    // ② MID AGLI ESTREMI: fuori da [0,10 · 0,90] un lato solo matura ZERO e si cancella subito
    //    (§4.1 regola 4, `latoSingolo`). E' una condizione del MERCATO, non nostra.
    await scenarioRiprezzo('mid agli estremi (lato singolo a zero)', '0x' + 'da'.repeat(32), (m) => {
      VENUE.aggiornaBook(m, 0.95);
    });

    // ③ UNA CANCELLAZIONE CHE FALLISCE: il venue rifiuta di togliere l'ordine. E' la condizione per cui
    //    esistono i cinque precontrolli del riprezzo — si scopre solo provandola.
    await scenarioRiprezzo('cancellazione rifiutata dal venue', '0x' + 'eb'.repeat(32), (m) => {
      m.book.yes.bids = []; m.book.no.bids = [];
    }, async () => ({ ok: false, reason: 'venue simulato: cancellazione rifiutata' }));
  }

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
    verifiche,
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

  // ── LE VERIFICHE DEL RESET ─────────────────────────────────────────────────────────────────────
  // ⚠ IL BANCO ESCE CON CODICE 1 SE UNA VERIFICA CADE, e non e' pedanteria: un banco che stampa un
  // numero e torna 0 mentre uno scenario si e' svuotato e' precisamente il modo in cui i due presidi di
  // agent40 hanno smesso di scattare senza che nessuno lo notasse. Il conteggio delle regole non lo
  // rileva — 20 su 91 resta 20 su 91 se una regola cade e un'altra nasce.
  const cadute = verifiche.filter((v) => !v.ok);
  console.log(`\n── le verifiche del reset ──`);
  for (const v of verifiche) console.log(`  ${v.ok ? '✅' : '🔴'}  ${v.nome}${v.ok ? '' : `\n        atteso: ${v.atteso}${v.visto ? `\n        visto:  ${JSON.stringify(v.visto)}` : ''}`}`);
  console.log(`\nreferto → ${path.relative(ROOT, BASE.OUT)}`);
  if (cadute.length) {
    console.log(`\n🔴 ${cadute.length} VERIFICA/E CADUTA/E: lo scenario dei due presidi non e' piu' autosufficiente.`);
    process.exitCode = 1;
  }
})();
