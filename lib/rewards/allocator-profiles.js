'use strict';
// lib/rewards/allocator-profiles.js — DUE PROFILI, UN ALLOCATORE SOLO.
//
// ═══ COSA NON È ══════════════════════════════════════════════════════════════════════════════════════
// NON è un secondo allocatore. Non contiene un knapsack, non sceglie mercati, non stima niente. È
// l'insieme dei PARAMETRI con cui `planAllocation` viene chiamato, e nient'altro: il motivo per cui la
// tab Risk non ha una copia della funzione che la tab Ottimizza usa da mesi.
//
// ═══ COSA CAMBIA FRA I DUE, E COSA NO ════════════════════════════════════════════════════════════════
// Cambia UNA cosa sola in tre parametri: QUALI MERCATI l'allocatore è disposto a proporre.
//
//                              SAFE                                  RISK
//   scadenza minima      rientro dal costo di adverse         pavimento di tradabilità del venue
//                        selection (horizon.js: payback,      (order-ttl.js: 180 s = 3 min)
//                        con minimo 2 giorni)
//   fuori banda          escluso                              tollerato
//   dati stale (>300 s)  escluso                              tollerato
//
// NON cambia NIENTE del motore di esecuzione. Piazzamento, GTD, rinnovo, dead-man's switch,
// reconciliation e kill-switch sono gli stessi identici per i due profili — un ordine nato da un piano
// Risk, una volta piazzato, è indistinguibile da uno nato da un piano Safe, e questo è deliberato: il
// «rischio» sta nella SCELTA del mercato, non nel modo in cui l'ordine viene gestito. Vedi il test
// motore-condiviso.test.js, che verifica proprio l'assenza di ogni ramo per profilo a valle.
//
// ═══ I NUMERI SONO IMPORTATI, NON SCRITTI ════════════════════════════════════════════════════════════
// Come in risk-classifier.js: le soglie vengono dai moduli che già le possedevano. Qui non c'è nessun
// numero letterale di strategia, e non deve essercene, altrimenti «la soglia che il filtro applica» e
// «la soglia che la nota sotto il bottone dichiara» diventano due cose che possono divergere.

const {
  VENUE_FLOOR_MINUTES, SAFE_FLOOR_MINUTES, STALE_SECONDS,
} = require('../maker/risk-classifier');
const { MIN_HORIZON_DAYS } = require('./horizon');
const { VENUE_GTD_MIN_FUTURE_SEC } = require('../maker/order-ttl');

/** La regola di scadenza del profilo Safe: il rientro dal costo di adverse selection (horizon.js). */
const RULE_ADVERSE = 'adverse-selection-recovery';
/** La regola di scadenza del profilo Risk: solo il pavimento di tradabilità del venue. */
const RULE_VENUE_FLOOR = 'venue-floor';

/**
 * IL PROFILO SAFE — il comportamento che l'ottimizzatore ha OGGI, dichiarato invece che implicito.
 *
 * `horizonFilter: true` è esattamente ciò che la rotta passa già quando il pannello chiede `auto=1`, e
 * `minTimeToCloseRule` vale RULE_ADVERSE, che nel codice dell'allocatore è il ramo che esisteva prima
 * che i profili esistessero. Passare questo profilo NON cambia una virgola del piano prodotto: è la
 * proprietà che il test di non-regressione verifica riga per riga.
 */
const SAFE_PROFILE = Object.freeze({
  key: 'safe',
  label: 'Safe',
  horizonFilter: true,
  minTimeToCloseRule: RULE_ADVERSE,
  /** In minuti — la soglia che il classificatore usa per etichettare. 2 giorni. */
  safeFloorMinutes: SAFE_FLOOR_MINUTES,
  allowOutOfBand: false,
  allowStaleData: false,
  staleSeconds: STALE_SECONDS,
});

/**
 * IL PROFILO RISK — stesso allocatore, tre vincoli allentati e nessun altro.
 *
 * `horizonFilter: true` resta ACCESO di proposito: il filtro orizzonte non serve solo a scartare i
 * mercati troppo corti, scarta anche i `resolved` — cioè quelli già chiusi. Un profilo che li lasciasse
 * passare non sarebbe «più tollerante», sarebbe rotto. Ciò che cambia è la REGOLA che il filtro applica,
 * non il fatto che ci sia.
 */
const RISK_PROFILE = Object.freeze({
  key: 'risk',
  label: 'Risk',
  horizonFilter: true,
  minTimeToCloseRule: RULE_VENUE_FLOOR,
  /** In minuti — 3. Il pavimento del venue, non una soglia di strategia. */
  safeFloorMinutes: VENUE_FLOOR_MINUTES,
  allowOutOfBand: true,
  allowStaleData: true,
  staleSeconds: STALE_SECONDS,
});

const PROFILES = Object.freeze({ safe: SAFE_PROFILE, risk: RISK_PROFILE });

/** Il profilo da un nome. Sconosciuto o assente ⇒ SAFE: il difetto è sempre quello che stringe. */
function resolveProfile(nameOrProfile) {
  if (nameOrProfile && typeof nameOrProfile === 'object' && nameOrProfile.key) return nameOrProfile;
  const k = String(nameOrProfile || '').trim().toLowerCase();
  return PROFILES[k] || SAFE_PROFILE;
}

/**
 * LA NOTA SOTTO IL BOTTONE, generata dai valori VERI dei due profili.
 *
 * Non è un testo scritto a mano che descrive il codice: è il codice che si descrive. Se una soglia
 * cambia in order-ttl.js o in horizon.js, questa frase cambia con lei — e non può restare indietro,
 * che è l'unico modo perché una nota del genere valga qualcosa.
 *
 * @returns {Array<{voce:string, safe:string, risk:string}>}
 */
function differenzeProfili() {
  const oreSafe = SAFE_FLOOR_MINUTES / 60;
  return [
    {
      voce: 'Scadenza minima del mercato',
      safe: `rientro dal costo di adverse selection — minimo ${MIN_HORIZON_DAYS} giorni (${oreSafe} h)`,
      risk: `pavimento del venue — ${VENUE_GTD_MIN_FUTURE_SEC} s (${VENUE_FLOOR_MINUTES} min)`,
    },
    {
      voce: 'Prezzo fuori dalla banda premiante',
      safe: 'escluso',
      risk: 'tollerato — il mercato viene proposto e il flag resta visibile sulla card',
    },
    {
      voce: `Dati più vecchi di ${STALE_SECONDS} s (${STALE_SECONDS / 60} min)`,
      safe: 'esclusi',
      risk: 'inclusi — la card dichiara «dati stale»',
    },
    {
      voce: 'Motore di esecuzione',
      safe: 'GTD, rinnovo, dead-man\'s switch, reconciliation, kill-switch',
      risk: 'IDENTICO — nessuna differenza a valle del piazzamento',
    },
  ];
}

module.exports = {
  SAFE_PROFILE, RISK_PROFILE, PROFILES, resolveProfile, differenzeProfili,
  RULE_ADVERSE, RULE_VENUE_FLOOR,
};
