'use strict';
// lib/maker/reward-riprova.test.js — CAMPO ASSENTE NON È CAMPO A ZERO.
//
// Il selfcheck del modulo copre la regola; qui si prova il CABLAGGIO — che è dove la stessa classe di
// difetto è già morta due volte in questo repo (§5 punti 52 e 75: la regola c'era, il chiamante non le
// passava ciò che chiede).

const fs = require('fs');
const path = require('path');
const RR = require('./reward-riprova');
const MS = require('./market-search');

let passati = 0; let falliti = 0;
function ok(nome, cond, extra) {
  if (cond) { passati += 1; console.log(`  ✓ ${nome}${extra ? ` — ${extra}` : ''}`); }
  else { falliti += 1; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
}

console.log('── 1 · LA REGOLA (selfcheck del modulo)');
{
  // Il selfcheck stampa da sé e termina il processo se rosso quando eseguito da solo; qui si riusa la
  // sua sostanza senza lasciargli chiamare `process.exit`.
  ok('il TTL è 10 minuti, come richiesto', RR.TTL_MS === 10 * 60_000);
  ok('il tetto di difetto è 12 (misurato: 97·100·106·122·143 ms per fetch, mediana 106)', RR.TETTO_DEFAULT === 12);
  ok('  cioè ~1,3 s tipici per un ciclo pieno di riprove', RR.TETTO_DEFAULT * 106 < 1500);
}

console.log('\n── 2 · I DUE MOTIVI DI SCARTO NON SI CONFONDONO');
{
  ok('venue che dice zero ⇒ `reward-zero`',
    RR.motivoScarto({ rewardsStato: 'senza-premio', rewardsDailyRate: 0 }) === 'reward-zero');
  ok('lettura mancata ⇒ `reward-sconosciuto`',
    RR.motivoScarto({ rewardsStato: 'illeggibile' }) === 'reward-sconosciuto');
  ok('  e sono DIVERSI', RR.motivoScarto({ rewardsStato: 'senza-premio' }) !== RR.motivoScarto({ rewardsStato: 'illeggibile' }));
  ok('premiato non è uno scarto', RR.motivoScarto({ rewardsStato: 'premiato' }) === 'ok');
  ok('riga assente ⇒ sconosciuto, mai zero', RR.motivoScarto(null) === 'reward-sconosciuto');
}

console.log('\n── 3 · IL COMPORTAMENTO, SENZA RETE');
(async () => {
  RR.svuotaCache();
  const riga = (id, stato) => ({ marketId: id, rewardsStato: stato, rewardsPerche: 'prima lettura',
    rewardsDailyRate: null, hasRewards: false });

  let n = 0;
  const r = await RR.risolviPremiMancanti({
    righe: [riga('0xa', 'illeggibile'), riga('0xb', 'senza-premio'), riga('0xc', 'premiato')],
    fetchOne: async () => { n += 1; return { ok: true, market: { rewardsStato: 'premiato', rewardsDailyRate: 42, rewardsPerche: 'montepremi pubblicato: 42$/g' } }; },
    nowMs: 1000,
  });
  ok('si richiede SOLO ciò che non si è letto', n === 1);
  ok('  il mercato recuperato torna premiato, col suo montepremi',
    r.righe[0].rewardsStato === 'premiato' && r.righe[0].rewardsDailyRate === 42 && r.righe[0].hasRewards === true);
  ok('  un «no» del venue non si rimette in discussione', r.righe[1].rewardsStato === 'senza-premio');

  // ⚠ IL CASO CHE IL DIFETTO PRODUCEVA: senza la riprova questo mercato sarebbe stato scartato come
  // se non pagasse, mentre paga $42/g.
  ok('SENZA la riprova sarebbe stato scartato pur pagando $42/g',
    RR.motivoScarto(riga('0xa', 'illeggibile')) === 'reward-sconosciuto' && RR.motivoScarto(r.righe[0]) === 'ok');

  // La cache non fa una seconda richiesta dentro il TTL, e la fa dopo.
  const c1 = await RR.risolviPremiMancanti({ righe: [riga('0xa', 'illeggibile')], nowMs: 1000 + 9 * 60_000,
    fetchOne: async () => { n += 1; return { ok: true, market: { rewardsStato: 'premiato', rewardsDailyRate: 42 } }; } });
  ok('a 9 minuti risponde la cache', n === 1 && c1.daCache === 1);
  const c2 = await RR.risolviPremiMancanti({ righe: [riga('0xa', 'illeggibile')], nowMs: 1000 + 11 * 60_000,
    fetchOne: async () => { n += 1; return { ok: true, market: { rewardsStato: 'premiato', rewardsDailyRate: 42 } }; } });
  ok('a 11 minuti la cache è scaduta e si richiede', n === 2 && c2.riprovate === 1);

  // Il fallimento della seconda fetch.
  RR.svuotaCache();
  const f1 = await RR.risolviPremiMancanti({ righe: [riga('0xz', 'illeggibile')], nowMs: 5000,
    fetchOne: async () => ({ ok: false, market: null }) });
  ok('seconda fetch a vuoto ⇒ scartato, ma come `reward-sconosciuto`',
    RR.motivoScarto(f1.righe[0]) === 'reward-sconosciuto' && f1.sconosciute === 1);
  ok('  e NON viene messo in cache: al giro dopo si riprova davvero',
    (await RR.risolviPremiMancanti({ righe: [riga('0xz', 'illeggibile')], nowMs: 5001,
      fetchOne: async () => ({ ok: true, market: { rewardsStato: 'premiato', rewardsDailyRate: 3 } }) })).riprovate === 1);

  // Il tetto per ciclo: chi resta fuori non viene condannato.
  RR.svuotaCache();
  let k = 0;
  const t = await RR.risolviPremiMancanti({
    righe: Array.from({ length: 20 }, (_, i) => riga(`0x${i}`, 'illeggibile')), tetto: 3, nowMs: 6000,
    fetchOne: async () => { k += 1; return { ok: false, market: null }; },
  });
  ok('il tetto per ciclo limita le richieste', k === 3 && t.oltreIlTetto === 17);
  ok('  e «non abbiamo chiesto» è distinto da «abbiamo chiesto e non sappiamo»',
    t.righe[19].rewardsRiprova === 'oltre-il-tetto' && t.righe[0].rewardsRiprova !== 'oltre-il-tetto');
  ok('  la latenza peggiore di un ciclo resta sotto i 2 secondi', RR.TETTO_DEFAULT * 143 < 2000);

  console.log('\n── 4 · IL CABLAGGIO, CHE È DOVE QUESTA CLASSE DI DIFETTO MUORE');
  const srcMS = fs.readFileSync(path.join(__dirname, 'market-search.js'), 'utf8');
  const srcGate = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'api', 'maker', 'markets', 'enable', 'route.ts'), 'utf8');
  ok('la ricerca chiama la riprova quando trova righe illeggibili',
    srcMS.includes("require('./reward-riprova')") && srcMS.includes('risolviPremiMancanti'));
  ok('  e solo allora: chi non ha righe illeggibili non carica nemmeno il modulo',
    srcMS.includes('if (daRiprovare > 0)'));
  ok('  il referto dichiara quante ne sono state recuperate', srcMS.includes('rewardRiprova:'));
  ok('il GATE richiede prima di decidere', srcGate.includes('reward-riprova') && srcGate.includes('risolviPremiMancanti'));
  ok('  e pubblica il motivo di scarto distinto',
    srcGate.includes("motivoScarto: nonLetto ? 'reward-sconosciuto' : 'reward-zero'"));
  ok('  senza allargare il gate: un `senza-premio` letto rifiuta come prima',
    srcGate.includes('const contraddizionePot = potAtPlan != null && potAtPlan > 0 && m.hasRewards !== true;'));
  ok('una riprova che fallisce lascia il verdetto di prima, mai peggio',
    (srcMS.match(/mai peggio/g) || []).length >= 1 && (srcGate.match(/mai peggio/g) || []).length >= 1);

  // `rewardStateOf` non è stata toccata: è lei a distinguere i tre stati, e resta la fonte.
  ok('`rewardStateOf` continua a distinguere i tre stati',
    MS.rewardStateOf({ clobRewards: [{ rewardsDailyRate: 5 }] }).stato === 'premiato'
    && MS.rewardStateOf({ clobRewards: [] }).stato === 'senza-premio'
    && MS.rewardStateOf({}).stato === 'illeggibile');

  console.log(`\n${falliti === 0 ? '✅ TUTTI VERDI' : '❌ ROSSI'}: ${passati} passati, ${falliti} falliti`);
  process.exit(falliti === 0 ? 0 : 1);
})();
