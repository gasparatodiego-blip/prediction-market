'use strict';
// lib/maker/scansione-e-quota.test.js — 23 agosto 2026.
//
// DUE PROPRIETA', ed entrambe mordono sul COMPORTAMENTO:
//   ① la selezione non ha un tetto proprio: un board grande viene valutato TUTTO, riga per riga.
//      Alzare `REWARD_MAX_CLOB_MARKETS` deve tradursi in mercati valutati, non fermarsi a monte.
//   ② con quota «basso» 4 su 12, un board con ≥ 4 candidati «basso» deve produrre 4 assegnazioni
//      «basso» — non una, che era il comportamento fino a stamattina.
const fs = require('fs');
const path = require('path');
const RADICE = path.join(__dirname, '..', '..');
const SEL = require('./selezione-mercati');

let passati = 0, falliti = 0;
function ok(nome, cond, extra = '') {
  if (cond) { passati++; console.log(`  ok    ${nome}`); }
  else { falliti++; console.log(`  FAIL  ${nome}${extra ? ' — ' + extra : ''}`); }
}
const ORA = Date.UTC(2026, 7, 23, 9, 0, 0), ORE = 3600000;
const POS = { leggibile: true, conditionIds: [] };

/** minSize 20 ⇒ «basso» · minSize 50 ⇒ «alto». Lunghi per costruzione (400 h). */
function mkt(n, minSize) {
  return { conditionId: '0x' + String(n).padStart(4, '0').repeat(16),
    question: `Will market ${n} resolve yes?`, slug: `market-${n}`, category: 'Politics',
    rewardsMinSize: minSize, rewardsDailyRate: 40 + (n % 7), rewardsMaxSpread: 4.5,
    tickSize: 0.01, mid: 0.5, existing_depth_usd: 1267,
    endDate: new Date(ORA + 400 * ORE).toISOString(), levels: { 500: { grossRewardDay: 1.4 } } };
}

// ── ① IL TETTO DI SCANSIONE ARRIVA FINO IN FONDO ───────────────────────────────────────────────
console.log('\n① un board grande viene valutato TUTTO: la selezione non ha un tetto proprio');
const TETTO = (() => {
  const src = fs.readFileSync(path.join(RADICE, 'agents', 'agent24-liquidity-rewards.js'), 'utf8')
    .split('\n').map((l) => l.replace(/\/\/.*$/, ''));
  const m = src.map((l) => l.match(/REWARD_MAX_CLOB_MARKETS\)\s*:\s*(\d+)/)).filter(Boolean);
  return { valori: m.map((x) => Number(x[1])) };
})();
ok('il tetto di scansione e\' dichiarato in un posto solo', TETTO.valori.length === 1,
  JSON.stringify(TETTO.valori));
const tetto = TETTO.valori[0];
console.log(`        REWARD_MAX_CLOB_MARKETS (difetto) = ${tetto}`);
ok('il tetto e\' stato alzato sopra i 300 di prima', tetto > 300, `${tetto}`);
// ⚠ il conto del cronometro: overhead 113 s misurato, periodo 900 s, ritmo PEGGIORE osservato 2,29 s/mkt
const OVERHEAD_S = 113, PERIODO_S = 900, RITMO_PEGGIORE = 2.29;
const massimoCheCiSta = Math.floor((PERIODO_S - OVERHEAD_S) / RITMO_PEGGIORE);
console.log(`        massimo che sta nel periodo al ritmo PEGGIORE (${RITMO_PEGGIORE} s/mkt) = ${massimoCheCiSta}`);
ok(`il tetto sta nel periodo anche al ritmo peggiore (${tetto} ≤ ${massimoCheCiSta})`,
  tetto <= massimoCheCiSta, `${tetto} > ${massimoCheCiSta}`);
ok('  CONTROLLO — 382 NON ci starebbe al ritmo peggiore', 382 > massimoCheCiSta);
// e la selezione valuta tutto quello che le arriva
const boardGrande = Array.from({ length: 400 }, (_, i) => mkt(i + 1, i % 2 === 0 ? 20 : 50));
const gr = SEL.decidiSelezione({ board: boardGrande, stato: SEL.statoVuoto(), posizioni: POS,
  ora: ORA, max: 12, slotCorti: 2 });
console.log(`        board 400 righe ⇒ valutati ${gr.valutati} · ammissibili ${gr.ammissibili}`);
ok('un board di 400 righe viene valutato TUTTO (nessun tetto nella selezione)',
  gr.valutati === 400, `valutati ${gr.valutati}`);
ok('  e con ≥382 righe ammissibili la selezione le considera tutte',
  gr.ammissibili >= 382, `ammissibili ${gr.ammissibili}`);

