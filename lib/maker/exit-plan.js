'use strict';
// lib/maker/exit-plan.js — DOVE VA L'ORDINE DI USCITA DOPO UN FILL, e fin dove lo si insegue.
//
// COSA SOSTITUISCE. La vecchia chiusura automatica usciva a «carico + 1 centesimo», un numero fisso in
// centesimi. Su un mercato a 10¢ un centesimo e' il 10% di guadagno; su uno a 90¢ e' l'1.1%. La stessa
// costante voleva dire due cose diverse a seconda del prezzo, e nessuna delle due era quella scelta.
// Qui l'obiettivo e' PERCENTUALE sul carico, quindi vale lo stesso ovunque.
//
// TRE VINCOLI, IN QUEST'ORDINE. Non sono preferenze: sono i tre modi in cui un'uscita puo' essere
// sbagliata, e ognuno corregge il precedente.
//
//   1. L'OBIETTIVO — carico + 1%. E' il motivo per cui l'ordine esiste.
//
//   2. LA BANDA PREMIANTE — l'uscita deve restare DENTRO la banda. La vecchia chiusura automatica non lo
//      garantiva: piazzava a carico+1¢ e se quel prezzo cadeva fuori banda l'ordine riposava senza
//      maturare nulla mentre aspettava. Un'uscita che sta in banda viene pagata per aspettare. Se
//      l'obiettivo dell'1% cade sopra il bordo premiante, si scende AL BORDO — meno guadagno, ma
//      maturato. Mai oltre: fuori dalla banda l'attesa e' gratis per il mercato e costosa per noi.
//
//   3. IL TETTO DI RISCHIO — 4% sotto il carico, e non un tick piu' in basso.
//      Se il prezzo si muove contro, la banda scende con lui e il vincolo 2 vorrebbe trascinare l'uscita
//      sempre piu' giu': inseguendo la banda si finisce per vendere in perdita crescente, un tick alla
//      volta, senza che nessuna singola mossa sembri sbagliata. Il pavimento rompe quella catena.
//
// COSA SUCCEDE QUANDO IL PAVIMENTO E' RAGGIUNTO, dichiarato e non implicito: L'USCITA RESTA FERMA AL
// LIVELLO DEL 4% e il motore SMETTE DI INSEGUIRE. Non scende oltre, non cancella, non ripiega su altro.
// L'ordine resta li' come un'offerta di uscita al peggior prezzo che abbiamo deciso di accettare; se il
// mercato torna, si riempie; se non torna, la posizione resta aperta e la decisione successiva e'
// dell'operatore. La scelta e' deliberata: l'alternativa — vendere comunque a mercato — trasformerebbe
// un tetto di rischio in un ordine di stop eseguito al peggior momento possibile, che e' esattamente
// cio' che un maker non deve fare.
//
// NIENTE INVENTATO. Carico non leggibile, tick non leggibile, banda non pubblicata: si restituisce
// `ok:false` con il motivo, e il chiamante non piazza. Un'uscita a un prezzo indovinato e' peggio di
// nessuna uscita, perche' sembra una protezione.

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

// ── LE DUE PERCENTUALI, IN UN PUNTO SOLO ────────────────────────────────────────────────────────────
// Sono gli unici due numeri che governano un'uscita, e vivono qui perche' chi li cambia li trovi
// insieme: il guadagno che si cerca e la perdita che si accetta prima di smettere di cercarlo.
const EXIT_PROFIT_PCT = 1;        // % sopra il carico: l'obiettivo dell'uscita
const MAX_ADVERSE_PCT = 4;        // % sotto il carico: il pavimento oltre cui non si insegue piu'

/** Il prezzo piu' vicino a `p` sulla griglia del tick, arrotondato nella direzione indicata. */
function snapTo(p, tick, dir) {
  if (!fin(p) || !fin(tick) || tick <= 0) return null;
  const n = dir === 'up' ? Math.ceil(p / tick - 1e-9) : Math.floor(p / tick + 1e-9);
  return +(n * tick).toFixed(10);
}

/**
 * DOVE PIAZZARE L'USCITA, dato un carico e lo stato corrente del mercato.
 *
 * @param {object} a
 *   entryPrice      il prezzo di carico REALE della posizione (dal venue, mai dedotto)
 *   scoringMid      il mid di scoring del libro su cui si esce — quello che decide la banda
 *   tick            il tick del mercato
 *   bandRadiusCents mezza banda premiante, in centesimi. `null` ⇒ il venue non la pubblica
 *   profitPct       default EXIT_PROFIT_PCT
 *   maxAdversePct   default MAX_ADVERSE_PCT
 *
 * @returns {{ok:boolean, price:(number|null), reason:string, target:(number|null),
 *            floor:(number|null), bandHi:(number|null), clampedBy:(string|null), atFloor:boolean,
 *            profitPct:(number|null)}}
 *   `clampedBy` dice CHI ha deciso il prezzo finale: 'obiettivo', 'banda' o 'pavimento'. Serve a chi
 *   legge dopo — un'uscita a un prezzo diverso dall'obiettivo non e' un errore, ma va saputo perche'.
 */
