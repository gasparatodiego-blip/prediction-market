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

// ── LE SOGLIE SI RILEGGONO DA .env A OGNI CHIAMATA (7 agosto 2026) ────────────────────────────────
// `MID_EXTREME_LOW` / `MID_EXTREME_HIGH` sono in PREZZO (0–1), la stessa unità del mid che entra qui —
// non in centesimi, così chi le scrive in `.env` scrive lo stesso numero che legge nel book.
// Rilette a ogni giro come le soglie del guardiano delle perdite: allargare la protezione su un mercato
// che sta risolvendo non deve richiedere un riavvio, perché quando serve non c'è tempo di farlo.
//
// UNA SOGLIA CHE NON SI CAPISCE NON ALLARGA NIENTE. Un valore non numerico, fuori da (0,1), o con
// low ≥ high, viene SCARTATO e si torna a 3¢/97¢. La direzione dello scarto è deliberata: il default è
// la protezione, quindi un `.env` sbagliato non può spegnerla — al massimo non la sposta. In
// particolare `MID_EXTREME_LOW=0` non è ammesso, perché sarebbe l'unico modo di disattivare la regola
// scrivendo un numero apparentemente innocuo.
function sogliaFineScala(env = process.env) {
  const leggi = (nome, difettoCents) => {
    const grezzo = env[nome];
    if (grezzo == null || String(grezzo).trim() === '') return { cents: difettoCents, origine: 'difetto' };
    const v = Number(grezzo);
    if (!Number.isFinite(v) || v <= 0 || v >= 1) return { cents: difettoCents, origine: 'scartato' };
    return { cents: +(v * 100).toFixed(4), origine: 'env' };
  };
  const lo = leggi('MID_EXTREME_LOW', END_OF_SCALE_LOW_CENTS);
  const hi = leggi('MID_EXTREME_HIGH', END_OF_SCALE_HIGH_CENTS);
  if (lo.cents >= hi.cents) {
    return { lowCents: END_OF_SCALE_LOW_CENTS, highCents: END_OF_SCALE_HIGH_CENTS, origine: 'scartato' };
  }
  return {
    lowCents: lo.cents, highCents: hi.cents,
    origine: (lo.origine === 'env' || hi.origine === 'env') ? 'env' : (lo.origine === 'scartato' || hi.origine === 'scartato' ? 'scartato' : 'difetto'),
  };
}

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
function endOfScaleCheck(mid, env) {
  const { lowCents, highCents } = sogliaFineScala(env || process.env);
  if (!fin(mid)) {
    return { endOfScale: false, readable: false, midCents: null, side: null, reason: null, lowCents, highCents };
  }
  const midCents = +(mid * 100).toFixed(4);
  if (midCents < lowCents) {
    return { endOfScale: true, readable: true, midCents, side: 'low', lowCents, highCents,
      reason: `${END_OF_SCALE_REASON}: il mid è a ${midCents.toFixed(2)}¢, sotto la soglia di ${lowCents.toFixed(1)}¢` };
  }
  if (midCents > highCents) {
    return { endOfScale: true, readable: true, midCents, side: 'high', lowCents, highCents,
      reason: `${END_OF_SCALE_REASON}: il mid è a ${midCents.toFixed(2)}¢, sopra la soglia di ${highCents.toFixed(1)}¢` };
  }
  return { endOfScale: false, readable: true, midCents, side: null, reason: null, lowCents, highCents };
}

module.exports = {
  END_OF_SCALE_LOW_CENTS, END_OF_SCALE_HIGH_CENTS, END_OF_SCALE_REASON, endOfScaleCheck, sogliaFineScala,
};
