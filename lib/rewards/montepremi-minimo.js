'use strict';
// lib/rewards/montepremi-minimo.js — IL PAVIMENTO SUL MONTEPREMI DEL MERCATO, IN UN POSTO SOLO.
//
// ═══ PERCHÉ ESISTE ═══════════════════════════════════════════════════════════════════════════════════
// Fino al 7 agosto 2026 l'unico requisito per entrare nell'universo era `pot > 0`. Un mercato che paga
// $5 al giorno in tutto entrava esattamente come uno che ne paga $600, e poi competeva sullo stesso
// piano nel knapsack. Il knapsack non sbaglia — pesa il premio atteso — ma su un montepremi da $5 la
// quota che possiamo prenderci è irrilevante qualunque cosa facciamo, e ogni dollaro fermo lì è un
// dollaro che non sta su un mercato dove conta.
//
// ═══ IL NUMERO, E DA DOVE VIENE ══════════════════════════════════════════════════════════════════════
// $25 al giorno. Misurato su 21 maker che guadagnano davvero (data/manuale-operativo-maker-v2.md): il
// montepremi mediano dei mercati che scelgono è $47/giorno, Q1 $10, Q3 $300. E il montepremi è uno dei
// POCHI parametri con correlazione POSITIVA con la resa (ρ +0,34 su n=15) — quasi tutti gli altri, in
// particolare quelli di scala, correlano al contrario.
//
// $25 sta fra la mediana e il primo quartile del campione: taglia la coda povera senza inseguire solo
// i mercati grossi, dove l'affollamento è massimo. Sul nostro board del 7 agosto 2026 (117 mercati,
// montepremi mediano $11) lascia 44 mercati — quattro volte le posizioni che teniamo aperte, quindi il
// filtro seleziona senza mai svuotare l'universo.
//
// ═══ COSA NON FA ═════════════════════════════════════════════════════════════════════════════════════
// Non è un filtro a valle su un piano già calcolato, ed è deliberato: un mercato sotto il pavimento non
// deve nemmeno arrivare al knapsack, altrimenti comparirebbe fra i candidati valutati e chi legge il
// registro non capirebbe perché è stato scartato. Il rifiuto è esplicito e ha un suo codice.
//
// Non giudica un montepremi ILLEGGIBILE. `null` non è `0`: se il venue non ha detto quanto paga, questo
// modulo risponde che non lo sa e la decisione resta a chi chiama. Confondere «non l'ho letto» con «non
// paga» è lo stesso errore che il 3 agosto 2026 fece raccontare $124/g a una cache mentre il venue
// diceva $3 — in quel caso in eccesso, qui sarebbe in difetto, e in entrambi i casi è un numero inventato.

/** Il pavimento dichiarato, in dollari di montepremi giornaliero del mercato. */
const MIN_POT_USD_PER_DAY = 25;

/**
 * Questo mercato ha un montepremi abbastanza grande da meritare capitale?
 *
 * @param {number|null|undefined} pot  il montepremi giornaliero letto dal venue
 * @param {number} [pavimento]         override esplicito, per i test e per i chiamanti che ne hanno uno loro
 * @returns {{ammesso:boolean, leggibile:boolean, pot:(number|null), motivo:(string|null)}}
 *   leggibile:false ⇒ il montepremi non è stato letto. `ammesso` resta true — non si scarta un mercato
 *   per una lettura mancata, si scarta per un fatto. Chi chiama vede `leggibile` e decide.
 */
function montepremiSufficiente(pot, pavimento = MIN_POT_USD_PER_DAY) {
  const n = (pot === null || pot === undefined || pot === '') ? NaN : Number(pot);
  if (!Number.isFinite(n)) {
    return { ammesso: true, leggibile: false, pot: null, motivo: 'montepremi non letto: «non lo so» non è «non paga», il mercato resta in gioco' };
  }
  if (n < pavimento) {
    return { ammesso: false, leggibile: true, pot: n, motivo: `montepremi $${n}/g sotto il pavimento di $${pavimento}/g — la quota ottenibile non giustifica il capitale` };
  }
  return { ammesso: true, leggibile: true, pot: n, motivo: null };
}

/** Assertion indipendenti, stile del repo. `node -e "require('./lib/rewards/montepremi-minimo').selfcheck()"` */
function selfcheck() {
  const assert = require('assert');
  let n = 0;
  const ok = (nome, cond) => { assert.ok(cond, 'FAIL: ' + nome); console.log('  ✓ ' + nome); n++; };

  ok('il pavimento dichiarato è 25', MIN_POT_USD_PER_DAY === 25);
  ok('$600/g passa', montepremiSufficiente(600).ammesso === true);
  ok('$25/g passa: il pavimento è inclusivo', montepremiSufficiente(25).ammesso === true);
  ok('$24,99/g non passa', montepremiSufficiente(24.99).ammesso === false);
  ok('$5/g non passa, ed è il caso tipico del nostro board', montepremiSufficiente(5).ammesso === false);
  ok('$0 è letto e rifiutato', montepremiSufficiente(0).ammesso === false && montepremiSufficiente(0).leggibile === true);

  // Il gruppo che conta: «non letto» non è «non paga».
  for (const vuoto of [null, undefined, '', NaN, 'boh']) {
    const r = montepremiSufficiente(vuoto);
    ok(`${JSON.stringify(vuoto)} → non leggibile, e NON scartato`, r.leggibile === false && r.ammesso === true && r.pot === null);
  }
  ok('Number(null) non diventa 0 di nascosto', montepremiSufficiente(null).pot === null);

  ok('il pavimento si può sovrascrivere', montepremiSufficiente(10, 5).ammesso === true && montepremiSufficiente(10, 50).ammesso === false);
  ok('il motivo del rifiuto porta il numero', /\$5\/g/.test(montepremiSufficiente(5).motivo));

  console.log(`montepremi-minimo: ${n} assertions passed`);
}

module.exports = { MIN_POT_USD_PER_DAY, montepremiSufficiente, selfcheck };
