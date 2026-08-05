#!/usr/bin/env node
'use strict';
// IL MONTEPREMI HA TRE STATI, NON DUE.
//
// ═══ IL DIFETTO ══════════════════════════════════════════════════════════════════════════════════════
// `rewardRateOf` restituiva un numero oppure `null`, e `null` significava DUE cose schiacciate in una:
//
//     «il venue dice che questo mercato non è nel programma premi»
//     «il venue non me l'ha detto»
//
// Da lì `hasRewards: rate != null && rate > 0` produceva `false` in entrambi i casi — cioè
// un'affermazione SUL VENUE che il codice non era in grado di sostenere.
//
// Osservato il 5 agosto 2026 su mercati che pagavano: «China invade Taiwan» ($50/g) e «Netanyahu out by
// end of 2026» ($30/g) riportati come senza montepremi. Il gate `reward-contraddizione` rifiutava
// l'ingresso in coda dicendo che il venue non paga: un motivo FALSO per un blocco altrimenti corretto.
//
// ═══ LA REGOLA ERA GIÀ SCRITTA, IN UN ALTRO MODULO ═══════════════════════════════════════════════════
// `lib/maker/market-validity.js:88-92` la dice per esteso: «è illeggibile, non è zero. Zero significa
// "tolto dal programma", ed è una conclusione che si può trarre solo da un numero davvero letto».
// Quel modulo restituiva tre stati; questo ne restituiva due. Stessa domanda, due epistemiche.
//
// ═══ COSA NON CAMBIA ═════════════════════════════════════════════════════════════════════════════════
// La DECISIONE. Su un montepremi non letto non si impegna capitale, esattamente come su uno che
// contraddice il piano: il gate rifiuta in entrambi i casi. Cambia solo che adesso dice il vero.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ROOT = path.resolve(__dirname, '..', '..');
const M = require('./market-search');

console.log('\n══ 1 · I TRE STATI, UNO PER UNO');
{
  const casi = [
    ['array con rate 30', { clobRewards: [{ rewardsDailyRate: 30 }] }, 'premiato', 30],
    ['array vuoto — il venue HA parlato', { clobRewards: [] }, 'senza-premio', 0],
    ['rate 0 — letto e non paga', { clobRewards: [{ rewardsDailyRate: 0 }] }, 'senza-premio', 0],
    ['campo ASSENTE', {}, 'illeggibile', null],
    ['campo null', { clobRewards: null }, 'illeggibile', null],
    ['rate non numerico', { clobRewards: [{ rewardsDailyRate: 'boh' }] }, 'illeggibile', null],
  ];
  for (const [nome, m, atteso, rate] of casi) {
    const s = M.rewardStateOf(m);
    ok(`${nome} → ${atteso}`, s.stato === atteso && s.rate === rate, `rate=${s.rate}`);
  }
  ok('ogni stato porta il suo perché', casi.every(([, m]) => {
    const p = M.rewardStateOf(m).perche;
    return typeof p === 'string' && p.length > 10;
  }));
}

console.log('\n══ 2 · LA FORMA STRINGA — il meccanismo più probabile dell intermittenza');
{
  // Gamma serializza alcuni campi JSON come stringhe e non è coerente su quali: in UNA sola risposta,
  // misurata il 5 agosto, `clobRewards` array e `clobTokenIds`/`outcomes`/`outcomePrices` stringhe.
  // `tokenIdsOf` si difendeva già; `rewardRateOf` no, e con `Array.isArray` falso il mercato risultava
  // senza montepremi.
  const s = M.rewardStateOf({ clobRewards: JSON.stringify([{ rewardsDailyRate: 30 }]) });
  ok('clobRewards come STRINGA viene interpretato', s.stato === 'premiato' && s.rate === 30);
  const rotta = M.rewardStateOf({ clobRewards: '{non json' });
  ok('  ma una stringa illeggibile NON diventa «non paga»', rotta.stato === 'illeggibile');
  const strana = M.rewardStateOf({ clobRewards: 42 });
  ok('  né una forma inattesa', strana.stato === 'illeggibile' && /forma inattesa/.test(strana.perche));
}

console.log('\n══ 3 · `hasRewards` NON PUÒ PIÙ AFFERMARE CIÒ CHE NON SA');
{
  const riga = (m) => M.normalizeMarket({ conditionId: '0x' + 'a'.repeat(64), ...m }, Date.now());
  const paga = riga({ clobRewards: [{ rewardsDailyRate: 30 }] });
  ok('paga → hasRewards true, rate 30, stato premiato',
    paga.hasRewards === true && paga.rewardsDailyRate === 30 && paga.rewardsStato === 'premiato');

  const nonPaga = riga({ clobRewards: [] });
  ok('non paga → hasRewards false, rate 0, stato senza-premio',
    nonPaga.hasRewards === false && nonPaga.rewardsDailyRate === 0 && nonPaga.rewardsStato === 'senza-premio');

  const ignoto = riga({});
  ok('NON LETTO → hasRewards false, rate null, stato illeggibile',
    ignoto.hasRewards === false && ignoto.rewardsDailyRate === null && ignoto.rewardsStato === 'illeggibile');
  ok('  e i due «false» si distinguono, che è tutto il punto',
    nonPaga.rewardsStato !== ignoto.rewardsStato && nonPaga.hasRewards === ignoto.hasRewards,
    'stesso booleano, stati diversi');
  ok('  «rate 0» e «rate null» non sono lo stesso numero',
    nonPaga.rewardsDailyRate === 0 && ignoto.rewardsDailyRate === null);
}

