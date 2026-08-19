'use strict';
// lib/venues/risposta-venue.test.js
//
// «NON HO LETTO» NON E' «NON C'E' NIENTE» — la classe di difetto piu' ricorrente di questo repo
// (§5.3), qui applicata alle due cose da cui dipende il KILL: l'elenco degli ordini a libro e
// l'esito di una cancellazione.
//
// TRE BLOCCHI, e il secondo e il terzo sono quelli che contano:
//   ① LA DECISIONE  — il modulo puro, ai confini.
//   ② IL CABLAGGIO  — che gli adapter la usino DAVVERO, e che il fallback cieco non ci sia piu'.
//   ③ LO SCATTO     — `cancelVenueOrders` e `killMaker` guidati con un adapter che NON riesce a
//                     leggere: il KILL non deve poter presentare un numero.
//
// ⚠ Il blocco ③ e' l'unico che prova la proprieta' che l'operatore ha chiesto per nome. Un test che
//   si fermasse a ① proverebbe la decisione e non il cablaggio — che e' esattamente come tre difese
//   di questo repo sono rimaste inerti col verde (§5-bis p.181).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const R = require('./risposta-venue');
const { cancelVenueOrders } = require('../maker/cancel-all');
const { killMaker } = require('../maker/kill');

let passati = 0;
const ok = (c, n, x) => { assert.ok(c, n + (x ? ` — ${x}` : '')); passati += 1; };

// ══ ① LA DECISIONE ════════════════════════════════════════════════════════════════════════════════

// La lettura BUONA con zero ordini: e' il caso normale, e non deve mai essere confuso col guasto.
{
  const vuota = R.listaDaRisposta({ data: [], next_cursor: 'LTE=', limit: 500, count: 0 });
  ok(vuota.ok === true && vuota.lista.length === 0,
    '① ⚑ `{data:[]}` e una lettura RIUSCITA con zero ordini, non un guasto');

  ok(R.listaDaRisposta([]).ok === true, '① l array nudo vuoto e una lettura riuscita');
  const tre = R.listaDaRisposta({ data: [1, 2, 3] });
  ok(tre.ok === true && tre.lista.length === 3, '① e la lista si legge dal campo `data`');
  ok(R.listaDaRisposta({ orders: [1] }, ['data', 'orders']).ok === true, '① …o da un campo dichiarato');
}

// LA FORMA CHE NON SI CAPISCE: prima diventava `[]` con `ok:true`.
{
  for (const [nome, res] of [
    ['errore del venue', { error: 'internal error', status: 500 }],
    ['errore senza status', { error: 'boom' }],
    ['success:false', { success: false }],
    ['oggetto senza lista', { qualcosa: 1 }],
    ['stringa', 'service unavailable'],
    ['numero', 42],
    ['null', null],
    ['undefined', undefined],
  ]) {
    const r = R.listaDaRisposta(res);
    ok(r.ok === false, `① ⚑ «${nome}» ⇒ NON e una lista vuota, e una lettura fallita`);
    ok(r.forma && typeof r.forma === 'object', `①   «${nome}» porta la FORMA a verbale`, JSON.stringify(r.forma || null));
  }
}

// `error: null` NON e' un errore: alcune risposte buone portano il campo a null, e trattarlo come
// guasto renderebbe illeggibile una lettura sana — fallire chiuso su un caso normale e' il modo di
// costruire un bot che non fa mai niente.
{
  const r = R.listaDaRisposta({ error: null, data: [7] });
  ok(r.ok === true && r.lista.length === 1, '① ⚑ `error: null` non e un errore');
}

// Lo status si guarda solo se e' FINITO: `Number(undefined)` e' NaN e non deve valere ne 0 ne 500.
{
  ok(R.erroreDelVenue({ data: [] }).errore === false, '① status assente ⇒ nessun errore inventato');
  ok(R.erroreDelVenue({ status: 200, data: [] }).errore === false, '① status 200 ⇒ nessun errore');
  ok(R.erroreDelVenue({ status: 429 }).errore === true, '① status 429 ⇒ errore');
  ok(R.erroreDelVenue({ status: 'boh', data: [] }).errore === false, '① status non numerico ⇒ non e un 500');
}

