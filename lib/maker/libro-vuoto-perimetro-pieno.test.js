'use strict';
// lib/maker/libro-vuoto-perimetro-pieno.test.js
//
// LA PROPRIETA': «perimetro pieno, libro vuoto» non dura oltre la soglia.
// E le cose che la regola NON deve fare: liberare troppo presto, liberare al buio, liberare un
// mercato in gestione, liberare un INTOCCABILE (regola 9).
//
// ⚠ IL CONTRATTO E' CAMBIATO IL 20 AGOSTO, e queste asserzioni sono state RISCRITTE, non ammorbidite.
// La soglia non e' piu' «2 osservazioni consecutive» (~2-4 min) ma **22 minuti**, dal vuoto misurato
// [11,0 · 33,0] fra chi ha piazzato e chi non ha mai piazzato: a 4 minuti si uccidevano 10
// piazzamenti riusciti su 21, ed e' il danno per cui la regola fu disarmata il 18 agosto. Lo stato
// non porta piu' `conteggi` (quante osservazioni) ma `zeroDa` (da quando il libro e' vuoto).
// Il riarmo, la quarantena e il tetto orario sono provati in `slot-sterile-riarmato.test.js`.

const assert = require('assert');
const L = require('./libro-vuoto-perimetro-pieno');

let passati = 0;
const ok = (c, n) => { assert.ok(c, n); passati += 1; };
const T = 1_000_000;
const ordini = (ids) => ({ leggibile: true, ids });
// ⚠ LE POSIZIONI SONO UN INGRESSO OBBLIGATORIO dal 20 agosto: senza, la guardia della regola 9 e'
// fail-closed e non si rilascia nessuno. Qui si passano SEMPRE leggibili e vuote, tranne dove il
// test vuole proprio provare l'intoccabile.
const posiz = (ids = []) => ({ leggibile: true, conditionIds: ids });
// La catena di osservazioni contigue: il ciclo vero gira ogni 120 s.
const finoA = (minuti, extra = {}) => {
  let st = L.statoVuoto(); let r = null;
  for (let m = 0; m <= minuti; m += 2) {
    r = L.valuta({ attivi: ['0xa'], ordini: ordini([]), posizioni: posiz(), stato: st, ora: T + m * 60_000, ...extra });
    st = r.statoNuovo;
    if (r.azione === 'rilascia') return { ...r, minuto: m };
  }
  return { ...r, minuto: null };
};
const ids = (r) => r.daRilasciare.map((x) => x.id);

// ══ ① NON SI LIBERA PRIMA DELLA SOGLIA ═══════════════════════════════════════════════════════════
{
  const presto = finoA(20);
  ok(presto.minuto === null, '① sotto i 22 minuti nessuna azione');
  ok(presto.zeroDa['0xa'] === T, '① ma l orologio e partito, e ricorda da QUANDO');

  const giusto = finoA(30);
  ok(giusto.minuto === 22, '① ⚑ ai 22 minuti lo slot si libera');
  ok(ids(giusto).includes('0xa'), '① ed e il mercato giusto');
  ok(giusto.daRilasciare[0].motivo === 'slot-sterile', '① col motivo dichiarato');
  ok(giusto.daRilasciare[0].minuti === 22, '① e la riga porta i MINUTI, non un conteggio');
}

// ══ ② UN MERCATO CHE PRENDE ORDINI AZZERA TUTTO ═══════════════════════════════════════════════════
{
  const r1 = L.valuta({ attivi: ['0xa'], ordini: ordini([]), posizioni: posiz(), stato: L.statoVuoto(), ora: T });
  const r2 = L.valuta({ attivi: ['0xa'], ordini: ordini(['0xa']), posizioni: posiz(), stato: r1.statoNuovo, ora: T + 120_000 });
  ok(r2.azione === 'nessuna', '② con ordini a libro nessuna azione');
  ok(r2.zeroDa['0xa'] === undefined, '② e l orologio sparisce, non si porta dietro il passato');

  const r3 = L.valuta({ attivi: ['0xa'], ordini: ordini([]), posizioni: posiz(), stato: r2.statoNuovo, ora: T + 240_000 });
  ok(r3.azione === 'nessuna', '② ⚑ e dopo un giro con ordini si riparte da capo');
  ok(r3.zeroDa['0xa'] === T + 240_000, '② l orologio riparte da adesso');
}

