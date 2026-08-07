'use strict';
// lib/maker/motore-unico.js — UN SOLO MOTORE, COERENTE CON LA FORMULA CHE IL VENUE PAGA DAVVERO.
//
// ═══ COSA SOSTITUISCE, E PERCHÉ ══════════════════════════════════════════════════════════════════════
// Fino al 6 agosto 2026 esistevano DUE profili, Safe e Risk, con due insiemi di regole, due pavimenti
// di profondità ($15 cumulato / $20 sul gradino), due finestre di volatilità (8h / 5min) e due tetti di
// capitale (30% / 10%). Erano una nostra semplificazione, e non descrivevano come il venue paga.
//
// La formula pubblicata — implementata da tempo in lib/rewardScore.js, che agent24 e il board usano già:
//
//     S(v,s) = ((v − s) / v)²          punteggio di UN ordine: QUADRATICO nella distanza dal mid
//     Q_min  = mid ∈ [0.10, 0.90] ? max(min(Qy,Qn), max(Qy/3, Qn/3)) : min(Qy, Qn)
//
// non contiene nessuna nozione di «safe» o «rischioso»: è una curva continua. Due bucket con soglie
// fisse ci mettevano sopra una scalinata che il venue non paga. Questo modulo toglie la scalinata.
//
// ═══ LE CINQUE REGOLE, E L'ORDINE IN CUI SI APPLICANO ════════════════════════════════════════════════
//
//   1 · MAI PRIMO SUL BOOK — vincolo assoluto, slegato dal punteggio. È protezione dal fill avverso:
//       il primo livello è il primo a essere eseguito, e per un maker l'esecuzione è il COSTO, non il
//       ricavo. Non si negozia contro il punteggio, mai.
//
//   2 · PAVIMENTO DI PROFONDITÀ, RELATIVO A QUESTO MERCATO — non più un dollaro fisso uguale ovunque.
//       $15 davanti sono tantissimo su un mercato che ne muove $200 e nulla su uno che ne muove
//       $60.000: la stessa soglia proteggeva troppo il primo e per niente il secondo. Adesso è una
//       percentuale della liquidità NORMALE di quel mercato specifico.
//
//   3 · POI CI SI FERMA — e questa è la conseguenza diretta del quadratico. Soddisfatti 1 e 2, il
//       livello trovato è il PIÙ VICINO AL MID che li rispetta, quindi è quello col punteggio più
//       alto: allontanarsi di più costerebbe punteggio al quadrato senza comprare nessuna sicurezza
//       aggiuntiva. Non esiste più un controllo separato di volatilità, spread o quota massima —
//       la profondità reale del book li cattura già: un book instabile o sottile alza da sé il
//       pavimento richiesto, perché il pavimento si misura sulla liquidità media.
//
//   4 · LATO SINGOLO, DECISO DALLA FORMULA E NON DA UN TIMER. Dentro [0.10, 0.90] un lato solo matura
//       comunque un terzo: tenerlo è meglio che chiuderlo. Fuori da quel range matura ZERO: tenerlo è
//       capitale fermo, e si cancella SUBITO. È `qMin` a dirlo, non una nostra soglia — e si rilegge
//       il mid a ogni ciclo, così un mercato che scavalca il confine cambia comportamento nello stesso
//       giro. (Sostituisce la tolleranza a dieci minuti scritta il 6 agosto: quel timer era una
//       proxy ragionevole di una domanda a cui la formula risponde esattamente.)
//
//   5 · TETTO DI CAPITALE, 20% — uno solo, uguale per tutti. NON è una regola di reward: è gestione
//       del rischio di risoluzione, e sta deliberatamente fuori dal calcolo del punteggio.
//
// ═══ NIENTE BIFORCAZIONI, E NESSUNO STATO ════════════════════════════════════════════════════════════
// Un solo percorso per ogni ordine e per ogni proposta. Nessun `if (profilo)`, nessuna costante che
// esista in due versioni. Puro: nessun `fs`, nessuna rete, nessun orologio, nessuna cache — la
// liquidità media e il mid li porta chi chiama, dalla lettura che ha appena fatto.

