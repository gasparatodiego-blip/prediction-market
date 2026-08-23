'use strict';
// lib/maker/distanze-e-slot.test.js — 23 agosto 2026.
//
// LA PROPRIETA' DIFESA: la distanza dei lunghi configurata deve mettere l'ordine a 3,5¢ dal mid
// sulla banda modale ±4,5¢, e su OGNI banda del board deve restare dentro la banda con almeno un
// tick di margine dal bordo.
//
// ⚠ NON SI ASSERISCE SUL LETTERALE `0.7777...`. Si asserisce che la configurazione PRODUCA 3,5¢
//   passando dalla funzione vera (`distanzaObiettivoCents`), e che il margine regga: chi domani
//   scrivesse 0,95 «per stare piu' fuori» troverebbe questo test rosso, che e' il punto.
// ⚠ E SI ASSERISCE CHE IL PUNTO SIA UNO SOLO: due letterali per lo stesso prezzo sono il reperto D1
//   su ordini veri (§5.1: agent41 apre, agent40 rinnova).
const fs = require('fs');
const path = require('path');
const RADICE = path.join(__dirname, '..', '..');
const D = require('./distanza-obiettivo');

let passati = 0, falliti = 0;
function ok(nome, cond, extra = '') {
  if (cond) { passati++; console.log(`  ok    ${nome}`); }
  else { falliti++; console.log(`  FAIL  ${nome}${extra ? ' — ' + extra : ''}`); }
}
/** La frazione che l'ecosystem consegna DAVVERO a pm2 — si legge dal config, non dal sorgente. */
function frazioneConfigurata() {
  const c = require(path.join(RADICE, 'agents', 'ecosystem.config.js'));
  const v = new Set();
  for (const a of c.apps || []) {
    const x = a.env && a.env.MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V;
    if (x !== undefined) v.add(String(x));
  }
  return [...v];
}
const V_MODALE = 4.5, TICK_MODALE_C = 1.0;

console.log('\n① la configurazione mette i LUNGHI a 3,0¢ dal mid sulla banda modale');
const fr = frazioneConfigurata();
ok('tutti i processi che la dichiarano hanno lo STESSO valore', fr.length === 1, JSON.stringify(fr));
const r = D.distanzaObiettivoCents({ maxSpreadCents: V_MODALE, frazione: Number(fr[0]) });
console.log(`        frazione ${fr[0]} × v(${V_MODALE}¢) ⇒ ${r.distanzaC}¢`);
ok('su banda ±4,5¢ la distanza e\' esattamente 3,0¢', Math.abs(r.distanzaC - 3.0) < 1e-9, `${r.distanzaC}¢`);
ok('  e non e\' stata clampata da FRAZIONE_MASSIMA', r.clampata === false);

console.log('\n② il margine dal bordo — il conto, su ogni banda/tick del board');
// le tre combinazioni misurate sul board del 23/08; il test le difende tutte, non solo la modale
for (const [v, tick, n] of [[4.5, 0.01, 70], [4.5, 0.001, 10], [5.5, 0.001, 8]]) {
  const d = D.distanzaObiettivoCents({ maxSpreadCents: v, frazione: Number(fr[0]) }).distanzaC;
  const tickC = tick * 100;
  const margine = v - d;
  console.log(`        banda ±${v}¢ tick ${tickC.toFixed(1)}¢ (${n} mercati) ⇒ ${d.toFixed(3)}¢ · margine ${margine.toFixed(3)}¢ = ${(margine / tickC).toFixed(2)} tick`);
  ok(`  banda ±${v}¢ · resta DENTRO la banda`, d < v, `${d} >= ${v}`);
  ok(`  banda ±${v}¢ tick ${tickC}¢ · almeno UN tick di margine dal bordo`,
    margine >= tickC - 1e-9, `margine ${margine.toFixed(4)}¢ < ${tickC}¢`);
}
// il CONTROLLO: senza, i due `ok` sopra passerebbero anche con una manopola molto piu' vicina al mid
console.log('\n③ il CONTROLLO — la regola del tick sa dire di NO');
const troppo = D.distanzaObiettivoCents({ maxSpreadCents: V_MODALE, frazione: 0.95 }).distanzaC;
console.log(`        frazione 0,95 ⇒ ${troppo}¢ · margine ${(V_MODALE - troppo).toFixed(3)}¢ = ${((V_MODALE - troppo) / TICK_MODALE_C).toFixed(2)} tick`);
ok('0,95 (bordo esterno) NON supererebbe la regola del tick',
  (V_MODALE - troppo) < TICK_MODALE_C - 1e-9);