// ══ ③ CONSECUTIVE VUOL DIRE ANCHE CONTIGUE ════════════════════════════════════════════════════════
{
  let st = L.statoVuoto();
  for (let m = 0; m <= 20; m += 2) {
    st = L.valuta({ attivi: ['0xa'], ordini: ordini([]), posizioni: posiz(), stato: st, ora: T + m * 60_000 }).statoNuovo;
  }
  const lontano = L.valuta({ attivi: ['0xa'], ordini: ordini([]), posizioni: posiz(), stato: st,
    ora: T + 20 * 60_000 + L.MAX_INTERVALLO_MS + 1 });
  ok(lontano.azione === 'nessuna',
    '③ ⚑ un buco piu largo di MAX_INTERVALLO_MS non e contiguo: l orologio riparte');
  ok(lontano.zeroDa['0xa'] === T + 20 * 60_000 + L.MAX_INTERVALLO_MS + 1, '③ e riparte da adesso');

  const vicino = L.valuta({ attivi: ['0xa'], ordini: ordini([]), posizioni: posiz(), stato: st,
    ora: T + 20 * 60_000 + L.MAX_INTERVALLO_MS - 1 });
  ok(vicino.azione === 'rilascia', '③ appena dentro l intervallo, invece, si libera');
}

// ══ ④ FAIL-CLOSED: AL BUIO NON SI LIBERA, E NON SI DIMENTICA ══════════════════════════════════════
{
  // Si porta l'orologio a un passo dalla soglia con osservazioni CONTIGUE, poi si acceca il lettore.
  let st = L.statoVuoto();
  for (let m = 0; m <= L.SOGLIA_MIN - 2; m += 2) {
    st = L.valuta({ attivi: ['0xa'], ordini: ordini([]), posizioni: posiz(), stato: st, ora: T + m * 60_000 }).statoNuovo;
  }
  const quasi = T + (L.SOGLIA_MIN - 2) * 60_000;
  for (const cieco of [{ leggibile: false }, null, undefined, {}, { leggibile: 'si' }]) {
    const r = L.valuta({ attivi: ['0xa'], ordini: cieco, posizioni: posiz(), stato: st, ora: quasi + 120_000 });
    ok(r.azione === 'nessuna', `④ ordini illeggibili (${JSON.stringify(cieco)}) ⇒ non si libera`);
    // ⚠ E l'orologio NON si azzera: «non ho letto» non e' «il libro si e riempito».
    ok(r.statoNuovo.zeroDa['0xa'] === T, '④   e l orologio NON si azzera: si sospende il giudizio');
  }
  // ⚠ E LE POSIZIONI SONO L'ALTRA META' DEL FAIL-CLOSED, dal 20 agosto: senza di loro non si puo'
  // sapere chi ha una posizione aperta, e la regola 9 vieta di rilasciare al buio.
  const senzaPos = L.valuta({ attivi: ['0xa'], ordini: ordini([]), posizioni: { leggibile: false },
    stato: st, ora: quasi + 120_000 });
  ok(senzaPos.azione === 'nessuna', '④ posizioni illeggibili ⇒ non si libera (regola 9, fail-closed)');
  ok(/regola 9/.test(senzaPos.motivo), '④   e il motivo nomina la regola che sta difendendo');

  // Alla prima lettura buona si conclude: l'orologio non ha perso i minuti.
  const buona = L.valuta({ attivi: ['0xa'], ordini: ordini([]), posizioni: posiz(), stato: st, ora: quasi + 120_000 });
  ok(buona.azione === 'rilascia', '④ ⚑ e alla prima lettura buona si conclude, senza aver perso il conto');
}

// ══ ⑤ CHI NON E' FRA GLI ATTIVI NON SI TOCCA ══════════════════════════════════════════════════════
{
  // I mercati in gestione non arrivano in `attivi` (la rotazione ha gia' liberato il loro slot):
  // il chiamante li filtra, e qui si prova che non se ne inventano.
  const r1 = L.valuta({ attivi: [], ordini: ordini([]), posizioni: posiz(), stato: L.statoVuoto(), ora: T });
  ok(r1.azione === 'nessuna' && Object.keys(r1.zeroDa).length === 0,
    '⑤ nessuno slot attivo ⇒ niente da giudicare');

  const r2 = L.valuta({ attivi: ['0xa'], ordini: ordini([]), posizioni: posiz(), stato: L.statoVuoto(), ora: T });
  const r3 = L.valuta({ attivi: ['0xb'], ordini: ordini([]), posizioni: posiz(), stato: r2.statoNuovo, ora: T + 120_000 });
  ok(r3.azione === 'nessuna', '⑤ ⚑ un mercato NUOVO non eredita l orologio di quello uscito');
  ok(r3.zeroDa['0xa'] === undefined && r3.zeroDa['0xb'] === T + 120_000, '⑤ gli orologi seguono il mercato');
}