const { othersLadder, bestOtherBid, planBehindBest } = require('./top-of-book');
// LA FORMULA, IMPORTATA E MAI RISCRITTA. `qMin` è la stessa funzione che il board e agent24 usano per
// stimare i premi: se un giorno il venue cambia la regola, cambia in un posto solo.
const { qMin, scoreOrder, C_FACTOR } = require('../rewardScore');

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

// ── LE COSTANTI. Tre numeri, non due insiemi. ─────────────────────────────────────────────────────
/** Il pavimento di profondità è questa frazione della liquidità media in banda DI QUEL MERCATO. */
const DEPTH_FLOOR_PCT_OF_AVG = 0.10;
/** Rete di sicurezza per i mercati senza storico: un mercato nuovo non è un mercato senza regole. */
const DEPTH_FLOOR_FALLBACK_USD = 15;
/** Tetto di capitale per singolo mercato. Rischio di risoluzione, non reward. */
const MARKET_CAP_PCT = 0.20;
/** Gli estremi entro cui un lato solo matura ancora qualcosa. Sono della FORMULA, non nostri. */
const MID_MIN_UN_LATO = 0.10;
const MID_MAX_UN_LATO = 0.90;

/**
 * REGOLA 2 · IL PAVIMENTO DI QUESTO MERCATO, IN DOLLARI.
 *
 * ── DUE SORGENTI PER LA MEDIA, E NON SONO INTERCAMBIABILI ─────────────────────────────────────────
 * `liquiditaMediaUsd` è la media della profondità **ALTRUI** in banda, in dollari, misurata con la
 * stessa `othersLadder` che produce il numeratore del confronto (lib/maker/profondita-altrui.js).
 * `liquiditaMediaShare` è la vecchia media dal giornale di agent34, in share: somma il book PUBBLICO,
 * **i nostri ordini compresi**. Confrontare profondità altrui contro una media che include noi alza il
 * pavimento in proporzione al capitale che mettiamo a riposo — il maker si sbarra la strada da solo.
 *
 * Quando arriva quella pulita si usa quella, e la sporca resta calcolata come `lordoUsd`: serve solo a
 * far vedere nell'audit di quanto il pavimento era gonfio. Non decide più niente.
 *
 * QUALE DELLE DUE DECIDE lo dice `campioniAltrui`: passarlo — anche a 0, anche con media nulla —
 * significa «la sorgente pulita c'è, giudicami su quella». Chi non lo passa (i banchi storici, il
 * percorso di piazzamento manuale) resta sul vecchio comportamento, byte per byte.
 *
 * @param {object} a
 *   liquiditaMediaUsd    media della profondità ALTRUI in banda sulla finestra, in DOLLARI (preferita)
 *   campioniAltrui       quanti campioni ha la media pulita; presente ⇒ è lei a decidere
 *   liquiditaMediaShare  media della profondità PUBBLICA in banda (bid+ask) sulla finestra, in SHARE
 *   prezzoRif            il prezzo a cui convertire le share in dollari (il mid di scoring)
 *   campioni             quanti campioni ha la media sporca (sotto `minCampioni` non è affidabile)
 * @returns {{usd:number, fonte:'media-altrui'|'media'|'fallback', mediaUsd:number|null,
 *            lordoUsd:number|null, motivo:string}}
 */
