'use strict';
// lib/maker/libro-vuoto-perimetro-pieno.test.js
//
// LA PROPRIETA': «perimetro pieno, libro vuoto» non dura piu' di un ciclo.
// E le tre cose che la regola NON deve fare: liberare al primo giro, liberare al buio, liberare un
// mercato in gestione.

const assert = require('assert');
const L = require('./libro-vuoto-perimetro-pieno');

let passati = 0;
const ok = (c, n) => { assert.ok(c, n); passati += 1; };
const T = 1_000_000;
const ordini = (ids) => ({ leggibile: true, ids });
const ids = (r) => r.daRilasciare.map((x) => x.id);

// ══ ① NON SI LIBERA AL PRIMO GIRO ═════════════════════════════════════════════════════════════════
{
  const r1 = L.valuta({ attivi: ['0xa'], ordini: ordini([]), stato: L.statoVuoto(), ora: T });
  ok(r1.azione === 'nessuna', '① primo giro senza ordini ⇒ nessuna azione');
  ok(r1.conteggi['0xa'] === 1, '① ma il contatore parte');

  const r2 = L.valuta({ attivi: ['0xa'], ordini: ordini([]), stato: r1.statoNuovo, ora: T + 120_000 });
  ok(r2.azione === 'rilascia', '① ⚑ alla SECONDA osservazione consecutiva lo slot si libera');
  ok(ids(r2).includes('0xa'), '① ed e il mercato giusto');
  ok(r2.daRilasciare[0].motivo === 'slot-sterile', '① col motivo dichiarato');
}

// ══ ② UN MERCATO CHE PRENDE ORDINI AZZERA TUTTO ═══════════════════════════════════════════════════
{
  const r1 = L.valuta({ attivi: ['0xa'], ordini: ordini([]), stato: L.statoVuoto(), ora: T });
  const r2 = L.valuta({ attivi: ['0xa'], ordini: ordini(['0xa']), stato: r1.statoNuovo, ora: T + 120_000 });
  ok(r2.azione === 'nessuna', '② con ordini a libro nessuna azione');
  ok(r2.conteggi['0xa'] === undefined, '② e il contatore sparisce, non si porta dietro il passato');

  const r3 = L.valuta({ attivi: ['0xa'], ordini: ordini([]), stato: r2.statoNuovo, ora: T + 240_000 });
  ok(r3.azione === 'nessuna', '② ⚑ e dopo un giro con ordini si riparte da capo, non si riprende a 2');
  ok(r3.conteggi['0xa'] === 1, '② il contatore riparte da 1');
}

// ══ ③ CONSECUTIVE VUOL DIRE ANCHE CONTIGUE ════════════════════════════════════════════════════════
{
  const r1 = L.valuta({ attivi: ['0xa'], ordini: ordini([]), stato: L.statoVuoto(), ora: T });
  const lontano = L.valuta({ attivi: ['0xa'], ordini: ordini([]), stato: r1.statoNuovo,
    ora: T + L.MAX_INTERVALLO_MS + 1 });
  ok(lontano.azione === 'nessuna',
    '③ ⚑ due osservazioni troppo lontane non sono consecutive: il contatore riparte');
  ok(lontano.conteggi['0xa'] === 1, '③ e riparte da 1');

  const vicino = L.valuta({ attivi: ['0xa'], ordini: ordini([]), stato: r1.statoNuovo,
    ora: T + L.MAX_INTERVALLO_MS - 1 });
  ok(vicino.azione === 'rilascia', '③ appena dentro l intervallo, invece, si libera');
}

// ══ ④ FAIL-CLOSED: AL BUIO NON SI LIBERA, E NON SI DIMENTICA ══════════════════════════════════════
{
  const r1 = L.valuta({ attivi: ['0xa'], ordini: ordini([]), stato: L.statoVuoto(), ora: T });
  for (const cieco of [{ leggibile: false }, null, undefined, {}, { leggibile: 'si' }]) {
    const r = L.valuta({ attivi: ['0xa'], ordini: cieco, stato: r1.statoNuovo, ora: T + 120_000 });
    ok(r.azione === 'nessuna', `④ ordini illeggibili (${JSON.stringify(cieco)}) ⇒ non si libera`);
    // ⚠ E il contatore NON si azzera: «non ho letto» non e' «il libro si e riempito».
    ok(r.conteggi['0xa'] === 1, '④   e il contatore NON si azzera: si sospende il giudizio');
  }
  // Alla prima lettura buona si riprende da dov era.
  const buona = L.valuta({ attivi: ['0xa'], ordini: ordini([]), stato: r1.statoNuovo, ora: T + 120_000 });
  ok(buona.azione === 'rilascia', '④ ⚑ e alla prima lettura buona si conclude, senza aver perso il conto');
}

// ══ ⑤ CHI NON E' FRA GLI ATTIVI NON SI TOCCA ══════════════════════════════════════════════════════
{
  // I mercati in gestione non arrivano in `attivi` (la rotazione ha gia' liberato il loro slot):
  // il chiamante li filtra, e qui si prova che non se ne inventano.
  const r1 = L.valuta({ attivi: [], ordini: ordini([]), stato: L.statoVuoto(), ora: T });
  ok(r1.azione === 'nessuna' && Object.keys(r1.conteggi).length === 0,
    '⑤ nessuno slot attivo ⇒ niente da giudicare');

  const r2 = L.valuta({ attivi: ['0xa'], ordini: ordini([]), stato: L.statoVuoto(), ora: T });
  const r3 = L.valuta({ attivi: ['0xb'], ordini: ordini([]), stato: r2.statoNuovo, ora: T + 120_000 });
  ok(r3.azione === 'nessuna', '⑤ ⚑ un mercato NUOVO non eredita il contatore di quello uscito');
  ok(r3.conteggi['0xa'] === undefined && r3.conteggi['0xb'] === 1, '⑤ i contatori seguono il mercato');
}

// ══ ⑥ INGRESSI MALFATTI ⇒ NESSUNA AZIONE ══════════════════════════════════════════════════════════
{
  for (const cattivo of [
    { attivi: null, ordini: ordini([]), ora: T },
    { attivi: ['0xa'], ordini: ordini([]), ora: null },
    { attivi: ['0xa'], ordini: ordini([]), ora: NaN },
  ]) {
    const r = L.valuta({ ...cattivo, stato: L.statoVuoto() });
    ok(r.azione === 'nessuna', `⑥ ingresso malfatto ⇒ nessuna azione (${JSON.stringify(Object.keys(cattivo))})`);
  }
}

// ══ ⑦ IL MODULO E' PURO ═══════════════════════════════════════════════════════════════════════════
{
  const src = require('fs').readFileSync(require.resolve('./libro-vuoto-perimetro-pieno'), 'utf8');
  const req = src.split('\n').filter((l) => /(^|[^/])\brequire\s*\(/.test(l) && !l.trim().startsWith('//'));
  ok(req.length === 0, '⑦ zero `require`: decide e basta, non tocca il venue ne il disco');
}

console.log(`libro vuoto a perimetro pieno: ${passati}/${passati} verdi, 0 rossi`);