// LA CATTURA DEL CORPO GREZZO — cio' che mancava il 19 agosto.
{
  const e = Object.assign(new Error('response.data is not iterable'), { name: 'ApiError', status: 503, data: { error: 'upstream', detail: 'x' } });
  const d = R.dettagliErrore(e);
  ok(d.status === 503, '① ⚑ dallo scoppio si recupera lo STATUS', String(d.status));
  ok(d.corpo && String(d.corpo.campione).includes('upstream'),
    '① ⚑ e il CORPO: e la prova che di un ora di guasto non e rimasto niente', JSON.stringify(d.corpo || null));

  const axiosLike = Object.assign(new Error('Request failed'), { response: { status: 502, data: 'bad gateway' } });
  const d2 = R.dettagliErrore(axiosLike);
  ok(d2.status === 502 && String(d2.corpo.campione).includes('bad gateway'),
    '① anche dalla forma axios, che e quella che arriva davvero');

  // Un errore nudo non inventa niente.
  const d3 = R.dettagliErrore(new Error('boom'));
  ok(d3.status === undefined && d3.corpo === undefined, '① un errore senza status/corpo non ne fabbrica');
}

// L'ESITO DI UNA CANCELLAZIONE.
{
  const buono = R.esitoCancellazione({ canceled: ['a', 'b'], not_canceled: {} });
  ok(buono.ok === true && buono.cancellati === 2 && buono.nonCancellati === 0, '① cancellazione riuscita: 2 cancellati');

  const rifiutata = R.esitoCancellazione({ error: 'not authorized', status: 401 });
  ok(rifiutata.ok === false, '① ⚑ una cancellazione RIFIUTATA dal venue non e una cancellazione riuscita');
  ok(rifiutata.status === 401 && String(rifiutata.messaggio).includes('not authorized'), '①   con status e messaggio');

  // `not_canceled` si DICHIARA e non rende rosso l'esito: il venue ci mette anche gli ordini che nel
  // frattempo si erano riempiti, e trattarli come fallimento renderebbe rosso un KILL riuscito.
  const parziale = R.esitoCancellazione({ canceled: ['a'], not_canceled: { b: 'already filled' } });
  ok(parziale.ok === true && parziale.cancellati === 1 && parziale.nonCancellati === 1,
    '① ⚑ i non cancellati si CONTANO senza rendere rosso l esito');
}