function pavimentoDepth({
  liquiditaMediaUsd = null, campioniAltrui = null,
  liquiditaMediaShare = null, prezzoRif = null, campioni = 0, minCampioni = 5,
} = {}) {
  // Il pavimento che la vecchia media avrebbe prodotto. Sempre e solo un termine di paragone.
  const lordoUsd = (fin(liquiditaMediaShare) && liquiditaMediaShare > 0 && fin(prezzoRif) && prezzoRif > 0)
    ? +(liquiditaMediaShare * prezzoRif * DEPTH_FLOOR_PCT_OF_AVG).toFixed(4)
    : null;

  if (fin(campioniAltrui)) {
    if (fin(liquiditaMediaUsd) && liquiditaMediaUsd > 0 && campioniAltrui >= minCampioni) {
      const usd = +(liquiditaMediaUsd * DEPTH_FLOOR_PCT_OF_AVG).toFixed(4);
      return {
        usd, fonte: 'media-altrui', mediaUsd: +liquiditaMediaUsd.toFixed(2), lordoUsd,
        motivo: `${Math.round(DEPTH_FLOOR_PCT_OF_AVG * 100)}% della liquidità ALTRUI media in banda di questo`
          + ` mercato ($${liquiditaMediaUsd.toFixed(2)} su ${campioniAltrui} campioni) = $${usd.toFixed(2)}`,
      };
    }
    // Nessuna media pulita ancora: si RIPIEGA, non si torna alla sporca. La media sporca è la causa del
    // difetto, non un secondo migliore — e il ripiego è la rete pensata apposta per chi non ha storico.
    return {
      usd: DEPTH_FLOOR_FALLBACK_USD, fonte: 'fallback', mediaUsd: null, lordoUsd,
      motivo: `storico pulito insufficiente (${campioniAltrui} campioni altrui): pavimento di ripiego`
        + ` $${DEPTH_FLOOR_FALLBACK_USD} — un mercato senza storico non è un mercato senza regole`,
    };
  }

  // ── IL PERCORSO STORICO, per chi non passa ancora la media pulita ───────────────────────────────
  const affidabile = fin(liquiditaMediaShare) && liquiditaMediaShare > 0
    && fin(prezzoRif) && prezzoRif > 0 && campioni >= minCampioni;
  if (!affidabile) {
    return {
      usd: DEPTH_FLOOR_FALLBACK_USD, fonte: 'fallback', mediaUsd: null, lordoUsd,
      motivo: `storico insufficiente (${campioni} campioni): pavimento di ripiego $${DEPTH_FLOOR_FALLBACK_USD}`
        + ' — un mercato nuovo non è un mercato senza regole',
    };
  }
  const mediaUsd = liquiditaMediaShare * prezzoRif;
  const usd = +(mediaUsd * DEPTH_FLOOR_PCT_OF_AVG).toFixed(4);
  return {
    usd, fonte: 'media', mediaUsd: +mediaUsd.toFixed(2), lordoUsd,
    motivo: `${Math.round(DEPTH_FLOOR_PCT_OF_AVG * 100)}% della liquidità media in banda di questo mercato`
      + ` ($${mediaUsd.toFixed(2)}) = $${usd.toFixed(2)}`,
  };
}

/**
 * REGOLA 1 · MAI PRIMO SUL BOOK. Delega a top-of-book, che è dove la regola vive.
 * `alone: true` non è una violazione: dove non c'è nessun altro, «primo» non descrive niente.
 */
function controlloMaiPrimo({ bookLevels, ownOrders, tick, scoringMid, bandRadiusCents, deps = {} }) {
  const bo = (deps.bestOtherBid || bestOtherBid)({ levels: bookLevels, ownOrders: ownOrders || [], tick });
  if (!bo || bo.readable !== true) {
    return { ok: false, motivo: `miglior prezzo altrui non leggibile: ${bo ? bo.reason : 'nessuna risposta'}`
      + ' — non si piazza senza sapere se si finirebbe primi', bestOther: null, alone: null };
  }
  if (bo.alone === true) {
    return { ok: true, motivo: 'nessun altro su questo lato: «primo» non descrive niente', bestOther: null, alone: true };
  }
  const piano = (deps.planBehindBest || planBehindBest)({ bestOther: bo.price, tick, scoringMid, bandRadiusCents });
  if (piano && piano.quotabile === false) {
    return { ok: false, motivo: `un tick dietro il miglior prezzo altrui (${bo.price}) uscirebbe dalla banda: ${piano.reason}`,
      bestOther: bo.price, alone: false };
  }
  if (piano && piano.onTop === true) {
    return { ok: false, motivo: 'si finirebbe in cima al libro: non si resta primi nemmeno per restare premianti',
      bestOther: bo.price, alone: false };
  }
  return { ok: true, motivo: `un tick dietro ${bo.price} resta in banda`, bestOther: bo.price, alone: false,
    prezzoSuggerito: piano ? piano.price : null };
}