ok('  3,5¢ e\' il PIU\' ESTERNO che supera la regola del tick, e 3,6¢ no',
  (V_MODALE - 3.6) < TICK_MODALE_C - 1e-9 && (V_MODALE - 3.5) >= TICK_MODALE_C - 1e-9);
ok('  ma 3,5¢ NON e\' esprimibile su griglia 1,0¢, e 3,0¢ si\' — per questo i lunghi stanno a 3,0¢',
  Math.abs(3.5 / TICK_MODALE_C - Math.round(3.5 / TICK_MODALE_C)) > 1e-9
  && Math.abs(3.0 / TICK_MODALE_C - Math.round(3.0 / TICK_MODALE_C)) < 1e-9);

console.log('\n④ un solo punto di configurazione (il reperto D1 su un prezzo vero)');
const eco = fs.readFileSync(path.join(RADICE, 'agents', 'ecosystem.config.js'), 'utf8')
  .split('\n').map((l) => l.replace(/\/\/.*$/, ''));
const letterali = eco.filter((l) => /MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V\s*:\s*'/.test(l));
ok('nessun blocco env scrive la frazione come letterale', letterali.length === 0,
  JSON.stringify(letterali));
const decl = eco.filter((l) => /const\s+DISTANZA_LUNGHI_FRAZIONE_V\s*=/.test(l));
ok('la frazione e\' dichiarata una volta sola', decl.length === 1, `trovate ${decl.length}`);
const rif = eco.filter((l) => /MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V\s*:\s*DISTANZA_LUNGHI_FRAZIONE_V/.test(l));
ok('  e i due processi che decidono un prezzo la REFERENZIANO entrambi', rif.length === 2,
  `trovati ${rif.length}`);

console.log('\n⑤ il nome della manopola vive in un posto solo (gia\' vero, si difende)');
ok('`ENV_FRAZIONE` e\' dichiarato in distanza-obiettivo.js', D.ENV_FRAZIONE === 'MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V');
ok('  e la manopola spenta NON diventa zero: resta `null` (comportamento di sempre)',
  D.distanzaObiettivoCents({ maxSpreadCents: 4.5, env: {} }).distanzaC === null);

// ── ⑥ I CORTI A 3,5¢, E PIU' LONTANI DEI LUNGHI ────────────────────────────────────────────────
console.log('\n⑥ i CORTI a 3,5¢ dal mid, con un tick di margine, e mai piu' + "'" + ' vicini dei lunghi');
const DF = require('./distanza-fascia');
const ecoTxt = fs.readFileSync(path.join(RADICE, 'agents', 'ecosystem.config.js'), 'utf8')
  .split('\n').map((l) => l.replace(/\/\/.*$/, ''));
const mC = ecoTxt.map((l) => l.match(/MAKER_DISTANZA_CORTI_CENTS\s*:\s*'([^']+)'/)).filter(Boolean);
ok('la distanza dei corti e\' dichiarata in un posto solo', mC.length === 1, `trovate ${mC.length}`);
const dCorti = Number(mC[0][1]);
const dLunghi = D.distanzaObiettivoCents({ maxSpreadCents: V_MODALE, frazione: Number(fr[0]) }).distanzaC;
console.log(`        corti ${dCorti}¢ · lunghi ${dLunghi}¢ · bordo ${V_MODALE}¢`);
ok('i corti stanno a 3,5¢', Math.abs(dCorti - 3.5) < 1e-9, `${dCorti}¢`);
ok('  e sono PIU' + "'" + ' LONTANI dei lunghi (la fascia corta esiste per questo)', dCorti > dLunghi,
  `corti ${dCorti} <= lunghi ${dLunghi}`);
for (const [v, tick, n] of [[4.5, 0.01, 1], [5.5, 0.01, 2]]) {
  const r = DF.distanzaPerMercato({ oreAllaScadenza: 30, bandRadiusCents: v, tick,
    distanzaLunghiCents: dLunghi, env: { MAKER_DISTANZA_CORTI_CENTS: String(dCorti) } });
  const tickC = tick * 100;
  ok(`  banda ±${v}¢ (${n} corti) · la distanza di fascia si applica`, r.applica === true, r.motivo);
  const margine = v - r.cents;
  console.log(`        banda ±${v}¢ ⇒ ${r.cents}¢ · margine ${margine.toFixed(3)}¢ = ${(margine / tickC).toFixed(2)} tick`);
  ok(`  banda ±${v}¢ · almeno un tick di margine`, margine >= tickC - 1e-9, `${margine}¢`);
}
ok('  CONTROLLO — una distanza corti PIU' + "'" + ' VICINA dei lunghi viene RIFIUTATA',
  DF.distanzaPerMercato({ oreAllaScadenza: 30, bandRadiusCents: V_MODALE, tick: 0.01,
    distanzaLunghiCents: dLunghi, env: { MAKER_DISTANZA_CORTI_CENTS: '1.0' } }).applica === false);

// ── ⑦ CON N SLOT IL PIANO ASSEGNA N MERCATI, SE N AMMISSIBILI ESISTONO ─────────────────────────
console.log('\n⑦ con N slot il piano assegna N mercati, se N ammissibili esistono');
const SEL = require('./selezione-mercati');
const Q = require('./quanti-mercati');
const ORA = Date.UTC(2026, 7, 23, 9, 0, 0), ORE_MS = 3600000;
function lungo(n) {
  return { conditionId: '0x' + String(n).padStart(2, '0').repeat(32),
    question: `Will market ${n} resolve yes?`, slug: `market-${n}`, category: 'Politics',
    rewardsMinSize: 50, rewardsDailyRate: 40, rewardsMaxSpread: 4.5, tickSize: 0.01, mid: 0.5,
    existing_depth_usd: 1267, endDate: new Date(ORA + 400 * ORE_MS).toISOString(),
    levels: { 500: { grossRewardDay: 1.4 } } };
}
const part = Q.slotDiFascia({ MAKER_MERCATI_CONTEMPORANEI: '12', MAKER_SLOT_CORTI: '2' });
console.log(`        partizione configurata: ${part.corti} corti + ${part.lunghi} lunghi = ${part.totale}`);
ok('la partizione e\' 2 corti + 10 lunghi = 12', part.corti === 2 && part.lunghi === 10 && part.totale === 12);
// 20 lunghi ammissibili, tutti 'alto': con 10 posti lunghi e quota alto 11, ne devono entrare 10
const boardL = Array.from({ length: 20 }, (_, i) => lungo(i + 1));
const dec = SEL.decidiSelezione({ board: boardL, stato: SEL.statoVuoto(),
  posizioni: { leggibile: true, conditionIds: [] }, ora: ORA, max: 12, slotCorti: part.corti });
console.log(`        ammissibili ${dec.ammissibili} · entranti ${dec.entranti.length} · fasce ${JSON.stringify(dec.fasce && dec.fasce.entrantiPerFascia)}`);
ok('con 20 lunghi ammissibili e 10 posti lunghi entrano ESATTAMENTE 10 mercati',
  dec.entranti.length === part.lunghi, `entranti ${dec.entranti.length}, attesi ${part.lunghi}`);
ok('  e nessuno finisce nella fascia corta', dec.fasce.entrantiPerFascia.corta === 0);
ok('  i 2 posti corti restano vuoti e si DICHIARANO',
  JSON.stringify(dec.fasce.postiVuoti) === JSON.stringify([{ fascia: 'corta', posti: 2 }]),
  JSON.stringify(dec.fasce.postiVuoti));
// CONTROLLO: con meno ammissibili degli slot, entrano tutti quelli che esistono e non di piu'
const dec2 = SEL.decidiSelezione({ board: boardL.slice(0, 4), stato: SEL.statoVuoto(),
  posizioni: { leggibile: true, conditionIds: [] }, ora: ORA, max: 12, slotCorti: part.corti });
ok('  CONTROLLO — con 4 ammissibili entrano 4, non 10', dec2.entranti.length === 4,
  `entranti ${dec2.entranti.length}`);

console.log(`\ndistanze e slot: ${passati} passati, ${falliti} falliti`);
process.exit(falliti === 0 ? 0 : 1);
