#!/usr/bin/env node
'use strict';
// QUANDO L'INSEGUIMENTO DEL MID E «MAI PRIMI SUL LIBRO» CHIEDONO DUE COSE OPPOSTE, CEDE L'INSEGUIMENTO.
//
// ═══ IL CICLO, CON I NUMERI VERI (5 agosto 2026, Eric Barlow, tick 0.001) ════════════════════════════
// 1 · il mid YES è 0.6515; l'inseguimento vuole l'ordine a 0.55¢ dal mid ⇒ obiettivo 0.646
// 2 · al piazzamento «mai primi» guarda il miglior bid altrui (0.650) e si mette un tick dietro ⇒ 0.649
// 3 · a 0.649 la distanza dal mid è 0.25¢, non 0.55¢ ⇒ il ciclo dopo l'inseguimento rivuole 0.646
// 4 · si ricomincia, ogni ~35s (il minimo fra due mosse è 30s)
// Risultato misurato: 21 riprezzi in sei minuti, tetto orario bruciato alle 20:40:44, e — per il difetto
// gemello — le due gambe perse alla scadenza GTD alle ~21:02:34.
//
// ═══ PERCHÉ BARLOW SÌ E TX-15 NO ═════════════════════════════════════════════════════════════════════
// È strutturale e dipende dal TICK, non dal mercato:
//   tick 0.001 (Barlow)  · un tick dietro il concorrente cade a 0.25¢ dal mid, PIÙ VICINO del bersaglio
//                          di 0.55¢ ⇒ le due regole tirano in direzioni opposte, e nessuna cede
//   tick 0.01 (TX-15)    · un tick dietro coincide col bersaglio di 2.00¢ ⇒ concordano, niente da rilevare
// E c'è un secondo effetto dello stesso tick: la soglia minima di movimento è un tick (1.00¢ su TX-15,
// 0.10¢ su Barlow), quindi su tick grosso l'inseguimento non parte nemmeno.
//
// ═══ CHI CEDE, E PERCHÉ NON È UN COMPROMESSO ═════════════════════════════════════════════════════════
// Mai «mai primi»: è la priorità più alta, già decisa e verificata. Cede l'inseguimento, e senza costo:
// 0.25¢ dal mid è più VICINO al mid di 0.55¢, quindi PUNTEGGIO REWARD MIGLIORE. L'inseguimento chiede di
// allontanarsi da una posizione migliore di quella che chiede: è una richiesta priva di senso economico.
//
// ═══ RILEVATO IN MODO STRUTTURALE, NON CON UN CONTATORE ══════════════════════════════════════════════
// La condizione è «il prezzo che "mai primi" imporrà è più vicino al mid del prezzo che l'inseguimento
// chiede». Un contatore direbbe «ho già provato N volte»; questo dice PERCHÉ, e quindi si scioglie da
// solo appena il book cambia — senza stato da azzerare.
//
// NESSUN ORDINE REALE: `decideReprice` è pura; il ciclo gira su dipendenze iniettate.

const AR = require('./auto-reprice');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const MKT = '0xfb481845055afdf15febad269fcb534be4c5e79d5789b72659a036660b46e11b';
const NOW = 1_700_000_000_000;

const mercato = ({ tick, mid, titolo }) => ({
  readable: true, missing: [], marketId: MKT, title: titolo, mid, tick, minSize: 50,
  maxSpreadCents: 4.5, tokenId: 'ty', tokenIdNo: 'tn', midSource: 'live-book', midAgeSec: 2,
  feedVitality: { assetsWithEvents: 40, seededAssets: 100, windowMs: 30_000 },
  books: { yes: { tokenId: 'ty', scoringMid: mid }, no: { tokenId: 'tn', scoringMid: +(1 - mid).toFixed(6) } },
});
const CFG = {
  restingGtdSeconds: 1380, refreshMarginSeconds: 180, minIntervalMs: 30_000, maxPerHour: 20,
  maxMidAgeSecLive: 60, maxMidAgeSecBlind: 10, feedAliveMinAssets: 5, requireLiveBook: true,
  confirmSamples: 2, hysteresisTicks: 1, pollMs: 5000, strategy: 'band-edge', disconnectCancelSeconds: 180,
};
const libro = (bids) => ({ yes: { bids, asks: [] }, no: { bids: [], asks: [] } });
const decidi = ({ rules, order, targetOffsetCents, minMoveCents, bids, ownOrders = null, repricesThisHour = 0 }) =>
  AR.decideReprice(
    { order, rules, config: CFG, lastRepriceAt: null, consecutiveBreaches: 0, repricesThisHour, now: NOW,
      ownOrders: ownOrders || [{ orderId: order.orderId, price: order.price, size: order.size, book: order.book }] },
    { resolveOffset: () => ({ targetOffsetCents, source: 'observed', minMoveCents }),
      resolveDepth: () => libro(bids) },
  );

