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
// 20% del capitale su un singolo mercato. Non è una preferenza estetica: nella misura del 3 agosto 2026
// il knapsack senza tetto metteva il 68% del reward atteso su un mercato solo, ed è esattamente quel
// mercato che è poi collassato da $124/g a $3/g in poche ore. Il tetto non avrebbe evitato il collasso —
// nessun tetto lo fa — ma avrebbe ridotto quanto del piano se ne andava con lui.
//
// È 20% e non 30% dal 7 agosto 2026. Questo modulo è nato per togliere di mezzo due risposte alla stessa
// domanda, e una seconda coppia era rimasta: qui c'era 30%, mentre il motore di piazzamento
// (lib/maker/motore-unico.js, MARKET_CAP_PCT) rifiuta da sempre tutto ciò che porta un mercato oltre il
// **20% del saldo**. Il vincolo più stretto vinceva comunque, quindi il 30% non allargava il rischio: si
// limitava a far proporre al pianificatore righe che il motore avrebbe poi tagliato in fase di quoting —
// un piano che il pannello mostrava e il venue non vedeva mai per intero. Il tetto di sicurezza è quello
// del motore, deciso per limitare il rischio di RISOLUZIONE su un mercato solo; il pianificatore lo
// adotta invece di contraddirlo. Se un giorno cambia, cambiano insieme: sono lo stesso vincolo.
//
// Il meccanismo NON è un filtro a valle: `allocateBudget` costruisce la griglia delle size fino al tetto,
// quindi il knapsack non vede nemmeno i livelli oltre. Non c'è nessun punto in cui un'allocazione viene
// calcolata e poi tagliata.

const CONCENTRATION_CAP_FRAC = 0.20;

/**
 * Il tetto in dollari per un dato capitale, o null se il capitale non è un numero utilizzabile —
 * null significa «nessun tetto», che è il comportamento storico e va chiesto, non subito per errore.
 */
function capPerMarketUsd(capitalUsd, frac = CONCENTRATION_CAP_FRAC) {
  if (typeof capitalUsd !== 'number' || !Number.isFinite(capitalUsd) || capitalUsd <= 0) return null;
  return +(capitalUsd * frac).toFixed(2);
}

module.exports = { CONCENTRATION_CAP_FRAC, capPerMarketUsd };
