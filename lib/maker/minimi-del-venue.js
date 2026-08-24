'use strict';
// lib/maker/minimi-del-venue.js — I DUE MINIMI, CON DUE NOMI, E NON SONO INTERCAMBIABILI.
//
// ═══ IL FATTO — 24 agosto 2026, letto dal venue e dai log ═════════════════════════════════════════
// Polymarket pubblica DUE numeri diversi su ogni mercato, e questo repo ne aveva UNO:
//
//   `rewards.min_size`      50 · 50 · 20 · 20   →  PAVIMENTO PREMIANTE: sotto, il premio e' **ZERO**
//   `minimum_order_size`     5 ·  5 ·  5 ·  5   →  MINIMO D'ORDINE:     sotto, l'ordine e' **RIFIUTATO**
//
// `rules.minSize` in tutto il repo e' il PRIMO (`catalogRec.rewardsMinSize`, `manual-order.js:355`), e
// il percorso d'USCITA lo usava come se fosse il secondo. Il 24 agosto agent40 scriveva a ogni giro:
//     «4.85 share scoperte su YES, sotto il minimo del venue (50)»
// dove il minimo del venue e' **5**. Su quelle quattro gambe la conclusione non cambiava — 4,85 e 2,01
// e 2,8461 sono sotto 5 come sono sotto 50 — quindi il bot aveva ragione **per caso**. Un residuo di
// **30 share** sarebbe stato dichiarato non piazzabile mentre il venue lo avrebbe accettato: una
// posizione recuperabile abbandonata su un numero letto per un altro.
//
// ═══ LA REGOLA ═══════════════════════════════════════════════════════════════════════════════════
//   · Ogni decisione sull'AMMISSIBILITA' AL PREMIO  legge `pavimentoPremiante`.
//   · Ogni decisione sul PERCORSO D'USCITA — «questo residuo si puo' vendere?», «si puo' comprare la
//     sorella?», e la marcatura R6 quando verra' cablata — legge `minimoOrdine`.
//
// ⚠ FAIL-CLOSED, E NEL VERSO GIUSTO PER CIASCUNO. Sono opposti apposta:
//   · pavimento premiante non leggibile ⇒ non si sa se maturera' premio ⇒ e' una domanda sul RICAVO,
//     e la risposta prudente e' «non lo so», non «no»;
//   · minimo d'ordine non leggibile ⇒ **il percorso d'uscita non indovina**: non dichiara piazzabile,
//     non dichiara non-piazzabile, e soprattutto **non marca R6**. Dichiara ILLEGGIBILE e si ferma.
//     Marcare una posizione come abbandonata su un minimo indovinato e' smettere di provare a
//     recuperare capitale sulla base di un numero che non si e' letto — cioe' il guasto di oggi,
//     promosso a regola.
//
// ⚠ NON HA VALORI PROPRI E NON NE AVRA'. Nessun `5`, nessun `50`, nessun `20` qui dentro: i minimi
// sono del VENUE e per MERCATO, e cablarne uno significherebbe che il giorno in cui il venue lo cambia
// il bot continua a usare il vecchio senza accorgersene. Si leggono e si passano.
//
// ⚠ PURO: zero `require`. Si giudica, non si legge dal disco e non si chiama nessuno.

/** I due nomi, come costanti, cosi' un refuso non diventa un terzo concetto. */
const PAVIMENTO_PREMIANTE = 'pavimentoPremiante';
const MINIMO_ORDINE = 'minimoOrdine';

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * Estrae i due minimi da un record del venue, con i nomi giusti e senza confonderli.
 *
 * Accetta le forme in cui i due numeri arrivano davvero: il record di `/markets/<cid>`
 * (`rewards.min_size`, `minimum_order_size`), il book di `/book` (`min_order_size`) e il record del
 * catalogo interno (`rewardsMinSize`).
 *
 * ⚠ `Number(null) === 0` E' IL DIFETTO PIU' RICORRENTE DI QUESTO REPO (sei occorrenze, §5.3): qui un
 * campo assente diventa `null`, mai `0`. Uno zero direbbe «nessun minimo», cioe' «qualunque size
 * passa» — fail-open su una domanda a cui si risponde con capitale.
 *
 * @returns {{pavimentoPremiante:(number|null), minimoOrdine:(number|null)}}
 */