/**
 * REGOLE 2+3 · IL LIVELLO SU CUI PIAZZARSI.
 *
 * Si parte dal SECONDO livello in banda (il primo è della Regola 1) e si somma la profondità ALTRUI
 * finché supera il pavimento. Ci si ferma LÌ: è il più vicino al mid fra quelli ammessi, quindi quello
 * col punteggio più alto. Il quadratico è il motivo per cui non si cerca oltre.
 */
function trovaLivello({
  side = 'BUY', bookLevels = null, bandBounds = null, ownOrders = [], tick = null,
  pavimentoUsd = DEPTH_FLOOR_FALLBACK_USD, scoringMid = null, bandRadiusCents = null,
} = {}) {
  const no = (motivo, extra = {}) => ({ ok: false, price: null, level: null, motivo, depthAheadUsd: null, ...extra });

  const altrui = othersLadder({ levels: bookLevels, ownOrders: ownOrders || [], tick });
  if (altrui.readable !== true) return no(`profondità non leggibile: ${altrui.reason} — un dato mancante non è un via libera`);
  if (!bandBounds || !fin(bandBounds.lo) || !fin(bandBounds.hi)) return no('banda premiante non calcolabile');

  const dentro = altrui.levels
    .filter((l) => l && fin(l.price) && fin(l.size) && l.size > 0)
    .filter((l) => l.price >= bandBounds.lo - 1e-9 && l.price <= bandBounds.hi + 1e-9)
    // Dal più vicino al mid verso il bordo: per un BID «vicino» è più alto, per un ASK più basso.
    .sort((a, b) => (side === 'SELL' ? a.price - b.price : b.price - a.price));

  if (dentro.length < 2) {
    return no(`dentro la banda c'è ${dentro.length} livello: la ricerca parte dal secondo e non c'è`);
  }

  let cum = 0;
  for (let i = 1; i < dentro.length; i++) {
    const l = dentro[i];
    cum += l.price * l.size;
    if (cum + 1e-9 < pavimentoUsd) continue;
    // ── QUI CI SI FERMA. Vedi la Regola 3 nell'intestazione: è il più vicino al mid fra gli ammessi.
    return {
      ok: true, price: l.price, level: i + 1, depthAheadUsd: +cum.toFixed(4),
      punteggioRelativo: punteggioDiUnLivello({ price: l.price, scoringMid, bandRadiusCents }),
      motivo: `profondità altrui $${cum.toFixed(2)} ≥ pavimento $${pavimentoUsd.toFixed(2)} al livello ${i + 1}`
        + ' — ci si ferma qui: è il più vicino al mid fra quelli ammessi, quindi quello che rende di più',
    };
  }
  return no(
    `la banda finisce prima del pavimento: $${cum.toFixed(2)} su ${dentro.length - 1} livelli contro $${pavimentoUsd.toFixed(2)}`,
    { depthAheadUsd: +cum.toFixed(4) },
  );
}

/**
 * Il punteggio RELATIVO di un livello: S(v,s) = ((v − s)/v)², con v = raggio della banda e s = distanza
 * dal mid. È il fattore per share, non il premio in dollari — quello dipende dalla concorrenza, che
 * questo modulo non conosce. Serve a MOSTRARE perché un livello vale più di un altro.
 */
function punteggioDiUnLivello({ price, scoringMid, bandRadiusCents }) {
  if (!fin(price) || !fin(scoringMid) || !fin(bandRadiusCents) || bandRadiusCents <= 0) return null;
  const s = Math.abs(price - scoringMid) * 100;   // distanza in centesimi
  if (s >= bandRadiusCents) return 0;
  return +(((bandRadiusCents - s) / bandRadiusCents) ** 2).toFixed(6);
}

/**
 * REGOLA 4 · UN LATO SOLO: LO DECIDE LA FORMULA.
 *
 * Non un timer, non una soglia nostra. `qMin` con un lato a zero risponde esattamente:
 *   mid ∈ [0.10, 0.90] → max(min(x,0), max(x/3, 0)) = x/3   → un terzo, vale la pena tenerlo
 *   mid fuori          → min(x, 0) = 0                       → zero, non vale la pena tenerlo
 *
 * @returns {{maturaQualcosa:boolean, frazione:number, azione:'tieni'|'cancella'|'non-piazzare',
 *            mid:number|null, motivo:string}}
 */
