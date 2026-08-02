'use strict';
// lib/maker/end-of-scale.js — LA CANCELLAZIONE DI SICUREZZA A FINE SCALA.
//
// IL PROBLEMA CHE RISOLVE. Un mercato il cui mid è arrivato a 2¢ o a 98¢ non sta più facendo mercato: sta
// risolvendo. Il prezzo ha smesso di essere un'opinione contesa fra due lati e ha cominciato a essere il
// conto alla rovescia verso un esito già deciso. Un ordine a riposo lì dentro non è più una quota di
// market making, è una scommessa asimmetrica: nella direzione giusta guadagna qualche decimo di
// centesimo, nella direzione sbagliata — la sorpresa, il ribaltamento tardivo, la notizia — perde tutto
// il nominale. Il motore che insegue il mid continuerebbe a riprezzare felicemente dentro quella zona,
// perché per la sua aritmetica una banda a 2¢ è una banda come un'altra.
//
// COSA FA. Sopra la soglia si CANCELLA e basta. Non si riprezza, non si sposta, non si rinnova: quelle
// sono tutte azioni che rimettono capitale in un posto da cui lo stiamo togliendo. Cancellare è l'unica
// direzione che può soltanto ridurre l'esposizione, ed è per questo che è la sola consentita qui.
//
// ── LA SOGLIA, E SI CAMBIA SOLO QUI ────────────────────────────────────────────────────────────────
// Questi due numeri sono l'UNICA definizione di «fine scala» in tutto il progetto. I due motori che li
// usano — il watcher reattivo (lib/maker/auto-reprice.js) e il market maker a due lati
// (lib/maker/mm-tracking.js) — li importano da qui e non ne tengono copia: due soglie leggermente
// diverse in due file vorrebbero dire un mercato protetto da un motore e non dall'altro, che è la
// forma peggiore possibile di questa protezione perché sembra esserci.
//
// Perché 3¢ e 97¢: sotto i 3¢ il tick da 1¢ è già un terzo del prezzo, quindi la granularità stessa del
// venue rende la quotazione grossolana, e la banda premiante tipica (±2.25¢) arriverebbe a coprire lo
// zero. È il punto in cui «fare mercato» smette di descrivere quello che sta succedendo. La soglia alta
// è il suo specchio esatto — 100 − 3 — perché su un mercato binario un YES a 97¢ È un NO a 3¢, e
// proteggere un lato solo non proteggerebbe niente.
const END_OF_SCALE_LOW_CENTS = 3.0;
const END_OF_SCALE_HIGH_CENTS = 97.0;

// Il motivo, scritto una volta sola: finisce identico nell'audit dei due motori, così una ricerca nel
// registro trova tutti gli episodi e non metà.
const END_OF_SCALE_REASON = 'prezzo vicino a risoluzione — fine scala, cancellazione di sicurezza';

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * Il mid di questo mercato è a fine scala?
 *
 * @param {number|null} mid  il mid in PREZZO (0–1), non in centesimi — la stessa unità che usano
 *                           `rules.mid` e gli scoringMid, così nessun chiamante deve convertire.
 * @returns {{ endOfScale:boolean, readable:boolean, midCents:number|null, side:('low'|'high'|null), reason:(string|null) }}
 *
 * UN MID CHE NON SI LEGGE NON È UN MID A FINE SCALA. Questa funzione risponde `readable:false` e
 * `endOfScale:false`, e la scelta è deliberata: cancellare è un'azione, e un'azione presa su un dato che
 * non abbiamo letto è una decisione presa a caso, anche quando la direzione è quella prudente. Chi chiama
 * ha già i propri gate sul mid vivo e fresco, e passa di qui solo dopo averli superati — quindi qui
 * `readable:false` significa davvero «non lo so», e la risposta giusta a «non lo so» è non agire.
 * L'ordine intanto non resta scoperto: senza rinnovo la GTD del venue lo ritira da sola.
 */
function endOfScaleCheck(mid) {
  if (!fin(mid)) {
    return { endOfScale: false, readable: false, midCents: null, side: null, reason: null };
  }
  const midCents = +(mid * 100).toFixed(4);
  if (midCents < END_OF_SCALE_LOW_CENTS) {
    return { endOfScale: true, readable: true, midCents, side: 'low',
      reason: `${END_OF_SCALE_REASON}: il mid è a ${midCents.toFixed(2)}¢, sotto la soglia di ${END_OF_SCALE_LOW_CENTS.toFixed(1)}¢` };
  }
  if (midCents > END_OF_SCALE_HIGH_CENTS) {
    return { endOfScale: true, readable: true, midCents, side: 'high',
      reason: `${END_OF_SCALE_REASON}: il mid è a ${midCents.toFixed(2)}¢, sopra la soglia di ${END_OF_SCALE_HIGH_CENTS.toFixed(1)}¢` };
  }
  return { endOfScale: false, readable: true, midCents, side: null, reason: null };
}

module.exports = {
  END_OF_SCALE_LOW_CENTS, END_OF_SCALE_HIGH_CENTS, END_OF_SCALE_REASON, endOfScaleCheck,
};
