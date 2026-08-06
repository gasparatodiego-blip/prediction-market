#!/usr/bin/env node
'use strict';
// LA PROFONDITÀ DAVANTI, E QUANTA NE FACCIAMO NOI.
//
// Le quattro proprietà che questo file deve inchiodare:
//   1. sotto DEPTH_MIN_AHEAD_USD di dollari altrui davanti ⇒ rifiuto, col numero misurato;
//   2. sopra MAX_SELF_SHARE_AT_LEVEL della size del livello ⇒ rifiuto, anche se i dollari bastano;
//   3. i NOSTRI ordini sono esclusi da entrambe le misure — è il difetto che, non corretto, farebbe
//      leggere la nostra stessa size come «profondità di altri» e autorizzerebbe sempre;
//   4. un dato mancante o illeggibile ⇒ rifiuto, mai «probabilmente va bene».

const {
  checkDepthGuardRisk, DEPTH_MIN_AHEAD_USD, MAX_SELF_SHARE_AT_LEVEL,
} = require('./depth-guard');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const MID = '0x' + 'ab'.repeat(32);
const TICK = 0.01;

console.log('\n══ LE SOGLIE SONO QUELLE DICHIARATE');
{
  ok('minimo davanti = $50', DEPTH_MIN_AHEAD_USD === 50, `$${DEPTH_MIN_AHEAD_USD}`);
  ok('quota nostra massima = 40%', MAX_SELF_SHARE_AT_LEVEL === 0.40, `${MAX_SELF_SHARE_AT_LEVEL}`);
}

console.log('\n══ IL CASO VALIDO');
{
  // Livello 0,50. Altrui: 200 share a 0,50 = $100 davanti (sopra i $50). La nostra size 100 su un
  // totale di 300 = 33% (sotto il 40%).
  const r = checkDepthGuardRisk({
    marketId: MID, side: 'BUY', proposedSize: 100, price: 0.50, tick: TICK,
    restingBookAtLevel: [{ price: 0.50, size: 200 }],
    ownOrders: [],
  });
  ok('autorizzato', r.allowed === true, r.reason);
  ok('  e riporta i dollari davanti', r.depthAheadUsd === 100, `$${r.depthAheadUsd}`);
  ok('  e la nostra quota del livello', Math.abs(r.selfShareAtLevel - 100 / 300) < 1e-6, `${(r.selfShareAtLevel * 100).toFixed(1)}%`);
}

console.log('\n══ 1 · SOTTO LA SOGLIA IN DOLLARI');
{
  // 80 share a 0,50 = $40, sotto i $50.
  const r = checkDepthGuardRisk({
    marketId: MID, side: 'BUY', proposedSize: 10, price: 0.50, tick: TICK,
    restingBookAtLevel: [{ price: 0.50, size: 80 }],
    ownOrders: [],
  });
  ok('rifiutato', r.allowed === false);
  ok('  col numero misurato, non un messaggio generico', /\$40\.00/.test(r.reason), r.reason);
  ok('  e la soglia dichiarata nel motivo', new RegExp(`\\$${DEPTH_MIN_AHEAD_USD}`).test(r.reason));

  // ── I DOLLARI, NON LE SHARE ───────────────────────────────────────────────────────────────────
  // Le stesse 80 share a 0,95 valgono $76 e passano; a 0,05 valgono $4 e non passano. Se la soglia
  // fosse in share, la stessa quantità autorizzerebbe o rifiuterebbe a seconda del prezzo del
  // mercato — cioè non sarebbe una soglia di rischio.
  const caro = checkDepthGuardRisk({
    marketId: MID, side: 'BUY', proposedSize: 10, price: 0.95, tick: TICK,
    restingBookAtLevel: [{ price: 0.95, size: 80 }], ownOrders: [],
  });
  ok('80 share a 95¢ = $76 ⇒ passa la soglia dollari', caro.depthAheadUsd === 76, `$${caro.depthAheadUsd}`);
  const economico = checkDepthGuardRisk({
    marketId: MID, side: 'BUY', proposedSize: 10, price: 0.05, tick: TICK,
    restingBookAtLevel: [{ price: 0.05, size: 80 }], ownOrders: [],
  });
  ok('  le stesse 80 share a 5¢ = $4 ⇒ non passa', economico.allowed === false, `$${economico.depthAheadUsd}`);
}

