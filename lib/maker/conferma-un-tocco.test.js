#!/usr/bin/env node
'use strict';
// LA CONFERMA A UN TOCCO — L'ORCHESTRAZIONE DELLE DUE GAMBE, A SECCO.
//
// ═══ COSA VERIFICA ═══════════════════════════════════════════════════════════════════════════════════
// La rotta /api/maker/manual/place-market non inventa un piazzamento: chiama `runBulkAllocation` con le
// DUE righe di un mercato. Quindi la proprietà da dimostrare non è «la rotta funziona», è:
//
//   1. le due gambe partono NELL'ORDINE in cui sono arrivate, e non se ne salta nessuna;
//   2. se la SECONDA viene rifiutata, la PRIMA — già sul libro — viene CANCELLATA, e il referto la
//      chiama `rolled-back`, non «piazzata» e non «rifiutata»;
//   3. se quella cancellazione di ripristino FALLISCE, la gamba diventa `orphan`, il referto la nomina
//      per orderId e la sequenza si ferma: è l'unico caso in cui resta esposizione asimmetrica vera;
//   4. se la PRIMA viene rifiutata, la seconda non parte affatto — non c'è niente da accompagnare;
//   5. `inCoda` arriva fino a chi piazza. È la richiesta di non finire primi sul libro, e una riga che
//      la porta non deve poter essere inoltrata come se non l'avesse chiesta.
//
// ═══ PERCHÉ QUI E NON SULLA ROTTA ════════════════════════════════════════════════════════════════════
// Perché la rotta è il collante (validazione, verifica al venue, le tre scritture di preparazione) e
// l'ORCHESTRAZIONE è tutta in runBulkAllocation, che accetta dipendenze iniettabili. Provarla qui
// significa provarla senza rete, senza chiavi e senza toccare un venue — e senza che questo file possa
// mai, per costruzione, inviare un ordine: `place` è una funzione di questo test.

const { runBulkAllocation } = require('./bulk-allocate');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const MID = '0x' + 'ab'.repeat(32);
/** Le due gambe come le produce lib/rewards/plan-to-orders.gambeDiUnaRiga. */
const gambe = () => ([
  { marketId: MID, book: 'yes', side: 'BUY', price: 0.48, size: 100, coppia: MID, gamba: 'yes', inCoda: true },
  { marketId: MID, book: 'no', side: 'BUY', price: 0.50, size: 100, coppia: MID, gamba: 'no', inCoda: true },
]);

/** Dipendenze che rendono il percorso deterministico e incapace di uscire da questo processo. */
const deps = (over = {}) => ({
  now: () => 1_754_000_000_000,
  killStatus: () => ({ effectivelyKilled: false, readable: true }),
  resolveCaps: () => ({ readable: true, maxOpenNotionalUsd: 100_000, maxOrdersPerWindow: 20,
    // `effectiveOrderCapUsd` entra qui il 12 agosto 2026 col precontrollo della coppia: la fixture lo
    // ometteva perche' nessuno lo leggeva, e un caps senza tetto per ordine vale `cap-missing` — che e'
    // il comportamento giusto (limite assente != illimitato) e lo stesso che il gate vero avrebbe dato.
    maxOrderNotionalUsd: 100_000, liveMinCapUsd: 100_000, effectiveOrderCapUsd: 100_000 }),
  engine: { placement: 'dry-run' },
  audit: () => {},
  openNotionalUsd: 0,
  ordersInWindow: 0,
  ...over,
});

// NOTA: il referto di runBulkAllocation descrive una riga con `book`, non con `gamba` — `rowRef` non
// ricopia l'appartenenza alla coppia. Le ricerche qui sotto usano quindi `book`, che è il campo che
// esiste davvero; cercare per `gamba` restituirebbe undefined e ogni assert passerebbe per il motivo
// sbagliato (o fallirebbe senza dire perché).
const esitiDi = (rep) => rep.results.map((r) => `${r.book}:${r.status}`);

