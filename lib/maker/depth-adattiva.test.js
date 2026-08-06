#!/usr/bin/env node
'use strict';
// LA RICERCA DEL LIVELLO — DUE PERCORSI, DUE LOGICHE, NESSUNO STATO IN COMUNE.
//
// Le proprietà che questo file inchioda:
//   · Safe cumula e si FERMA al primo livello che supera il pavimento — non cerca il massimo;
//   · Safe scarta un livello troppo «nostro» e prova il successivo invece di rinunciare;
//   · Risk valuta il SINGOLO livello, prova al più due volte, e con mercato nervoso si sposta di uno;
//   · Risk rinuncia se lo spostamento uscirebbe dalla banda: fuori banda non si matura, quindi
//     allontanarsi non protegge — toglie solo il ricavo;
//   · in ENTRAMBI i percorsi i nostri ordini sono sottratti prima di qualunque conto;
//   · nessuna delle due funzioni conserva niente fra una chiamata e l'altra.

const {
  findAdaptiveDepthLevelSafe, findAdaptiveDepthLevelRisk,
  SAFE_DEPTH_FLOOR_USD, SAFE_MAX_SELF_SHARE, RISK_DEPTH_FLOOR_USD, RISK_MAX_TENTATIVI,
} = require('./depth-adattiva');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const TICK = 0.01;
const BANDA = { lo: 0.44, hi: 0.56 };   // mid 0.50, raggio ±6¢
const c = (p) => (p == null ? '—' : `${(p * 100).toFixed(0)}¢`);

console.log('\n══ LE COSTANTI');
{
  ok('pavimento Safe = $15', SAFE_DEPTH_FLOOR_USD === 15);
  ok('quota massima Safe = 65%', SAFE_MAX_SELF_SHARE === 0.65);
  ok('pavimento Risk = $20', RISK_DEPTH_FLOOR_USD === 20);
  ok('Risk prova al più due livelli', RISK_MAX_TENTATIVI === 2);
}

console.log('\n══ SAFE · SI FERMA AL PRIMO CHE BASTA, NON CERCA IL MASSIMO');
{
  // Liv.1 50¢×100 (ignorato: è il top-of-book). Liv.2 49¢×40 = $19,60 ⇒ supera già i $15.
  // Liv.3 avrebbe $245: se la funzione cercasse il massimo sceglierebbe quello.
  const r = findAdaptiveDepthLevelSafe({
    marketId: 'M', side: 'BUY', tick: TICK, bandBounds: BANDA, proposedSize: 10, ownOrders: [],
    bookLevels: [{ price: 0.50, size: 100 }, { price: 0.49, size: 40 }, { price: 0.48, size: 500 }],
  });
  ok('trova un livello', r.ok === true, r.reason);
  ok('  ed è il SECONDO, non il terzo', r.level === 2 && r.price === 0.49, `liv.${r.level} @${c(r.price)}`);
  ok('  con la cumulata dichiarata', Math.abs(r.depthAheadUsd - 19.6) < 1e-6, `$${r.depthAheadUsd}`);
  ok('  il primo livello NON entra nella cumulata',
    r.depthAheadUsd < 50 * 0.5, 'i $50 del top-of-book non sono contati');
}

console.log('\n══ SAFE · CUMULA FINCHÉ NON BASTA');
{
  // Liv.2 49¢×10 = $4,90 · Liv.3 48¢×10 = $4,80 (cum $9,70) · Liv.4 47¢×20 = $9,40 (cum $19,10) ⇒ qui.
  const r = findAdaptiveDepthLevelSafe({
    marketId: 'M', side: 'BUY', tick: TICK, bandBounds: BANDA, proposedSize: 5, ownOrders: [],
    bookLevels: [{ price: 0.50, size: 100 }, { price: 0.49, size: 10 }, { price: 0.48, size: 10 }, { price: 0.47, size: 20 }],
  });
  ok('serve il quarto livello per superare $15', r.ok === true && r.level === 4, `liv.${r.level} @${c(r.price)}`);
  ok('  e la cumulata è la somma dei tre', Math.abs(r.depthAheadUsd - 19.1) < 1e-6, `$${r.depthAheadUsd}`);
}

