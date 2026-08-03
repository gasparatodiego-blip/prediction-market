#!/usr/bin/env node
'use strict';
// «ESEGUI ALLOCAZIONE» È UN RESET, NON UNA SOMMA.
//
// Lo scenario centrale è quello osservato in produzione: mercati abilitati in sessioni passate — con
// ordini veri ancora a riposo — che restavano nella allowlist perché il registro è additivo. Qui si
// verifica che dopo il tap lo stato finale sia ESATTAMENTE il piano nuovo, e niente altro.
//
// Nessuna rete, nessun venue, nessun ordine reale: ogni effetto collaterale è iniettato e «cancellare»
// significa chiamare una funzione finta che registra.

const { runAllocationReset } = require('./allocation-reset');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const VECCHIO_A = '0x' + 'aa'.repeat(32);   // Cori Bush — scade fra un giorno, non è nel piano nuovo
const VECCHIO_B = '0x' + 'bb'.repeat(32);   // finestra BTC chiusa, non è nel piano nuovo
const NUOVO_1 = '0x' + 'c1'.repeat(32);
const NUOVO_2 = '0x' + 'c2'.repeat(32);
const COMUNE = '0x' + 'dd'.repeat(32);      // era abilitato E resta nel piano nuovo

/**
 * Il mondo finto: due registri, un venue con ordini a riposo, e il conto di tutto ciò che viene fatto.
 */
function mondo(opts = {}) {
  const stato = {
    abilitati: opts.abilitati ? [...opts.abilitati] : [VECCHIO_A, VECCHIO_B, COMUNE],
    tracking: opts.tracking ? [...opts.tracking] : [VECCHIO_A, COMUNE],
    // ordini VERI a riposo sul venue, per mercato
    libro: opts.libro || {
      [VECCHIO_A]: [{ orderId: 'oldA1', price: 0.42, size: 100 }, { orderId: 'oldA2', price: 0.58, size: 100 }],
      [VECCHIO_B]: [{ orderId: 'oldB1', price: 0.10, size: 250 }],
      [COMUNE]: [{ orderId: 'oldC1', price: 0.49, size: 80 }],
    },
  };
  const fatti = { cancellati: [], trackingOff: [], disabilitati: [], abilitati: [], manual: [], piazzati: [], audit: [] };
  const cancelFallisce = opts.cancelFallisce || null;
  const listFallisce = opts.listFallisce || null;
  const enableFallisce = opts.enableFallisce || null;

  const deps = {
    now: (() => { let t = 1_800_000_000_000; return () => (t += 10); })(),
    readEnabled: () => [...stato.abilitati],
    readTracking: () => [...stato.tracking],
    listOrders: async ({ marketId }) => {
      if (listFallisce && listFallisce === marketId) return { ok: false, error: 'venue irraggiungibile (finto)' };
      return { ok: true, simulated: false, orders: (stato.libro[marketId] || []).map((o) => ({ ...o })) };
    },
    cancelOrder: async ({ orderId, marketId }) => {
      if (cancelFallisce && cancelFallisce === orderId) return { ok: false, reason: 'cancellazione rifiutata (finto)' };
      fatti.cancellati.push({ marketId, orderId });
      stato.libro[marketId] = (stato.libro[marketId] || []).filter((o) => o.orderId !== orderId);
      return { ok: true };
    },
    setTrackingOff: async ({ marketId }) => {
      fatti.trackingOff.push(marketId);
      stato.tracking = stato.tracking.filter((m) => m !== marketId);
      return { ok: true };
    },
    setEnabled: async ({ marketId, enabled }) => {
      if (enableFallisce && enableFallisce === marketId && enabled === true) return { ok: false, error: 'scrittura rifiutata (finto)' };
      if (enabled) { fatti.abilitati.push(marketId); if (!stato.abilitati.includes(marketId)) stato.abilitati.push(marketId); }
      else { fatti.disabilitati.push(marketId); stato.abilitati = stato.abilitati.filter((m) => m !== marketId); }
      return { ok: true };
    },
    setManual: async ({ marketId }) => { fatti.manual.push(marketId); return { ok: true }; },
    placeBulk: async ({ rows, dryRunOnly }) => {
      if (!dryRunOnly) for (const r of rows) fatti.piazzati.push({ marketId: r.marketId, book: r.book, price: r.price, size: r.size });
      return {
        ok: true, placed: dryRunOnly ? 0 : rows.length, refused: 0, skipped: dryRunOnly ? rows.length : 0,
        results: rows.map((r) => ({ marketId: r.marketId, book: r.book, status: dryRunOnly ? 'skipped' : 'placed' })),
        totals: { rows: rows.length },
      };
    },
    audit: (rec) => fatti.audit.push(rec),
  };
  return { stato, fatti, deps };
}

