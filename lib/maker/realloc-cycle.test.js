#!/usr/bin/env node
'use strict';
// IL RIALLOCATORE PERIODICO, IN UN MONDO FINTO.
//
// Questo ciclo è l'unico processo autorizzato a cancellare e piazzare ordini VERI senza che nessuno
// confermi. Perciò i tre scenari che l'operatore ha chiesto — mercato risolto ⇒ reset, tutti validi ⇒
// niente, cancellazione fallita ⇒ stop pulito — non bastano da soli: quello che va provato con la stessa
// insistenza è tutto ciò che deve FERMARLO. Saldo illeggibile, allocatore in errore, universo vuoto,
// venue muto: in nessuno di quei casi un ordine deve partire, e in nessuno di quei casi si deve
// riprovare subito.
//
// Nessuna rete, nessun venue, nessun capitale: ogni effetto è iniettato. Lo scenario della cancellazione
// fallita usa il VERO lib/maker/allocation-reset.js, non un finto: il fermo che conta è il suo.

const { runReallocCycle, CONCENTRATION_CAP_FRAC } = require('./realloc-cycle');
const { runAllocationReset } = require('./allocation-reset');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ORA = Date.parse('2026-08-03T12:00:00Z');
const A = '0x' + 'aa'.repeat(32);   // in gestione, sano
const B = '0x' + 'bb'.repeat(32);   // in gestione, è lui che si guasta
const N1 = '0x' + 'c1'.repeat(32);  // mercato del piano nuovo
const N2 = '0x' + 'c2'.repeat(32);

const venueSano = (over = {}) => ({
  readable: true, closed: false, active: true, acceptingOrders: true,
  rewardsDailyRate: 100, maxSpreadCents: 4, minSizeShares: 20,
  endDate: new Date(ORA + 60 * 24 * 3_600_000).toISOString(), ...over,
});

/** Una riga di piano eseguibile, con i campi che planToOrders si aspetta. */
const rigaPiano = (marketId, capital = 200) => ({
  marketId, name: 'Mercato ' + marketId.slice(2, 6), capital,
  mid: 0.5, tick: 0.01, newestTsMs: ORA - 20_000,
  maxSpreadCents: 4, computedDefaultOffsetTicks: 1,
  sizePerSideShares: 100, grossInBandPerDay: 12, belowVenueMinSize: false,
  fillsByTick: [{ tick: 1, bid: 0.49, ask: 0.51 }],
});

const pianoSano = (capital = 1000) => ({
  capital,
  rows: [rigaPiano(N1), rigaPiano(N2)],
  candidates: [
    { marketId: N1, status: 'scelto', pot: 300 },
    { marketId: N2, status: 'scelto', pot: 150 },
    { marketId: A, status: 'scartato', pot: 40 },
  ],
  coverage: { coveredMarketCount: 120 },
  totals: { grossPerDay: 24, realisticPerDay: 9 },
  concentration: { maxPerMarketUsd: capital * CONCENTRATION_CAP_FRAC, capped: true },
});

/**
 * Il mondo finto. Ogni dipendenza è registrata: alla fine si può chiedere non solo «cos'è successo» ma
 * «cosa NON è successo», che in un processo che tocca capitale è la domanda più importante.
 */
function mondo(opts = {}) {
  const fatti = { venueLetti: [], resetChiamato: [], pianiChiesti: [], poolScritti: [], tettiScritti: [], log: [] };
  const venue = opts.venue || { [A]: venueSano(), [B]: venueSano() };
  const deps = {
    now: () => ORA,
    readEnabled: opts.readEnabled || (() => (opts.abilitati || [A, B])),
    readTracking: opts.readTracking || (() => (opts.tracking || [A])),
    readVenue: async ({ marketId }) => { fatti.venueLetti.push(marketId); return venue[marketId] ?? { readable: false, error: 'sconosciuto' }; },
    readPlanPools: () => (opts.poolAlPiano || {}),
    writePlanPools: (p) => { if (opts.poolScritturaFallisce) throw new Error('disco pieno'); fatti.poolScritti.push(p); },
    writeAllocatedCapital: (s) => { fatti.tettiScritti.push(s); },
    readBalance: opts.readBalance || (async () => ({ readable: true, usd: 1000 })),
    makePlan: opts.makePlan || (async (a) => { fatti.pianiChiesti.push(a); return pianoSano(a.capital); }),
    runReset: opts.runReset || (async (a) => { fatti.resetChiamato.push(a); return { ok: true, piazzamento: { placed: a.rows.length, refused: 0 }, cancellazione: { cancellati: [{}, {}] }, accensione: { markets: [N1, N2] } }; }),
    log: (r) => fatti.log.push(r),
  };
  return { deps, fatti };
}

