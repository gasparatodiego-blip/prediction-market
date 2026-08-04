#!/usr/bin/env node
'use strict';
// LA VERIFICA AL VENUE DEI MERCATI CHE STANNO PER RICEVERE ORDINI.
//
// Nasce da un fatto tracciato il 4 agosto 2026 sul flusso «Ottimizza» manuale: dei cinque mercati che il
// piano aveva scelto, DUE avevano il montepremi crollato sul venue mentre il board locale raccontava
// ancora quello vecchio ($114/g contro $11/g, e $5/g contro $2/g). Erano aperti, negoziabili e con la
// loro banda: invisibili a qualunque controllo che chieda solo «esiste ancora?».

const { verificaMercatiAlVenue, filtraRighe } = require('./verifica-mercati-venue');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const A = '0x' + 'a1'.repeat(32);
const B = '0x' + 'b2'.repeat(32);
const ORA = Date.parse('2026-08-04T12:00:00Z');

const sano = (over = {}) => ({
  readable: true, closed: false, active: true, acceptingOrders: true,
  rewardsDailyRate: 100, maxSpreadCents: 4, minSizeShares: 20,
  endDate: new Date(ORA + 60 * 86_400_000).toISOString(), ...over,
});
const coppia = (marketId) => ([
  { marketId, book: 'yes', side: 'BUY', price: 0.49, size: 100, coppia: marketId, gamba: 'yes' },
  { marketId, book: 'no', side: 'BUY', price: 0.49, size: 100, coppia: marketId, gamba: 'no' },
]);

(async () => {

  console.log('\n══ UN MERCATO PER OGNI CONDITION ID, NON UNA DOMANDA PER GAMBA');
  {
    const chiesti = [];
    await verificaMercatiAlVenue({ rows: [...coppia(A), ...coppia(B)], nowMs: ORA },
      { readVenue: async ({ marketId }) => { chiesti.push(marketId); return sano(); } });
    ok('due mercati, due domande al venue (non quattro)', chiesti.length === 2, String(chiesti.length));
  }

  console.log('\n══ IL MONTEPREMI DEL VENUE SMENTISCE IL BOARD ⇒ BOCCIATO');
  {
    const r = await verificaMercatiAlVenue(
      { rows: coppia(A), poolAlPiano: { [A]: 114 }, nowMs: ORA },
      { readVenue: async () => sano({ rewardsDailyRate: 11 }) },
    );
    ok('il mercato e bocciato', r.bocciati.length === 1 && r.bocciati[0].stato === 'premio-crollato', JSON.stringify(r.bocciati));
    ok('  e il motivo porta i due numeri', /114/.test(r.bocciati[0].motivo) && /11/.test(r.bocciati[0].motivo), r.bocciati[0].motivo);
    ok('  senza riferimento del piano il controllo NON si applica', (await verificaMercatiAlVenue(
      { rows: coppia(A), poolAlPiano: {}, nowMs: ORA }, { readVenue: async () => sano({ rewardsDailyRate: 11 }) },
    )).bocciati.length === 0);
  }

  console.log('\n══ UN MERCATO BOCCIATO PERDE ENTRAMBE LE GAMBE');
  {
    const righe = [...coppia(A), ...coppia(B)];
    const r = await verificaMercatiAlVenue({ rows: righe, nowMs: ORA },
      { readVenue: async ({ marketId }) => (marketId === A ? sano({ closed: true }) : sano()) });
    const rimaste = filtraRighe(righe, r.bocciati);
    ok('restano solo le due gambe del mercato sano', rimaste.length === 2 && rimaste.every((x) => x.marketId === B), String(rimaste.length));
    ok('  mai mezza coppia', rimaste.filter((x) => x.gamba === 'yes').length === rimaste.filter((x) => x.gamba === 'no').length);
  }

  console.log('\n══ ILLEGGIBILE NON E NE VALIDO NE INVALIDO');
  {
    const r = await verificaMercatiAlVenue({ rows: coppia(A), nowMs: ORA },
      { readVenue: async () => ({ readable: false, error: 'timeout' }) });
    ok('finisce fra gli illeggibili', r.illeggibili.length === 1 && r.bocciati.length === 0 && r.validi.length === 0);
    ok('  e filtraRighe NON lo toglie (chi chiama decide, questo modulo misura)',
      filtraRighe(coppia(A), r.bocciati).length === 2);
  }

  console.log('\n══ SENZA LETTORE INIETTATO NON SI INVENTA UNA LETTURA');
  {
    const r = await verificaMercatiAlVenue({ rows: coppia(A), nowMs: ORA }, {});
    ok('tutto illeggibile, mai «valido per difetto»', r.illeggibili.length === 1 && r.validi.length === 0);
  }

  console.log('\n══ UN LETTORE CHE ESPLODE E ILLEGGIBILE, NON UN CRASH');
  {
    const r = await verificaMercatiAlVenue({ rows: coppia(A), nowMs: ORA },
      { readVenue: async () => { throw new Error('rete giu'); } });
    ok('eccezione ⇒ illeggibile con il motivo', r.illeggibili.length === 1 && /rete giu/.test(r.illeggibili[0].motivo));
  }

  console.log('\n══ RIGHE VUOTE: ZERO DOMANDE, ZERO VERDETTI');
  {
    const r = await verificaMercatiAlVenue({ rows: [], nowMs: ORA }, { readVenue: async () => sano() });
    ok('nessun verdetto e nessun errore', r.verdetti.length === 0 && r.validi.length === 0);
  }

  console.log(`\nverifica al venue: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();