console.log('\n══ SAFE · BANDA ESAURITA SENZA RAGGIUNGERE IL PAVIMENTO ⇒ SKIP');
{
  const r = findAdaptiveDepthLevelSafe({
    marketId: 'M', side: 'BUY', tick: TICK, bandBounds: BANDA, proposedSize: 5, ownOrders: [],
    bookLevels: [{ price: 0.50, size: 100 }, { price: 0.49, size: 5 }, { price: 0.48, size: 5 }],
  });
  ok('nessun livello valido', r.ok === false && r.price === null);
  ok('  col motivo che dice quanto mancava', /la banda finisce prima del pavimento/.test(r.reason), r.reason);
  ok('  e riporta la cumulata raggiunta', Math.abs(r.depthAheadUsd - 4.85) < 1e-6, `$${r.depthAheadUsd}`);

  // I livelli FUORI banda non salvano la situazione: non sono premianti.
  const conFuori = findAdaptiveDepthLevelSafe({
    marketId: 'M', side: 'BUY', tick: TICK, bandBounds: BANDA, proposedSize: 5, ownOrders: [],
    bookLevels: [{ price: 0.50, size: 100 }, { price: 0.49, size: 5 }, { price: 0.40, size: 9999 }],
  });
  ok('un livello fuori banda non viene contato', conFuori.ok === false, conFuori.reason);
}

console.log('\n══ SAFE · QUOTA MASSIMA 65% — SI SCARTA IL LIVELLO E SI PROVA IL SUCCESSIVO');
{
  // Liv.2: altrui 40 share a 49¢ = $19,60 (pavimento ok). Ma la nostra size è 200 ⇒ 200/240 = 83%.
  // Liv.3: altrui 500 ⇒ 200/700 = 28,6%, sotto il tetto. Si deve scegliere il TERZO.
  const r = findAdaptiveDepthLevelSafe({
    marketId: 'M', side: 'BUY', tick: TICK, bandBounds: BANDA, proposedSize: 200, ownOrders: [],
    bookLevels: [{ price: 0.50, size: 100 }, { price: 0.49, size: 40 }, { price: 0.48, size: 500 }],
  });
  ok('non si rinuncia: si scende al livello successivo', r.ok === true && r.level === 3, `liv.${r.level} @${c(r.price)}`);
  ok('  la quota al livello scelto è sotto il tetto', r.selfShare <= SAFE_MAX_SELF_SHARE, `${(r.selfShare * 100).toFixed(1)}%`);
  ok('  e il livello scartato è dichiarato col motivo',
    r.scartati.length === 1 && r.scartati[0].level === 2 && /quota nostra/.test(r.scartati[0].motivo),
    JSON.stringify(r.scartati[0]));

  // Esattamente al 65% si passa: è un tetto, non una barriera stretta.
  // altrui 35, nostra 65 ⇒ 65/100 = 65%. A 49¢ gli altrui valgono $17,15 > $15.
  const bordo = findAdaptiveDepthLevelSafe({
    marketId: 'M', side: 'BUY', tick: TICK, bandBounds: BANDA, proposedSize: 65, ownOrders: [],
    bookLevels: [{ price: 0.50, size: 100 }, { price: 0.49, size: 35 }],
  });
  ok('esattamente al 65% ⇒ accettato', bordo.ok === true && Math.abs(bordo.selfShare - 0.65) < 1e-9,
    `${(bordo.selfShare * 100).toFixed(1)}%`);
}

console.log('\n══ RISK · IL SECONDO LIVELLO BASTA');
{
  const r = findAdaptiveDepthLevelRisk({
    marketId: 'M', side: 'BUY', tick: TICK, bandBounds: BANDA, ownOrders: [], nervousMarket: false,
    bookLevels: [{ price: 0.50, size: 100 }, { price: 0.49, size: 50 }, { price: 0.48, size: 10 }],
  });
  // 50 × 0,49 = $24,50 ≥ $20
  ok('sceglie il secondo livello', r.ok === true && r.level === 2, `liv.${r.level} @${c(r.price)}`);
  ok('  con la profondità DI QUEL livello, non cumulata', Math.abs(r.depthAtLevelUsd - 24.5) < 1e-6, `$${r.depthAtLevelUsd}`);
  ok('  e non è nervoso', r.nervous === false);
}

