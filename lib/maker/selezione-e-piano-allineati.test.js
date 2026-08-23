'use strict';
// lib/maker/selezione-e-piano-allineati.test.js — 23 agosto 2026.
//
// DUE PROPRIETA':
//   ① un occupante che il PIANO dichiara in perdita non tiene il posto contro uno sfidante che il
//      piano finanzierebbe, nemmeno se stanno in secchi diversi — purche' lo scambio muova la
//      composizione VERSO la quota decisa dall'operatore.
//   ② la distanza a cui il piano giudica esce dalla stessa funzione che decide dove il motore posta,
//      e non e' un letterale.
const fs = require('fs');
const path = require('path');
const RADICE = path.join(__dirname, '..', '..');
const SEL = require('./selezione-mercati');

let passati = 0, falliti = 0;
function ok(nome, cond, extra = '') {
  if (cond) { passati++; console.log(`  ok    ${nome}`); }
  else { falliti++; console.log(`  FAIL  ${nome}${extra ? ' — ' + extra : ''}`); }
}
const ORA = Date.UTC(2026, 7, 23, 10, 0, 0), ORE = 3600000;
const POS = { leggibile: true, conditionIds: [] };
function mkt(n, minSize, giorni = 100) {
  return { conditionId: '0x' + String(n).padStart(4, '0').repeat(16),
    question: `Will market ${n} resolve yes?`, slug: `market-${n}`, category: 'Politics',
    rewardsMinSize: minSize, rewardsDailyRate: 40, rewardsMaxSpread: 4.5, tickSize: 0.01,
    mid: 0.5, existing_depth_usd: 1267,
    endDate: new Date(ORA + giorni * 24 * ORE).toISOString(), levels: { 500: { grossRewardDay: 1.4 } } };
}
const id = (n) => '0x' + String(n).padStart(4, '0').repeat(16);

// ── ① LO SCAMBIO CHE ERA BLOCCATO DAL SECCHIO ──────────────────────────────────────────────────
console.log('\n① un occupante in PERDITA non e\' protetto dal secchio, se lo scambio avvicina la quota');
// 12 occupanti: 11 «alto» (minSize 50) + 1 «basso» (minSize 20). Quota a 12 = 4 basso + 8 alto,
// quindi «alto» e' SOPRA quota (11 > 8) e «basso» SOTTO (1 < 4): la deroga puo' applicarsi.
const occupanti = [mkt(1, 20), ...Array.from({ length: 11 }, (_, i) => mkt(10 + i, 50))];
const sfidante = mkt(90, 20);                       // «basso», fuori
const board = [...occupanti, sfidante];
const stato = { versione: 1, attiva: true, selezionati: {} };
for (const m of occupanti) {
  stato.selezionati[m.conditionId] = { entratoAt: ORA - 6 * ORE, question: m.question,
    uscenteDal: null, motivoUscita: null,
    scaglione: Number(m.rewardsMinSize) <= 20 ? 'basso' : 'alto',
    categoria: 'politics', inGestione: false, inGestioneDal: null };
}
const q = SEL.quotaScaglioni(12);
console.log(`        quota a 12: ${q.map((x) => x.chiave + ' ' + x.posti).join(' · ')} · occupanti: basso 1 · alto 11`);
// netti: l'occupante «alto» n.10 perde, lo sfidante «basso» rende
// ⚠ IL FIXTURE DEVE ISOLARE LA DEROGA. L'unico occupante «basso» ha un netto ALTISSIMO: cosi' la
// regola di sempre (stesso secchio) non puo' scattare, e se uno scambio avviene e' la deroga.
const netto = {};
for (const m of board) netto[m.conditionId.toLowerCase()] = 1.0;
netto[id(1).toLowerCase()] = 999.0;                 // occupante «basso» IMBATTIBILE
netto[id(10).toLowerCase()] = -5.0;                 // occupante «alto» in PERDITA
netto[id(90).toLowerCase()] = 20.0;                 // sfidante «basso» che RENDE
const comune = { board, stato, posizioni: POS, ora: ORA, max: 12, slotCorti: 2,
  conOrdiniVivi: { leggibile: true, ids: [] } };
const r = SEL.decidiSelezione({ ...comune, nettoPerMercato: netto });
console.log(`        spodestati ${(r.spodestati || []).length} · entranti ${(r.entranti || []).length}`);
ok('lo sfidante «basso» spodesta l\'occupante «alto» in perdita',
  (r.spodestati || []).length === 1
  && String(r.spodestati[0].id).toLowerCase() === id(10).toLowerCase()
  && String(r.spodestati[0].sostituitoDa).toLowerCase() === id(90).toLowerCase(),
  JSON.stringify((r.spodestati || []).map((x) => [x.id.slice(0, 8), x.sostituitoDa.slice(0, 8)])));
ok('  e la composizione si muove VERSO la quota (basso 1 → 2, alto 11 → 10)', (() => {
  const c = { basso: 0, alto: 0 };
  for (const v of Object.values(r.statoNuovo.selezionati)) c[v.scaglione] += 1;
  return c.basso === 2 && c.alto === 10;
})());
ok('  gli slot restano 12, non 13', Object.keys(r.statoNuovo.selezionati).length === 12);

// ── ② LE QUATTRO CONDIZIONI, UNA ALLA VOLTA: ognuna da sola BLOCCA ─────────────────────────────
console.log('\n② le quattro condizioni della deroga, e ognuna da sola la blocca');
// ① occupante NON in perdita
const nA = { ...netto }; nA[id(10).toLowerCase()] = +0.1;   // nessun «alto» in perdita
ok('occupante con netto POSITIVO ⇒ niente deroga',
  (SEL.decidiSelezione({ ...comune, nettoPerMercato: nA }).spodestati || []).length === 0);