const PIANO = [
  { marketId: NUOVO_1, book: 'yes', price: 0.494, size: 200 },
  { marketId: NUOVO_1, book: 'no', price: 0.494, size: 200 },
  { marketId: COMUNE, book: 'yes', price: 0.48, size: 150 },
  { marketId: COMUNE, book: 'no', price: 0.50, size: 150 },
];

(async () => {
  // ═════════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n══ LO SCENARIO · mercati vecchi con ordini veri, piano nuovo diverso');
  // ═════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const m = mondo();
    const r = await runAllocationReset({ rows: PIANO }, m.deps);
    ok('la sequenza arriva in fondo', r.ok === true && r.stoppedBy === null, r.reason || '');

    console.log('\n── 1 · I VECCHI ORDINI SONO CANCELLATI, tutti');
    ok('quattro ordini a riposo, quattro cancellati', m.fatti.cancellati.length === 4, `${m.fatti.cancellati.length}`);
    for (const id of ['oldA1', 'oldA2', 'oldB1', 'oldC1']) {
      ok(`  ${id} cancellato`, m.fatti.cancellati.some((c) => c.orderId === id));
    }
    ok('  e il libro è rimasto vuoto sui mercati vecchi',
      Object.values(m.stato.libro).every((v) => v.length === 0), JSON.stringify(Object.entries(m.stato.libro).map(([k, v]) => v.length)));
    ok('  anche su un mercato che RESTA nel piano', m.fatti.cancellati.some((c) => c.orderId === 'oldC1'),
      'il reset è completo: non si conserva un ordine solo perché il mercato sopravvive');

    console.log('\n── 2 · I VECCHI MERCATI SONO SPENTI');
    ok('il tracking è stato spento su tutti quelli che ce l avevano', m.fatti.trackingOff.length === 2
      && m.fatti.trackingOff.includes(VECCHIO_A) && m.fatti.trackingOff.includes(COMUNE), m.fatti.trackingOff.length + '');
    ok('  e non resta nessun mercato in tracking', m.stato.tracking.length === 0);
    ok('i mercati abilitati FUORI dal piano sono disabilitati', m.fatti.disabilitati.length === 2
      && m.fatti.disabilitati.includes(VECCHIO_A) && m.fatti.disabilitati.includes(VECCHIO_B), m.fatti.disabilitati.join(','));
    ok('  Cori Bush (il caso del bug) NON è più abilitato', !m.stato.abilitati.includes(VECCHIO_A));
    ok('  la finestra BTC chiusa nemmeno', !m.stato.abilitati.includes(VECCHIO_B));
    ok('  ma quello che il piano CONTIENE non viene tolto e rimesso', !m.fatti.disabilitati.includes(COMUNE),
      'sarebbe lo stesso stato con due scritture e una finestra in mezzo');

    console.log('\n── 3 · I NUOVI MERCATI SONO ABILITATI, esattamente quelli');
    ok('abilitati i due mercati del piano', m.fatti.abilitati.length === 2
      && m.fatti.abilitati.includes(NUOVO_1) && m.fatti.abilitati.includes(COMUNE), m.fatti.abilitati.join(','));
    ok('  con la proprietà manuale, come fa il percorso a mano', m.fatti.manual.length === 2);
    ok('  lo stato finale è ESATTAMENTE il piano', JSON.stringify([...m.stato.abilitati].sort()) === JSON.stringify([NUOVO_1, COMUNE].sort()),
      m.stato.abilitati.map((x) => x.slice(0, 6)).join(','));
    ok('  nessun residuo di sessioni passate', !m.stato.abilitati.includes(VECCHIO_A) && !m.stato.abilitati.includes(VECCHIO_B));

    console.log('\n── 4 · I NUOVI ORDINI SONO PIAZZATI');
    ok('quattro righe del piano, quattro piazzamenti', m.fatti.piazzati.length === 4, `${m.fatti.piazzati.length}`);
    ok('  con le size esatte del piano', m.fatti.piazzati.every((p) => PIANO.some((x) => x.marketId === p.marketId && x.book === p.book && x.size === p.size)));
    ok('  e nessun ordine su mercati fuori dal piano',
      m.fatti.piazzati.every((p) => p.marketId === NUOVO_1 || p.marketId === COMUNE));
  }

  console.log('\n══ L ORDINE DELLE OPERAZIONI');
  {
    const m = mondo();
    await runAllocationReset({ rows: PIANO }, m.deps);
    const fasi = m.fatti.audit.map((a) => a.fase);
    const primo = (f) => fasi.indexOf(f);
    ok('inventario → cancellazione → spegnimento → accensione → piazzamento',
      primo('inventario') < primo('cancellazione')
      && primo('cancellazione') < primo('spegnimento')
      && primo('spegnimento') < primo('accensione')
      && primo('accensione') < primo('piazzamento'), fasi.join(' '));
    ok('  si CANCELLA prima di spegnere', primo('cancellazione') < primo('spegnimento'),
      'spegnere prima lascerebbe ordini veri su mercati che il sistema non governa piu');
    ok('  si ACCENDE prima di piazzare', primo('accensione') < primo('piazzamento'),
      'il piazzamento e soggetto all allowlist: prima deve esistere');
  }

  console.log('\n══ L ANTEPRIMA NON TOCCA NULLA');
  {
    const m = mondo();
    const r = await runAllocationReset({ rows: PIANO, dryRunOnly: true }, m.deps);
    ok('nessuna cancellazione', m.fatti.cancellati.length === 0);
    ok('nessuno spegnimento', m.fatti.trackingOff.length === 0 && m.fatti.disabilitati.length === 0);
    ok('nessuna accensione', m.fatti.abilitati.length === 0 && m.fatti.manual.length === 0);
    ok('nessun ordine piazzato', m.fatti.piazzati.length === 0);
    ok('  i registri sono intatti', m.stato.abilitati.length === 3 && m.stato.tracking.length === 2);
    ok('  e il libro è intatto', Object.values(m.stato.libro).reduce((s, v) => s + v.length, 0) === 4);

    console.log('\n── ma DICE cosa farebbe, che è il punto');
    ok('elenca i 4 ordini che cancellerebbe', r.cancellazione.daCancellare.length === 4, `${r.cancellazione.daCancellare.length}`);
    ok('  marcandolo come simulazione', r.cancellazione.simulata === true);
    ok('elenca i mercati che spegnerebbe', r.spegnimento.abilitati.length === 2 && r.spegnimento.tracking.length === 2);
    ok('elenca i mercati che accenderebbe', r.accensione.markets.length === 2);
    ok('  e il referto si dichiara anteprima', r.preview === true);
  }

  console.log('\n══ SE UNA CANCELLAZIONE FALLISCE, SI FERMA TUTTO');
  {
    const m = mondo({ cancelFallisce: 'oldB1' });
    const r = await runAllocationReset({ rows: PIANO }, m.deps);
    ok('la sequenza si ferma', r.ok === false && r.stoppedBy === 'cancel-failed', r.stoppedBy);
    ok('  NESSUN ordine viene piazzato', m.fatti.piazzati.length === 0,
      'piazzare sopra un ordine vecchio rimasto sarebbe esposizione oltre il piano');
    ok('  e nessun registro viene toccato', m.fatti.trackingOff.length === 0 && m.fatti.disabilitati.length === 0 && m.fatti.abilitati.length === 0);
    ok('  quindi lo stato resta quello di partenza', m.stato.abilitati.length === 3 && m.stato.tracking.length === 2,
      'il tentativo e ripetibile da capo, non da meta');
    ok('  il motivo dice che si puo ripremere', /ripremere il bottone riparte da capo/.test(r.reason), r.reason.slice(0, 80));
    ok('  e l ordine fallito e nominato', r.cancellazione.falliti.length === 1 && r.cancellazione.falliti[0].orderId === 'oldB1');
  }

  console.log('\n══ SE IL VENUE NON SI LEGGE, NON SI TOCCA NIENTE');
  {
    const m = mondo({ listFallisce: VECCHIO_B });
    const r = await runAllocationReset({ rows: PIANO }, m.deps);
    ok('la sequenza si ferma', r.ok === false && r.stoppedBy === 'list-failed', r.stoppedBy);
    ok('  nemmeno una cancellazione e partita', m.fatti.cancellati.length === 0,
      'non sapere cosa e a riposo non e la stessa cosa di non avere nulla a riposo');
    ok('  nessun registro toccato', m.fatti.disabilitati.length === 0 && m.fatti.abilitati.length === 0);
    ok('  nessun ordine piazzato', m.fatti.piazzati.length === 0);
    ok('  e il mercato illeggibile e nominato', r.lettureFallite.length === 1 && r.lettureFallite[0].marketId === VECCHIO_B);
  }

  console.log('\n══ SE UN MERCATO DEL PIANO NON SI ABILITA, NON SI PIAZZA');
  {
    const m = mondo({ enableFallisce: NUOVO_1 });
    const r = await runAllocationReset({ rows: PIANO }, m.deps);
    ok('la sequenza si ferma', r.ok === false && r.stoppedBy === 'enable-failed', r.stoppedBy);
    ok('  nessun ordine piazzato', m.fatti.piazzati.length === 0);
    ok('  ma il libro era gia stato liberato', m.fatti.cancellati.length === 4,
      'lo stato finale e pulito e vuoto, non a meta');
    ok('  e il motivo lo dice', /senza esposizione/.test(r.reason), r.reason.slice(-60));
  }

  console.log('\n══ L INVENTARIO COPRE TUTTE E TRE LE FONTI');
  {
    // Un mercato che ha ordini a riposo ma NON e ne abilitato ne in tracking: entra comunque, perche
    // e nel piano nuovo e potrebbe portarsi dietro ordini di una sessione precedente.
    const m = mondo({
      abilitati: [VECCHIO_A], tracking: [],
      libro: { [VECCHIO_A]: [{ orderId: 'x1', price: 0.3, size: 10 }], [NUOVO_2]: [{ orderId: 'x2', price: 0.7, size: 20 }] },
    });
    const r = await runAllocationReset({ rows: [{ marketId: NUOVO_2, book: 'yes', price: 0.5, size: 50 }] }, m.deps);
    ok('un mercato del PIANO con ordini vecchi viene ripulito', m.fatti.cancellati.some((c) => c.orderId === 'x2'));
    ok('  e quello abilitato pure', m.fatti.cancellati.some((c) => c.orderId === 'x1'));
    ok('  l inventario li elenca entrambi', r.inventario.gestiti.length === 2, r.inventario.gestiti.length + '');
  }

  console.log('\n══ NIENTE DA FARE È UNO STATO VALIDO, non un errore');
  {
    const m = mondo({ abilitati: [], tracking: [], libro: {} });
    const r = await runAllocationReset({ rows: [{ marketId: NUOVO_1, book: 'yes', price: 0.5, size: 50 }] }, m.deps);
    ok('partendo da zero la sequenza arriva in fondo', r.ok === true && r.stoppedBy === null);
    ok('  nessuna cancellazione', m.fatti.cancellati.length === 0);
    ok('  un mercato acceso e un ordine piazzato', m.fatti.abilitati.length === 1 && m.fatti.piazzati.length === 1);
  }

  console.log('\n══ OGNI PASSO È RICOSTRUIBILE DALL AUDIT');
  {
    const m = mondo();
    const r = await runAllocationReset({ rows: PIANO }, m.deps);
    ok('l audit persistente ha ricevuto ogni riga del log', m.fatti.audit.length === r.log.length, `${m.fatti.audit.length}`);
    ok('  ogni riga porta op:«allocation-reset»', m.fatti.audit.every((a) => a.op === 'allocation-reset'));
    ok('  ogni riga porta un istante', m.fatti.audit.every((a) => typeof a.at === 'string' && a.at.length > 10));
    const canc = m.fatti.audit.filter((a) => a.evento === 'cancellato');
    ok('ogni cancellazione e nominata con mercato, ordine, prezzo e size', canc.length === 4
      && canc.every((a) => a.marketId && a.orderId && a.price != null && a.size != null),
      JSON.stringify(canc[0] && { orderId: canc[0].orderId, price: canc[0].price, size: canc[0].size }));
    ok('l accensione di ogni mercato e a registro', m.fatti.audit.filter((a) => a.evento === 'abilitato').length === 2);
    ok('lo spegnimento pure', m.fatti.audit.filter((a) => a.evento === 'disabilitato').length === 2);
    ok('e il piazzamento chiude il registro con i suoi conti',
      m.fatti.audit.some((a) => a.fase === 'piazzamento' && a.piazzati === 4));
  }

  console.log(`\nreset dell allocazione: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();