console.log('\n══ RISK · SERVE IL TERZO');
{
  // Liv.2 49¢×10 = $4,90 (sotto) · Liv.3 48¢×50 = $24 (sopra).
  const r = findAdaptiveDepthLevelRisk({
    marketId: 'M', side: 'BUY', tick: TICK, bandBounds: BANDA, ownOrders: [], nervousMarket: false,
    bookLevels: [{ price: 0.50, size: 100 }, { price: 0.49, size: 10 }, { price: 0.48, size: 50 }],
  });
  ok('scende al terzo livello', r.ok === true && r.level === 3, `liv.${r.level} @${c(r.price)}`);
  ok('  e il secondo è registrato come tentativo fallito',
    r.tentativi.length === 1 && r.tentativi[0].level === 2, JSON.stringify(r.tentativi));
}

console.log('\n══ RISK · NÉ IL SECONDO NÉ IL TERZO ⇒ SKIP, NIENTE QUARTO TENTATIVO');
{
  const r = findAdaptiveDepthLevelRisk({
    marketId: 'M', side: 'BUY', tick: TICK, bandBounds: BANDA, ownOrders: [], nervousMarket: false,
    bookLevels: [{ price: 0.50, size: 100 }, { price: 0.49, size: 5 }, { price: 0.48, size: 5 }, { price: 0.47, size: 9999 }],
  });
  ok('nessun livello scelto', r.ok === false && r.price === null, r.reason);
  ok('  esattamente due tentativi, non tre', r.tentativi.length === 2, `${r.tentativi.length}`);
  ok('  il QUARTO livello esiste e ricchissimo, ma non viene provato',
    !r.tentativi.some((t) => t.level === 4), 'la regola dice due tentativi e sono due');
}

console.log('\n══ RISK · MERCATO NERVOSO — SI SPOSTA DI UN TICK');
{
  // Senza nervosismo sceglierebbe il liv.2 ($24,50). Con nervosismo parte dal liv.3.
  const libro = [{ price: 0.50, size: 100 }, { price: 0.49, size: 50 }, { price: 0.48, size: 60 }, { price: 0.47, size: 70 }];
  const calmo = findAdaptiveDepthLevelRisk({
    marketId: 'M', side: 'BUY', tick: TICK, bandBounds: BANDA, ownOrders: [], nervousMarket: false, bookLevels: libro,
  });
  const nervoso = findAdaptiveDepthLevelRisk({
    marketId: 'M', side: 'BUY', tick: TICK, bandBounds: BANDA, ownOrders: [], nervousMarket: true, bookLevels: libro,
  });
  ok('da calmo sceglie il secondo', calmo.level === 2, `liv.${calmo.level}`);
  ok('da nervoso sceglie il TERZO — un tick più lontano', nervoso.level === 3, `liv.${nervoso.level}`);
  ok('  e lo dichiara nel motivo', /mercato nervoso/.test(nervoso.reason), nervoso.reason);
  ok('  il flag viaggia nel referto', nervoso.nervous === true && calmo.nervous === false);
  ok('  il pavimento resta applicato anche da nervoso', nervoso.depthAtLevelUsd >= RISK_DEPTH_FLOOR_USD,
    `$${nervoso.depthAtLevelUsd}`);
}

console.log('\n══ RISK · NERVOSO CHE USCIREBBE DALLA BANDA ⇒ SKIP');
{
  // Solo due livelli dentro banda. Da calmo userebbe il liv.2; da nervoso servirebbe il liv.3, che
  // non esiste dentro la banda ⇒ si rinuncia invece di uscire dal perimetro premiante.
  const bandaStretta = { lo: 0.485, hi: 0.515 };
  const libro = [{ price: 0.50, size: 100 }, { price: 0.49, size: 200 }, { price: 0.48, size: 9999 }];
  const calmo = findAdaptiveDepthLevelRisk({
    marketId: 'M', side: 'BUY', tick: TICK, bandBounds: bandaStretta, ownOrders: [], nervousMarket: false, bookLevels: libro,
  });
  const nervoso = findAdaptiveDepthLevelRisk({
    marketId: 'M', side: 'BUY', tick: TICK, bandBounds: bandaStretta, ownOrders: [], nervousMarket: true, bookLevels: libro,
  });
  ok('da calmo piazza al secondo', calmo.ok === true && calmo.level === 2, `liv.${calmo.level}`);
  ok('da nervoso RINUNCIA', nervoso.ok === false, nervoso.reason);
  ok('  col motivo che spiega perché non ha senso allontanarsi',
    /fuori dalla banda premiante/.test(nervoso.reason) && /toglie solo il reward/.test(nervoso.reason));
  ok('  e il livello a 48¢, ricchissimo, resta ignorato perché fuori banda', nervoso.price === null);
}