function planExit({ entryPrice, scoringMid, tick, bandRadiusCents = null, profitPct = EXIT_PROFIT_PCT, maxAdversePct = MAX_ADVERSE_PCT } = {}) {
  const out = (reason, extra = {}) => ({
    ok: false, price: null, reason, target: null, floor: null, bandHi: null,
    clampedBy: null, atFloor: false, profitPct: null, ...extra,
  });
  if (!fin(entryPrice) || entryPrice <= 0) return out('prezzo di carico non leggibile — nessuna uscita viene inventata');
  if (!fin(tick) || tick <= 0) return out('tick del venue non leggibile — nessuna uscita viene inventata');

  // 1 · L'OBIETTIVO. Arrotondato IN SU: arrotondare in giu' consegnerebbe meno guadagno di quello
  //     promesso dalla costante, e su un tick da 0.001 la differenza e' quasi tutto l'obiettivo.
  const target = snapTo(entryPrice * (1 + profitPct / 100), tick, 'up');

  // 3 · IL PAVIMENTO. Arrotondato IN SU anch'esso: fra due prezzi sulla griglia si sceglie il meno
  //     peggiore, cosi' il 4% e' un tetto di perdita e non un obiettivo di perdita.
  const floor = snapTo(entryPrice * (1 - maxAdversePct / 100), tick, 'up');

  // 2 · LA BANDA. Senza una banda pubblicata non si puo' AFFERMARE che un prezzo maturi, quindi non si
  //     usa quel vincolo — ma non si finge nemmeno che non esista: lo si dichiara.
  let bandHi = null;
  if (fin(bandRadiusCents) && bandRadiusCents > 0 && fin(scoringMid) && scoringMid > 0) {
    bandHi = snapTo(scoringMid + bandRadiusCents / 100, tick, 'down');
  }

  let price = target;
  let clampedBy = 'obiettivo';
  if (bandHi != null && price > bandHi) { price = bandHi; clampedBy = 'banda'; }

  // IL PAVIMENTO VINCE SULLA BANDA, sempre. Se il bordo premiante e' sceso sotto il 4%, inseguirlo
  // significherebbe vendere in perdita crescente per restare premiati: si smette di inseguire.
  let atFloor = false;
  if (price < floor) { price = floor; clampedBy = 'pavimento'; atFloor = true; }

  if (!(price > 0) || price >= 1) {
    return out(`il prezzo di uscita calcolato (${price}) e' fuori dai limiti del libro`, { target, floor, bandHi });
  }

  const realizedPct = +(((price - entryPrice) / entryPrice) * 100).toFixed(3);
  const reason = clampedBy === 'obiettivo'
    ? `uscita all'obiettivo: carico ${entryPrice} + ${profitPct}% = ${price}`
    : clampedBy === 'banda'
      ? `uscita LIMITATA DALLA BANDA: l'obiettivo ${target} cadeva oltre il bordo premiante ${bandHi}, quindi si esce al bordo (${realizedPct}% sul carico) dove l'attesa matura`
      : `PAVIMENTO DI RISCHIO RAGGIUNTO: il ${maxAdversePct}% sotto il carico e' ${floor} e il mercato non consente di meglio dentro la banda.`
        + ' L\'uscita resta FERMA qui e il motore smette di inseguire il prezzo: non scende oltre.';

  return { ok: true, price, reason, target, floor, bandHi, clampedBy, atFloor, profitPct: realizedPct };
}

/**
 * IL PREZZO E' ANCORA QUELLO GIUSTO? Confronta un'uscita gia' a riposo col piano di adesso.
 *
 * Serve a non cancellare-e-ripiazzare per nulla: un'uscita che sta gia' al prezzo giusto non si tocca,
 * e una che sta al PAVIMENTO non si muove piu' per definizione.
 */
function exitNeedsMove({ restingPrice, plan, tick } = {}) {
  if (!plan || plan.ok !== true) return { move: false, reason: 'nessun piano valido: non si tocca nulla' };
  if (!fin(restingPrice)) return { move: true, reason: 'nessuna uscita a riposo: la si piazza' };
  if (plan.atFloor) {
    return { move: false, reason: 'uscita al pavimento del rischio: da qui non si insegue piu\', l\'ordine resta dov\'e\'' };
  }
  const t = fin(tick) && tick > 0 ? tick : 0.01;
  if (Math.abs(restingPrice - plan.price) < t / 1000) return { move: false, reason: 'l\'uscita e\' gia\' al prezzo giusto' };
  // NON SI ABBASSA MAI UN'USCITA GIA' A RIPOSO. Alzarla insegue un mercato che sale (piu' guadagno);
  // abbassarla insegue un mercato che scende, cioe' peggiora un'uscita gia' piazzata — che e'
  // esattamente quello che il pavimento esiste per impedire, applicato tick per tick.
  if (plan.price < restingPrice) {
    return { move: false, reason: `l'uscita a riposo (${restingPrice}) e' MIGLIORE del piano di adesso (${plan.price}): non si abbassa un'uscita gia' piazzata` };
  }
  return { move: true, reason: `l'uscita si alza da ${restingPrice} a ${plan.price}` };
}

module.exports = { planExit, exitNeedsMove, snapTo, EXIT_PROFIT_PCT, MAX_ADVERSE_PCT };
