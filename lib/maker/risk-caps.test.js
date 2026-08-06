#!/usr/bin/env node
'use strict';
// I DUE TETTI DEL BUCKET RISK: 15% in tutto, 10% per mercato.
//
// Le proprietà che contano:
//   · i due tetti sono INDIPENDENTI — uno solo non basta, e il test lo dimostra costruendo i due casi
//     che ciascuno da solo lascerebbe passare;
//   · le percentuali sono sul saldo LETTO ADESSO: lo stesso portafoglio, con un saldo sceso, sfora;
//   · saldo non leggibile ⇒ niente nuova esposizione, ma nemmeno un'eccedenza inventata;
//   · nessuno stato fra due chiamate.

const {
  puoAggiungereRisk, eccedenzaRisk, tettiDa,
  RISK_BUCKET_CAP_PCT, RISK_PER_MARKET_CAP_PCT,
} = require('./risk-caps');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const A = 'mercato-a', B = 'mercato-b', C = 'mercato-c';

console.log('\n══ LE COSTANTI E I TETTI DERIVATI');
{
  ok('bucket 15%', RISK_BUCKET_CAP_PCT === 0.15);
  ok('per mercato 10%', RISK_PER_MARKET_CAP_PCT === 0.10);
  const t = tettiDa(1000);
  ok('su $1000: bucket $150, per mercato $100', t.bucketCapUsd === 150 && t.perMarketCapUsd === 100,
    `$${t.bucketCapUsd} / $${t.perMarketCapUsd}`);
  ok('saldo non leggibile ⇒ tetti null, non zero e non infinito',
    tettiDa(null).leggibile === false && tettiDa(null).bucketCapUsd === null);
  ok('  e nemmeno un saldo negativo passa', tettiDa(-5).leggibile === false);
}

console.log('\n══ AGGIUNGERE: IL TETTO PER MERCATO');
{
  const base = { saldoUsd: 1000, esposizioneRisk: { [A]: 90 } };
  const ok10 = puoAggiungereRisk({ ...base, marketId: A, aggiuntaUsd: 10 });
  ok('90 + 10 = 100, esattamente al tetto ⇒ consentito', ok10.consentito === true, ok10.motivo);
  const no11 = puoAggiungereRisk({ ...base, marketId: A, aggiuntaUsd: 11 });
  ok('90 + 11 = 101, un dollaro oltre ⇒ rifiutato', no11.consentito === false);
  ok('  col motivo che nomina il tetto e il saldo', /\$100\.00/.test(no11.motivo) && /\$1000\.00/.test(no11.motivo), no11.motivo);
  ok('  e riporta le misure su cui ha deciso', no11.mercatoRiskUsd === 90 && no11.perMarketCapUsd === 100);
}

console.log('\n══ AGGIUNGERE: IL TETTO TOTALE, CHE È UN VINCOLO DIVERSO');
{
  // Ogni mercato è sotto il 10%, ma insieme sfondano il 15%: il tetto per mercato da solo li
  // lascerebbe passare tutti. È il caso che dimostra perché i tetti devono essere due.
  const esp = { [A]: 60, [B]: 60 };
  const r = puoAggiungereRisk({ saldoUsd: 1000, marketId: C, aggiuntaUsd: 60, esposizioneRisk: esp });
  ok('tre mercati da $60 (ognuno sotto $100) sfondano il bucket da $150', r.consentito === false);
  ok('  e il motivo nomina il bucket, non il per-mercato', /bucket Risk/.test(r.motivo), r.motivo);
  ok('  il singolo mercato infatti sarebbe stato ammesso',
    60 <= 100, 'ecco perché il tetto per mercato da solo non basta');

  // E il simmetrico: un mercato solo che si prende tutto il bucket è fermato dal per-mercato.
  const solo = puoAggiungereRisk({ saldoUsd: 1000, marketId: A, aggiuntaUsd: 150, esposizioneRisk: {} });
  ok('un mercato solo che prendesse tutto il bucket ($150) è fermato dal per-mercato', solo.consentito === false);
  ok('  col motivo del per-mercato', /tetto per mercato/.test(solo.motivo), solo.motivo);
}

console.log('\n══ IL SALDO È QUELLO DI ADESSO: UN FILL LO CAMBIA E IL TETTO SI MUOVE');
{
  const esp = { [A]: 90 };
  const prima = eccedenzaRisk({ saldoUsd: 1000, esposizioneRisk: esp });
  ok('con saldo $1000 la stessa esposizione è dentro', prima.sforato === false,
    `mercato $90 ≤ $${prima.perMarketCapUsd}`);

  // Il saldo scende a $600 (un fill ha consumato capitale). Nulla è cambiato negli ordini, ma il
  // tetto per mercato ora è $60 e quei $90 sono di troppo.
  const dopo = eccedenzaRisk({ saldoUsd: 600, esposizioneRisk: esp });
  ok('con saldo $600 la STESSA esposizione sfora', dopo.sforato === true);
  ok('  e dice quale mercato e di quanto',
    dopo.eccedenzePerMercato.length === 1
    && dopo.eccedenzePerMercato[0].marketId === A
    && dopo.eccedenzePerMercato[0].eccedenzaUsd === 30,
    JSON.stringify(dopo.eccedenzePerMercato[0]));
  ok('  il tetto per mercato è sceso a $60', dopo.perMarketCapUsd === 60);
}

