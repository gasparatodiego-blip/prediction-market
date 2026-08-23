'use strict';
// lib/maker/distanza-lunghi-35.test.js — 23 agosto 2026.
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

console.log('\n① la configurazione mette i lunghi a 3,5¢ dal mid sulla banda modale');
const fr = frazioneConfigurata();
ok('tutti i processi che la dichiarano hanno lo STESSO valore', fr.length === 1, JSON.stringify(fr));
const r = D.distanzaObiettivoCents({ maxSpreadCents: V_MODALE, frazione: Number(fr[0]) });
console.log(`        frazione ${fr[0]} × v(${V_MODALE}¢) ⇒ ${r.distanzaC}¢`);
ok('su banda ±4,5¢ la distanza e\' esattamente 3,5¢', Math.abs(r.distanzaC - 3.5) < 1e-9, `${r.distanzaC}¢`);
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
ok('  e 3,5¢ e\' il PIU\' ESTERNO che la supera: 3,6¢ non la supererebbe',
  (V_MODALE - 3.6) < TICK_MODALE_C - 1e-9 && (V_MODALE - 3.5) >= TICK_MODALE_C - 1e-9);

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

console.log(`\ndistanza dei lunghi a 3,5¢: ${passati} passati, ${falliti} falliti`);
process.exit(falliti === 0 ? 0 : 1);
