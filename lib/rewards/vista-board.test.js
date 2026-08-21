'use strict';
// lib/rewards/vista-board.test.js — 21 agosto 2026.
//
// LE DUE PROPRIETA' DIFESE, ed entrambe mordono sul COMPORTAMENTO, non su una costante:
//   ① un mercato ammissibile che sta OLTRE la vecchia soglia deve comparire fra i candidati scelti
//      per la scansione — cioe' il bot deve poterlo VEDERE;
//   ② un libro che MANCA dal lotto deve escludere il candidato, non valutarlo a concorrenza zero —
//      che e' la quota stimata MASSIMA, cioe' il modo di far salire in cima alla classifica proprio
//      i mercati che non abbiamo letto.

const assert = require('assert');
const A24 = require('../../agents/agent24-liquidity-rewards');
const { scaricaLibri } = require('./libri-batch');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { if (c) { pass += 1; console.log(`  ✓ ${n}`); } else { fail += 1; console.log(`  ✗ ${n}${x ? ' — ' + x : ''}`); } };

/** Una popolazione finta ma realistica: montepremi decrescente, scaglioni misti. */
function popolazione(n) {
  return Array.from({ length: n }, (_, i) => ({
    conditionId: '0x' + String(i).padStart(64, '0'),
    question: `mercato ${i}`,
    rewardsDailyRate: 1000 - i,          // decrescente: l'indice E' la posizione in classifica
    rewardsMinSize: i % 3 === 0 ? 20 : 1000,   // un terzo alla portata, due terzi no
    rewardsMaxSpread: 3.5,
    tokenId: `t${i}y`, tokenIdNo: `t${i}n`,
  }));
}

console.log('\n════ ① un mercato ammissibile oltre la vecchia soglia DEVE essere visto ════');
{
  const pop = popolazione(600);
  const a150 = A24.sceltiPerLaScansione(pop, { tetto: 150 });
  const a300 = A24.sceltiPerLaScansione(pop, { tetto: 300 });
  ok('col tetto vecchio si guardano 150 mercati', a150.length === 150, String(a150.length));
  ok('col tetto nuovo se ne guardano 300', a300.length === 300, String(a300.length));

  // ⚠ LA PROPRIETA', e non e' «300 > 150»: esiste un mercato AMMISSIBILE (minSize alla portata) che il
  // tetto vecchio non vedeva e il nuovo vede. Se un giorno la regola di scelta cambiasse in modo da
  // continuare a nasconderlo, questo test cade anche restando il tetto a 300.
  const idsA150 = new Set(a150.map((m) => m.conditionId));
  const nuoviAmmissibili = a300.filter((m) => !idsA150.has(m.conditionId) && Number(m.rewardsMinSize) <= 100);
  ok('esiste almeno un mercato alla portata del capitale che PRIMA non si vedeva e ORA sì',
    nuoviAmmissibili.length > 0, String(nuoviAmmissibili.length));
  ok(`  e non è un caso isolato: ne entrano ${nuoviAmmissibili.length}`, nuoviAmmissibili.length >= 50);

  // ⚠ NON SI PERDE NIENTE DI CIO' CHE SI VEDEVA: allargare deve essere MONOTONO.
  const idsA300 = new Set(a300.map((m) => m.conditionId));
  const persi = a150.filter((m) => !idsA300.has(m.conditionId));
  ok('nessun mercato che si vedeva col tetto vecchio sparisce con quello nuovo', persi.length === 0, String(persi.length));

  // ⚠ La quota resta metà dei posti ai mercati alla portata, a QUALUNQUE tetto: e' la regola di §5 p.132.
  const compat300 = a300.filter((m) => Number(m.rewardsMinSize) <= 100).length;
  ok('metà dei posti resta riservata ai minSize ≤ 100, e la regola non dipende dal tetto',
    compat300 >= 150, String(compat300));

  // Il tetto vivo del modulo e' quello nuovo, e si legge dal modulo invece di essere ricopiato qui.
  ok('il tetto di produzione è quello nuovo', A24.MAX_CLOB_MARKETS === 300, String(A24.MAX_CLOB_MARKETS));
}

console.log('\n════ ② un libro che manca ESCLUDE, non vale «concorrenza zero» ════');
{
  // Il lotto risponde per un token solo su due: l'altro e' MANCANTE.
  return (async () => {
    const r = await scaricaLibri(['a', 'b'], { post: async () => ([{ asset_id: 'a', bids: [{ price: '0.4', size: '100' }], asks: [{ price: '0.6', size: '100' }] }]) });
    ok('il token che è tornato sta nei libri', r.libri.has('a'));
    ok('il token che NON è tornato è dichiarato mancante', r.mancanti.has('b') && r.mancanti.size === 1);

    const letto = A24.analizzaLibro(r.libri.get('a'), 3.5, 20, 0.5);
    const assente = A24.analizzaLibro(r.libri.get('b') || null, 3.5, 20, 0.5);
    ok('un libro letto NON è assente', letto.assente === false);
    ok('un libro mancante è dichiarato ASSENTE', assente.assente === true);
    // ⚠ IL CUORE: assente e vuoto devono essere distinguibili, o a valle sono lo stesso zero.
    const vuoto = A24.analizzaLibro({ bids: [], asks: [] }, 3.5, 20, 0.5);
    ok('un libro VUOTO non è assente: il venue ha risposto, e quello zero è una misura',
      vuoto.assente === false && vuoto.emptyBook === true);
    ok('  mentre un libro assente NON si dichiara vuoto: non è la misura di niente',
      assente.emptyBook === false);
    ok('e i due casi non sono distinguibili dal solo Qmin — che è 0 in entrambi',
      vuoto.Qmin === 0 && assente.Qmin === 0);

    // Un lotto che fallisce del tutto lascia MANCANTI tutti i suoi token, e lo dichiara.
    const rotto = await scaricaLibri(['x', 'y'], { post: async () => { throw new Error('HTTP 502'); }, tentativi: 2 });
    ok('un lotto fallito non produce libri', rotto.libri.size === 0);
    ok('  e i suoi token sono tutti mancanti', rotto.mancanti.size === 2);
    ok('  e il fallimento è contato, non silenzioso', rotto.lotti.falliti === 1 && rotto.lotti.ritentati === 1);
    ok('  con il motivo a verbale', /502/.test(JSON.stringify(rotto.lotti.errori)));

    // ⚠ Una risposta 200 che non e' una lista NON e' «zero libri»: e' un lotto fallito.
    const strana = await scaricaLibri(['z'], { post: async () => ({ error: 'boh' }), tentativi: 1 });
    ok('una risposta che non è una lista conta come lotto FALLITO, non come zero libri',
      strana.lotti.falliti === 1 && strana.mancanti.has('z'));

    // ⚠ Un token chiesto e non tornato e' mancante ANCHE se il lotto e' «riuscito».
    const parziale = await scaricaLibri(['p', 'q'], { post: async () => ([{ asset_id: 'p', bids: [], asks: [] }]) });
    ok('un lotto riuscito ma incompleto lascia mancante il token omesso',
      parziale.lotti.riusciti === 1 && parziale.lotti.falliti === 0 && parziale.mancanti.has('q'));
    ok('  e il token omesso NON diventa un libro vuoto', !parziale.libri.has('q'));

    console.log(`\nvista-board: ${pass} passati, ${fail} falliti`);
    assert.strictEqual(fail, 0, `${fail} asserzioni fallite`);
  })();
}