// ══ ② IL CABLAGGIO — il fallback cieco non c'e' piu', in NESSUNO dei due adapter ══════════════════
{
  const sorgenti = [
    ['piazzamento', path.join(__dirname, 'polymarket-clob-maker/adapter.js')],
    ['sola cancellazione', path.join(__dirname, 'polymarket-clob/adapter.js')],
  ];
  for (const [nome, file] of sorgenti) {
    // ⚠ Si filtrano i COMMENTI: qui sopra il difetto vecchio e' CITATO per spiegare la correzione, e
    //   un test che cercasse la stringa nel sorgente nudo sarebbe verde grazie al commento che lo
    //   racconta (§5.3). Si guarda il codice, non la narrazione.
    const codice = fs.readFileSync(file, 'utf8')
      .split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n');
    ok(!/Array\.isArray\(res\.data\)\s*\?\s*res\.data\s*:\s*\[\]/.test(codice)
      && !/Array\.isArray\(res\)\s*\?\s*res\s*:\s*\(res\s*&&\s*Array\.isArray\(res\.data\)\s*\?\s*res\.data\s*:\s*\[\]\)/.test(codice),
      `② ⚑ adapter di ${nome}: il fallback cieco «forma inattesa ⇒ lista vuota» non e piu nel codice`);
    ok(/require\(['"][^'"]*risposta-venue['"]\)/.test(codice),
      `② adapter di ${nome}: importa la definizione condivisa invece di ricopiarla (reperto D1)`);
    ok(/esitoCancellazione\(/.test(codice),
      `② ⚑ adapter di ${nome}: la CANCELLAZIONE giudica la risposta, non il fatto che non ha sollevato`);
  }
}

(async () => {
  // ══ ③ LO SCATTO — il KILL guidato con un venue che non si lascia leggere ═════════════════════════

  // Un adapter di sola cancellazione che FALLISCE la lettura, e conta quante volte gli viene chiesto di
  // cancellare. Se la spazzata partisse comunque, si vedrebbe qui.
  function adapterCieco(errore = { ok: false, error: 'response.data is not iterable', causa: 'forma-inattesa', status: 503, forma: { tipo: 'object', chiavi: ['error', 'status'] } }) {
    const chiamate = [];
    return {
      spia: chiamate,
      dryRun: false,
      async listOpenOrders() { return errore; },
      async cancelMarketOrders(m) { chiamate.push(m); return { ok: true, sent: true, marketId: m, response: { canceled: ['x'] } }; },
    };
  }

  {
    const a = adapterCieco();
    const r = await cancelVenueOrders('polymarket', { buildAdapter: () => a });
    ok(r.ok === false, '③ lettura fallita ⇒ l esito e rosso');
    ok(r.cancelled === null, '③ ⚑ e `cancelled` e `null`, NON `0`: «non lo so» non si scrive con un numero', String(r.cancelled));
    ok(r.letturaFallita === true, '③ ⚑ ed e dichiarato per nome: `letturaFallita: true`');
    ok(r.status === 503 && r.causa === 'forma-inattesa', '③ la causa e lo status dell adapter arrivano fino al referto');
    ok(r.forma && r.forma.chiavi, '③ ⚑ e la FORMA della risposta arriva a verbale: il guasto si riconosce la volta dopo');
    ok(a.spia.length === 0, '③ ⚑ e non si e cancellato NIENTE alla cieca', `${a.spia.length} cancellazioni`);
  }

  // LA PROPRIETA' CHIESTA DALL'OPERATORE: «il KILL non deve mai poter dire fatto quando non ha letto».
  {
    const a = adapterCieco();
    const k = await killMaker({ by: 'test', reason: 'prova' }, {
      setGlobalKill: () => {},
      cancelAllOrders: () => cancelVenueOrders('polymarket', { buildAdapter: () => a }).then((x) => [x]),
      now: () => 1_700_000_000_000,
    });
    ok(k.killed === true, '③ il KILL si posa comunque: una spazzata che non riesce non blocca lo STOP');
    ok(k.cancelledTotal === null,
      '③ ⚑⚑ IL TOTALE E `null`, NON `0`: il KILL non presenta un numero che non ha misurato', String(k.cancelledTotal));
    ok(k.letturaFallita === true && k.venuesNonLetti.includes('polymarket'),
      '③ ⚑ e dichiara QUALE venue non ha letto', JSON.stringify(k.venuesNonLetti));
  }

  // E IL CONTROLLO, senza il quale i rossi qui sopra non proverebbero niente: a venue leggibile il KILL
  // misura e presenta un numero vero.
  {
    const chiamate = [];
    const sano = {
      dryRun: false,
      async listOpenOrders() { return { ok: true, count: 2, orders: [
        { market: '0xm1', price: 0.5, size: 10, size_matched: 0 },
        { market: '0xm1', price: 0.4, size: 10, size_matched: 0 },
      ] }; },
      async cancelMarketOrders(m) { chiamate.push(m); return { ok: true, sent: true, marketId: m, response: { canceled: ['a', 'b'] } }; },
    };
    const k = await killMaker({ by: 'test', reason: 'prova' }, {
      setGlobalKill: () => {},
      cancelAllOrders: () => cancelVenueOrders('polymarket', { buildAdapter: () => sano }).then((x) => [x]),
      now: () => 1_700_000_000_000,
    });
    ok(k.cancelledTotal === 2, '③ ⚑ CONTROLLO: a venue leggibile il totale e un numero vero', String(k.cancelledTotal));
    ok(k.letturaFallita === false, '③ CONTROLLO: e nessuna lettura e dichiarata fallita');
    ok(chiamate.length === 1, '③ CONTROLLO: e la spazzata e partita davvero', `${chiamate.length} mercati`);
  }

    console.log(`risposta del venue: ${passati}/${passati} verdi, 0 rossi`);

})().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
