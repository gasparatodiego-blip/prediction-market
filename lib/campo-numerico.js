'use strict';
// lib/campo-numerico.js — UN CAMPO VUOTO NON È UNO ZERO.
//
// ═══ IL DIFETTO CHE HA PRODOTTO QUESTO MODULO ════════════════════════════════════════════════════════
// 4 agosto 2026, pannello «Nuovo ordine a mano». Il bottone PIAZZA ORDINE era disattivato e sotto
// comparivano tre errori del guard di validazione:
//
//     PRICE_OUT_OF_RANGE   price 0 is outside the venue range [0.001, 0.999]
//     OUT_OF_BAND          |price − scoring mid| 53.55¢ exceeds the reward band ±2.25¢
//     BELOW_MIN_SIZE       size is missing or ≤ 0
//
// L'operatore vedeva 0.536 nel campo prezzo e 50 nel campo size, e concludeva — ragionevolmente — che
// il guard stesse leggendo un input scollegato dal form. Non era così: quei due valori erano i
// PLACEHOLDER (il mid del mercato e la size minima del venue), il form era VUOTO, e
//
//     Number('') === 0        // non NaN
//
// Con il mid a 0,5355, |0 − 0,5355| fa esattamente 53,55¢: il guard non leggeva un dato sbagliato,
// leggeva zero perché zero è ciò che `Number('')` restituisce.
//
// ═══ PERCHÉ NON È UN DETTAGLIO DI PARSING ════════════════════════════════════════════════════════════
// È la stessa epistemica che questo repo applica ovunque — un montepremi non leggibile non è zero, una
// scadenza assente non è «scade domani», una posizione non letta non è «nessuna posizione» — applicata
// al posto più banale e per questo dimenticato: la casella di un modulo.
//
// La conseguenza non è cosmetica. Un modulo mai toccato che si accusa di tre errori insegna
// all'operatore che gli avvisi del guard sono rumore, e il giorno che ne compare uno vero lo salta.
//
// L'idioma giusto esisteva già due volte in questo repo (RewardsUnified, MarketTerminal):
//     sizeInput.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null
// Il pannello degli ordini a mano era l'unico fuori riga. Adesso la regola sta qui.

/**
 * Il numero che l'utente ha DIGITATO, oppure null se non ha digitato niente di utilizzabile.
 *
 * Tre esiti soltanto, e nessuno di essi è «0 per ripiego»:
 *   number  una stringa che è davvero un numero finito
 *   null    campo vuoto o di soli spazi  →  NON DIGITATO
 *   null    testo non numerico           →  non interpretabile (mai NaN in circolazione)
 *
 * @param {unknown} s  il valore grezzo del campo (`e.target.value`)
 * @returns {number|null}
 */
function numeroDigitato(s) {
  if (typeof s !== 'string' || s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Lo stesso, ma per i campi in cui lo zero non è un valore legittimo (prezzo, size): un «0» digitato
 * a mano resta un numero, e va giudicato dal guard — mentre un campo vuoto non arriva nemmeno al guard.
 * Distinguere i due casi è tutto il punto: «non l'ho scritto» e «ho scritto zero» meritano risposte
 * diverse, e prima ne ricevevano una sola.
 */
function digitatoEPositivo(s) {
  const n = numeroDigitato(s);
  return n != null && n > 0 ? n : null;
}

/** Asserzioni indipendenti. Esegui: node -e "require('./lib/campo-numerico').selfcheck()" */
function selfcheck() {
  const assert = require('assert');
  let n = 0;
  const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };

  // ── IL CASO CHE HA PRODOTTO IL MODULO
  ok('campo vuoto → null, NON zero', numeroDigitato('') === null);
  ok('  ed è precisamente ciò che Number() non fa', Number('') === 0);
  ok('  soli spazi → null', numeroDigitato('   ') === null);

  // ── I NUMERI VERI PASSANO
  ok('«0.536» → 0.536', numeroDigitato('0.536') === 0.536);
  ok('«50» → 50', numeroDigitato('50') === 50);
  ok('  con spazi intorno → il numero', numeroDigitato('  50  ') === 50);
  ok('«0» digitato a mano È un numero: va giudicato, non ignorato', numeroDigitato('0') === 0);
  ok('  e resta distinto dal campo vuoto', numeroDigitato('0') !== numeroDigitato(''));
  ok('un negativo passa: sarà il guard a rifiutarlo, con il suo nome', numeroDigitato('-1') === -1);

  // ── NIENTE NaN IN CIRCOLAZIONE
  ok('testo non numerico → null, mai NaN', numeroDigitato('abc') === null);
  ok('  stringa mista → null', numeroDigitato('0.5x') === null);
  ok('  Infinity → null (non è un prezzo)', numeroDigitato('Infinity') === null);
  ok('non-stringhe → null', numeroDigitato(null) === null && numeroDigitato(undefined) === null && numeroDigitato(5) === null);

  // ── LA VARIANTE CHE PRETENDE ANCHE IL POSITIVO
  ok('digitatoEPositivo: vuoto → null', digitatoEPositivo('') === null);
  ok('  «0» → null (digitato, ma non utilizzabile come size o prezzo)', digitatoEPositivo('0') === null);
  ok('  «50» → 50', digitatoEPositivo('50') === 50);

  console.log('campo-numerico: ' + n + ' assertions passed');
  return n;
}

module.exports = { numeroDigitato, digitatoEPositivo, selfcheck };