console.log('\n══ 4 · L ETICHETTA DICE DUE COSE DIVERSE');
{
  const paga = { hasRewards: true, rewardsDailyRate: 30, rewardsStato: 'premiato' };
  const nonPaga = { hasRewards: false, rewardsDailyRate: 0, rewardsStato: 'senza-premio' };
  const ignoto = { hasRewards: false, rewardsDailyRate: null, rewardsStato: 'illeggibile' };
  ok('paga → mostra la cifra', M.rewardLabelFor(paga) === 'reward 30$/g');
  ok('non paga → NESSUN REWARD', M.rewardLabelFor(nonPaga) === M.NO_REWARD_LABEL);
  ok('NON LETTO → un\'altra etichetta', M.rewardLabelFor(ignoto) === M.UNREADABLE_REWARD_LABEL);
  ok('  e non è quella di «non paga»', M.rewardLabelFor(ignoto) !== M.NO_REWARD_LABEL,
    M.UNREADABLE_REWARD_LABEL);
  // La retrocompatibilità: un chiamante che non passa `rewardsStato` non deve rompersi.
  ok('senza `rewardsStato` si ripiega su NESSUN REWARD, come prima',
    M.rewardLabelFor({ hasRewards: false, rewardsDailyRate: null }) === M.NO_REWARD_LABEL);
}

console.log('\n══ 5 · IL GATE RIFIUTA IN ENTRAMBI I CASI, MA DICE IL VERO');
{
  const route = fs.readFileSync(path.join(ROOT, 'app', 'api', 'maker', 'markets', 'enable', 'route.ts'), 'utf8');
  ok('la condizione di rifiuto è INVARIATA',
    /const contraddizionePot = potAtPlan != null && potAtPlan > 0 && m\.hasRewards !== true;/.test(route),
    'non si è allentato niente: si rifiuta come prima');
  ok('  ma il gate ha due nomi, uno per fatto',
    /gate: nonLetto \? 'reward-non-letto' : 'reward-contraddizione'/.test(route));
  ok('  e il messaggio del caso «non letto» non afferma che il venue non paga',
    /NON È STATO LETTO/.test(route) && /non vuol dire che il mercato non paghi/.test(route));
  ok('  con il motivo tecnico allegato', /rewardsPerche: m\.rewardsPerche/.test(route));
  ok('l avviso non bloccante distingue anche lui',
    /Montepremi NON LETTO al venue/.test(route) && /Non è la stessa cosa di «non paga»/.test(route));
}

console.log('\n══ 6 · NIENTE PIÙ COPIE DELLA STRINGA NEI PANNELLI');
{
  // L'intestazione del modulo lo dice: «a second copy of this string somewhere would be a second
  // answer to "does this market pay anything"». Ce n'erano tre.
  const console_ = fs.readFileSync(path.join(ROOT, 'app', 'components', 'LiquidityRewardsConsole.tsx'), 'utf8');
  const alloc = fs.readFileSync(path.join(ROOT, 'app', 'components', 'RewardsAllocatePanel.tsx'), 'utf8');
  ok('la console usa `rewardLabel`, non una copia', /data-lrc-no-reward>\{m\.rewardLabel\}/.test(console_));
  ok('il pannello di allocazione idem', /\{addPreview\.summary\.rewardLabel\}/.test(alloc));
  // Restano le occorrenze nei COMMENTI, che descrivono la convenzione: quelle vanno bene.
  const codice = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((r) => !/^\s*\/\//.test(r) && !/^\s*\*/.test(r)).join('\n');
  ok('  e la stringa non è più scritta a mano in nessuno dei due',
    !/NESSUN REWARD — solo trading direzionale/.test(codice(console_))
    && !/NESSUN REWARD — solo trading direzionale/.test(codice(alloc)));
}

console.log('\n══ 7 · SUL VENUE VERO, ADESSO');
{
  // Non una finzione: il mercato che il 5 agosto è stato riportato come non pagante.
  const { fetchMarketByConditionId } = M;
  const ID = '0xd1796c09d0d6f876f8580086ae9808ec991784e3a74b25a1830a25de71a78c96';
  const t = fetchMarketByConditionId(ID);
  t.then((r) => {
    if (!r.ok) {
      ok('lettura del venue riuscita', false, r.error);
    } else {
      ok('il mercato «Netanyahu» ha uno stato dichiarato', ['premiato', 'senza-premio', 'illeggibile'].includes(r.market.rewardsStato),
        `${r.market.rewardsStato} · rate ${r.market.rewardsDailyRate}`);
      ok('  e se è illeggibile NON viene chiamato «senza premio»',
        r.market.rewardsStato !== 'illeggibile' || r.market.rewardsDailyRate === null);
    }
    console.log(`\nmontepremi tre stati: ${pass} passati, ${fail} falliti`);
    process.exit(fail ? 1 : 0);
  });
}
