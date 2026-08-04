'use strict';
// lib/maker/rimpiazzo-gamba.js — DOPO UN FILL, LA GAMBA TORNA SUL LIBRO SUBITO.
//
// ═══ IL PROBLEMA ═════════════════════════════════════════════════════════════════════════════════════
// Quando una gamba viene eseguita, il mercato resta «a una gamba sola». Per la formula del venue quella
// configurazione matura ZERO fuori dal range [0,10-0,90] e un terzo dentro — mentre il capitale, ormai
// diventato share, resta impegnato per intero. L'uscita automatica si occupa della SICUREZZA di quelle
// share; nessuno si occupava di rimettere il mercato a produrre. Fino al ciclo successivo: sei ore.
//
// ═══ LA REGOLA DEL TETTO, CHE È LA PARTE DELICATA ═══════════════════════════════════════════════════
// Il rimpiazzo NON è capitale nuovo che si aggiunge: è capitale che torna dove era. Ma nel frattempo la
// posizione in chiusura occupa ancora il suo spazio sotto il tetto del mercato, e l'uscita a riposo pure.
// Sommarci sopra una gamba intera raddoppierebbe l'esposizione sullo stesso mercato.
//
// Quindi lo spazio disponibile è:
//
//     disponibile = tettoDelMercato − (posizione aperta + ordini a riposo su questo mercato)
//
// e il rimpiazzo entra SOLO per quello che ci sta. Se non ci sta niente, non si piazza e si dice perché:
// il tetto non si forza mai, nemmeno per tornare produttivi.
//
// ═══ NON INTERFERISCE CON L'USCITA AUTOMATICA ══════════════════════════════════════════════════════
// Sono due ordini distinti sullo stesso mercato e non si confondono, per costruzione:
//   · l'uscita è un SELL sul token che possediamo, e auto-close la riconosce contando i SELL a riposo
//     su quel tokenId;
//   · il rimpiazzo è un BUY, e non entra in quel conteggio.
// Un BUY in più non fa mai sembrare «coperta» una posizione che non lo è.

const { planQuotes } = require('./mm-quote-math');

const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Decide se e come rimettere sul libro la gamba appena eseguita.
 *
 * @param {object} args
 *   marketId
 *   book            'yes'|'no' — il libro della gamba che è stata eseguita
 *   rules           resolveMarketRules() shape (mid, tick, maxSpreadCents, books)
 *   offsetCents     la distanza dal mid con cui la gamba era stata piazzata
 *   tettoMercatoUsd il tetto per questo mercato (lib/maker/allocated-capital), null = non leggibile
 *   posizioneUsd    il nozionale della posizione aperta su questo mercato
 *   ordiniApertiUsd il nozionale degli ordini a riposo su questo mercato (uscita compresa)
 *   minSizeShares   la size minima premiante del venue
 * @returns {{action:'rimpiazza'|'skip', gate, reason, price, size, disponibileUsd}}
 */
function decideRimpiazzo({
  book, rules, offsetCents, tettoMercatoUsd = null,
  posizioneUsd = 0, ordiniApertiUsd = 0, minSizeShares = null,
} = {}) {
  const out = (action, gate, reason, extra = {}) => ({ action, gate, reason, price: null, size: null, disponibileUsd: null, ...extra });

  if (!rules || rules.readable !== true) return out('skip', 'rules-unreadable', 'regole di venue non leggibili — nessun rimpiazzo viene costruito');
  if (book !== 'yes' && book !== 'no') return out('skip', 'book-ignoto', 'lato non identificato: non si indovina su quale libro rimettere la gamba');

  // ── LO SPAZIO SOTTO IL TETTO ────────────────────────────────────────────────────────────────────
  // Tetto non leggibile ⇒ NON si piazza. È l'unico fail-closed che conta qui: senza sapere quanto si
  // può, «un po'» non è una risposta. (auto-close, che CHIUDE, fallisce nella direzione opposta.)
  if (!fin(tettoMercatoUsd) || tettoMercatoUsd <= 0) {
    return out('skip', 'tetto-non-leggibile',
      'il tetto per questo mercato non è leggibile: non si apre esposizione nuova senza sapere quanta se ne può avere');
  }
  const impegnato = (fin(posizioneUsd) ? posizioneUsd : 0) + (fin(ordiniApertiUsd) ? ordiniApertiUsd : 0);
  const disponibile = +(tettoMercatoUsd - impegnato).toFixed(4);
  if (disponibile <= 0) {
    return out('skip', 'tetto-saturo',
      `il tetto del mercato ($${tettoMercatoUsd}) è già occupato da posizione ($${(fin(posizioneUsd) ? posizioneUsd : 0).toFixed(2)}) e ordini a riposo ($${(fin(ordiniApertiUsd) ? ordiniApertiUsd : 0).toFixed(2)}): il rimpiazzo aspetta che la chiusura liberi spazio, non forza il tetto`,
      { disponibileUsd: disponibile });
  }

  // ── IL PREZZO: la stessa aritmetica delle due gambe, allo stesso offset ─────────────────────────
  const bandRadiusCents = fin(rules.maxSpreadCents) ? rules.maxSpreadCents / 2 : null;
  const q = planQuotes({ mid: rules.mid, offsetCents, tick: rules.tick, bandRadiusCents });
  const lato = book === 'no' ? q.no : q.yes;
  if (!lato || lato.placeable !== true) {
    return out('skip', 'prezzo-non-piazzabile', `${(lato && lato.reason) || q.reason || 'prezzo non calcolabile'} — nessun rimpiazzo`, { disponibileUsd: disponibile });
  }
  if (lato.inBand === false) {
    return out('skip', 'fuori-banda',
      `all offset di ${offsetCents}¢ il lato ${book.toUpperCase()} riposerebbe fuori dalla banda premiante: rimetterlo lì sarebbe capitale fermo a rendere zero`,
      { disponibileUsd: disponibile });
  }

  // Le share che lo spazio disponibile compra a quel prezzo, troncate al decimo (mai arrotondate per
  // eccesso: il tetto non si sfora per un arrotondamento).
  const shares = Math.floor((disponibile / lato.price) * 10) / 10;
  if (!(shares > 0)) {
    return out('skip', 'spazio-insufficiente',
      `lo spazio disponibile ($${disponibile}) non compra nemmeno un decimo di share a ${lato.price}`, { disponibileUsd: disponibile });
  }
  if (fin(minSizeShares) && minSizeShares > 0 && shares < minSizeShares) {
    return out('skip', 'sotto-size-minima',
      `$${disponibile} comprano ${shares} share, sotto il minimo premiante del venue (${minSizeShares}): l ordine non scorerebbe, sarebbe capitale fermo`,
      { disponibileUsd: disponibile, shares });
  }

  return {
    action: 'rimpiazza', gate: null,
    reason: `la gamba ${book.toUpperCase()} era stata eseguita: torna sul libro a ${lato.price} per ${shares} share, dentro lo spazio rimasto sotto il tetto ($${disponibile} di $${tettoMercatoUsd})`,
    price: lato.price, size: shares, book, disponibileUsd: disponibile,
  };
}

module.exports = { decideRimpiazzo };
