#!/usr/bin/env node
'use strict';
// LE DUE GAMBE DI UN MERCATO VIVONO O MUOIONO INSIEME.
//
// Da quando il piano emette due righe per mercato — un BUY sul libro YES e un BUY sul libro NO — il
// caso peggiore non è più «nessun ordine»: è UNA GAMBA SOLA. Per la formula del venue una gamba sola
// matura ZERO fuori dal range [0.10, 0.90] e un terzo dentro, mentre il capitale resta impegnato per
// intero. Questo file prova che non può succedere, e che quando succede lo dice invece di nasconderlo.
//
// Nessuna rete, nessun venue, nessun capitale: piazzamento, cancellazione, kill switch e limiti sono
// tutti iniettati.

const { runBulkAllocation } = require('./bulk-allocate');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const M1 = '0x' + 'a1'.repeat(32);
const M2 = '0x' + 'b2'.repeat(32);

/** Le due gambe di un mercato, come le emette plan-to-orders. */
const coppia = (marketId, prezzoYes, prezzoNo, size) => ([
  { marketId, title: 'M', book: 'yes', side: 'BUY', price: prezzoYes, size, coppia: marketId, gamba: 'yes' },
  { marketId, title: 'M', book: 'no', side: 'BUY', price: prezzoNo, size, coppia: marketId, gamba: 'no' },
]);

/**
 * Il mondo finto. `esiti` decide cosa risponde il piazzamento, nell'ordine delle chiamate.
 */
function mondo(opts = {}) {
  const fatti = { piazzati: [], cancellati: [], audit: [] };
  let n = 0;
  const deps = {
    now: () => 1_700_000_000_000,
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    engine: {},
    // `effectiveOrderCapUsd` e' il tetto PER ORDINE, ed e' entrato in questa fixture il 12 agosto 2026
    // insieme al precontrollo della coppia: `resolveCaps` lo ha sempre restituito, ma finche' nessuno
    // in questo file lo leggeva la fixture poteva ometterlo. Ora lo legge il precontrollo, e un caps
    // senza quel campo vale `cap-missing` — che e' il comportamento GIUSTO (limite assente ≠
    // illimitato) e lo stesso che `placeManualOrder` avrebbe dato una riga dopo. Il difetto sarebbe
    // stato ometterlo e far passare tutto.
    resolveCaps: () => ({ readable: true,
      maxOpenNotionalUsd: opts.ceiling != null ? opts.ceiling : 10_000,
      maxOrderNotionalUsd: opts.orderCap != null ? opts.orderCap : 10_000,
      liveMinCapUsd: opts.orderCap != null ? opts.orderCap : 10_000,
      effectiveOrderCapUsd: opts.orderCap != null ? opts.orderCap : 10_000,
      maxOrdersPerWindow: opts.rateCap != null ? opts.rateCap : 1000 }),
    ordersInWindow: opts.ordersInWindow || 0,
    openNotionalUsd: opts.openNotionalUsd || 0,
    audit: (r) => fatti.audit.push(r),
    placeOrder: async (spec) => {
      fatti.piazzati.push(spec);
      const esito = (opts.esiti || [])[n++];
      if (esito === undefined || esito === true) return { ok: true, sent: true, orderId: `ord-${n}` };
      if (esito === 'throw') throw new Error('rete giu');
      return { ok: false, reason: typeof esito === 'string' ? esito : 'rifiutato', gate: 'test' };
    },
    cancelOrder: opts.cancelOrder || (async ({ orderId, marketId }) => {
      fatti.cancellati.push({ orderId, marketId });
      return opts.cancelFallisce ? { ok: false, reason: 'venue muto' } : { ok: true, cancelled: true };
    }),
  };
  if (opts.senzaCancel) delete deps.cancelOrder;
  return { deps, fatti };
}

