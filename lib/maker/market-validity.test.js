#!/usr/bin/env node
'use strict';
// «È ANCORA VALIDO?» — E SOPRATTUTTO: «NON SI SA» NON È «SÌ» E NON È «NO».
//
// Il caso reale che governa questo file è il 3 agosto 2026: il mercato lettone AS, ancora aperto, ancora
// negoziabile, ancora con la sua banda, passato da $124/g a $3/g. Le tre domande ovvie lo avrebbero
// dichiarato valido. Qui si verifica che la quarta lo veda, e che nessuna delle altre lo confonda.

const { marketValidity, decidiRiallocazione, HORIZON_MIN_HOURS, POOL_COLLAPSE_FRAC } = require('./market-validity');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ORA = Date.parse('2026-08-03T12:00:00Z');
const M = '0x' + 'a1'.repeat(32);
const fraOre = (h) => new Date(ORA + h * 3_600_000).toISOString();

/** Il venue di un mercato in perfetta salute. */
const sano = (over = {}) => ({
  readable: true, closed: false, active: true, acceptingOrders: true,
  rewardsDailyRate: 100, maxSpreadCents: 4, minSizeShares: 20, endDate: fraOre(24 * 60),
  ...over,
});
const v = (venue, poolAlPiano = null) => marketValidity({ marketId: M, venue, poolAlPiano, nowMs: ORA });

console.log('\n══ IL MERCATO SANO');
{
  const r = v(sano());
  ok('e valido', r.valido === true && r.stato === 'valido');
  ok('  e il verdetto porta con se i numeri su cui e stato dato', r.dettagli.rewardsDailyRate === 100 && r.dettagli.maxSpreadCents === 4);
}

console.log('\n══ «NON SI SA» È UN TERZO VERDETTO, E NON FA SCATTARE NIENTE');
{
  for (const [nome, venue] of [
    ['venue null', null],
    ['readable:false', { readable: false, error: 'timeout' }],
    ['montepremi non numerico', sano({ rewardsDailyRate: null })],
    ['montepremi stringa', sano({ rewardsDailyRate: '124' })],
  ]) {
    const r = v(venue);
    ok(`${nome}: valido === null`, r.valido === null && r.stato === 'illeggibile', `${r.stato}/${r.valido}`);
  }
  ok('un montepremi illeggibile NON viene trattato come zero',
    v(sano({ rewardsDailyRate: undefined })).stato !== 'senza-premio');
  ok('e l errore del venue arriva nel verdetto', v({ readable: false, error: 'ECONNRESET' }).dettagli.error === 'ECONNRESET');
}

console.log('\n══ I MERCATI CHE NON CI SONO PIÙ');
{
  ok('chiuso ⇒ risolto', v(sano({ closed: true })).stato === 'risolto' && v(sano({ closed: true })).valido === false);
  ok('non attivo ⇒ risolto', v(sano({ active: false })).stato === 'risolto');
  ok('non accetta ordini ⇒ non-negoziabile', v(sano({ acceptingOrders: false })).stato === 'non-negoziabile');
  ok('  e non-negoziabile fa scattare il reset', v(sano({ acceptingOrders: false })).valido === false);
  ok('«active» assente non diventa «non attivo»', v(sano({ active: null })).valido === true);
  ok('«acceptingOrders» assente non diventa «non accetta»', v(sano({ acceptingOrders: null })).valido === true);
}

console.log('\n══ LA SCADENZA');
{
  ok('data passata ⇒ scaduto', v(sano({ endDate: fraOre(-1) })).stato === 'scaduto');
  ok(`meno di ${HORIZON_MIN_HOURS}h ⇒ in-scadenza`, v(sano({ endDate: fraOre(HORIZON_MIN_HOURS - 1) })).stato === 'in-scadenza');
  ok('  e in-scadenza fa scattare il reset', v(sano({ endDate: fraOre(1) })).valido === false);
  ok(`esattamente ${HORIZON_MIN_HOURS}h resta valido`, v(sano({ endDate: fraOre(HORIZON_MIN_HOURS) })).valido === true);
  ok('data assente NON diventa «scade domani»', v(sano({ endDate: null })).valido === true);
  ok('data illeggibile NON diventa «scade domani»', v(sano({ endDate: 'domani' })).valido === true);
  ok('  ma la chiusura vince sulla scadenza mancante', v(sano({ endDate: null, closed: true })).stato === 'risolto');
}