console.log('\n══ 2 · SOPRA LA QUOTA MASSIMA DEL LIVELLO');
{
  // Altrui 120 share a 0,50 = $60 (i dollari BASTANO). Ma la nostra size 200 su 320 = 62,5%.
  const r = checkDepthGuardRisk({
    marketId: MID, side: 'BUY', proposedSize: 200, price: 0.50, tick: TICK,
    restingBookAtLevel: [{ price: 0.50, size: 120 }],
    ownOrders: [],
  });
  ok('rifiutato anche se i dollari davanti bastano', r.allowed === false && r.depthAheadUsd === 60, `$${r.depthAheadUsd}`);
  ok('  col motivo che nomina la quota', /62\.5%/.test(r.reason), r.reason);
  ok('  e il tetto', /40%/.test(r.reason));

  // Esattamente al 40% passa: la soglia è un tetto, non una barriera stretta.
  // Altrui 150, nostra 100 → 100/250 = 40% esatto. $75 davanti, sopra i $50.
  const bordo = checkDepthGuardRisk({
    marketId: MID, side: 'BUY', proposedSize: 100, price: 0.50, tick: TICK,
    restingBookAtLevel: [{ price: 0.50, size: 150 }], ownOrders: [],
  });
  ok('esattamente al 40% ⇒ autorizzato', bordo.allowed === true && Math.abs(bordo.selfShareAtLevel - 0.40) < 1e-9,
    `${(bordo.selfShareAtLevel * 100).toFixed(1)}%`);
}

console.log('\n══ 3 · I NOSTRI ORDINI SONO ESCLUSI — IL PUNTO CHE FA CADERE TUTTO IL RESTO');
{
  // Il book PUBBLICA 200 share a 0,50, ma 160 sono NOSTRE. Gli altri sono 40 share = $20, sotto soglia.
  // Senza l'esclusione si leggerebbe $100 e si autorizzerebbe: la nostra size scambiata per concorrenza.
  const conNostri = checkDepthGuardRisk({
    marketId: MID, side: 'BUY', proposedSize: 10, price: 0.50, tick: TICK,
    restingBookAtLevel: [{ price: 0.50, size: 200 }],
    ownOrders: [{ orderId: 'A', price: 0.50, size: 160 }],
  });
  ok('i nostri 160 sono sottratti: restano $20 di altri', conNostri.depthAheadUsd === 20, `$${conNostri.depthAheadUsd}`);
  ok('  quindi RIFIUTATO', conNostri.allowed === false);

  // La prova che il test non è vuoto: senza i nostri, lo stesso book autorizzerebbe.
  const senzaNostri = checkDepthGuardRisk({
    marketId: MID, side: 'BUY', proposedSize: 10, price: 0.50, tick: TICK,
    restingBookAtLevel: [{ price: 0.50, size: 200 }], ownOrders: [],
  });
  ok('  e senza l esclusione lo stesso book autorizzerebbe', senzaNostri.allowed === true,
    'è esattamente il difetto che l esclusione esiste per impedire');

  // DUE nostri ordini sullo STESSO livello vanno tolti entrambi.
  const due = checkDepthGuardRisk({
    marketId: MID, side: 'BUY', proposedSize: 10, price: 0.50, tick: TICK,
    restingBookAtLevel: [{ price: 0.50, size: 200 }],
    ownOrders: [{ orderId: 'A', price: 0.50, size: 100 }, { orderId: 'B', price: 0.50, size: 60 }],
  });
  ok('due nostri ordini sullo stesso prezzo: tolti entrambi', due.depthAheadUsd === 20, `$${due.depthAheadUsd}`);

  // I nostri escono anche dal denominatore della quota.
  const quota = checkDepthGuardRisk({
    marketId: MID, side: 'BUY', proposedSize: 100, price: 0.50, tick: TICK,
    restingBookAtLevel: [{ price: 0.50, size: 400 }],
    ownOrders: [{ orderId: 'A', price: 0.50, size: 250 }],
  });
  // altrui = 150; quota = 100/250 = 40%
  ok('  e la quota si calcola sugli altrui, non sul pubblicato',
    Math.abs(quota.selfShareAtLevel - 0.40) < 1e-9, `${(quota.selfShareAtLevel * 100).toFixed(1)}%`);
}

console.log('\n══ «DAVANTI» DIPENDE DAL LATO');
{
  const livelli = [{ price: 0.52, size: 100 }, { price: 0.50, size: 100 }, { price: 0.48, size: 100 }];
  // BUY a 0,50: davanti c'è chi offre DI PIÙ (0,52) più il proprio livello. $52 + $50 = $102.
  const buy = checkDepthGuardRisk({
    marketId: MID, side: 'BUY', proposedSize: 10, price: 0.50, tick: TICK,
    restingBookAtLevel: livelli, ownOrders: [],
  });
  ok('BUY: davanti = i prezzi più ALTI', buy.depthAheadUsd === 102, `$${buy.depthAheadUsd}`);
  // SELL a 0,50: davanti c'è chi chiede DI MENO (0,48) più il proprio livello. $48 + $50 = $98.
  const sell = checkDepthGuardRisk({
    marketId: MID, side: 'SELL', proposedSize: 10, price: 0.50, tick: TICK,
    restingBookAtLevel: livelli, ownOrders: [],
  });
  ok('SELL: davanti = i prezzi più BASSI', sell.depthAheadUsd === 98, `$${sell.depthAheadUsd}`);
  ok('  e i due non coincidono', buy.depthAheadUsd !== sell.depthAheadUsd);
}