function latoSingolo({ mid = null, esisteGia = false, deps = {} } = {}) {
  if (!fin(mid)) {
    // Il mid è il dato su cui si decide: senza, non si piazza e non si cancella nulla — cancellare
    // contro un numero che non si è potuto leggere è peggio del problema che risolverebbe.
    return { maturaQualcosa: false, frazione: null, azione: esisteGia ? 'tieni' : 'non-piazzare', mid: null,
      motivo: 'midpoint non leggibile: non si piazza un lato solo al buio, e non si cancella quello che c\'è già' };
  }
  const q = (deps.qMin || qMin);
  // Un lato a 1, l'altro a 0: il rapporto col caso a due lati è esattamente la frazione che matura.
  const frazione = q(1, 0, mid);
  const maturaQualcosa = frazione > 0;
  return {
    maturaQualcosa, frazione, mid,
    azione: maturaQualcosa ? 'tieni' : (esisteGia ? 'cancella' : 'non-piazzare'),
    motivo: maturaQualcosa
      ? `midpoint ${mid.toFixed(4)} dentro [${MID_MIN_UN_LATO}, ${MID_MAX_UN_LATO}]: un lato solo matura`
        + ` 1/${C_FACTOR} del punteggio — tenerlo rende più che chiuderlo`
      : `midpoint ${mid.toFixed(4)} FUORI da [${MID_MIN_UN_LATO}, ${MID_MAX_UN_LATO}]: un lato solo matura ZERO`
        + ' — è capitale fermo, si chiude subito senza aspettare nessun timer',
  };
}

/**
 * REGOLA 5 · IL TETTO DI CAPITALE PER MERCATO. Uno, uguale per tutti.
 * Saldo non leggibile ⇒ nessuna nuova esposizione: un tetto che non si può calcolare non è un tetto ampio.
 */
function tettoMercato({ saldoUsd = null, esposizioneMercatoUsd = 0, aggiuntaUsd = 0 } = {}) {
  if (!fin(saldoUsd) || saldoUsd <= 0) {
    return { consentito: false, capUsd: null, dopoUsd: null,
      motivo: 'saldo non leggibile: nessuna nuova esposizione (un tetto non calcolabile non è un tetto ampio)' };
  }
  const capUsd = +(saldoUsd * MARKET_CAP_PCT).toFixed(2);
  const attuale = fin(esposizioneMercatoUsd) ? esposizioneMercatoUsd : 0;
  const dopo = +(attuale + (fin(aggiuntaUsd) ? aggiuntaUsd : 0)).toFixed(2);
  if (dopo > capUsd + 1e-9) {
    return { consentito: false, capUsd, dopoUsd: dopo,
      motivo: `il mercato arriverebbe a $${dopo.toFixed(2)}, oltre il ${Math.round(MARKET_CAP_PCT * 100)}%`
        + ` del saldo ($${capUsd.toFixed(2)})` };
  }
  return { consentito: true, capUsd, dopoUsd: dopo,
    motivo: `$${dopo.toFixed(2)} entro il ${Math.round(MARKET_CAP_PCT * 100)}% del saldo ($${capUsd.toFixed(2)})` };
}

/**
 * IL PERCORSO UNICO. Un ordine, una proposta, una ricerca manuale: tutti passano da qui, nello stesso
 * ordine, con le stesse costanti. Non esiste un secondo ingresso con controlli ridotti.
 *
 * @returns {{ok:boolean, price:number|null, level:number|null, controlli:object,
 *            bocciature:Array<{regola:string,motivo:string}>, motivo:string}}
 */