function leggiMinimi(record = {}) {
  const r = record || {};
  const num = (x) => { const n = Number(x); return fin(n) && n > 0 ? n : null; };
  const rw = r.rewards && typeof r.rewards === 'object' ? r.rewards : {};
  return {
    [PAVIMENTO_PREMIANTE]: num(rw.min_size) ?? num(r.rewardsMinSize) ?? num(r.minSize) ?? null,
    [MINIMO_ORDINE]: num(r.minimum_order_size) ?? num(r.min_order_size) ?? num(r.minOrderSize) ?? null,
  };
}

/**
 * ① LA DOMANDA DEL PERCORSO D'USCITA: questa size il venue la accetta?
 *
 * ⚠ TRE RISPOSTE, NON DUE. `piazzabile` puo' essere `true`, `false` o **`null`**, e la terza e' quella
 * che conta: «non lo so» non e' «no». Chi consuma questa funzione deve ramificare su tutte e tre — ed
 * e' il motivo per cui non restituisce un booleano.
 *
 * @returns {{piazzabile:(boolean|null), minimoOrdine:(number|null), size:(number|null), motivo:string}}
 */
function piazzabileAlVenue({ size = null, minimoOrdine = null } = {}) {
  const s = fin(size) ? size : null;
  const m = fin(minimoOrdine) && minimoOrdine > 0 ? minimoOrdine : null;
  if (s === null || s <= 0) {
    return { piazzabile: null, minimoOrdine: m, size: s,
      motivo: 'size non leggibile: non si giudica la piazzabilita\' di una quantita\' che non si e\' letta' };
  }
  if (m === null) {
    return { piazzabile: null, minimoOrdine: null, size: s,
      motivo: 'minimo d\'ordine del venue non leggibile: il percorso d\'uscita NON indovina — non dichiara '
        + 'piazzabile, non dichiara non-piazzabile, e non marca R6' };
  }
  const piazzabile = s >= m;
  return { piazzabile, minimoOrdine: m, size: s,
    motivo: piazzabile
      ? `${s} share >= minimo d'ordine del venue ${m}: il venue accetterebbe l'ordine`
      : `${s} share sotto il minimo d'ORDINE del venue ${m}: l'ordine verrebbe RIFIUTATO `
        + '(⚠ non confondere col pavimento premiante, che e\' un altro numero e risponde a un\'altra domanda)' };
}

/**
 * ② LA DOMANDA DEL PREMIO: questa size matura reward?
 * Verso opposto sul non-leggibile, per la ragione scritta in testata: e' una domanda sul RICAVO.
 *
 * @returns {{premiante:(boolean|null), pavimentoPremiante:(number|null), size:(number|null), motivo:string}}
 */
function maturaPremio({ size = null, pavimentoPremiante = null } = {}) {
  const s = fin(size) ? size : null;
  const p = fin(pavimentoPremiante) && pavimentoPremiante > 0 ? pavimentoPremiante : null;
  if (s === null || p === null) {
    return { premiante: null, pavimentoPremiante: p, size: s,
      motivo: 'size o pavimento premiante non leggibili: non si dichiara che un ordine non maturera\' premio' };
  }
  const premiante = s >= p;
  return { premiante, pavimentoPremiante: p, size: s,
    motivo: premiante
      ? `${s} share >= pavimento premiante ${p}: l'ordine matura reward`
      : `${s} share sotto il pavimento premiante ${p}: reward ZERO (⚠ l'ordine resta comunque VALIDO `
        + 'per il venue se supera il minimo d\'ordine, che e\' un altro numero)' };
}