// ── BARLOW, esattamente come l'audit lo fotografa alle 20:34:18 ───────────────────────────────────
const BARLOW = mercato({ tick: 0.001, mid: 0.6515, titolo: 'Eric Barlow' });
const GAMBA = { orderId: '0xb99f5566', price: 0.649, size: 60.1, book: 'yes', side: 'BUY', secondsToExpiry: 1345 };
const CONCORRENTE = [{ price: 0.650, size: 500 }, { price: 0.649, size: 60.1 }];

console.log('\n══ 1 · IL CONFLITTO VIENE RICONOSCIUTO, NON SUBITO');
{
  const d = decidi({ rules: BARLOW, order: GAMBA, targetOffsetCents: 0.55, minMoveCents: 0.1, bids: CONCORRENTE });
  ok('l ordine NON viene toccato', d.action === 'hold', `${d.action}/${d.gate}`);
  ok('  e il gate nomina il conflitto', d.gate === 'inseguimento-contro-mai-primo', String(d.gate));
  ok('  la soppressione è marcata', d.soppresso === true);
}

console.log('\n══ 2 · I QUATTRO NUMERI DELLA DECISIONE, STRUTTURATI E NON DA DEDURRE');
{
  const d = decidi({ rules: BARLOW, order: GAMBA, targetOffsetCents: 0.55, minMoveCents: 0.1, bids: CONCORRENTE });
  ok('prezzo obiettivo dell inseguimento', d.inseguimentoPrezzo === 0.646, String(d.inseguimentoPrezzo));
  ok('  con la sua distanza dal mid', Math.abs(d.inseguimentoDistanzaC - 0.55) < 0.001, `${d.inseguimentoDistanzaC}¢`);
  ok('prezzo imposto da «mai primi»', d.maiPrimoPrezzo === 0.649, String(d.maiPrimoPrezzo));
  ok('  con la sua distanza dal mid', Math.abs(d.maiPrimoDistanzaC - 0.25) < 0.001, `${d.maiPrimoDistanzaC}¢`);
  ok('e il concorrente da cui si sta dietro', d.bestOther === 0.65, String(d.bestOther));
  ok('la distanza attuale resta dichiarata come sempre', Math.abs(d.distanceC - 0.25) < 0.001, `${d.distanceC}¢`);

  ok('il motivo dice che il conflitto è stato RILEVATO', /CONFLITTO RILEVATO/.test(d.reason));
  ok('  che vince «mai primi»', /vince «mai primi»/.test(d.reason));
  ok('  che il prezzo imposto è più vicino al mid', /PIU. VICINO/.test(d.reason));
  ok('  quindi migliore per il reward', /punteggio reward/.test(d.reason));
  ok('  e a quali condizioni si riprova', /finche' non cambia il book|il concorrente si sposta/.test(d.reason));
  ok('  nominando l episodio da cui viene la regola', /21 riprezzi/.test(d.reason));
}

console.log('\n══ 3 · LO STESSO SUL LATO NO (obiettivo 0.343, riportato a 0.346)');
{
  // Il lato NO di Barlow: mid di scoring 0.3485, miglior bid altrui 0.347 ⇒ un tick dietro dà 0.346.
  const d = AR.decideReprice({
    order: { orderId: '0x356079', price: 0.346, size: 60.1, book: 'no', side: 'BUY', secondsToExpiry: 1345 },
    rules: BARLOW, config: CFG, now: NOW,
    ownOrders: [{ orderId: '0x356079', price: 0.346, size: 60.1, book: 'no' }],
  }, {
    resolveOffset: () => ({ targetOffsetCents: 0.55, source: 'observed', minMoveCents: 0.1 }),
    resolveDepth: () => ({ yes: { bids: [], asks: [] }, no: { bids: [{ price: 0.347, size: 400 }, { price: 0.346, size: 60.1 }], asks: [] } }),
  });
  ok('soppresso anche qui', d.action === 'hold' && d.gate === 'inseguimento-contro-mai-primo', `${d.action}/${d.gate}`);
  ok('  l inseguimento chiedeva 0.343', d.inseguimentoPrezzo === 0.343, String(d.inseguimentoPrezzo));
  ok('  «mai primi» impone 0.346', d.maiPrimoPrezzo === 0.346, String(d.maiPrimoPrezzo));
}

console.log('\n══ 4 · TX-15 ED ED MARKEY NON CAMBIANO: LÌ LE DUE REGOLE CONCORDANO');
{
  // TX-15 come è adesso, letto dal book vivo il 5 agosto: mid 0.63, nostro ordine a 0.61, miglior bid
  // altrui 0.62. Un tick dietro (tick 0.01) dà 0.61, che è a 2.00¢ dal mid — esattamente il bersaglio.
  const TX15 = mercato({ tick: 0.01, mid: 0.63, titolo: 'TX-15' });
  const d = decidi({
    rules: TX15,
    order: { orderId: '0xtx', price: 0.61, size: 61.2, book: 'yes', side: 'BUY', secondsToExpiry: 776 },
    targetOffsetCents: 2.0, minMoveCents: 1.0,
    bids: [{ price: 0.62, size: 180 }, { price: 0.61, size: 61.2 }],
  });
  ok('holding, come da ore', d.action === 'hold', `${d.action}/${d.gate}`);
  ok('  e NON per soppressione: l inseguimento non è mai partito', d.gate === null && d.soppresso !== true, String(d.gate));
  ok('  perché la deriva è nulla', Math.abs(d.currentOffsetCents - d.targetOffsetCents) < 1e-9,
    `${d.currentOffsetCents}¢ contro ${d.targetOffsetCents}¢`);
  ok('  cioè le due regole chiedono lo STESSO prezzo', d.currentOffsetCents === 2);
}
{
  // Ed Markey: mid 0.79, ordine a 0.77, miglior bid altrui 0.78, bersaglio memorizzato 1.5¢. Qui la
  // deriva esiste (0.5¢) ma sta sotto la soglia minima di movimento, che su tick 0.01 vale 1.00¢.
  const MARKEY = mercato({ tick: 0.01, mid: 0.79, titolo: 'Ed Markey' });
  const d = decidi({
    rules: MARKEY,
    order: { orderId: '0xem', price: 0.77, size: 48.4, book: 'yes', side: 'BUY', secondsToExpiry: 700 },
    targetOffsetCents: 1.5, minMoveCents: 1.0,
    bids: [{ price: 0.78, size: 20 }, { price: 0.77, size: 48.4 }],
  });
  ok('holding anche qui', d.action === 'hold', `${d.action}/${d.gate}`);
  ok('  senza soppressione', d.gate === null && d.soppresso !== true, String(d.gate));
  ok('  perché la deriva sta sotto la soglia di un tick',
    Math.abs(d.currentOffsetCents - d.targetOffsetCents) < d.minMoveCents,
    `deriva 0.5¢ contro soglia ${d.minMoveCents}¢`);
}

console.log('\n══ 5 · IL MECCANISMO NON INCHIODA UN ORDINE NEL POSTO SBAGLIATO');
{
  // Il caso opposto, ed è quello che una regola scritta male romperebbe: un ordine finito LONTANO dal
  // mid (0.60, cioè 5.15¢ — fuori banda, quindi giudicato dall'altro ramo). Qui la versione in banda:
  // ordine a 0.634, bersaglio 0.55¢, quindi l'inseguimento vuole avvicinarlo. «Mai primi» lo porterebbe
  // ancora più dentro. Sopprimere lo abbandonerebbe dov'è: si deve MUOVERE.
  const d = decidi({
    rules: BARLOW,
    order: { orderId: '0xfar', price: 0.6335, size: 60.1, book: 'yes', side: 'BUY', secondsToExpiry: 1345 },
    targetOffsetCents: 0.55, minMoveCents: 0.1,
    bids: [{ price: 0.650, size: 500 }, { price: 0.6335, size: 60.1 }],
  });
  ok('l ordine lontano dal mid si muove', d.action === 'reprice', `${d.action}/${d.gate}`);
  ok('  col trigger dell inseguimento', d.gate === 'mid-chase', String(d.gate));
  ok('  e NON viene soppresso', d.soppresso !== true);
}
{
  // …e al giro dopo, arrivato dove «mai primi» lo vuole, la soppressione scatta. Il ciclo converge in
  // UNA mossa invece di ripetersi per sempre.
  const d = decidi({ rules: BARLOW, order: GAMBA, targetOffsetCents: 0.55, minMoveCents: 0.1, bids: CONCORRENTE });
  ok('il giro dopo si ferma', d.action === 'hold' && d.gate === 'inseguimento-contro-mai-primo', `${d.action}/${d.gate}`);
}

console.log('\n══ 6 · SI SCIOGLIE DA SOLO QUANDO IL BOOK CAMBIA (nessuno stato da azzerare)');
{
  // Il concorrente si sposta a 0.660: un tick dietro dà 0.659, che dal mid 0.6515 dista 0.75¢ — PIÙ
  // LONTANO del bersaglio di 0.55¢. Il conflitto non c'è più, e l'inseguimento riprende.
  const d = decidi({
    rules: BARLOW, order: GAMBA, targetOffsetCents: 0.55, minMoveCents: 0.1,
    bids: [{ price: 0.660, size: 500 }, { price: 0.649, size: 60.1 }],
  });
  ok('il concorrente si sposta ⇒ l inseguimento riparte', d.action === 'reprice', `${d.action}/${d.gate}`);
  ok('  e non c è nessuna soppressione', d.soppresso !== true);
}
{
  // La profondità illeggibile non è una licenza: senza il book non si può PREVEDERE dove «mai primi»
  // metterebbe l'ordine, quindi si torna al comportamento di prima (l'inseguimento propone la mossa e
  // il piazzamento decide). Fallire verso il vecchio comportamento è diverso da fallire in silenzio.
  const d = AR.decideReprice({
    order: GAMBA, rules: BARLOW, config: CFG, now: NOW,
    ownOrders: [{ orderId: GAMBA.orderId, price: GAMBA.price, size: GAMBA.size, book: 'yes' }],
  }, { resolveOffset: () => ({ targetOffsetCents: 0.55, source: 'observed', minMoveCents: 0.1 }) });
  ok('senza il book la decisione resta quella di prima', d.action === 'reprice' && d.gate === 'mid-chase', `${d.action}/${d.gate}`);
}

console.log('\n══ 7 · SE IL PIAZZAMENTO RIFIUTEREBBE, NON SI PARTE (e non si perde l ordine)');
{
  // Un tick dietro il concorrente uscirebbe dalla banda ⇒ `prezzoInCoda` risponde «non quotare».
  // Prima si proponeva comunque la mossa: `replaceManualOrder` cancella al passo 1 e piazza al passo 2,
  // quindi il rifiuto arrivava con l'ordine vecchio già tolto — gamba scoperta per aver inseguito il mid.
  // Banda [0.77, 0.81] con mid 0.79. Il nostro ordine è a 0.77, sullo stesso livello del miglior
  // concorrente: un tick dietro darebbe 0.76, fuori dalla banda, e restare in banda vorrebbe dire
  // risalire in cima. «Mai primi» risponde «non quotare».
  const M = mercato({ tick: 0.01, mid: 0.79, titolo: 'banda stretta' });
  const d = decidi({
    rules: M,
    order: { orderId: '0xnq', price: 0.77, size: 60, book: 'yes', side: 'BUY', secondsToExpiry: 1345 },
    targetOffsetCents: 1.0, minMoveCents: 0.5,
    bids: [{ price: 0.77, size: 360 }],
  });
  ok('non si tenta la mossa', d.action === 'skip', `${d.action}/${d.gate}`);
  ok('  col gate che lo nomina', d.gate === 'mai-primo-non-quotabile', String(d.gate));
  ok('  spiegando che un riprezzo cancella prima di piazzare',
    /cancella prima di piazzare/.test(d.reason));
}

console.log('\n══ 8 · IL CICLO LO SCRIVE NEL REGISTRO — LA TRANSIZIONE, NON OGNI CICLO');
(async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conflitto-'));
  const deps = {
    configFile: path.join(dir, 'config.json'),
    autoStateFile: path.join(dir, 'state.json'),
    autoAuditFile: path.join(dir, 'audit.jsonl'),
  };
  fs.writeFileSync(deps.configFile, JSON.stringify({ global: { enabled: true }, markets: { [MKT.toLowerCase()]: { enabled: true } } }));
  fs.writeFileSync(deps.autoStateFile, JSON.stringify({ markets: {}, heartbeatAt: NOW, cycles: 0 }));

  const righe = [];
  const inviati = [];
  const conflittiSoppressi = new Set();
  const base = {
    now: () => NOW, configDeps: deps, config: CFG,
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    isManual: () => ({ manual: true, readable: true }),
    trackedMarketIds: () => [], marketWindow: () => ({ tooClose: false }),
    resolveRules: () => BARLOW,
    resolveOffset: () => ({ targetOffsetCents: 0.55, source: 'configured', minMoveCents: 0.1 }),
    rememberObserved: () => {},
    resolveDepth: () => libro(CONCORRENTE),
    listOrders: async () => ({ ok: true, simulated: false, orders: [{
      orderId: '0xb99f5566', source: 'manual-ui', side: 'BUY', price: 0.649, size: 60.1,
      sizeRemaining: 60.1, marketId: MKT, tokenId: 'ty', secondsToExpiry: 1345, orderType: 'GTD',
    }] }),
    replaceOrder: async (spec) => { inviati.push(spec); return { ok: true, place: { sent: true, orderId: '0xNEW' } }; },
    audit: (rec) => righe.push(rec),
    conflittiSoppressi,
  };

  const r1 = await AR.runAutoRepriceCycle(base);
  const dichiarate = () => righe.filter((x) => x.outcome === 'inseguimento-soppresso');
  ok('nessun ordine viene mosso', inviati.length === 0, `${inviati.length} invii`);
  ok('  la gamba risulta in hold', r1.markets[0].held === 1);
  ok('la transizione ha la sua riga di audit', dichiarate().length === 1, `${dichiarate().length}`);
  const a = dichiarate()[0];
  ok('  col prezzo dell inseguimento', a && a.observed.inseguimentoPrezzo === 0.646);
  ok('  la sua distanza dal mid', a && Math.abs(a.observed.inseguimentoDistanzaC - 0.55) < 0.001);
  ok('  il prezzo di «mai primi»', a && a.observed.maiPrimoPrezzo === 0.649);
  ok('  la sua distanza dal mid', a && Math.abs(a.observed.maiPrimoDistanzaC - 0.25) < 0.001);
  ok('  il motivo della soppressione, a parole', a && /più VICINO al mid/.test(a.observed.motivo));
  ok('  e il tick, che è la causa strutturale', a && a.observed.tick === 0.001);

  // Secondo e terzo giro: la condizione è identica, e il registro NON si riempie.
  await AR.runAutoRepriceCycle(base);
  await AR.runAutoRepriceCycle(base);
  ok('tre cicli, UNA riga: la soppressione non diventa rumore', dichiarate().length === 1, `${dichiarate().length} righe`);
  ok('  ma i numeri di ogni ciclo restano nella fotografia dell hold',
    (r1.markets[0].holds[0] || {}).inseguimentoSoppresso === true);

  // Il concorrente si sposta: il conflitto si scioglie, e ANCHE questo si vede.
  const r4 = await AR.runAutoRepriceCycle({ ...base, resolveDepth: () => libro([{ price: 0.660, size: 500 }, { price: 0.649, size: 60.1 }]) });
  ok('il conflitto rientrato ha la sua riga', righe.some((x) => x.outcome === 'inseguimento-ripreso'));
  ok('  e l inseguimento riparte davvero', inviati.length === 1, `${inviati.length} invii`);
  ok('  con la memoria pulita', conflittiSoppressi.size === 0 || !conflittiSoppressi.has('0xb99f5566'));
  ok('  senza inseguire noi stessi: il nostro ordine è escluso dal book',
    r4.actions.some((x) => x.action === 'reprice'));

  console.log(`\ninseguimento contro mai-primo: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();
