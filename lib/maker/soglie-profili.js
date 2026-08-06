'use strict';
// lib/maker/soglie-profili.js — LE SOGLIE DEI DUE PROFILI, IN UN MODULO CHE IL BROWSER PUÒ LEGGERE.
//
// ═══ PERCHÉ ESISTE ═══════════════════════════════════════════════════════════════════════════════════
// L'interfaccia deve DICHIARARE le soglie con cui il motore lavora — un banner che scrive «$20» a mano
// è un banner che mente il giorno in cui la costante cambia. Ma i moduli che quelle soglie le USANO non
// sono tutti importabili da un componente client: `volatilita-mercato.js` legge il giornale di agent34
// e quindi importa `fs`, che nel bundle del browser non esiste.
//
// Quindi i NUMERI stanno qui — un file senza nessun `require`, sicuro da importare da qualunque parte —
// e i moduli che li applicano li importano da qui. Non è una copia: è l'unico posto in cui sono scritti.
// Se un giorno una soglia cambia, cambia per il motore e per la frase che la descrive nello stesso
// istante, perché sono lo stesso simbolo.
//
// ═══ COSA NON STA QUI ════════════════════════════════════════════════════════════════════════════════
// Le soglie DERIVATE da fatti del venue (il pavimento GTD di order-ttl, il minimo di horizon, la
// staleness di plan-to-orders) restano nei moduli che le possiedono e viaggiano attraverso
// risk-classifier: quelle non sono scelte di strategia, sono vincoli, e il posto giusto è accanto alla
// fonte primaria che le documenta.

// ── VOLATILITÀ E SPREAD ───────────────────────────────────────────────────────────────────────────
/** Finestra della volatilità Safe, in minuti. 480 = 8 ore. */
const SAFE_VOLATILITY_WINDOW_MIN = 480;
/** Range ≥ questo multiplo dell'AMPIEZZA della banda ⇒ margine dal bordo raddoppiato. */
const SAFE_VOLATILITY_THRESHOLD_MULT = 2;
/** Spread corrente ≥ questo multiplo della sua media mobile ⇒ blocco. */
const SAFE_SPREAD_ANOMALY_MULT = 3;
/** Finestra della media mobile dello spread, in minuti. */
const SAFE_SPREAD_WINDOW_MIN = 120;
/** Finestra del nervosismo Risk, in minuti. */
const RISK_VOLATILITY_WINDOW_MIN = 5;
/** Range ≥ questo multiplo dell'ampiezza della banda ⇒ mercato nervoso. */
const RISK_VOLATILITY_THRESHOLD_MULT = 0.5;

module.exports = {
  SAFE_VOLATILITY_WINDOW_MIN, SAFE_VOLATILITY_THRESHOLD_MULT,
  SAFE_SPREAD_ANOMALY_MULT, SAFE_SPREAD_WINDOW_MIN,
  RISK_VOLATILITY_WINDOW_MIN, RISK_VOLATILITY_THRESHOLD_MULT,
};
