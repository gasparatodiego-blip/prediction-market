'use strict';
// mm-quote-math — L'ARITMETICA DEL MARKET MAKING A DUE LATI, e NIENT'ALTRO.
//
// Vive separata da mm-tracking.js per una ragione precisa: il pannello di piazzamento deve mostrare
// l'anteprima con LA STESSA funzione che il motore usa per decidere, altrimenti l'anteprima e' una
// seconda implementazione che puo' divergere da quella vera. Ma mm-tracking legge file (configurazione,
// stato), e un modulo che tocca `fs` non entra in un bundle di browser.
//
// Quindi qui c'e' solo il calcolo: nessun require, nessun file, nessuna rete. Il motore lo importa e lo
// riesporta; il pannello lo importa direttamente. Una sola aritmetica, due chiamanti.

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const c2p = (cents) => cents / 100;
const p2c = (price) => price * 100;

/** Aggancia alla griglia del tick. Arrotonda al piu' vicino: nessuno dei due lati va favorito. */
function snap(price, tick) {
  if (!fin(price) || !fin(tick) || tick <= 0) return null;
  return +(Math.round(price / tick) * tick).toFixed(10);
}

/**
 * DOVE VANNO I DUE ORDINI, dato un mid e un offset.
 *
 * Restituisce sempre entrambi i lati, ciascuno con il proprio verdetto: un lato che non sta dentro
 * (0,1) dopo l'aggancio al tick e' `placeable:false` CON IL MOTIVO, mai un prezzo silenziosamente
 * spostato dentro i limiti. Un offset che porta un lato fuori dal libro e' una configurazione da
 * mostrare all'operatore, non da correggere alle sue spalle.
 */
function planQuotes({ mid, offsetCents, tick, bandRadiusCents = null } = {}) {
  const out = { ok: false, reason: null, mid, offsetCents, tick, yes: null, no: null };
  if (!fin(mid) || mid <= 0 || mid >= 1) { out.reason = 'mid non leggibile o fuori da (0,1)'; return out; }
  if (!fin(offsetCents) || offsetCents <= 0) { out.reason = 'offset non valido'; return out; }
  if (!fin(tick) || tick <= 0) { out.reason = 'tick del venue non leggibile'; return out; }

  const off = c2p(offsetCents);
  const build = (book, rawMid) => {
    const raw = rawMid - off;
    const price = snap(raw, tick);
    const placeable = fin(price) && price > 0 && price < 1;
    // LA BANDA, quando il venue la pubblica. L'offset e' una distanza dal mid, e la banda premiante e'
    // un raggio attorno al mid: se l'offset supera il raggio, quel lato riposa fuori e matura ZERO.
    // Non e' un motivo per rifiutare — l'operatore puo' volerlo per stare lontano dal fill — ma e' un
    // fatto che deve viaggiare fino allo schermo, non restare qui dentro.
    const inBand = fin(bandRadiusCents) ? offsetCents <= bandRadiusCents + 1e-9 : null;
    return {
      book,
      referenceMid: +rawMid.toFixed(6),
      price: placeable ? price : null,
      priceCents: placeable ? +p2c(price).toFixed(3) : null,
      placeable,
      reason: placeable ? null : `l'offset di ${offsetCents}¢ porta il lato ${book.toUpperCase()} a ${(p2c(raw)).toFixed(2)}¢, fuori dai limiti del libro`,
      inBand,
      bandNote: inBand === null
        ? 'il venue non pubblica una banda per questo mercato: non si puo dire se questo lato maturi'
        : inBand
          ? null
          : `fuori banda: l'offset ${offsetCents}¢ supera il raggio premiante ${bandRadiusCents}¢ — questo lato non matura reward`,
    };
  };

  out.yes = build('yes', mid);
  out.no = build('no', +(1 - mid).toFixed(6));
  out.ok = out.yes.placeable || out.no.placeable;
  if (!out.ok) out.reason = 'nessuno dei due lati e piazzabile con questo offset';
  return out;
}

/**
 * SI RIPREZZA?
 *
 * La soglia si misura sul MID, non sul prezzo degli ordini: e' il mid che si muove, e i due ordini lo
 * seguono rigidamente. Confrontare i prezzi darebbe la stessa risposta ma nasconderebbe la causa.
 *
 * `referenceMid` e' il mid al momento dell'ultimo piazzamento, non l'ultimo mid osservato: cosi' una
 * deriva lenta che supera la soglia in dieci cicli fa scattare UN reprice quando la supera, invece di
 * non farlo mai perche' ogni singolo passo era piccolo.
 */
function decideRetrack({ mid, referenceMid, minMoveCents, lastRepriceAt = null, minIntervalMs = 0, now = Date.now() } = {}) {
  if (!fin(mid)) return { act: false, gate: 'mid-unreadable', reason: 'mid non leggibile — non si riprezza su un numero che non si e letto' };
  if (!fin(referenceMid)) return { act: true, gate: null, reason: 'nessun mid di riferimento: primo piazzamento', movedCents: null };
  if (!fin(minMoveCents) || minMoveCents <= 0) return { act: false, gate: 'threshold-invalid', reason: 'soglia di movimento non valida' };

  const movedCents = +Math.abs(p2c(mid) - p2c(referenceMid)).toFixed(4);
  if (movedCents < minMoveCents) {
    return { act: false, gate: 'below-threshold', movedCents, reason: `il mid si e mosso ${movedCents}¢, sotto la soglia di ${minMoveCents}¢ — non si tocca nulla` };
  }
  // IL FRENO. Una soglia bassa su un mercato nervoso puo' produrre un reprice a ogni ciclo; il freno
  // rende quel caso lento invece che continuo, e vive qui e non nella soglia perche' sono due limiti
  // diversi: uno dice «quanto deve muoversi», l'altro «quanto spesso posso agire».
  if (fin(lastRepriceAt) && minIntervalMs > 0 && now - lastRepriceAt < minIntervalMs) {
    const waitS = Math.ceil((minIntervalMs - (now - lastRepriceAt)) / 1000);
    return { act: false, gate: 'rate-limited', movedCents, reason: `soglia superata (${movedCents}¢) ma l ultimo reprice e di ${Math.round((now - lastRepriceAt) / 1000)}s fa — attendo altri ${waitS}s` };
  }
  return { act: true, gate: null, movedCents, reason: `il mid si e mosso ${movedCents}¢, oltre la soglia di ${minMoveCents}¢` };
}