// ══ ⑥ INGRESSI MALFATTI ⇒ NESSUNA AZIONE ══════════════════════════════════════════════════════════
{
  for (const cattivo of [
    { attivi: null, ordini: ordini([]), posizioni: posiz(), ora: T },
    { attivi: ['0xa'], ordini: ordini([]), posizioni: posiz(), ora: null },
    { attivi: ['0xa'], ordini: ordini([]), posizioni: posiz(), ora: NaN },
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
  for (let m = 0; m <= L.SOGLIA_MIN; m += 2) {
    r = L.valuta({ attivi: ['0xirr'], ordini: ordini([]), posizioni: posiz(), stato: st, ora: T + m * 60_000 });
    st = r.statoNuovo;
  }
  ok(r.azione === 'rilascia', `⑥-bis ① mercato irraggiungibile ⇒ RILASCIATO dopo ${L.SOGLIA_MIN} minuti`);
  ok(ids(r).includes('0xirr'), '⑥-bis ① ed e proprio lui');

  // ② SVUOTATO DA NOI: il repricer cancella per mid stantio a ogni giro. DIECI osservazioni, e non
  //    deve uscire mai — perche' per cancellare un ordine bisogna prima averlo piazzato.
  st = L.statoVuoto();
  for (let m = 0; m <= 60; m += 2) {
    r = L.valuta({ attivi: ['0xnostro'], ordini: ordini([]), posizioni: posiz(), stato: st, ora: T + m * 60_000,
      svuotatiDaNoi: ['0xnostro'] });
    st = r.statoNuovo;
    ok(r.azione === 'nessuna', `⑥-bis ② minuto ${m}/60 (oltre il doppio della soglia): NON si rilascia`);
  }
  ok((r.nonContate || []).some((x) => x.id === '0xnostro' && x.motivo === 'svuotato-da-noi'),
    '⑥-bis ② ⚑ e la non-conta e dichiarata col suo motivo, non taciuta');

  // ③ UN PIAZZAMENTO RIUSCITO AZZERA. Un mercato a un passo dal rilascio che riesce a piazzare
  //    riparte da zero: la prova che il capitale ci si puo' mettere batte tutto quello che c'era prima.
  st = L.valuta({ attivi: ['0xa'], ordini: ordini([]), posizioni: posiz(), stato: L.statoVuoto(), ora: T }).statoNuovo;
  const dopoPiazzamento = L.valuta({ attivi: ['0xa'], ordini: ordini([]), posizioni: posiz(), stato: st,
    ora: T + 120_000, piazzatiConSuccesso: ['0xa'] });
  ok(dopoPiazzamento.azione === 'nessuna', '⑥-bis ③ un piazzamento riuscito impedisce il rilascio');
  ok(dopoPiazzamento.zeroDa['0xa'] === undefined, '⑥-bis ③ ⚑ e AZZERA l orologio, non lo congela');

  // ④ LA DIFFERENZA FRA I DUE: «svuotato» CONSERVA il conteggio, «piazzato» lo AZZERA. Sono due cose
  //    diverse e il test le separa, o domani qualcuno le unifica credendo siano la stessa.
  const conConteggio = L.valuta({ attivi: ['0xa'], ordini: ordini([]), posizioni: posiz(), stato: st,
    ora: T + 120_000, svuotatiDaNoi: ['0xa'] });
  ok(conConteggio.zeroDa['0xa'] === T,
    '⑥-bis ④ ⚑ «svuotato da noi» CONSERVA l orologio (non riparte da zero all infinito)');
  ok(dopoPiazzamento.zeroDa['0xa'] === undefined,
    '⑥-bis ④ ⚑ mentre «piazzato con successo» lo AZZERA — due segnali diversi, due effetti diversi');

  // ⑤ E il caso misto: due mercati insieme, uno sterile e uno svuotato da noi. Esce solo il primo.
  st = L.statoVuoto();
  for (let m = 0; m <= L.SOGLIA_MIN; m += 2) {
    r = L.valuta({ attivi: ['0xirr', '0xnostro'], ordini: ordini([]), posizioni: posiz(), stato: st,
      ora: T + m * 60_000, svuotatiDaNoi: ['0xnostro'] });
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