console.log('\n══ 4 · UN DATO MANCANTE NON È UN VIA LIBERA');
{
  const senzaLivelli = checkDepthGuardRisk({
    marketId: MID, side: 'BUY', proposedSize: 10, price: 0.50, tick: TICK,
    restingBookAtLevel: null, ownOrders: [],
  });
  ok('livelli assenti ⇒ rifiuto', senzaLivelli.allowed === false);
  ok('  col motivo che dice che non si è potuto leggere', /non leggibile/.test(senzaLivelli.reason), senzaLivelli.reason);

  const senzaTick = checkDepthGuardRisk({
    marketId: MID, side: 'BUY', proposedSize: 10, price: 0.50, tick: null,
    restingBookAtLevel: [{ price: 0.50, size: 200 }], ownOrders: [],
  });
  ok('tick assente ⇒ rifiuto', senzaTick.allowed === false, senzaTick.reason);

  const senzaPrezzo = checkDepthGuardRisk({
    marketId: MID, side: 'BUY', proposedSize: 10, price: null, tick: TICK,
    restingBookAtLevel: [{ price: 0.50, size: 200 }], ownOrders: [],
  });
  ok('prezzo assente ⇒ rifiuto', senzaPrezzo.allowed === false, senzaPrezzo.reason);

  const senzaSize = checkDepthGuardRisk({
    marketId: MID, side: 'BUY', proposedSize: 0, price: 0.50, tick: TICK,
    restingBookAtLevel: [{ price: 0.50, size: 200 }], ownOrders: [],
  });
  ok('size proposta zero ⇒ rifiuto', senzaSize.allowed === false, senzaSize.reason);

  // Il feed che dice «non c'è nessuno» è un FATTO, non un'incognita — ma resta un rifiuto, perché
  // zero dollari davanti è esattamente la condizione che la regola esiste per impedire.
  const libroVuoto = checkDepthGuardRisk({
    marketId: MID, side: 'BUY', proposedSize: 10, price: 0.50, tick: TICK,
    restingBookAtLevel: [], ownOrders: [],
  });
  ok('libro vuoto ⇒ rifiuto (zero davanti), non un errore di lettura',
    libroVuoto.allowed === false && libroVuoto.depthAheadUsd === 0 && !/non leggibile/.test(libroVuoto.reason),
    libroVuoto.reason);
}

console.log('\n══ ISOLAMENTO: NESSUNO STATO FRA UNA CHIAMATA E L ALTRA');
{
  // Stessa funzione, due mercati, due book opposti, chiamati alternandoli: il risultato di ciascuno
  // non deve dipendere da cosa è stato chiesto prima. Se ci fosse una cache per marketId o un
  // contatore condiviso, questa sequenza lo farebbe emergere.
  const buono = { marketId: 'M-BUONO', side: 'BUY', proposedSize: 10, price: 0.50, tick: TICK,
    restingBookAtLevel: [{ price: 0.50, size: 300 }], ownOrders: [] };
  const cattivo = { marketId: 'M-CATTIVO', side: 'BUY', proposedSize: 10, price: 0.50, tick: TICK,
    restingBookAtLevel: [{ price: 0.50, size: 10 }], ownOrders: [] };

  const seq = [buono, cattivo, buono, cattivo, buono].map((x) => checkDepthGuardRisk(x).allowed);
  ok('alternando due mercati il verdetto non cambia mai',
    JSON.stringify(seq) === JSON.stringify([true, false, true, false, true]), seq.join(','));

  // E il modulo non espone nessuna struttura mutabile in cui accumulare stato.
  const esportati = Object.keys(require('./depth-guard'));
  ok('il modulo esporta solo la funzione e le due soglie',
    esportati.length === 3 && esportati.includes('checkDepthGuardRisk'), esportati.join(', '));

  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('./depth-guard'), 'utf8');
  ok('nessuna Map/Set/array a livello di modulo in cui accumulare per mercato',
    !/^const \w+ = new (Map|Set)\(/m.test(src) && !/^let /m.test(src));
  ok('nessun fs, nessuna rete, nessun orologio',
    !/require\('fs'\)|fetch\(|Date\.now\(\)/.test(src.replace(/^\/\/.*$/gm, '')));
}

console.log(`\ndepth guard: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