async function main() {
  console.log('\n══ IL CASO NORMALE: DUE GAMBE, NELL\'ORDINE, ENTRAMBE SUL LIBRO');
  {
    const visti = [];
    const r = await runBulkAllocation({ rows: gambe() }, deps({
      placeOrder: async (spec) => { visti.push(spec); return { ok: true, sent: true, orderId: `ord-${spec.book}` }; },
    }));
    ok('entrambe piazzate', r.placed === 2 && r.refused === 0, esitiDi(r).join(' '));
    ok('  nell\'ordine YES poi NO', visti.map((v) => v.book).join(',') === 'yes,no', visti.map((v) => v.book).join(','));
    ok('  e nessuna gamba orfana', (r.orphan || 0) === 0 && (r.rolledBack || 0) === 0);
    ok('  `inCoda` è arrivato fino a chi piazza', visti.every((v) => v.inCoda === true),
      JSON.stringify(visti.map((v) => v.inCoda)));
    ok('  il referto dichiara UN mercato completo', r.totals.mercatiCompleti === 1 && r.totals.mercati === 1);
    ok('  ok è vero', r.ok === true);
  }

  console.log('\n══ LA SECONDA GAMBA È RIFIUTATA: LA PRIMA VIENE RITIRATA');
  {
    const cancellate = [];
    const r = await runBulkAllocation({ rows: gambe() }, deps({
      placeOrder: async (spec) => (spec.book === 'yes'
        ? { ok: true, sent: true, orderId: 'ord-yes' }
        : { ok: false, reason: 'venue-rules: prezzo fuori griglia' }),
      cancelOrder: async ({ orderId }) => { cancellate.push(orderId); return { ok: true }; },
    }));
    const yes = r.results.find((x) => x.book === 'yes');
    const no = r.results.find((x) => x.book === 'no');
    ok('la gamba YES NON resta «piazzata»', yes && yes.status === 'rolled-back', yes && yes.status);
    ok('  ed è stata davvero cancellata', cancellate.length === 1 && cancellate[0] === 'ord-yes', cancellate.join(','));
    ok('la gamba NO è «refused» col motivo vero', no && no.status === 'refused' && /fuori griglia/.test(no.reason), no && no.reason);
    ok('nessuna esposizione residua dichiarata', (r.orphan || 0) === 0 && r.rolledBack === 1);
    ok('  e il conteggio dei piazzati è ZERO, non uno', r.placed === 0, String(r.placed));
    ok('  il referto NON dice ok', r.ok === false);
    ok('  e il motivo del ritiro è scritto sulla gamba', yes && /è stata rifiutata/.test(yes.rollbackReason || ''), yes && yes.rollbackReason);
    ok('nessun mercato completo', r.totals.mercatiCompleti === 0);
  }

  console.log('\n══ IL RITIRO FALLISCE: LA GAMBA È ORFANA, E SI DICE');
  {
    const r = await runBulkAllocation({ rows: gambe() }, deps({
      placeOrder: async (spec) => (spec.book === 'yes'
        ? { ok: true, sent: true, orderId: 'ord-yes' }
        : { ok: false, reason: 'rifiutata dal cap per ordine' }),
      cancelOrder: async () => ({ ok: false, reason: 'venue irraggiungibile' }),
    }));
    const yes = r.results.find((x) => x.book === 'yes');
    ok('la gamba YES è «orphan»', yes && yes.status === 'orphan', yes && yes.status);
    ok('  e il referto la conta', r.orphan === 1);
    ok('  con l\'orderId da guardare a mano', yes && yes.orderId === 'ord-yes');
    ok('  e dice che il ripristino è FALLITO', yes && /FALLITA/.test(yes.rollbackReason || ''), yes && yes.rollbackReason);
    ok('la sequenza si ferma', r.stoppedBy === 'gamba-orfana', String(r.stoppedBy));
    ok('  e ok è falso', r.ok === false);
  }

  console.log('\n══ LA PRIMA GAMBA È RIFIUTATA: LA SECONDA NON PARTE');
  {
    const visti = [];
    const r = await runBulkAllocation({ rows: gambe() }, deps({
      placeOrder: async (spec) => { visti.push(spec.book); return { ok: false, reason: 'manual-mode-inactive' }; },
    }));
    ok('si è tentata SOLO la prima gamba', visti.length === 1 && visti[0] === 'yes', visti.join(','));
    ok('  niente è finito sul libro', r.placed === 0 && (r.orphan || 0) === 0);
    ok('  e il motivo è quello del venue', /manual-mode-inactive/.test(JSON.stringify(r.results)));
  }

  console.log('\n══ L\'ANTEPRIMA NON PIAZZA NIENTE');
  {
    let chiamate = 0;
    const r = await runBulkAllocation({ rows: gambe(), dryRunOnly: true }, deps({
      placeOrder: async () => { chiamate += 1; return { ok: true, sent: true, orderId: 'x' }; },
    }));
    ok('nessuna chiamata a chi piazza', chiamate === 0, String(chiamate));
    ok('  entrambe le righe risultano saltate', r.results.length === 2 && r.results.every((x) => x.status === 'skipped'));
    ok('  e il motivo lo dice', r.results.every((x) => /anteprima/.test(x.reason)));
  }

  console.log('\n══ IL KILL SWITCH FERMA TUTTO, E UNO STATO NON LEGGIBILE VALE ATTIVO');
  {
    let chiamate = 0;
    const attivo = await runBulkAllocation({ rows: gambe() }, deps({
      killStatus: () => ({ effectivelyKilled: true, readable: true }),
      placeOrder: async () => { chiamate += 1; return { ok: true }; },
    }));
    ok('kill attivo ⇒ niente parte', chiamate === 0 && attivo.stoppedBy === 'kill');

    const illeggibile = await runBulkAllocation({ rows: gambe() }, deps({
      killStatus: () => ({ effectivelyKilled: false, readable: false }),
      placeOrder: async () => { chiamate += 1; return { ok: true }; },
    }));
    ok('kill NON leggibile ⇒ trattato come attivo', chiamate === 0 && illeggibile.stoppedBy === 'kill',
      illeggibile.reason);
  }

  console.log('\n══ IL CAP CUMULATIVO SI VALUTA SULLA COPPIA INTERA');
  {
    let chiamate = 0;
    // La coppia vale 0,48·100 + 0,50·100 = $98. Con un tetto di $150 e $80 già aperti, la coppia INTERA
    // non ci sta — e non deve entrarci nemmeno mezza.
    const r = await runBulkAllocation({ rows: gambe() }, deps({
      resolveCaps: () => ({ readable: true, maxOpenNotionalUsd: 150, maxOrdersPerWindow: 20,
        maxOrderNotionalUsd: 100_000, liveMinCapUsd: 100_000, effectiveOrderCapUsd: 100_000 }),
      openNotionalUsd: 80,
      placeOrder: async () => { chiamate += 1; return { ok: true, sent: true, orderId: 'x' }; },
    }));
    ok('non parte NESSUNA delle due gambe', chiamate === 0, String(chiamate));
    ok('  e la sequenza si ferma sul cap', r.stoppedBy === 'cap-cumulativo', String(r.stoppedBy));
    ok('  entrambe le righe sono saltate, non una sola', r.results.filter((x) => x.status === 'skipped').length === 2);
  }

  console.log(`\nconferma a un tocco: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
}

main();