(async () => {

  console.log('\n══ DUE GAMBE CHE VANNO BENE SONO DUE ORDINI');
  {
    const m = mondo();
    const r = await runBulkAllocation({ rows: coppia(M1, 0.49, 0.49, 100) }, m.deps);
    ok('il referto e ok', r.ok === true, r.reason || '');
    ok('  due ordini inviati', m.fatti.piazzati.length === 2);
    ok('  uno per libro', m.fatti.piazzati[0].book === 'yes' && m.fatti.piazzati[1].book === 'no');
    ok('  entrambi BUY', m.fatti.piazzati.every((x) => x.side === 'BUY'));
    ok('  placed = 2, refused = 0', r.placed === 2 && r.refused === 0);
    ok('  e il conteggio dei MERCATI dice 1, non 2', r.totals.mercati === 1 && r.totals.mercatiCompleti === 1, JSON.stringify(r.totals));
    ok('  nessuna cancellazione di ripristino', m.fatti.cancellati.length === 0);
  }

  console.log('\n══ SE LA SECONDA GAMBA FALLISCE, LA PRIMA VIENE RITIRATA');
  {
    const m = mondo({ esiti: [true, 'mercato chiuso'] });
    const r = await runBulkAllocation({ rows: coppia(M1, 0.49, 0.49, 100) }, m.deps);
    ok('la prima gamba e stata cancellata', m.fatti.cancellati.length === 1 && m.fatti.cancellati[0].orderId === 'ord-1',
      JSON.stringify(m.fatti.cancellati));
    ok('  ed e riportata come «rolled-back», non come «placed»',
      r.rolledBack === 1 && r.placed === 0, JSON.stringify({ placed: r.placed, rolledBack: r.rolledBack }));
    ok('  il referto NON e ok', r.ok === false);
    ok('  nessuna gamba orfana', r.orphan === 0);
    ok('  il capitale piazzato torna a zero', r.totals.placedUsd === 0, String(r.totals.placedUsd));
    const rec = r.results.find((x) => x.status === 'rolled-back');
    ok('  e il motivo nomina il rifiuto dell altra gamba', /mercato chiuso/.test(rec.rollbackReason), rec.rollbackReason);
  }

  console.log('\n══ SE LA PRIMA GAMBA FALLISCE, LA SECONDA NON SI TENTA NEMMENO');
  {
    const m = mondo({ esiti: ['rifiutato dal gate'] });
    const r = await runBulkAllocation({ rows: coppia(M1, 0.49, 0.49, 100) }, m.deps);
    ok('un solo tentativo di piazzamento', m.fatti.piazzati.length === 1, String(m.fatti.piazzati.length));
    ok('  la seconda gamba e rifiutata senza toccare il venue', r.refused === 1);
    ok('  e non c e niente da cancellare', m.fatti.cancellati.length === 0);
  }

  console.log('\n══ SE IL RIPRISTINO FALLISCE, LA SEQUENZA SI FERMA E LO DICE');
  {
    const m = mondo({ esiti: [true, 'rifiutato', true, true], cancelFallisce: true });
    const r = await runBulkAllocation({ rows: [...coppia(M1, 0.49, 0.49, 100), ...coppia(M2, 0.30, 0.68, 50)] }, m.deps);
    ok('il referto si ferma su «gamba-orfana»', r.stoppedBy === 'gamba-orfana', String(r.stoppedBy));
    ok('  la gamba rimasta e contata come orfana', r.orphan === 1, JSON.stringify({ orphan: r.orphan }));
    ok('  il referto NON e ok', r.ok === false);
    ok('  il motivo nomina l ordine da guardare a mano', /ord-1/.test(r.reason), r.reason.slice(0, 120));
    ok('  e il SECONDO mercato non viene piazzato sopra l esposizione asimmetrica',
      m.fatti.piazzati.length === 2, `${m.fatti.piazzati.length} tentativi`);
    ok('  le sue righe sono saltate con il motivo giusto',
      r.results.filter((x) => x.marketId === M2).every((x) => x.status === 'skipped' && /orfana/.test(x.reason)));
  }

  console.log('\n══ SENZA UNA FUNZIONE DI CANCELLAZIONE, L ORFANA E DICHIARATA (mai taciuta)');
  {
    const m = mondo({ esiti: [true, 'rifiutato'], senzaCancel: true });
    const r = await runBulkAllocation({ rows: coppia(M1, 0.49, 0.49, 100) }, m.deps);
    ok('la gamba resta orfana e il referto lo dice', r.orphan === 1 && r.stoppedBy === 'gamba-orfana');
    const rec = r.results.find((x) => x.status === 'orphan');
    ok('  con il motivo vero: nessuna cancellazione iniettata',
      /nessuna funzione di cancellazione/.test(rec.rollbackReason), rec.rollbackReason);
  }

  console.log('\n══ IL CAP CUMULATIVO SI VALUTA SULLA COPPIA, NON SULLA SINGOLA GAMBA');
  {
    // Coppia da $98 ($49 + $49) con un tetto di $60: una gamba sola ci starebbe, la coppia no.
    // Prima della revisione sarebbe entrata la prima gamba e poi la sequenza si sarebbe fermata,
    // lasciando esattamente il lato solo che tutto questo file esiste per impedire.
    const m = mondo({ ceiling: 60 });
    const r = await runBulkAllocation({ rows: coppia(M1, 0.49, 0.49, 100) }, m.deps);
    ok('nessuna gamba viene inviata', m.fatti.piazzati.length === 0, String(m.fatti.piazzati.length));
    ok('  la sequenza si ferma sul cap', r.stoppedBy === 'cap-cumulativo');
    ok('  ed entrambe le righe sono saltate, non una', r.skipped === 2, String(r.skipped));
    ok('  il motivo parla della COPPIA, non della riga', /questa coppia/.test(r.results[0].reason), r.results[0].reason.slice(0, 90));
  }

  console.log('\n══ IL CAP CONTA ENTRAMBE LE GAMBE NEL TOTALE CORRENTE');
  {
    // Due coppie da $98: con un tetto di $150 ci sta solo la prima.
    const m = mondo({ ceiling: 150 });
    const r = await runBulkAllocation({ rows: [...coppia(M1, 0.49, 0.49, 100), ...coppia(M2, 0.49, 0.49, 100)] }, m.deps);
    ok('la prima coppia entra intera', r.placed === 2, String(r.placed));
    ok('  la seconda e saltata intera', r.skipped === 2 && r.stoppedBy === 'cap-cumulativo');
    ok('  nessun mercato resta a meta', r.totals.mercatiCompleti === 1, JSON.stringify(r.totals));
  }

  console.log('\n══ LA QUOTA DI APERTURA NON PUO SPEZZARE UNA COPPIA A META');
  {
    // ⚠ DAL 12 AGOSTO 2026 LE APERTURE NON HANNO TUTTA LA FINESTRA: ne hanno il 60%, e il 40% resta
    // riservato ai rinnovi e alle chiusure protettive. La fixture DERIVA il posto rimasto invece di
    // ricopiare un numero, cosi' resta valida se la quota si sposta. Un posto libero = mezza coppia.
    const CAP = 20, QUOTA = Math.floor(CAP * 0.60);
    const m = mondo({ rateCap: CAP, ordersInWindow: QUOTA - 1 });
    const r = await runBulkAllocation({ rows: coppia(M1, 0.49, 0.49, 100) }, m.deps);
    ok('nessuna gamba viene inviata', m.fatti.piazzati.length === 0, String(m.fatti.piazzati.length));
    ok('  la sequenza si ferma sulla quota di apertura', r.stoppedBy === 'quota-apertura', String(r.stoppedBy));
    ok('  ed entrambe le righe sono saltate', r.skipped === 2);
    ok('  il motivo dichiara la quota e i posti riservati ai rinnovi',
      /quota per le aperture/.test(r.reason) && /riservati ai rinnovi/.test(r.reason), r.reason.slice(0, 140));
    ok('  ed e un RINVIO, non un errore', /si riprende al giro successivo/.test(r.reason));
  }

  console.log('\n══ LA QUOTA LASCIA PASSARE LE COPPIE CHE CI STANNO');
  {
    // Si lasciano liberi ESATTAMENTE 4 posti dentro la quota: due coppie entrano, la terza no.
    const CAP = 20, QUOTA = Math.floor(CAP * 0.60);
    const m = mondo({ rateCap: CAP, ordersInWindow: QUOTA - 4 });
    const M3 = '0x' + 'c3'.repeat(32);
    const r = await runBulkAllocation({
      rows: [...coppia(M1, 0.49, 0.49, 100), ...coppia(M2, 0.49, 0.49, 100), ...coppia(M3, 0.49, 0.49, 100)],
    }, m.deps);
    ok('due coppie intere passano', r.placed === 4, String(r.placed));
    ok('  la terza e saltata intera', r.skipped === 2 && r.stoppedBy === 'quota-apertura', String(r.stoppedBy));
    ok('  e nessun mercato resta a meta', r.totals.mercatiCompleti === 2, JSON.stringify(r.totals));
  }

  console.log('\n══ ANCHE UN TENTATIVO RIFIUTATO CONSUMA LA FINESTRA');
  {
    // Il venue conta i tentativi, non i successi: se il conteggio ignorasse i rifiuti, una raffica di
    // rifiuti farebbe sforare il tetto vero.
    const m = mondo({ rateCap: 4, esiti: ['rifiutato', true, true] });
    const M3 = '0x' + 'c3'.repeat(32);
    const r = await runBulkAllocation({
      rows: [...coppia(M1, 0.49, 0.49, 100), ...coppia(M2, 0.49, 0.49, 100), ...coppia(M3, 0.49, 0.49, 100)],
    }, m.deps);
    ok('la prima coppia consuma il suo posto anche fallendo', m.fatti.piazzati.length <= 4, `${m.fatti.piazzati.length} tentativi con tetto 4`);
    ok('  e la sequenza si ferma prima di sforare', r.stoppedBy === 'rate-limit' || r.results.some((x) => x.status === 'skipped'), String(r.stoppedBy));
  }

  console.log('\n══ IL PERCORSO A UNA RIGA (pannello manuale) SI COMPORTA COME PRIMA');
  {
    // Righe SENZA `coppia`: ognuna e un gruppo di una, e un rifiuto non ferma la sequenza.
    const righe = [
      { marketId: M1, title: 'A', book: 'yes', price: 0.49, size: 100 },
      { marketId: M2, title: 'B', book: 'yes', price: 0.30, size: 50 },
    ];
    const m = mondo({ esiti: ['rifiutato', true] });
    const r = await runBulkAllocation({ rows: righe }, m.deps);
    ok('un rifiuto NON ferma la sequenza', m.fatti.piazzati.length === 2, String(m.fatti.piazzati.length));
    ok('  una rifiutata, una piazzata', r.refused === 1 && r.placed === 1);
    ok('  e nessun ripristino viene tentato su righe non accoppiate', m.fatti.cancellati.length === 0);
    ok('  side di difetto BUY come prima', m.fatti.piazzati[0].side === 'BUY');
  }

  console.log('\n══ L ANTEPRIMA NON INVIA NIENTE, NEMMENO CON LE COPPIE');
  {
    const m = mondo();
    const r = await runBulkAllocation({ rows: coppia(M1, 0.49, 0.49, 100), dryRunOnly: true }, m.deps);
    ok('nessun ordine inviato', m.fatti.piazzati.length === 0);
    ok('  entrambe le gambe compaiono nel referto', r.skipped === 2);
    ok('  e nessuna cancellazione', m.fatti.cancellati.length === 0);
  }

  console.log('\n══ IL KILL SWITCH FERMA TUTTO PRIMA DELLE COPPIE');
  {
    const m = mondo();
    m.deps.killStatus = () => ({ effectivelyKilled: true, readable: true });
    const r = await runBulkAllocation({ rows: coppia(M1, 0.49, 0.49, 100) }, m.deps);
    ok('nessun ordine inviato', m.fatti.piazzati.length === 0 && r.stoppedBy === 'kill');
    ok('  entrambe le gambe saltate', r.skipped === 2);
  }

  console.log('\n══ UNA GAMBA CON PREZZO NON VALIDO INVALIDA LA COPPIA');
  {
    const m = mondo();
    const righe = coppia(M1, 0.49, 0.49, 100);
    righe[1].price = NaN;
    const r = await runBulkAllocation({ rows: righe }, m.deps);
    ok('nessuna delle due gambe viene inviata', m.fatti.piazzati.length === 0, String(m.fatti.piazzati.length));
    ok('  entrambe rifiutate', r.refused === 2, String(r.refused));
    ok('  e il motivo dice che e per via dell altra gamba',
      /nessuna delle due gambe/.test(r.results[0].reason), r.results[0].reason);
  }

  console.log('\n══ UN PIAZZAMENTO CHE ESPLODE E TRATTATO COME UN RIFIUTO, NON COME UN SUCCESSO');
  {
    const m = mondo({ esiti: [true, 'throw'] });
    const r = await runBulkAllocation({ rows: coppia(M1, 0.49, 0.49, 100) }, m.deps);
    ok('la prima gamba viene ritirata', r.rolledBack === 1 && m.fatti.cancellati.length === 1);
    ok('  e l eccezione finisce nel motivo', /rete giu/.test(r.results[1].reason), r.results[1].reason);
  }

  console.log(`\nallocazione in blocco: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();
