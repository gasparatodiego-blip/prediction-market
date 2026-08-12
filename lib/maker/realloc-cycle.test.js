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

const { runReallocCycle, MARKET_CAP_FIXED_USD, PLAN_VERIFY_MAX_PASSES } = require('./realloc-cycle');
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
  marketId, name: 'Mercato ' + marketId.slice(2, 6), capital, minSizeShares: null,
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
  concentration: { maxPerMarketUsd: Math.min(MARKET_CAP_FIXED_USD, capital), capped: true },
  // L'età della fotografia del board: il ciclo si rifiuta di piazzare su un board vecchio, quindi
  // ogni piano finto deve dichiararla come farebbe quello vero.
  board: { atMs: ORA - 60_000, atIso: new Date(ORA - 60_000).toISOString(), ageS: 60 },
});

/**
 * Il mondo finto. Ogni dipendenza è registrata: alla fine si può chiedere non solo «cos'è successo» ma
 * «cosa NON è successo», che in un processo che tocca capitale è la domanda più importante.
 */
function mondo(opts = {}) {
  const fatti = { venueLetti: [], resetChiamato: [], pianiChiesti: [], poolScritti: [], tettiScritti: [], log: [] };
  // I mercati del piano NUOVO (N1/N2) stanno nella mappa del venue come quelli in gestione: dalla
  // revisione della verifica in entrata il ciclo interroga il venue anche su di loro prima di piazzare.
  const venue = Object.assign({ [N1]: venueSano({ rewardsDailyRate: 300 }), [N2]: venueSano({ rewardsDailyRate: 150 }) },
    opts.venue || { [A]: venueSano(), [B]: venueSano() });
  const deps = {
    now: () => ORA,
    readEnabled: opts.readEnabled || (() => (opts.abilitati || [A, B])),
    readTracking: opts.readTracking || (() => (opts.tracking || [A])),
    readVenue: async ({ marketId }) => { fatti.venueLetti.push(marketId); return venue[marketId] ?? { readable: false, error: 'sconosciuto' }; },
    readPlanPools: () => (opts.poolAlPiano || {}),
    writePlanPools: (p) => { if (opts.poolScritturaFallisce) throw new Error('disco pieno'); fatti.poolScritti.push(p); },
    writeAllocatedCapital: (s) => { fatti.tettiScritti.push(s); },
    readBalance: opts.readBalance || (async () => ({ readable: true, usd: 1000 })),
    readExposureCap: opts.readExposureCap !== undefined ? opts.readExposureCap
      : () => ({ readable: true, maxOpenNotionalUsd: opts.tettoEsposizione != null ? opts.tettoEsposizione : 100_000 }),
    makePlan: async (a) => {
      fatti.pianiChiesti.push(a);
      if (opts.makePlan) return opts.makePlan(a);
      // Il ciclo chiede DUE piani: quello libero e quello ristretto ai mercati in gestione (onlyMarketIds).
      if (a.onlyMarketIds) return opts.pianoProduzione !== undefined ? opts.pianoProduzione : pianoSano(a.capital);
      return opts.pianoFresco !== undefined ? opts.pianoFresco : pianoSano(a.capital);
    },
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
    ok('il venue e stato interrogato su ENTRAMBI i mercati in gestione', m.fatti.venueLetti.includes(A) && m.fatti.venueLetti.includes(B));
    ok('  e anche sui DUE mercati che il piano nuovo piazzerebbe', m.fatti.venueLetti.includes(N1) && m.fatti.venueLetti.includes(N2));
    ok('il piano e stato chiesto al saldo reale, non a una costante', m.fatti.pianiChiesti[0].capital === 1000);
    ok(`  con il tetto per mercato FISSO a $${MARKET_CAP_FIXED_USD}, non una frazione del capitale`,
      m.fatti.pianiChiesti[0].maxPerMarketUsd === MARKET_CAP_FIXED_USD, String(m.fatti.pianiChiesti[0].maxPerMarketUsd));
    // DUE mercati, QUATTRO righe: da questa revisione ogni mercato è una coppia bid+ask.
    ok('il reset ha ricevuto le righe eseguibili del piano', m.fatti.resetChiamato[0].rows.length === 4,
      `${m.fatti.resetChiamato[0].rows.length} righe`);
    ok('  due gambe per mercato, una per libro',
      new Set(m.fatti.resetChiamato[0].rows.map((x) => x.marketId)).size === 2
      && m.fatti.resetChiamato[0].rows.filter((x) => x.book === 'yes').length === 2
      && m.fatti.resetChiamato[0].rows.filter((x) => x.book === 'no').length === 2);
    ok('  e ogni gamba porta la sua coppia', m.fatti.resetChiamato[0].rows.every((x) => x.coppia === x.marketId));
    ok('  al bid del tick di difetto e con la size del piano',
      m.fatti.resetChiamato[0].rows[0].price === 0.49 && m.fatti.resetChiamato[0].rows[0].size > 0,
      JSON.stringify(m.fatti.resetChiamato[0].rows[0]));
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
    ok('i DUE piani sono stati calcolati lo stesso: il secondo trigger si misura sempre',
      m.fatti.pianiChiesti.length === 2 && !m.fatti.pianiChiesti[0].onlyMarketIds && !!m.fatti.pianiChiesti[1].onlyMarketIds);
    ok('  e quello ristretto guarda esattamente i mercati in gestione',
      m.fatti.pianiChiesti[1].onlyMarketIds.length === 2);
    ok('ma valendo uguale non fa scattare niente', r.valore.misurabile === true && r.valore.scattato !== true, JSON.stringify({ g: r.valore.guadagno }));
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
    ok('il piano calcolato resta nel referto, per capire cosa si SAREBBE fatto',
      !!r.piano && r.piano.mercatiEseguibili === 2 && r.piano.righeEseguibili === 4,
      JSON.stringify({ mercati: r.piano && r.piano.mercatiEseguibili, righe: r.piano && r.piano.righeEseguibili }));
  }

  console.log('\n══ IL VENUE MUTO NON È UN MERCATO MORTO');
  {
    const m = mondo({ venue: { [A]: { readable: false, error: 'ETIMEDOUT' }, [B]: { readable: false, error: 'ETIMEDOUT' } } });
    const r = await runReallocCycle({}, m.deps);
    ok('nessuna azione, non un reset', r.azione === 'nessuna', r.azione);
    ok('  e il motivo lo dice chiaramente', /leggibil/.test(r.motivo), r.motivo.slice(0, 90));
    ok('nessun ordine toccato', m.fatti.resetChiamato.length === 0);
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

  console.log('\n══ IL SECONDO TRIGGER · IL PIANO FRESCO VALE ABBASTANZA DI PIÙ?');
  {
    // Tutti i mercati validi secondo il PRIMO controllo, ma un piano fresco che rende molto di più.
    const conValore = (v) => ({ ...pianoSano(), totals: { grossPerDay: v * 2, realisticPerDay: v, realisticRowsUnknown: 0 } });
    const m = mondo({ pianoFresco: conValore(13), pianoProduzione: conValore(10) });   // +30%
    const r = await runReallocCycle({}, m.deps);
    ok('mercati tutti validi ma piano fresco +30% ⇒ il reset scatta lo stesso', r.azione === 'reset', r.azione);
    ok('  e la causa registrata e «valore», non «validita»', r.causa === 'valore', String(r.causa));
    ok('  il motivo dice che i mercati erano validi', r.motivo.includes('ancora validi'), r.motivo.slice(0, 80));
    ok('  e riporta i due numeri messi a confronto',
      r.valore.fresco === 13 && r.valore.produzione === 10 && Math.abs(r.valore.guadagno - 0.3) < 1e-9, JSON.stringify(r.valore.guadagno));
    ok('il reset ha ricevuto le righe del piano FRESCO', m.fatti.resetChiamato.length === 1 && m.fatti.resetChiamato[0].rows.length === 4);
    const passiTrigger = r.passi.filter((p) => p.fase === 'trigger');
    ok('i due trigger sono registrati SEPARATAMENTE', passiTrigger.length === 2
      && passiTrigger[0].evento === 'validita' && passiTrigger[1].evento === 'valore', JSON.stringify(passiTrigger.map((p) => p.evento)));
    ok('  il primo dice di non essere scattato', passiTrigger[0].scattato === false);
    ok('  il secondo di si', passiTrigger[1].scattato === true);
    ok('  e la decisione porta la causa a verbale',
      r.passi.some((p) => p.fase === 'decisione' && p.causa === 'valore' && p.triggerValidita === false && p.triggerValore === true));
  }
  {
    const conValore = (v) => ({ ...pianoSano(), totals: { grossPerDay: v * 2, realisticPerDay: v, realisticRowsUnknown: 0 } });
    const m = mondo({ pianoFresco: conValore(11.9), pianoProduzione: conValore(10) });   // +19%
    const r = await runReallocCycle({}, m.deps);
    ok('+19% NON basta: sotto soglia nessuna azione', r.azione === 'nessuna' && m.fatti.resetChiamato.length === 0, r.azione);
    ok('  anche se il piano sarebbe tecnicamente migliorabile', r.valore.misurabile === true && r.valore.guadagno > 0);
    ok('  e zero tocchi al venue oltre alle verifiche', m.fatti.venueLetti.length === 4);
  }
  {
    const conValore = (v) => ({ ...pianoSano(), totals: { grossPerDay: v * 2, realisticPerDay: v, realisticRowsUnknown: 0 } });
    const m = mondo({ pianoFresco: conValore(12), pianoProduzione: conValore(10) });   // esattamente +20%
    const r = await runReallocCycle({}, m.deps);
    ok('esattamente alla soglia NON scatta (serve piu del 20%)', r.azione === 'nessuna', r.azione);
  }
  {
    const conValore = (v) => ({ ...pianoSano(), totals: { grossPerDay: v * 2, realisticPerDay: v, realisticRowsUnknown: 0 } });
    const m = mondo({
      venue: { [A]: venueSano(), [B]: venueSano({ closed: true }) },
      pianoFresco: conValore(20), pianoProduzione: conValore(10),
    });
    const r = await runReallocCycle({}, m.deps);
    ok('quando scattano entrambi la causa e «entrambi»', r.causa === 'entrambi', String(r.causa));
    ok('  e il motivo li nomina tutti e due', r.motivo.includes('validità') && r.motivo.includes('valore'), r.motivo.slice(0, 60));
  }
  {
    // Il primo trigger scatta e il secondo no: il reset si fa comunque, e l'audit lo distingue.
    const conValore = (v) => ({ ...pianoSano(), totals: { grossPerDay: v * 2, realisticPerDay: v, realisticRowsUnknown: 0 } });
    const m = mondo({
      venue: { [A]: venueSano(), [B]: venueSano({ closed: true }) },
      pianoFresco: conValore(10), pianoProduzione: conValore(10),
    });
    const r = await runReallocCycle({}, m.deps);
    ok('validita si, valore no ⇒ reset con causa «validita»', r.azione === 'reset' && r.causa === 'validita', `${r.azione}/${r.causa}`);
  }
  {
    // La soglia e configurabile, e il difetto e quello che l'operatore ha chiesto.
    const { VALUE_TRIGGER_FRAC } = require('./realloc-cycle');
    ok('la soglia di difetto e il 20%', VALUE_TRIGGER_FRAC === 0.20, String(VALUE_TRIGGER_FRAC));
    const conValore = (v) => ({ ...pianoSano(), totals: { grossPerDay: v * 2, realisticPerDay: v, realisticRowsUnknown: 0 } });
    const m = mondo({ pianoFresco: conValore(10.6), pianoProduzione: conValore(10) });
    const r = await runReallocCycle({ valueTriggerFrac: 0.05 }, m.deps);
    ok('  e si puo stringere: +6% con soglia al 5% scatta', r.azione === 'reset' && r.causa === 'valore', r.azione);
  }

  console.log('\n══ IL SECONDO TRIGGER SI ASTIENE QUANDO NON HA MISURATO, NON QUANDO GLI CONVIENE');
  {
    const conValore = (v, over = {}) => ({ ...pianoSano(), totals: { grossPerDay: v * 2, realisticPerDay: v, realisticRowsUnknown: 0 }, ...over });
    const casi = [
      ['il piano ristretto esplode', { makePlan: async (a) => (a.onlyMarketIds ? Promise.reject(new Error('tape mancante')) : conValore(50)) }],
      ['il piano ristretto risponde con un errore', { pianoFresco: conValore(50), pianoProduzione: { error: 'journal corrotto' } }],
      ['il piano ristretto risponde vuoto', { pianoFresco: conValore(50), pianoProduzione: null }],
      ['nessun mercato in gestione e valutabile oggi', { pianoFresco: conValore(50), pianoProduzione: { ...conValore(0), candidates: [] } }],
      ['il corretto/g dei mercati in gestione e ignoto', { pianoFresco: conValore(50), pianoProduzione: conValore(null) }],
      ['il corretto/g del piano fresco e ignoto', { pianoFresco: conValore(null), pianoProduzione: conValore(1) }],
      ['ci sono righe con correzione ignota in produzione', { pianoFresco: conValore(50), pianoProduzione: { ...pianoSano(), totals: { grossPerDay: 20, realisticPerDay: 10, realisticRowsUnknown: 2 } } }],
    ];
    for (const [nome, opts] of casi) {
      const m = mondo(opts);
      const r = await runReallocCycle({}, m.deps);
      ok(`${nome}: nessun reset`, r.azione === 'nessuna' && m.fatti.resetChiamato.length === 0, r.azione);
      ok('  e l astensione e detta, non nascosta', r.valore && r.valore.misurabile === false && !!r.valore.motivo, r.valore && r.valore.motivo ? r.valore.motivo.slice(0, 50) : 'niente');
    }
  }
  {
    // IL CASO CHE SI È VISTO DAVVERO: l'allocatore elenca 115 candidati (i pre-scartati dell'intero
    // board) ma ne ha VALUTATI zero, e il corretto/g esce 0,00. Contare i candidati invece dei valutati
    // farebbe leggere «i tuoi mercati non valgono niente» e cancellare ordini veri per ignoranza.
    const cieco = {
      ...pianoSano(), rows: [],
      candidates: new Array(115).fill(null).map((_, i) => ({ marketId: '0x' + String(i).padStart(4, '0'), status: 'scartato', reasonCode: 'senza-storico' })),
      universe: { evaluated: 0, chosen: 0, restrictedTo: 2 },
      totals: { grossPerDay: 0, realisticPerDay: 0, realisticRowsUnknown: 0 },
    };
    const fresco = { ...pianoSano(), universe: { evaluated: 115, chosen: 2 }, totals: { grossPerDay: 50, realisticPerDay: 25, realisticRowsUnknown: 0 } };
    const m = mondo({ pianoFresco: fresco, pianoProduzione: cieco });
    const r = await runReallocCycle({}, m.deps);
    ok('115 candidati ma ZERO valutati ⇒ astensione, non «valgono zero»', r.azione === 'nessuna' && m.fatti.resetChiamato.length === 0, r.azione);
    ok('  e il motivo parla di valutati, non di candidati', /valutabile|valutati/.test(r.valore.motivo), r.valore.motivo.slice(0, 60));
  }
  {
    // Lo stesso principio sul piano FRESCO: registro pieno, valutati zero ⇒ non è un piano magro.
    const cieco = {
      ...pianoSano(), rows: [],
      candidates: new Array(115).fill(null).map((_, i) => ({ marketId: '0x' + String(i).padStart(4, '0'), status: 'scartato' })),
      universe: { evaluated: 0, chosen: 0 },
      totals: { grossPerDay: 0, realisticPerDay: 0, realisticRowsUnknown: 0 },
    };
    const m = mondo({ venue: { [A]: venueSano(), [B]: venueSano({ closed: true }) }, pianoFresco: cieco });
    const r = await runReallocCycle({}, m.deps);
    ok('piano fresco con registro pieno ma zero valutati ⇒ fermato', r.azione === 'fermato' && m.fatti.resetChiamato.length === 0, r.azione);
  }
  {
    // Lo ZERO MISURATO invece scatta: i mercati in gestione sono stati valutati e non valgono niente.
    const conValore = (v) => ({ ...pianoSano(), totals: { grossPerDay: v * 2, realisticPerDay: v, realisticRowsUnknown: 0 } });
    const m = mondo({ pianoFresco: conValore(8), pianoProduzione: conValore(0) });
    const r = await runReallocCycle({}, m.deps);
    ok('mercati in gestione valutati e a zero ⇒ scatta', r.azione === 'reset' && r.causa === 'valore', `${r.azione}/${r.causa}`);
    ok('  e lo zero e riportato come misurato', r.valore.produzione === 0 && r.valore.guadagnoInfinito === true);
  }
  {
    // Se anche il piano fresco vale zero, non c'e niente da guadagnare: non si churna per nulla.
    const conValore = (v) => ({ ...pianoSano(), totals: { grossPerDay: 0, realisticPerDay: v, realisticRowsUnknown: 0 } });
    const m = mondo({ pianoFresco: conValore(0), pianoProduzione: conValore(0) });
    const r = await runReallocCycle({}, m.deps);
    ok('zero contro zero non e un miglioramento', r.azione === 'nessuna', r.azione);
  }

  console.log('\n══ QUANDO IL PRIMO TRIGGER NON SCATTA, UN DATO MANCANTE NON DIVENTA UN ALLARME');
  {
    const m = mondo({ readBalance: async () => ({ readable: false, error: 'RPC giu' }) });
    const r = await runReallocCycle({}, m.deps);
    ok('saldo illeggibile e mercati tutti validi ⇒ nessuna azione, non «fermato»', r.azione === 'nessuna', r.azione);
    ok('  ma il confronto di valore risulta NON misurabile', r.valore.misurabile === false, r.valore.motivo);
    ok('  e resta a verbale nel registro', r.passi.some((p) => p.fase === 'capitale' && p.evento === 'non-leggibile'));
    ok('nessun ordine toccato', m.fatti.resetChiamato.length === 0);
  }
  {
    const m = mondo({ makePlan: async () => { throw new Error('journal corrotto'); } });
    const r = await runReallocCycle({}, m.deps);
    ok('allocatore in errore e mercati validi ⇒ nessuna azione, non «fermato»', r.azione === 'nessuna', r.azione);
    ok('  con l astensione motivata', r.valore.misurabile === false && /journal/.test(r.valore.motivo));
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


  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // LA VERIFICA AL VENUE DEI MERCATI CHE ENTRANO NEL PIANO
  //
  // Il controllo di validità guarda chi ESCE. Questi scenari guardano chi ENTRA: il piano nasce da una
  // fotografia del board vecchia fino a 15 minuti, e fra due fotografie un mercato può risolversi. Prima
  // di questa revisione il ciclo avrebbe cancellato ordini buoni per piazzarne su un mercato morto.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════

  console.log('\n══ UN MERCATO DEL PIANO NUOVO È GIÀ RISOLTO ⇒ ESCE E IL CAPITALE VA ALTROVE');
  {
    // N2 è risolto sul venue benché il board lo elenchi ancora. Al secondo giro il piano rifatto porta
    // N3 al suo posto: è esattamente la riallocazione automatica che l'operatore ha chiesto.
    const N3 = '0x' + 'c3'.repeat(32);
    let giro = 0;
    const m = mondo({
      venue: { [A]: venueSano(), [B]: venueSano({ closed: true }), [N1]: venueSano({ rewardsDailyRate: 300 }), [N2]: venueSano({ closed: true }), [N3]: venueSano({ rewardsDailyRate: 200 }) },
      makePlan: async (a) => {
        if (a.onlyMarketIds) return pianoSano(a.capital);
        giro++;
        if (a.excludeMarketIds && a.excludeMarketIds.includes(N2)) {
          return { ...pianoSano(a.capital), rows: [rigaPiano(N1, 300), rigaPiano(N3, 300)], candidates: [{ marketId: N1, status: 'scelto', pot: 300 }, { marketId: N3, status: 'scelto', pot: 200 }] };
        }
        return pianoSano(a.capital);
      },
    });
    const r = await runReallocCycle({}, m.deps);
    ok('il ciclo arriva al reset', r.azione === 'reset', r.azione + ' · ' + r.motivo.slice(0, 60));
    ok('  il mercato risolto è dichiarato escluso', r.esclusiDalVenue.length === 1 && r.esclusiDalVenue[0].marketId === N2, JSON.stringify(r.esclusiDalVenue));
    ok('  con lo stato che il venue ha detto, non un generico «scartato»', r.esclusiDalVenue[0].stato === 'risolto');
    ok('  il piano è stato RIFATTO escludendolo', giro === 2 && m.fatti.pianiChiesti.some((x) => x.excludeMarketIds && x.excludeMarketIds.includes(N2)));
    ok('  e il ricalcolo ha tenuto lo stesso capitale e lo stesso tetto', (() => {
      const rif = m.fatti.pianiChiesti.find((x) => x.excludeMarketIds);
      return rif.capital === 1000 && rif.maxPerMarketUsd === MARKET_CAP_FIXED_USD;
    })());
    ok('il reset NON riceve il mercato risolto', !m.fatti.resetChiamato[0].rows.some((x) => x.marketId === N2));
    ok('  e riceve invece il sostituto trovato dal ricalcolo', m.fatti.resetChiamato[0].rows.some((x) => x.marketId === N3));
    ok('  il capitale impegnato non è calato: è stato riallocato, non perso',
      new Set(m.fatti.resetChiamato[0].rows.map((x) => x.marketId)).size === 2, `${m.fatti.resetChiamato[0].rows.length} righe`);
  }

  console.log('\n══ IL MONTEPREMI DEL VENUE SMENTISCE QUELLO DEL BOARD ⇒ IL MERCATO NON ENTRA');
  {
    // Il caso del 3 agosto, applicato in ENTRATA: il board dice $300/g, il venue ne dice $9/g. Il mercato
    // è vivo, negoziabile e con la sua banda — invisibile a qualunque controllo di sola esistenza.
    const m = mondo({
      venue: { [A]: venueSano(), [B]: venueSano({ closed: true }), [N1]: venueSano({ rewardsDailyRate: 9 }), [N2]: venueSano({ rewardsDailyRate: 150 }) },
      makePlan: async (a) => (a.onlyMarketIds ? pianoSano(a.capital)
        : a.excludeMarketIds && a.excludeMarketIds.length
          ? { ...pianoSano(a.capital), rows: [rigaPiano(N2)], candidates: [{ marketId: N2, status: 'scelto', pot: 150 }] }
          : pianoSano(a.capital)),
    });
    const r = await runReallocCycle({}, m.deps);
    ok('il mercato col montepremi crollato viene escluso', r.esclusiDalVenue.some((x) => x.marketId === N1 && x.stato === 'premio-crollato'), JSON.stringify(r.esclusiDalVenue));
    ok('  il confronto usa il montepremi di QUESTO piano ($300), non di uno vecchio', r.esclusiDalVenue[0].motivo.includes('300'), r.esclusiDalVenue[0].motivo);
    ok('  e non finisce negli ordini', !m.fatti.resetChiamato[0].rows.some((x) => x.marketId === N1));
  }

  console.log('\n══ UN MERCATO DEL PIANO CHE IL VENUE NON SA DIRE ⇒ NON SI PIAZZA AL BUIO');
  {
    // Simmetrico rovesciato, ed è deliberato: per un mercato GIÀ IN GESTIONE «illeggibile» vuol dire
    // «lascialo dov'è» e non fa scattare nulla; per un mercato che sta per RICEVERE ordini veri la parte
    // che non agisce è NON PIAZZARE. Non si conclude che sia morto — si conclude che non lo si è potuto
    // confermare, e non si scommette capitale su una conferma mancata.
    const m = mondo({
      venue: { [A]: venueSano(), [B]: venueSano({ closed: true }), [N1]: venueSano({ rewardsDailyRate: 300 }), [N2]: { readable: false, error: 'timeout dopo 12000ms' } },
    });
    const r = await runReallocCycle({}, m.deps);
    ok('il ciclo si ferma', r.azione === 'fermato', r.azione);
    ok('  e nessun ordine è stato toccato', m.fatti.resetChiamato.length === 0);
    ok('  il motivo nomina il mercato non confermato', r.motivo.includes(N2.slice(0, 10)), r.motivo.slice(0, 110));
    ok('  e dice che si riprova al ciclo successivo, non subito', r.motivo.includes('ciclo successivo'));
  }

  console.log('\n══ SE IL PIANO RESTA SPORCO DOPO I RICALCOLI, CI SI FERMA (niente giro infinito)');
  {
    // L'allocatore continua a proporre lo stesso mercato morto: dopo PLAN_VERIFY_MAX_PASSES giri il dato
    // di partenza è marcio e non c'è nessun ricalcolo che lo aggiusti.
    let ricalcoli = 0;
    const m = mondo({
      venue: { [A]: venueSano(), [B]: venueSano({ closed: true }), [N1]: venueSano({ rewardsDailyRate: 300, acceptingOrders: false }), [N2]: venueSano({ rewardsDailyRate: 150 }) },
      makePlan: async (a) => { if (!a.onlyMarketIds && a.excludeMarketIds) ricalcoli++; return pianoSano(a.capital); },
    });
    const r = await runReallocCycle({}, m.deps);
    ok('il ciclo si ferma invece di ricalcolare all infinito', r.azione === 'fermato', r.motivo.slice(0, 90));
    ok(`  dopo esattamente ${PLAN_VERIFY_MAX_PASSES - 1} ricalcoli`, ricalcoli === PLAN_VERIFY_MAX_PASSES - 1, String(ricalcoli));
    ok('  e nessun ordine è stato toccato', m.fatti.resetChiamato.length === 0);
  }

  console.log('\n══ UN BOARD VECCHIO NON È UNA BASE PER PIAZZARE ORDINI VERI');
  {
    const casi = [
      ['fotografia di due ore fa', { atMs: ORA - 7_200_000, ageS: 7200 }],
      ['età della fotografia ignota', { atMs: null, ageS: null }],
      ['nessun blocco board nel piano', undefined],
    ];
    for (const [nome, board] of casi) {
      const m = mondo({
        venue: { [A]: venueSano(), [B]: venueSano({ closed: true }), [N1]: venueSano({ rewardsDailyRate: 300 }), [N2]: venueSano({ rewardsDailyRate: 150 }) },
        makePlan: async (a) => { const p = pianoSano(a.capital); if (board === undefined) delete p.board; else p.board = board; return p; },
      });
      const r = await runReallocCycle({}, m.deps);
      ok(`${nome}: fermato, nessun ordine`, r.azione === 'fermato' && m.fatti.resetChiamato.length === 0, r.motivo.slice(0, 75));
    }
    // E il board fresco non deve disturbare niente: il caso normale resta normale.
    const sano = mondo({ venue: { [A]: venueSano(), [B]: venueSano({ closed: true }), [N1]: venueSano({ rewardsDailyRate: 300 }), [N2]: venueSano({ rewardsDailyRate: 150 }) } });
    const rs = await runReallocCycle({}, sano.deps);
    ok('board di un minuto: il ciclo prosegue normalmente', rs.azione === 'reset', rs.azione);
  }


  console.log('\n══ IL CAPITALE NON PUO SUPERARE IL TETTO DI ESPOSIZIONE APERTA');
  {
    // Saldo $1000, tetto $600: il piano deve nascere su $600, non su $1000-poi-troncato. Un piano
    // calcolato su un capitale che il libro non puo portare non e il miglior piano possibile: e un
    // piano che si ferma a meta sul cap cumulativo, con la scelta dei mercati fatta dal caso.
    const m = mondo({ tettoEsposizione: 600, venue: { [A]: venueSano(), [B]: venueSano({ closed: true }), [N1]: venueSano({ rewardsDailyRate: 300 }), [N2]: venueSano({ rewardsDailyRate: 150 }) } });
    const r = await runReallocCycle({}, m.deps);
    ok('il piano e stato chiesto su $600, non su $1000', m.fatti.pianiChiesti[0].capital === 600,
      String(m.fatti.pianiChiesti[0].capital));
    // Il tetto per mercato NON dipende piu dal capitale, quindi resta quello FISSO anche quando il tetto di
    // esposizione taglia il capitale da $1000 a $600. Il punto della sezione — «il piano si chiede sul
    // capitale VERO» — e provato dalla riga sopra, che e quella che conta; qui si verifica che il tetto
    // per mercato non si muova insieme, che e la proprieta nuova.
    ok('  e il tetto per mercato resta FISSO, indifferente al taglio dell esposizione',
      m.fatti.pianiChiesti[0].maxPerMarketUsd === MARKET_CAP_FIXED_USD,
      String(m.fatti.pianiChiesti[0].maxPerMarketUsd));
    const passo = r.passi.find((p) => p.fase === 'capitale' && p.evento === 'letto');
    ok('  il registro dice che a limitare e stato il tetto, non il saldo', passo.limitatoDa === 'tetto-esposizione', passo.limitatoDa);
    ok('  e riporta entrambi i numeri', passo.saldoLiberoUsd === 1000 && passo.tettoEsposizioneUsd === 600,
      JSON.stringify({ saldo: passo.saldoLiberoUsd, tetto: passo.tettoEsposizioneUsd }));
  }

  console.log('\n══ SE IL SALDO E SOTTO IL TETTO, COMANDA IL SALDO');
  {
    const m = mondo({ tettoEsposizione: 5000, venue: { [A]: venueSano(), [B]: venueSano({ closed: true }), [N1]: venueSano({ rewardsDailyRate: 300 }), [N2]: venueSano({ rewardsDailyRate: 150 }) } });
    const r = await runReallocCycle({}, m.deps);
    ok('il piano usa il saldo, non il tetto', m.fatti.pianiChiesti[0].capital === 1000);
    const passo = r.passi.find((p) => p.fase === 'capitale' && p.evento === 'letto');
    ok('  e il registro lo dice', passo.limitatoDa === 'saldo', passo.limitatoDa);
  }

  console.log('\n══ UN TETTO DI ESPOSIZIONE NON LEGGIBILE NON E UN TETTO ALTO');
  {
    for (const [nome, lettore] of [
      ['il lettore risponde non leggibile', () => ({ readable: false, error: 'config assente' })],
      ['il lettore risponde con un limite nullo', () => ({ readable: true, maxOpenNotionalUsd: null })],
      ['il lettore esplode', () => { throw new Error('file corrotto'); }],
    ]) {
      const m = mondo({ readExposureCap: lettore, venue: { [A]: venueSano(), [B]: venueSano({ closed: true }) } });
      const r = await runReallocCycle({}, m.deps);
      ok(`${nome}: fermato, nessun piano`, r.azione === 'fermato' && m.fatti.pianiChiesti.length === 0,
        r.motivo.slice(0, 80));
    }
  }

  // Dal 9 agosto 2026 il tetto e' un VALORE FISSO IN DOLLARI e non piu' una frazione del capitale.
  // Il rischio che questa sezione difende e' lo stesso di sempre — che il numero esista in piu'
  // versioni — ed e' ora piu' grave, perche' un pianificatore che propone il tetto contro un motore che
  // verifica il 20% del saldo ($118,82 sul saldo reale) rifiuterebbe OGNI riga del piano al quoting.
  console.log('\n══ IL TETTO È LO STESSO NUMERO PER PANNELLO, MOTORE, RIMPIAZZO E RISCHIO');
  {
    const { MARKET_CAP_FIXED_USD: dalModulo, capPerMarketUsd, mercatiNecessari } = require('../rewards/concentration');
    const { tettoMercato } = require('./motore-unico');
    ok('il ciclo e il modulo condiviso espongono LO STESSO valore', MARKET_CAP_FIXED_USD === dalModulo, String(dalModulo));
    ok('  ed e il tetto DERIVATO dal capitale, non una costante', dalModulo === capPerMarketUsd(665.71));
    // IL TEST CRITICO: una riga esattamente al tetto deve passare la Regola 5 sul saldo VERO.
    const r5 = tettoMercato({ saldoUsd: 594.10, esposizioneMercatoUsd: 0, aggiuntaUsd: dalModulo });
    ok('  e il motore ACCETTA una riga al tetto sul saldo reale (era il rischio critico)',
      r5.consentito === true && r5.capUsd === dalModulo, r5.motivo);
    ok('capPerMarketUsd(665.71) = il tetto — non piu una frazione', capPerMarketUsd(665.71) === dalModulo, String(capPerMarketUsd(665.71)));
    // Capitale illeggibile ⇒ il PAVIMENTO premiante, mai `null` (che a valle varrebbe «nessun tetto»).
    // Prima era «il tetto pieno» perche' il tetto era una costante; adesso senza capitale non c'e' un
    // tetto da calcolare, e il ripiego prudente e' il numero piu' piccolo che compra ancora reward.
    ok('capitale non utilizzabile ⇒ pavimento premiante, mai null',
      [0, null, NaN].every((v) => typeof capPerMarketUsd(v) === 'number' && capPerMarketUsd(v) > 0),
      String(capPerMarketUsd(null)));
    // Col tetto dimezzato i mercati necessari RADDOPPIANO: e' l'effetto voluto, e si deriva.
    ok(`il numero di mercati e una conseguenza: $594 ⇒ ${Math.ceil(594.10 / dalModulo)}`,
      mercatiNecessari(594.10) === Math.ceil(594.10 / dalModulo));
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