console.log('\n══ ECCEDENZA: TOTALE E PER MERCATO SONO DUE NUMERI DIVERSI');
{
  // Totale $200 su un bucket da $150 ⇒ eccedenza totale $50. Nessun singolo mercato sfora ($70 < $100).
  const soloTotale = eccedenzaRisk({ saldoUsd: 1000, esposizioneRisk: { [A]: 70, [B]: 70, [C]: 60 } });
  ok('il totale sfora ma nessun mercato singolo',
    soloTotale.eccedenzaTotaleUsd === 50 && soloTotale.eccedenzePerMercato.length === 0,
    `totale +$${soloTotale.eccedenzaTotaleUsd}`);
  ok('  ed è comunque «sforato»: c è qualcosa da fare', soloTotale.sforato === true);

  // Un mercato sfora ma il totale no: $120 su un solo mercato, bucket $150.
  const soloMercato = eccedenzaRisk({ saldoUsd: 1000, esposizioneRisk: { [A]: 120 } });
  ok('un mercato sfora ma il totale no',
    soloMercato.eccedenzaTotaleUsd === 0 && soloMercato.eccedenzePerMercato.length === 1,
    `mercato +$${soloMercato.eccedenzePerMercato[0].eccedenzaUsd}`);
  ok('  ed è comunque «sforato»', soloMercato.sforato === true);

  // Le eccedenze sono ordinate dalla più grande: chi agisce comincia da dove pesa di più.
  const molti = eccedenzaRisk({ saldoUsd: 1000, esposizioneRisk: { [A]: 110, [B]: 180, [C]: 130 } });
  ok('le eccedenze sono ordinate per grandezza',
    molti.eccedenzePerMercato.map((x) => x.marketId).join(',') === `${B},${C},${A}`,
    molti.eccedenzePerMercato.map((x) => `${x.marketId}+$${x.eccedenzaUsd}`).join(' '));

  const dentro = eccedenzaRisk({ saldoUsd: 1000, esposizioneRisk: { [A]: 50 } });
  ok('tutto dentro ⇒ nessuna eccedenza e nessun allarme',
    dentro.sforato === false && dentro.eccedenzaTotaleUsd === 0 && dentro.eccedenzePerMercato.length === 0);
}

console.log('\n══ SALDO NON LEGGIBILE: NÉ VIA LIBERA NÉ CANCELLAZIONE');
{
  const agg = puoAggiungereRisk({ saldoUsd: null, marketId: A, aggiuntaUsd: 10, esposizioneRisk: {} });
  ok('non si AGGIUNGE niente', agg.consentito === false);
  ok('  e il motivo lo spiega', /saldo non leggibile/.test(agg.motivo), agg.motivo);

  const ecc = eccedenzaRisk({ saldoUsd: null, esposizioneRisk: { [A]: 999999 } });
  ok('ma l ECCEDENZA non viene inventata', ecc.eccedenzaTotaleUsd === null && ecc.leggibile === false);
  ok('  e nessun mercato viene indicato da cancellare', ecc.eccedenzePerMercato.length === 0,
    'rispondere «tutto è di troppo» farebbe cancellare ordini veri contro un numero assente');
  ok('  l esposizione misurata viaggia comunque, per poterla mostrare', ecc.totaleRiskUsd === 999999);
}

console.log('\n══ CASI LIMITE E FORME DI INPUT');
{
  ok('marketId assente ⇒ rifiuto',
    puoAggiungereRisk({ saldoUsd: 1000, marketId: null, aggiuntaUsd: 10 }).consentito === false);
  ok('aggiunta negativa ⇒ rifiuto',
    puoAggiungereRisk({ saldoUsd: 1000, marketId: A, aggiuntaUsd: -5 }).consentito === false);
  ok('aggiunta zero su un bucket vuoto ⇒ consentito',
    puoAggiungereRisk({ saldoUsd: 1000, marketId: A, aggiuntaUsd: 0, esposizioneRisk: {} }).consentito === true);

  // Map e oggetto devono dare lo stesso risultato: la forma dell'input non è una regola.
  const daOggetto = eccedenzaRisk({ saldoUsd: 1000, esposizioneRisk: { [A]: 120 } });
  const daMap = eccedenzaRisk({ saldoUsd: 1000, esposizioneRisk: new Map([[A, 120]]) });
  ok('Map e oggetto danno lo stesso verdetto',
    JSON.stringify(daOggetto.eccedenzePerMercato) === JSON.stringify(daMap.eccedenzePerMercato));

  // Maiuscole/minuscole nel marketId non devono creare due mercati distinti.
  const misto = eccedenzaRisk({ saldoUsd: 1000, esposizioneRisk: new Map([['MeRcAtO-A', 60], ['mercato-a', 60]]) });
  ok('lo stesso mercato scritto in due modi è UN mercato',
    misto.eccedenzePerMercato.length === 1 && misto.eccedenzePerMercato[0].usd === 120,
    `$${misto.eccedenzePerMercato[0].usd}`);
}

console.log('\n══ ISOLAMENTO: NESSUNO STATO FRA CHIAMATE');
{
  const dentro = { saldoUsd: 1000, esposizioneRisk: { [A]: 50 } };
  const fuori = { saldoUsd: 1000, esposizioneRisk: { [A]: 500 } };
  const seq = [dentro, fuori, dentro, fuori, dentro].map((x) => eccedenzaRisk(x).sforato);
  ok('alternando due portafogli il verdetto non cambia mai',
    JSON.stringify(seq) === JSON.stringify([false, true, false, true, false]), seq.join(','));

  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('./risk-caps'), 'utf8');
  ok('nessuno stato mutabile a livello di modulo',
    !/^const \w+ = new (Map|Set)\(/m.test(src) && !/^let /m.test(src));
  ok('nessun fs, nessuna rete, nessun orologio',
    !/require\('fs'\)|fetch\(|Date\.now\(\)/.test(src.replace(/^\/\/.*$/gm, '')));
}

console.log(`\ntetti del bucket Risk: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