(async () => {

  console.log('\n══ SCENARIO 1 · UN MERCATO SI RISOLVE DURANTE IL CICLO ⇒ IL RESET SCATTA');
  {
    const m = mondo({ venue: { [A]: venueSano(), [B]: venueSano({ closed: true }) } });
    const r = await runReallocCycle({}, m.deps);
    ok('l azione e il reset', r.azione === 'reset', r.azione + ' · ' + r.motivo);
    ok('  e il motivo nomina il mercato risolto', r.motivo.includes('risolto') && r.motivo.includes(B.slice(0, 10)));
    ok('il venue e stato interrogato su ENTRAMBI i mercati in gestione', m.fatti.venueLetti.length === 2);
    ok('il piano e stato chiesto al saldo reale, non a una costante', m.fatti.pianiChiesti[0].capital === 1000);
    ok(`  con il tetto di concentrazione al ${Math.round(CONCENTRATION_CAP_FRAC * 100)}%`, m.fatti.pianiChiesti[0].maxPerMarketUsd === 300, String(m.fatti.pianiChiesti[0].maxPerMarketUsd));
    ok('il reset ha ricevuto le righe eseguibili del piano', m.fatti.resetChiamato[0].rows.length === 2);
    ok('  al bid del tick di difetto e con la size del piano',
      m.fatti.resetChiamato[0].rows[0].price === 0.49 && m.fatti.resetChiamato[0].rows[0].size === 100);
    ok('il referto porta piano vecchio E piano nuovo',
      r.pianoVecchio.mercati.length === 2 && r.piano.mercati.length === 2);
    ok('  e il piano vecchio dice chi era invalido e perche',
      r.pianoVecchio.invalidi.length === 1 && r.pianoVecchio.invalidi[0].stato === 'risolto');
    ok('i montepremi del piano nuovo sono stati persistiti per il prossimo giro',
      m.fatti.poolScritti.length === 1 && m.fatti.poolScritti[0][N1] === 300 && m.fatti.poolScritti[0][N2] === 150);
    ok('  e solo quelli SCELTI', Object.keys(m.fatti.poolScritti[0]).length === 2);
    ok('anche il tetto di posizione e stato riscritto sul piano nuovo',
      m.fatti.tettiScritti.length === 1 && m.fatti.tettiScritti[0].rows.length === 2 && m.fatti.tettiScritti[0].capital === 1000);
    ok('ogni passo e finito nel registro persistente', m.fatti.log.length >= 6);
    ok('  e ogni riga del registro porta istante e fase', m.fatti.log.every((x) => x.at && x.fase));
  }

  console.log('\n══ SCENARIO 2 · TUTTI I MERCATI SONO ANCORA VALIDI ⇒ NESSUNA AZIONE');
  {
    const m = mondo();
    const r = await runReallocCycle({}, m.deps);
    ok('nessuna azione', r.azione === 'nessuna' && r.ok === true, r.motivo);
    ok('NESSUN piano e stato calcolato', m.fatti.pianiChiesti.length === 0);
    ok('NESSUN reset e stato chiamato', m.fatti.resetChiamato.length === 0);
    ok('NESSUN riferimento e stato riscritto', m.fatti.poolScritti.length === 0 && m.fatti.tettiScritti.length === 0);
    ok('e i verdetti restano nel referto, uno per mercato', r.verdetti.length === 2 && r.verdetti.every((v) => v.valido === true));
  }

  console.log('\n══ SCENARIO 3 · LA CANCELLAZIONE FALLISCE ⇒ FERMO PULITO (col VERO allocation-reset)');
  {
    const scritture = [];
    const m = mondo({
      venue: { [A]: venueSano(), [B]: venueSano({ closed: true }) },
      runReset: ({ rows, dryRunOnly }) => runAllocationReset({ rows, dryRunOnly }, {
        readEnabled: () => [A, B],
        readTracking: () => [A],
        listOrders: async ({ marketId }) => ({ ok: true, orders: [{ orderId: 'ord-' + marketId.slice(2, 6), price: 0.5, size: 10 }] }),
        // Il venue rifiuta la cancellazione: è il caso in cui un ordine vecchio resta sul libro.
        cancelOrder: async () => ({ ok: false, reason: 'venue: order not cancellable' }),
        setTrackingOff: async ({ marketId }) => { scritture.push(['tracking-off', marketId]); return { ok: true }; },
        setEnabled: async ({ marketId, enabled }) => { scritture.push(['enabled', marketId, enabled]); return { ok: true }; },
        setManual: async ({ marketId }) => { scritture.push(['manual', marketId]); return { ok: true }; },
        placeBulk: async ({ rows: rr }) => { scritture.push(['PIAZZATO', rr.length]); return { ok: true, placed: rr.length }; },
        audit: () => {},
      }),
    });
    const r = await runReallocCycle({}, m.deps);
    ok('il ciclo si dichiara FERMATO', r.azione === 'fermato' && r.ok === false, r.azione);
    ok('  e il fermo e quello del reset, nominato', r.motivo.includes('cancel-failed'), r.motivo.slice(0, 80));
    ok('  e dice che si riprova al ciclo successivo, non subito', /prossimo ciclo|ciclo successivo/.test(r.motivo));
    ok('NESSUN ordine e stato piazzato', !scritture.some((s) => s[0] === 'PIAZZATO'));
    ok('NESSUN registro e stato modificato', scritture.length === 0, JSON.stringify(scritture));
    ok('e il riferimento del piano NON e stato riscritto (il piano non e in opera)',
      m.fatti.poolScritti.length === 0 && m.fatti.tettiScritti.length === 0);
    ok('il piano calcolato resta nel referto, per capire cosa si SAREBBE fatto', !!r.piano && r.piano.righeEseguibili === 2);
  }

  console.log('\n══ IL VENUE MUTO NON È UN MERCATO MORTO');
  {
    const m = mondo({ venue: { [A]: { readable: false, error: 'ETIMEDOUT' }, [B]: { readable: false, error: 'ETIMEDOUT' } } });
    const r = await runReallocCycle({}, m.deps);
    ok('nessuna azione, non un reset', r.azione === 'nessuna', r.azione);
    ok('  e il motivo lo dice chiaramente', /leggibil/.test(r.motivo), r.motivo.slice(0, 90));
    ok('nessun ordine toccato', m.fatti.resetChiamato.length === 0 && m.fatti.pianiChiesti.length === 0);
  }
  {
    // Un solo mercato illeggibile mentre un altro è misuratamente morto: si rialloca lo stesso.
    const m = mondo({ venue: { [A]: { readable: false, error: 'ETIMEDOUT' }, [B]: venueSano({ acceptingOrders: false }) } });
    const r = await runReallocCycle({}, m.deps);
    ok('un invalido MISURATO fa scattare il reset anche con un illeggibile accanto', r.azione === 'reset', r.motivo.slice(0, 90));
  }

  console.log('\n══ IL CASO DEL 3 AGOSTO: IL MONTEPREMI CROLLATO FA SCATTARE IL CICLO');
  {
    const m = mondo({
      venue: { [A]: venueSano(), [B]: venueSano({ rewardsDailyRate: 3 }) },
      poolAlPiano: { [B]: 124 },
    });
    const r = await runReallocCycle({}, m.deps);
    ok('il mercato aperto, negoziabile e con banda ma a $3/g fa riallocare', r.azione === 'reset', r.motivo.slice(0, 90));
    ok('  e il verdetto e «premio-crollato»', r.verdetti.some((v) => v.stato === 'premio-crollato'));
  }
  {
    // Senza il riferimento persistito, lo stesso mercato passa per sano: è la prova che la riga
    // writePlanPools del ciclo precedente è ciò che rende visibile il guasto.
    const m = mondo({ venue: { [A]: venueSano(), [B]: venueSano({ rewardsDailyRate: 3 }) } });
    const r = await runReallocCycle({}, m.deps);
    ok('senza il riferimento del piano precedente il crollo e invisibile', r.azione === 'nessuna');
  }

  console.log('\n══ SENZA SAPERE QUANTO CAPITALE C È, NON SI CANCELLA NIENTE');
  {
    for (const [nome, saldo] of [
      ['saldo illeggibile', { readable: false, error: 'RPC giù' }],
      ['saldo nullo', null],
      ['saldo a zero', { readable: true, usd: 0 }],
      ['saldo non numerico', { readable: true, usd: null }],
      ['lettore che esplode', new Error('boom')],
    ]) {
      const m = mondo({
        venue: { [A]: venueSano(), [B]: venueSano({ closed: true }) },
        readBalance: async () => { if (saldo instanceof Error) throw saldo; return saldo; },
      });
      const r = await runReallocCycle({}, m.deps);
      ok(`${nome}: fermato prima di toccare qualunque cosa`, r.azione === 'fermato' && m.fatti.resetChiamato.length === 0, r.azione);
    }
  }

  console.log('\n══ UN PIANO CHE NON SI PUÒ CALCOLARE NON È UN PIANO VUOTO');
  {
    const casi = [
      ['l allocatore esplode', async () => { throw new Error('journal corrotto'); }],
      ['l allocatore risponde con un errore', async () => ({ error: 'tape mancante' })],
      ['l allocatore risponde vuoto', async () => null],
      ['universo senza candidati', async () => ({ ...pianoSano(), candidates: [] })],
      ['storico senza copertura', async () => ({ ...pianoSano(), coverage: { coveredMarketCount: 0 } })],
    ];
    for (const [nome, makePlan] of casi) {
      const m = mondo({ venue: { [A]: venueSano(), [B]: venueSano({ closed: true }) }, makePlan });
      const r = await runReallocCycle({}, m.deps);
      ok(`${nome}: fermato, nessun reset`, r.azione === 'fermato' && m.fatti.resetChiamato.length === 0, r.motivo.slice(0, 70));
    }
  }

  console.log('\n══ IL RIALLOCATORE MANTIENE UN ALLOCAZIONE, NON NE APRE UNA');
  {
    const m = mondo({ abilitati: [], tracking: [] });
    const r = await runReallocCycle({}, m.deps);
    ok('senza mercati in gestione non fa niente', r.azione === 'nessuna', r.motivo.slice(0, 80));
    ok('  e non chiede nemmeno il saldo o un piano', m.fatti.pianiChiesti.length === 0);
    ok('  ne interroga il venue', m.fatti.venueLetti.length === 0);
  }
  {
    const m = mondo({ readEnabled: () => { throw new Error('json rotto'); } });
    const r = await runReallocCycle({}, m.deps);
    ok('registri locali illeggibili ⇒ fermo, non «zero mercati»', r.azione === 'fermato', r.motivo.slice(0, 70));
  }

  console.log('\n══ I DUE REGISTRI SI UNISCONO, NON SI SCEGLIE IL PIÙ COMODO');
  {
    const m = mondo({ abilitati: [A], tracking: [B], venue: { [A]: venueSano(), [B]: venueSano() } });
    const r = await runReallocCycle({}, m.deps);
    ok('un mercato presente solo in tracking viene comunque verificato', m.fatti.venueLetti.includes(B));
    ok('  e uno presente solo in allowlist pure', m.fatti.venueLetti.includes(A));
    ok('  senza doppioni quando compare in entrambi', r.verdetti.length === 2);
  }

  console.log('\n══ L ANTEPRIMA NON SCRIVE NEMMENO I RIFERIMENTI');
  {
    const m = mondo({ venue: { [A]: venueSano(), [B]: venueSano({ closed: true }) } });
    const r = await runReallocCycle({ dryRunOnly: true }, m.deps);
    ok('il reset e stato chiamato in anteprima', m.fatti.resetChiamato[0].dryRunOnly === true);
    ok('il referto si dichiara dry run', r.dryRun === true);
    ok('e nessun riferimento e stato persistito', m.fatti.poolScritti.length === 0 && m.fatti.tettiScritti.length === 0);
  }

  console.log('\n══ IL REGISTRO NON PUÒ FERMARE IL CICLO');
  {
    const m = mondo({ venue: { [A]: venueSano(), [B]: venueSano({ closed: true }) }, poolScritturaFallisce: true });
    m.deps.log = () => { throw new Error('disco pieno'); };
    const r = await runReallocCycle({}, m.deps);
    ok('un registro che esplode non annulla il reset', r.azione === 'reset', r.azione);
    ok('  e la scrittura fallita del riferimento resta a verbale',
      r.passi.some((p) => p.evento === 'scrittura-fallita'));
  }

  console.log(`\nriallocatore periodico: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();