// ── ② LA QUOTA «BASSO» E' 4 SU 12, E PRODUCE 4 ASSEGNAZIONI ────────────────────────────────────
console.log('\n② con quota «basso» 4 su 12, ≥4 candidati «basso» ⇒ 4 assegnazioni');
const q12 = SEL.quotaScaglioni(12);
const qb = q12.find((x) => x.chiave === 'basso').posti;
const qa = q12.find((x) => x.chiave === 'alto').posti;
console.log(`        quotaScaglioni(12) = basso ${qb} · alto ${qa}`);
ok('la quota «basso» a N=12 e\' 4', qb === 4, `${qb}`);
ok('  e la somma E\' il tetto, per costruzione', qb + qa === 12);
// un board con 6 «basso» e 6 «alto», tutti lunghi: devono entrare 4 basso + 8 alto? no: 6 alto esistono
const misto = [...Array.from({ length: 6 }, (_, i) => mkt(100 + i, 20)),
               ...Array.from({ length: 8 }, (_, i) => mkt(200 + i, 50))];
const r2 = SEL.decidiSelezione({ board: misto, stato: SEL.statoVuoto(), posizioni: POS,
  ora: ORA, max: 12, slotCorti: 2 });
const perScaglione = r2.entranti.reduce((a, e) => { a[e.scaglione] = (a[e.scaglione] || 0) + 1; return a; }, {});
console.log(`        entranti ${r2.entranti.length} · per scaglione ${JSON.stringify(perScaglione)}`);
ok('entrano ESATTAMENTE 4 «basso»', perScaglione.basso === 4, JSON.stringify(perScaglione));
// ⚠ NON sono 8: le due partizioni sono ORTOGONALI e vince la piu' stretta. Con `slotCorti: 2` i
// posti LUNGHI sono 10, e tutti i candidati qui sono lunghi ⇒ entrano 10 in tutto, di cui 4 «basso»
// (la quota) e 6 «alto» (il resto dei posti lunghi), non 8. La quota «alto» (8) non morde.
ok('  e 6 «alto», cioe\' i posti LUNGHI rimasti: vince la partizione piu\' stretta',
  perScaglione.alto === 6, JSON.stringify(perScaglione));
ok('  in tutto 10 entranti = i posti di fascia LUNGA, non i 12 slot',
  r2.entranti.length === 10, `${r2.entranti.length}`);
ok('  e i 2 posti CORTI restano vuoti, dichiarati',
  JSON.stringify(r2.fasce.postiVuoti) === JSON.stringify([{ fascia: 'corta', posti: 2 }]),
  JSON.stringify(r2.fasce.postiVuoti));
ok('  i 2 «basso» in eccesso restano fuori con `quota-scaglione-piena`',
  (r2.scartatiPerComposizione || []).filter((x) => x.scaglione === 'basso').length === 2,
  JSON.stringify(r2.scartatiPerComposizione));
// il CONTROLLO: con la regola VECCHIA (1 basso) ne sarebbe entrato UNO
ok('  CONTROLLO — la regola di prima (1 posto «basso») avrebbe fatto entrare 1, non 4', qb !== 1);
// e a N=3 la regola dell'operatore e' intatta
const q3 = SEL.quotaScaglioni(3);
ok('  a N=3 resta 1 basso + 2 alti, la regola originale dell\'operatore',
  q3.find((x) => x.chiave === 'basso').posti === 1 && q3.find((x) => x.chiave === 'alto').posti === 2);

// ── ③ LA QUOTA NON MUOVE IL CAPITALE ───────────────────────────────────────────────────────────
console.log('\n③ la composizione decide QUALI mercati, mai QUANTI né QUANTO capitale');
const C = require('../rewards/concentration');
const cap = JSON.parse(fs.readFileSync(path.join(RADICE, 'data', 'safety-risk-limits.json'), 'utf8')).global.maxOpenNotionalUsd;
ok('esposizioneMassimaRaggiungibileUsd(12) non contiene la quota',
  C.esposizioneMassimaRaggiungibileUsd(12) === 12 * 2 * 61.25);
ok(`  e resta dentro il cap ($${cap})`, C.esposizioneMassimaRaggiungibileUsd(12) <= cap,
  `${C.esposizioneMassimaRaggiungibileUsd(12)} > ${cap}`);
ok('  il soffitto del nozionale a riposo e\' cap/2 e NON dipende da N',
  [6, 12, 24].every((n) => C.esposizioneMassimaRaggiungibileUsd(n) / 2 / n === 61.25));

console.log(`\nscansione e quota: ${passati} passati, ${falliti} falliti`);
process.exit(falliti === 0 ? 0 : 1);