console.log('\n══ I NOSTRI ORDINI SONO ESCLUSI IN ENTRAMBI I PERCORSI');
{
  // Liv.2 pubblica 300 share a 49¢ = $147, ma 280 sono NOSTRE ⇒ altrui 20 × 0,49 = $9,80.
  const libro = [{ price: 0.50, size: 100 }, { price: 0.49, size: 300 }];
  const nostri = [{ orderId: 'A', price: 0.49, size: 280 }];

  const safeCon = findAdaptiveDepthLevelSafe({
    marketId: 'M', side: 'BUY', tick: TICK, bandBounds: BANDA, proposedSize: 5, ownOrders: nostri, bookLevels: libro,
  });
  ok('SAFE: coi nostri sottratti restano $9,80 ⇒ sotto il pavimento, skip', safeCon.ok === false,
    `$${safeCon.depthAheadUsd}`);
  const safeSenza = findAdaptiveDepthLevelSafe({
    marketId: 'M', side: 'BUY', tick: TICK, bandBounds: BANDA, proposedSize: 5, ownOrders: [], bookLevels: libro,
  });
  ok('  senza l esclusione lo stesso book passerebbe', safeSenza.ok === true,
    'è il difetto che l esclusione esiste per impedire');

  const riskCon = findAdaptiveDepthLevelRisk({
    marketId: 'M', side: 'BUY', tick: TICK, bandBounds: BANDA, ownOrders: nostri, bookLevels: libro,
  });
  ok('RISK: stessa sottrazione, stesso esito', riskCon.ok === false, riskCon.reason);
  const riskSenza = findAdaptiveDepthLevelRisk({
    marketId: 'M', side: 'BUY', tick: TICK, bandBounds: BANDA, ownOrders: [], bookLevels: libro,
  });
  ok('  e senza esclusione passerebbe anche qui', riskSenza.ok === true);

  // Due nostri ordini sullo stesso livello vanno tolti entrambi.
  const due = findAdaptiveDepthLevelRisk({
    marketId: 'M', side: 'BUY', tick: TICK, bandBounds: BANDA,
    ownOrders: [{ orderId: 'A', price: 0.49, size: 140 }, { orderId: 'B', price: 0.49, size: 140 }],
    bookLevels: libro,
  });
  ok('due nostri ordini sullo stesso prezzo: tolti entrambi', due.ok === false);
}

console.log('\n══ IL LATO CAMBIA COSA VUOL DIRE «VERSO IL BORDO»');
{
  // Per un SELL il bordo è verso l'ALTO: la scala va ordinata al contrario.
  const asks = [{ price: 0.50, size: 100 }, { price: 0.51, size: 50 }, { price: 0.52, size: 10 }];
  const r = findAdaptiveDepthLevelRisk({
    marketId: 'M', side: 'SELL', tick: TICK, bandBounds: BANDA, ownOrders: [], bookLevels: asks,
  });
  ok('SELL: il secondo livello è quello PIÙ ALTO', r.ok === true && r.price === 0.51, c(r.price));
}