function selfcheck() {
  let pass = 0; let fail = 0;
  const ok = (t, c, d) => { if (c) { pass += 1; console.log('  ok  ', t); } else { fail += 1; console.log('  FAIL', t, d || ''); } };

  console.log('\n① i due numeri si leggono separati, dalle forme vere del venue');
  const m = leggiMinimi({ rewards: { min_size: 50 }, minimum_order_size: 5 });
  ok('dal record /markets: pavimento 50, minimo d\'ordine 5', m.pavimentoPremiante === 50 && m.minimoOrdine === 5);
  ok('dal book /book (min_order_size stringa)', leggiMinimi({ min_order_size: '5' }).minimoOrdine === 5);
  ok('dal catalogo interno (rewardsMinSize)', leggiMinimi({ rewardsMinSize: 20 }).pavimentoPremiante === 20);
  ok('assente ⇒ null, MAI zero (Number(null)===0, §5.3)',
    leggiMinimi({}).minimoOrdine === null && leggiMinimi({}).pavimentoPremiante === null);
  ok('uno zero pubblicato vale null, non «nessun minimo»', leggiMinimi({ minimum_order_size: 0 }).minimoOrdine === null);

  console.log('\n② il caso vero del 24 agosto: 4,85 share, pavimento 50, minimo d\'ordine 5');
  const caso = { size: 4.85, ...leggiMinimi({ rewards: { min_size: 50 }, minimum_order_size: 5 }) };
  ok('non piazzabile (4,85 < 5) — e la causa e\' il MINIMO D\'ORDINE',
    piazzabileAlVenue(caso).piazzabile === false && piazzabileAlVenue(caso).minimoOrdine === 5);
  ok('e non matura premio (4,85 < 50), che e\' una domanda DIVERSA',
    maturaPremio(caso).premiante === false && maturaPremio(caso).pavimentoPremiante === 50);

  console.log('\n③ IL CASO CHE IL DIFETTO SBAGLIAVA: 30 share, pavimento 50, minimo d\'ordine 5');
  const trenta = { size: 30, pavimentoPremiante: 50, minimoOrdine: 5 };
  ok('30 share SONO PIAZZABILI (30 >= 5): il venue le accetta', piazzabileAlVenue(trenta).piazzabile === true);
  ok('  e NON maturano premio (30 < 50): le due risposte sono opposte, ed e\' il punto',
    maturaPremio(trenta).premiante === false);
  ok('  usare il pavimento premiante al posto del minimo d\'ordine direbbe «non piazzabile»: '
    + 'e\' il difetto, e qui e\' impossibile da esprimere per sbaglio',
    piazzabileAlVenue({ size: 30, minimoOrdine: 50 }).piazzabile === false);

  console.log('\n④ fail-closed, nei due versi opposti');
  const senzaMin = piazzabileAlVenue({ size: 30, minimoOrdine: null });
  ok('minimo d\'ordine illeggibile ⇒ piazzabile === null (mai true, mai false)', senzaMin.piazzabile === null);
  ok('  e il motivo dice esplicitamente che NON si marca R6', /non marca R6/.test(senzaMin.motivo));
  ok('size illeggibile ⇒ null', piazzabileAlVenue({ size: null, minimoOrdine: 5 }).piazzabile === null);
  ok('pavimento premiante illeggibile ⇒ premiante === null, non false',
    maturaPremio({ size: 30, pavimentoPremiante: null }).premiante === null);

  console.log('\n⑤ nessun minimo e\' cablato: si muove il parametro e il verdetto segue');
  ok('lo stesso size cambia verdetto al cambiare del minimo passato',
    piazzabileAlVenue({ size: 10, minimoOrdine: 5 }).piazzabile === true
    && piazzabileAlVenue({ size: 10, minimoOrdine: 20 }).piazzabile === false);

  console.log(`\nminimi del venue: ${pass} passati, ${fail} falliti\n`);
  return fail === 0;
}

if (require.main === module) process.exit(selfcheck() ? 0 : 1);

module.exports = { PAVIMENTO_PREMIANTE, MINIMO_ORDINE, leggiMinimi, piazzabileAlVenue, maturaPremio, selfcheck };