// ② sfidante NON in guadagno
const nB = { ...netto }; nB[id(90).toLowerCase()] = -1.0;
ok('sfidante con netto NEGATIVO ⇒ niente deroga',
  (SEL.decidiSelezione({ ...comune, nettoPerMercato: nB }).spodestati || []).length === 0);
// ③/④ la composizione NON migliora: sfidante «alto» come l'occupante ⇒ è la regola di sempre, non la deroga
const boardC = [...occupanti, mkt(91, 50)];
const nC = { ...netto }; nC[id(91).toLowerCase()] = 20.0; delete nC[id(90).toLowerCase()];
const rC = SEL.decidiSelezione({ ...comune, board: boardC, nettoPerMercato: nC });
ok('  sfidante dello STESSO secchio: lo scambio avviene per la regola di sempre, non per la deroga',
  (rC.spodestati || []).length === 1
  && String(rC.spodestati[0].sostituitoDa).toLowerCase() === id(91).toLowerCase());
// fail-closed: netto non iniettato
ok('netto NON iniettato ⇒ nessuno spodestamento (fail-closed)',
  (SEL.decidiSelezione({ ...comune, nettoPerMercato: null }).spodestati || []).length === 0);
// fail-closed: netto dello sfidante non finito
const nD = { ...netto }; nD[id(90).toLowerCase()] = null;
ok('netto dello sfidante non leggibile ⇒ niente deroga',
  (SEL.decidiSelezione({ ...comune, nettoPerMercato: nD }).spodestati || []).length === 0);

// ── ③ LA DEROGA NON SI APPLICA QUANDO IL SECCHIO E' GIA' A POSTO ───────────────────────────────
console.log('\n③ con la composizione GIA\' alla quota la deroga non si apre');
// 4 basso + 8 alto = esattamente la quota: nessun secchio e' sopra, nessuno sotto
const occ2 = [...Array.from({ length: 4 }, (_, i) => mkt(20 + i, 20)),
              ...Array.from({ length: 8 }, (_, i) => mkt(30 + i, 50))];
const stato2 = { versione: 1, attiva: true, selezionati: {} };
for (const m of occ2) {
  stato2.selezionati[m.conditionId] = { entratoAt: ORA - 6 * ORE, question: m.question,
    uscenteDal: null, motivoUscita: null,
    scaglione: Number(m.rewardsMinSize) <= 20 ? 'basso' : 'alto',
    categoria: 'politics', inGestione: false, inGestioneDal: null };
}
const n2 = {}; for (const m of [...occ2, sfidante]) n2[m.conditionId.toLowerCase()] = 999.0;
n2[id(30).toLowerCase()] = -5.0; n2[id(90).toLowerCase()] = 20.0;   // i «basso» sono imbattibili
const r2 = SEL.decidiSelezione({ board: [...occ2, sfidante], stato: stato2, posizioni: POS,
  ora: ORA, max: 12, slotCorti: 2, conOrdiniVivi: { leggibile: true, ids: [] }, nettoPerMercato: n2 });
ok('composizione gia\' 4+8 ⇒ nessuno scambio fra secchi diversi',
  (r2.spodestati || []).length === 0, JSON.stringify((r2.spodestati || []).map((x) => x.id.slice(0, 8))));

// ── ④ LA DISTANZA DEL PIANO ESCE DALLA FUNZIONE VERA ──────────────────────────────────────────
console.log('\n④ il piano giudica alla distanza a cui il motore posta, e il numero non e\' ricopiato');
const src = fs.readFileSync(path.join(RADICE, 'agents', 'agent41-realloc-scheduler.js'), 'utf8')
  .split('\n').map((l) => l.replace(/\/\/.*$/, ''));
ok('esiste UN solo punto che costruisce l\'offset del piano',
  src.filter((l) => /function conDistanzaDiPiano/.test(l)).length === 1);
// ⚠ si contano le CHIAMATE, non la definizione: `function conDistanzaDiPiano(` matcherebbe anche lei.
const chiamate = src.filter((l) => /conDistanzaDiPiano\(/.test(l) && !/function\s+conDistanzaDiPiano/.test(l));
ok('  e lo usano ENTRAMBI i piani (operativo e netti dei candidati)',
  chiamate.length === 2, String(chiamate.length));
ok('  la distanza esce da `distanzaObiettivoCents`, non da un letterale',
  src.some((l) => /distanzaObiettivoCents\(/.test(l)));
ok('  e passa `offsetTicks: null`, senza il quale i tick non sarebbero centesimi',
  src.some((l) => /offsetTicks:\s*null/.test(l)));
// il CONTROLLO aritmetico: 3 tick valgono 3,0¢ su griglia 1¢ ma 0,3¢ su griglia 0,1¢
ok('  CONTROLLO — 3 TICK non sono 3,0¢ su ogni griglia: 3 × 0,1¢ = 0,3¢',
  Math.abs(3 * 0.1 - 0.3) < 1e-9 && Math.abs(3 * 1.0 - 3.0) < 1e-9);
const D = require('./distanza-obiettivo');
const dv = D.distanzaObiettivoCents({ maxSpreadCents: 4.5, frazione: 3 / 4.5 });
ok(`  e sulla banda modale la distanza del piano e' ${dv.distanzaC}¢, la stessa del motore`,
  Math.abs(dv.distanzaC - 3.0) < 1e-9, `${dv.distanzaC}`);

console.log(`\nselezione e piano allineati: ${passati} passati, ${falliti} falliti`);
process.exit(falliti === 0 ? 0 : 1);