function valutaMercato(a = {}) {
  const {
    marketId = null, side = 'BUY', bookLevels = null, bandBounds = null, bandRadiusCents = null,
    tick = null, ownOrders = [], scoringMid = null,
    liquiditaMediaShare = null, liquiditaCampioni = 0,
    liquiditaMediaUsd = null, liquiditaCampioniAltrui = null,
    saldoUsd = null, esposizioneMercatoUsd = 0, proposedSize = null, proposedPrice = null,
    latiAttivi = null,          // ['yes','no'] — quando manca, la Regola 4 non si applica
    deps = {},
  } = a;

  const bocciature = [];
  const controlli = {};

  // ── REGOLA 1 ──────────────────────────────────────────────────────────────────────────────────
  const r1 = (deps.controlloMaiPrimo || controlloMaiPrimo)({ bookLevels, ownOrders, tick, scoringMid, bandRadiusCents, deps });
  controlli.maiPrimo = r1;
  if (!r1.ok) {
    // Vincolo assoluto: se cade qui non si calcola altro, perché non si piazza comunque.
    return { ok: false, marketId, price: null, level: null, controlli,
      bocciature: [{ regola: 'mai-primo-sul-libro', motivo: r1.motivo }],
      motivo: `mai-primo-sul-libro: ${r1.motivo}` };
  }

  // ── REGOLA 4 (prima della ricerca del livello: se un lato solo non matura, è inutile cercarlo) ──
  const lati = Array.isArray(latiAttivi)
    ? [...new Set(latiAttivi.map((x) => String(x || '').toLowerCase()).filter((x) => x === 'yes' || x === 'no'))]
    : null;
  if (lati && lati.length === 1) {
    const r4 = (deps.latoSingolo || latoSingolo)({ mid: scoringMid, esisteGia: true, deps });
    controlli.latoSingolo = r4;
    if (r4.azione === 'cancella') {
      return { ok: false, marketId, price: null, level: null, controlli,
        bocciature: [{ regola: 'lato-singolo-senza-punteggio', motivo: r4.motivo }],
        motivo: `lato-singolo-senza-punteggio: ${r4.motivo}`, azioneRichiesta: 'cancella' };
    }
  }

  // ── REGOLA 5 ──────────────────────────────────────────────────────────────────────────────────
  const aggiunta = fin(proposedSize) && fin(proposedPrice) ? proposedSize * proposedPrice : 0;
  const r5 = (deps.tettoMercato || tettoMercato)({ saldoUsd, esposizioneMercatoUsd, aggiuntaUsd: aggiunta });
  controlli.tetto = r5;
  if (!r5.consentito) bocciature.push({ regola: 'tetto-mercato', motivo: r5.motivo });

  // ── REGOLE 2+3 ────────────────────────────────────────────────────────────────────────────────
  const pav = (deps.pavimentoDepth || pavimentoDepth)({
    liquiditaMediaUsd, campioniAltrui: liquiditaCampioniAltrui,
    liquiditaMediaShare, prezzoRif: scoringMid, campioni: liquiditaCampioni,
  });
  controlli.pavimento = pav;
  const liv = (deps.trovaLivello || trovaLivello)({
    side, bookLevels, bandBounds, ownOrders, tick, pavimentoUsd: pav.usd, scoringMid, bandRadiusCents,
  });
  controlli.livello = liv;
  if (!liv.ok) bocciature.push({ regola: 'profondita-insufficiente', motivo: liv.motivo });

  const ok = bocciature.length === 0;
  return {
    ok, marketId, price: ok ? liv.price : null, level: ok ? liv.level : null,
    punteggioRelativo: ok ? liv.punteggioRelativo : null,
    controlli, bocciature,
    motivo: ok
      ? `livello ${liv.level} @${liv.price} · ${liv.motivo} · ${pav.motivo}`
      : bocciature.map((b) => `${b.regola}: ${b.motivo}`).join(' · '),
  };
}

module.exports = {
  valutaMercato, controlloMaiPrimo, trovaLivello, pavimentoDepth, latoSingolo, tettoMercato,
  punteggioDiUnLivello,
  DEPTH_FLOOR_PCT_OF_AVG, DEPTH_FLOOR_FALLBACK_USD, MARKET_CAP_PCT,
  MID_MIN_UN_LATO, MID_MAX_UN_LATO,
};
