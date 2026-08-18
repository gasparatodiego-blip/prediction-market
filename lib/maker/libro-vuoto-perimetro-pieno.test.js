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

// ══ ⑥-bis · LE DUE CAUSE OPPOSTE DI «NESSUN ORDINE A LIBRO» ═══════════════════════════════════════
//
// ⚠ E' IL BLOCCO CHE CONTA. La prima stesura vedeva una causa sola e ha buttato fuori CINQUE VOLTE un
// mercato che andava benissimo. «Sterile» deve significare «non ci abbiamo mai messo capitale, o non
// ce lo possiamo mettere», MAI «ce l'avevamo e l'abbiamo tolto noi».
{
  // ① IRRAGGIUNGIBILE: nessun ordine, nessuna cancellazione nostra, nessun piazzamento ⇒ si rilascia.
  let st = L.statoVuoto();
  let r;
  for (let i = 0; i < 2; i += 1) {
    r = L.valuta({ attivi: ['0xirr'], ordini: ordini([]), stato: st, ora: T + i * 120_000 });
    st = r.statoNuovo;
  }
  ok(r.azione === 'rilascia', '⑥-bis ① mercato irraggiungibile ⇒ RILASCIATO dopo 2 osservazioni');
  ok(ids(r).includes('0xirr'), '⑥-bis ① ed e proprio lui');

  // ② SVUOTATO DA NOI: il repricer cancella per mid stantio a ogni giro. DIECI osservazioni, e non
  //    deve uscire mai — perche' per cancellare un ordine bisogna prima averlo piazzato.
  st = L.statoVuoto();
  for (let i = 0; i < 10; i += 1) {
    r = L.valuta({ attivi: ['0xnostro'], ordini: ordini([]), stato: st, ora: T + i * 120_000,
      svuotatiDaNoi: ['0xnostro'] });
    st = r.statoNuovo;
    ok(r.azione === 'nessuna', `⑥-bis ② osservazione ${i + 1}/10: NON si rilascia`);
  }
  ok((r.nonContate || []).some((x) => x.id === '0xnostro' && x.motivo === 'svuotato-da-noi'),
    '⑥-bis ② ⚑ e la non-conta e dichiarata col suo motivo, non taciuta');

  // ③ UN PIAZZAMENTO RIUSCITO AZZERA. Un mercato a un passo dal rilascio che riesce a piazzare
  //    riparte da zero: la prova che il capitale ci si puo' mettere batte tutto quello che c'era prima.
  st = L.valuta({ attivi: ['0xa'], ordini: ordini([]), stato: L.statoVuoto(), ora: T }).statoNuovo;
  const dopoPiazzamento = L.valuta({ attivi: ['0xa'], ordini: ordini([]), stato: st,
    ora: T + 120_000, piazzatiConSuccesso: ['0xa'] });
  ok(dopoPiazzamento.azione === 'nessuna', '⑥-bis ③ un piazzamento riuscito impedisce il rilascio');
  ok(dopoPiazzamento.conteggi['0xa'] === undefined, '⑥-bis ③ ⚑ e AZZERA il contatore, non lo congela');

  // ④ LA DIFFERENZA FRA I DUE: «svuotato» CONSERVA il conteggio, «piazzato» lo AZZERA. Sono due cose
  //    diverse e il test le separa, o domani qualcuno le unifica credendo siano la stessa.
  const conConteggio = L.valuta({ attivi: ['0xa'], ordini: ordini([]), stato: st,
    ora: T + 120_000, svuotatiDaNoi: ['0xa'] });
  ok(conConteggio.conteggi['0xa'] === 1,
    '⑥-bis ④ ⚑ «svuotato da noi» CONSERVA il conteggio (non riparte da zero all infinito)');
  ok(dopoPiazzamento.conteggi['0xa'] === undefined,
    '⑥-bis ④ ⚑ mentre «piazzato con successo» lo AZZERA — due segnali diversi, due effetti diversi');

  // ⑤ E il caso misto: due mercati insieme, uno sterile e uno svuotato da noi. Esce solo il primo.
  st = L.statoVuoto();
  for (let i = 0; i < 2; i += 1) {
    r = L.valuta({ attivi: ['0xirr', '0xnostro'], ordini: ordini([]), stato: st,
      ora: T + i * 120_000, svuotatiDaNoi: ['0xnostro'] });
    st = r.statoNuovo;
  }
  ok(ids(r).includes('0xirr') && !ids(r).includes('0xnostro'),
    '⑥-bis ⑤ ⚑ nello stesso giro esce lo sterile e resta quello svuotato da noi');
}

// ══ ⑦ IL MODULO E' PURO ═══════════════════════════════════════════════════════════════════════════
{
  const src = require('fs').readFileSync(require.resolve('./libro-vuoto-perimetro-pieno'), 'utf8');
  const req = src.split('\n').filter((l) => /(^|[^/])\brequire\s*\(/.test(l) && !l.trim().startsWith('//'));
  ok(req.length === 0, '⑦ zero `require`: decide e basta, non tocca il venue ne il disco');
}

console.log(`libro vuoto a perimetro pieno: ${passati}/${passati} verdi, 0 rossi`);