console.log('\n══ IL PREMIO E LA BANDA');
{
  ok('montepremi zero ⇒ senza-premio', v(sano({ rewardsDailyRate: 0 })).stato === 'senza-premio');
  ok('  ed e un fatto MISURATO, quindi fa scattare il reset', v(sano({ rewardsDailyRate: 0 })).valido === false);
  ok('banda assente ⇒ senza-banda', v(sano({ maxSpreadCents: null })).stato === 'senza-banda');
  ok('banda zero ⇒ senza-banda', v(sano({ maxSpreadCents: 0 })).stato === 'senza-banda');
}

console.log('\n══ IL CASO DEL 3 AGOSTO: IL MONTEPREMI CROLLATO');
{
  const r = v(sano({ rewardsDailyRate: 3 }), 124);
  ok('da $124/g a $3/g ⇒ premio-crollato', r.stato === 'premio-crollato' && r.valido === false);
  ok('  e il verdetto dice da quanto a quanto', r.dettagli.poolAlPiano === 124 && r.dettagli.poolOra === 3, JSON.stringify(r.dettagli));
  ok('  mentre le tre domande ovvie lo avrebbero dichiarato sano',
    v(sano({ rewardsDailyRate: 3 })).valido === true, 'senza riferimento resta valido');

  ok(`sopra la soglia (${POOL_COLLAPSE_FRAC}) resta valido`, v(sano({ rewardsDailyRate: 62 }), 124).valido === true);
  ok('esattamente alla soglia resta valido', v(sano({ rewardsDailyRate: 62 }), 124).stato === 'valido');
  ok('appena sotto scatta', v(sano({ rewardsDailyRate: 61 }), 124).stato === 'premio-crollato');
  ok('un montepremi CRESCIUTO non e un crollo', v(sano({ rewardsDailyRate: 400 }), 124).valido === true);
  ok('senza riferimento il controllo non si applica', v(sano({ rewardsDailyRate: 3 }), null).valido === true);
  ok('un riferimento a zero non si applica (niente divisioni per zero)', v(sano({ rewardsDailyRate: 3 }), 0).valido === true);
}

console.log('\n══ LA DECISIONE SULL INSIEME');
{
  const V = (id, valido, stato) => ({ marketId: id, stato, valido, motivo: stato, dettagli: {} });
  const A = '0x' + 'aa'.repeat(32), B = '0x' + 'bb'.repeat(32), C = '0x' + 'cc'.repeat(32);

  let d = decidiRiallocazione([V(A, true, 'valido'), V(B, true, 'valido')]);
  ok('tutti validi ⇒ nessuna riallocazione', d.riallocare === false && d.validi.length === 2);

  d = decidiRiallocazione([V(A, true, 'valido'), V(B, false, 'risolto')]);
  ok('anche uno solo invalido ⇒ si rialloca', d.riallocare === true);
  ok('  e il motivo nomina il mercato e il suo stato', d.motivo.includes('risolto') && d.motivo.includes(B.slice(0, 10)));

  d = decidiRiallocazione([V(A, true, 'valido'), V(B, null, 'illeggibile')]);
  ok('un illeggibile da solo NON fa riallocare', d.riallocare === false && d.illeggibili.length === 1);
  ok('  e lo dice a voce alta', d.motivo.includes('illeggibile') || d.motivo.includes('leggibile'));

  d = decidiRiallocazione([V(A, false, 'risolto'), V(B, null, 'illeggibile')]);
  ok('un invalido MISURATO fa riallocare anche se un altro e illeggibile', d.riallocare === true);
  ok('  e l illeggibile resta menzionato', d.motivo.includes('illeggibile'));

  d = decidiRiallocazione([]);
  ok('nessun mercato ⇒ nessuna riallocazione', d.riallocare === false);

  d = decidiRiallocazione([V(A, null, 'illeggibile'), V(B, null, 'illeggibile'), V(C, null, 'illeggibile')]);
  ok('venue completamente muto ⇒ non si tocca niente', d.riallocare === false, d.motivo);
}

console.log(`\nvalidita dei mercati: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
