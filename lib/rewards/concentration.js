'use strict';
// lib/rewards/concentration.js — IL TETTO DI CONCENTRAZIONE, IN UN POSTO SOLO.
//
// ═══ PERCHÉ UN MODULO PER UN NUMERO ══════════════════════════════════════════════════════════════════
// Il tetto viveva in lib/maker/realloc-cycle.js e valeva solo per il riallocatore periodico. Il pannello
// «Ottimizza» non ne passava nessuno, quindi il suo tetto effettivo era il capitale intero: sullo stesso
// saldo e nello stesso istante le due strade producevano piani diversi — 4 mercati col 76,5% su uno solo
// contro 7 mercati col 29,4% al massimo — e nessuna delle due schermate diceva perché.
//
// Due strade che rispondono alla stessa domanda devono usare lo stesso numero, e l'unico modo perché
// resti lo stesso è che sia scritto una volta. Da qui lo leggono entrambe.
//
// ═══ IL NUMERO ═══════════════════════════════════════════════════════════════════════════════════════
// 30% del capitale su un singolo mercato. Non è una preferenza estetica: nella misura del 3 agosto 2026
// il knapsack senza tetto metteva il 68% del reward atteso su un mercato solo, ed è esattamente quel
// mercato che è poi collassato da $124/g a $3/g in poche ore. Il tetto non avrebbe evitato il collasso —
// nessun tetto lo fa — ma avrebbe ridotto quanto del piano se ne andava con lui.
//
// Il meccanismo NON è un filtro a valle: `allocateBudget` costruisce la griglia delle size fino al tetto,
// quindi il knapsack non vede nemmeno i livelli oltre. Non c'è nessun punto in cui un'allocazione viene
// calcolata e poi tagliata.

const CONCENTRATION_CAP_FRAC = 0.30;

/**
 * Il tetto in dollari per un dato capitale, o null se il capitale non è un numero utilizzabile —
 * null significa «nessun tetto», che è il comportamento storico e va chiesto, non subito per errore.
 */
function capPerMarketUsd(capitalUsd, frac = CONCENTRATION_CAP_FRAC) {
  if (typeof capitalUsd !== 'number' || !Number.isFinite(capitalUsd) || capitalUsd <= 0) return null;
  return +(capitalUsd * frac).toFixed(2);
}

module.exports = { CONCENTRATION_CAP_FRAC, capPerMarketUsd };