/**
 * IL VERDETTO PER UN LATO SOLO. E' il cuore della modalita' per-lato.
 *
 * LA DOMANDA NON E' PIU' «il mid si e' mosso?» MA «questo lato sta ancora maturando?». Un ordine dentro
 * la banda premiante rende esattamente come renderebbe se lo si rimettesse due tick piu' in la': muoverlo
 * costa una cancellazione, una firma, un posto in coda, e non compra niente. Un ordine fuori banda rende
 * ZERO, e ogni secondo che resta li' e' capitale fermo. Quindi il trigger e' l'uscita dalla banda, non il
 * movimento del mid — sono due cose diverse e prima erano la stessa.
 *
 * LA SOGLIA, E DOVE SI APPLICA DAVVERO. `minMoveCents` non sopprime il riprezzo di un lato uscito dalla
 * banda: sopprimerlo vorrebbe dire lasciare a rendere zero un ordine che sappiamo essere a rendere zero.
 * Serve invece per il caso patologico in cui l'offset e' PIU LARGO del raggio premiante: li' un lato
 * nasce gia' fuori banda e verrebbe riprezzato a ogni singolo aggiornamento del feed, all'infinito.
 * In quel caso — e solo in quel caso — si pretende che il mid si sia mosso almeno di `minMoveCents`
 * dall'ultimo piazzamento di QUEL lato.
 *
 * @param sideMid      il mid del book di questo lato (per NO: 1 − mid)
 * @param price        il prezzo dell'ordine attualmente a riposo su questo lato, o null se non c'e'
 * @param bandRadiusCents  raggio premiante; null = il venue non pubblica una banda
 * @param placedAtMid  il sideMid al momento in cui QUESTO lato e' stato piazzato
 */
function decideSide({ sideMid, price, offsetCents, bandRadiusCents, minMoveCents, placedAtMid } = {}) {
  if (!fin(sideMid)) return { act: false, gate: 'mid-unreadable', reason: 'mid non leggibile', inBand: null, distanceCents: null };
  if (!fin(price)) {
    return { act: true, gate: null, inBand: null, distanceCents: null, trigger: 'missing',
      reason: 'nessun ordine a riposo su questo lato: lo piazzo' };
  }
  const distanceCents = +Math.abs(p2c(price) - p2c(sideMid)).toFixed(4);
  // Banda non pubblicata ⇒ non si puo' AFFERMARE che il lato sia fuori. Non si tocca, e si dice perche':
  // muovere un ordine sulla base di una regola che non si e' letta e' peggio che lasciarlo dov'e'.
  if (!fin(bandRadiusCents)) {
    return { act: false, gate: 'band-unknown', inBand: null, distanceCents,
      reason: `il venue non pubblica una banda per questo mercato: non si puo dire se questo lato stia maturando, quindi non lo si muove (dista ${distanceCents}¢ dal mid)` };
  }
  const inBand = distanceCents <= bandRadiusCents + 1e-9;
  if (inBand) {
    return { act: false, gate: 'in-band', inBand: true, distanceCents,
      reason: `dentro banda: dista ${distanceCents}¢ dal mid, entro il raggio ${bandRadiusCents}¢ — sta maturando, non si tocca` };
  }
  // FUORI BANDA. Il freno vale solo se l'offset stesso e' piu' largo del raggio: in quel caso il lato
  // sarebbe fuori banda anche appena piazzato, e senza freno si riprezzerebbe di continuo.
  const offsetOutsideBand = fin(offsetCents) && fin(bandRadiusCents) && offsetCents > bandRadiusCents + 1e-9;
  if (offsetOutsideBand && fin(placedAtMid) && fin(minMoveCents)) {
    const movedCents = +Math.abs(p2c(sideMid) - p2c(placedAtMid)).toFixed(4);
    if (movedCents < minMoveCents) {
      return { act: false, gate: 'offset-outside-band', inBand: false, distanceCents, movedCents,
        reason: `fuori banda, ma l offset configurato (${offsetCents}¢) e gia piu largo del raggio premiante (${bandRadiusCents}¢): questo lato non maturera mai e riprezzarlo a ogni tick sarebbe solo rumore. Attendo che il mid si muova di ${minMoveCents}¢ (finora ${movedCents}¢).` };
    }
  }
  return { act: true, gate: null, inBand: false, distanceCents, trigger: 'out-of-band',
    reason: `FUORI BANDA: dista ${distanceCents}¢ dal mid, oltre il raggio ${bandRadiusCents}¢ — sta rendendo zero, lo riporto a ${offsetCents}¢ dal mid nuovo` };
}

module.exports = { planQuotes, decideRetrack, decideSide, snap };