console.log('\n══ DATI MANCANTI ⇒ NESSUN VIA LIBERA, IN ENTRAMBI I PERCORSI');
{
  const casi = [
    ['livelli assenti', { bookLevels: null, bandBounds: BANDA, tick: TICK }],
    ['banda assente', { bookLevels: [{ price: 0.5, size: 100 }], bandBounds: null, tick: TICK }],
    ['tick assente', { bookLevels: [{ price: 0.5, size: 100 }], bandBounds: BANDA, tick: null }],
  ];
  for (const [nome, arg] of casi) {
    const s = findAdaptiveDepthLevelSafe({ marketId: 'M', side: 'BUY', proposedSize: 10, ownOrders: [], ...arg });
    const r = findAdaptiveDepthLevelRisk({ marketId: 'M', side: 'BUY', ownOrders: [], ...arg });
    ok(`SAFE · ${nome} ⇒ rifiuto`, s.ok === false);
    ok(`RISK · ${nome} ⇒ rifiuto`, r.ok === false);
  }
  const senzaSize = findAdaptiveDepthLevelSafe({
    marketId: 'M', side: 'BUY', proposedSize: 0, ownOrders: [], bookLevels: [{ price: 0.5, size: 100 }], bandBounds: BANDA, tick: TICK,
  });
  ok('SAFE · size proposta zero ⇒ rifiuto', senzaSize.ok === false, senzaSize.reason);

  const unSoloLivello = findAdaptiveDepthLevelSafe({
    marketId: 'M', side: 'BUY', proposedSize: 10, ownOrders: [], bookLevels: [{ price: 0.50, size: 999 }], bandBounds: BANDA, tick: TICK,
  });
  ok('SAFE · un solo livello in banda ⇒ non c è un secondo da cui partire', unSoloLivello.ok === false,
    unSoloLivello.reason);
}

console.log('\n══ ISOLAMENTO: NESSUNO STATO FRA CHIAMATE, NÉ FRA I DUE PERCORSI');
{
  const buono = [{ price: 0.50, size: 100 }, { price: 0.49, size: 500 }];
  const cattivo = [{ price: 0.50, size: 100 }, { price: 0.49, size: 1 }];
  const aS = (l) => ({ marketId: 'A', side: 'BUY', tick: TICK, bandBounds: BANDA, proposedSize: 10, ownOrders: [], bookLevels: l });
  const aR = (l) => ({ marketId: 'B', side: 'BUY', tick: TICK, bandBounds: BANDA, ownOrders: [], bookLevels: l });

  // Alternati, e per giunta intercalando i due percorsi su mercati diversi.
  const seq = [];
  for (const l of [buono, cattivo, buono, cattivo, buono]) {
    seq.push(findAdaptiveDepthLevelSafe(aS(l)).ok);
    findAdaptiveDepthLevelRisk(aR(l === buono ? cattivo : buono));   // rumore sull'altro percorso
  }
  ok('Safe non è influenzato dalle chiamate a Risk intercalate',
    JSON.stringify(seq) === JSON.stringify([true, false, true, false, true]), seq.join(','));

  // Lo stesso input dà sempre lo stesso output, chiamato dieci volte.
  const dieci = new Set(Array.from({ length: 10 }, () => JSON.stringify(findAdaptiveDepthLevelSafe(aS(buono)))));
  ok('dieci chiamate identiche ⇒ un solo risultato distinto', dieci.size === 1, `${dieci.size}`);

  // Nessuna costante condivisa fra i due percorsi.
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('./depth-adattiva'), 'utf8');
  // I COMMENTI VANNO TOLTI PRIMA DEL CONFRONTO. Lo slice che va da una funzione all'altra include il
  // JSDoc della seconda, che nomina legittimamente le costanti della seconda: cercarle lì punirebbe la
  // documentazione invece del codice. È lo stesso errore già fatto due volte in questo repo (una con
  // «bulk-allocate» dentro un commento, una con MAKER_PLACEMENT).
  const senzaCommenti = (t) => t.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const corpoSafe = senzaCommenti(src.slice(src.indexOf('function findAdaptiveDepthLevelSafe'), src.indexOf('/**\n * PERCORSO RISK')));
  const corpoRisk = senzaCommenti(src.slice(src.indexOf('function findAdaptiveDepthLevelRisk'), src.indexOf('module.exports')));
  ok('la funzione Safe non nomina nessuna costante RISK', !/RISK_/.test(corpoSafe));
  ok('la funzione Risk non nomina nessuna costante SAFE', !/SAFE_/.test(corpoRisk));
  ok('  e il confronto non è vuoto: Safe nomina davvero le sue', /SAFE_DEPTH_FLOOR_USD/.test(corpoSafe));
  ok('  idem Risk', /RISK_DEPTH_FLOOR_USD/.test(corpoRisk));
}

console.log(`\ndepth adattiva: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
