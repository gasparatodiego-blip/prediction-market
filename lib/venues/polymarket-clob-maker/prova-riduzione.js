'use strict';
// lib/venues/polymarket-clob-maker/prova-riduzione.js — LA PROVA CHE UN ORDINE TOGLIE ESPOSIZIONE.
//
// ═══ PERCHÉ VIVE IN UN FILE SUO ══════════════════════════════════════════════════════════════════════
// Questa funzione è nata dentro `adapter.js` (§5 punto 26, l'eccezione di riduzione alla allowlist
// live-min) e da lì è stata ESTRATTA il 12 agosto 2026, senza cambiarne una riga di logica.
//
// La ragione è l'esenzione dal tetto per ordine (`lib/maker/esenzione-chiusura.js`): anche lei deve
// rispondere «questo SELL riduce?», e le risposte devono essere la STESSA risposta. Le due strade
// possibili erano ricopiare l'aritmetica — cioè il reperto che il rilevatore D1 dell'audit cerca, e qui
// una divergenza allargherebbe un limite di rischio — oppure importarla. Importarla direttamente da
// `adapter.js` avrebbe creato un ciclo, perché è l'adapter a importare l'esenzione.
//
// Quindi: un file senza dipendenze, importato da entrambi. `adapter.js` continua a esportare
// `evaluateReductionProof` con lo stesso nome e lo stesso comportamento — i suoi test non cambiano.

/**
 * Un SELL è una riduzione solo se le share vendute sono share che abbiamo DAVVERO, lette dal venue.
 *
 * `Number(null)` è 0 e `Number(undefined)` è NaN: entrambi devono valere «non provato», mai «zero share
 * detenute quindi va bene». Si richiede un numero finito e STRETTAMENTE positivo.
 */
function evaluateReductionProof({ side, size, heldSize } = {}) {
  if (side !== 'SELL') return { riduce: false, motivo: null };
  const s = Number(size);
  const h = Number(heldSize);
  if (!Number.isFinite(h) || h <= 0) return { riduce: false, motivo: null };
  if (!Number.isFinite(s) || s <= 0) return { riduce: false, motivo: null };
  if (s > h + 1e-9) return { riduce: false, motivo: null };
  return {
    riduce: true,
    motivo: `riduzione provata: SELL di ${s} share su ${h} realmente detenute (lettura del venue) — un ordine`
      + ' che TOGLIE esposizione non e\' vincolato alla allowlist live-min, che governa dove si PUO\' APRIRE.'
      + ' Senza questa eccezione una posizione sopravvissuta a una riallocazione resterebbe senza via d\'uscita.',
  };
}

module.exports = { evaluateReductionProof };
