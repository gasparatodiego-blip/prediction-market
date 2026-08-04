'use strict';
// lib/rewards/righe-piano.js — LE RIGHE DEI DUE PIANI, IN UNA MAPPA SOLA.
//
// ═══ IL DIFETTO CHE HA PRODOTTO QUESTO MODULO ════════════════════════════════════════════════════════
// Nella tab «Ottimizza» i piani sono DUE, con due bottoni e due stati React distinti:
//
//     plan      ← «Calcola»                         le righe del piano manuale
//     autoPlan  ← «Cerca la combinazione migliore»   LE CARD DI PROPOSTA
//
// La coda di piazzamento si appoggia a una mappa marketId → riga, e quella mappa leggeva SOLO
// `plan.rows`. Ma il bottone «+ Metti in coda» sta sulle card, che vengono da `autoPlan`.
//
// Conseguenza, per una sera intera: chi arrivava alle proposte dal percorso normale — premere «Cerca la
// combinazione migliore» e basta — aveva `plan` a null. Mappa vuota, `righePerId.has(...)` sempre falso,
// bottone MAI renderizzato. Non era nascosto da un flag, non era sparito dal bundle, nessun commit lo
// aveva tolto: era una condizione che non poteva avverarsi.
//
// ═══ PERCHÉ ADESSO STA IN UN MODULO E NON DENTRO IL COMPONENTE ═══════════════════════════════════════
// Perché una condizione dentro un `useMemo` si può verificare solo con una regex sul sorgente — cioè
// non si può verificare. Qui è una funzione pura, e il test che protegge il bottone esercita QUELLA,
// nello stato esatto in cui il difetto si manifestava: piano automatico pieno, piano manuale assente.

/**
 * La mappa marketId → riga, costruita da entrambi i piani.
 *
 * @param {object} a
 *   plan      il piano manuale («Calcola»), o null
 *   autoPlan  il piano automatico («Cerca la combinazione migliore»), o null
 * @returns {Map<string, object>}  chiavi in minuscolo
 *
 * `autoPlan` VINCE dove un mercato sta in tutti e due: è la riga della card che l'operatore sta
 * guardando quando preme il bottone, e prendere l'altra significherebbe mettere in coda numeri che sullo
 * schermo non ci sono.
 */
function righePerId({ plan = null, autoPlan = null } = {}) {
  const m = new Map();
  for (const r of (plan && Array.isArray(plan.rows) ? plan.rows : [])) {
    if (r && typeof r.marketId === 'string') m.set(r.marketId.toLowerCase(), r);
  }
  for (const r of (autoPlan && Array.isArray(autoPlan.rows) ? autoPlan.rows : [])) {
    if (r && typeof r.marketId === 'string') m.set(r.marketId.toLowerCase(), r);
  }
  return m;
}

/**
 * IL BOTTONE «+ Metti in coda» SI PUÒ MOSTRARE SU QUESTA CARD?
 * Serve una riga di piano da cui prendere prezzo e size: senza, la coda non avrebbe cosa mostrare e
 * mostrarlo lo stesso porterebbe a un pannello vuoto.
 */
function puoAndareInCoda({ righe = new Map(), marketId = '' } = {}) {
  return typeof marketId === 'string' && marketId.trim() !== '' && righe.has(marketId.toLowerCase());
}

/** Asserzioni indipendenti. Esegui: node -e "require('./lib/rewards/righe-piano').selfcheck()" */
function selfcheck() {
  const assert = require('assert');
  let n = 0;
  const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };
  const riga = (id, extra = {}) => ({ marketId: id, capital: 60, ...extra });

  // ── LO STATO ESATTO IN CUI IL DIFETTO SI MANIFESTAVA ─────────────────────────────────────────────
  const soloAuto = righePerId({ plan: null, autoPlan: { rows: [riga('0xAA'), riga('0xBB')] } });
  ok('SOLO il piano automatico (il percorso normale) → la mappa NON è vuota', soloAuto.size === 2);
  ok('  e il bottone si può mostrare — era questo a non succedere',
    puoAndareInCoda({ righe: soloAuto, marketId: '0xAA' }) === true);
  ok('  anche con l id in maiuscolo diverso', puoAndareInCoda({ righe: soloAuto, marketId: '0xaa' }) === true);

  const soloManuale = righePerId({ plan: { rows: [riga('0xCC')] }, autoPlan: null });
  ok('solo il piano manuale → funziona come prima', soloManuale.size === 1 && soloManuale.has('0xcc'));

  const nessuno = righePerId({ plan: null, autoPlan: null });
  ok('nessun piano → mappa vuota, e il bottone non si mostra',
    nessuno.size === 0 && puoAndareInCoda({ righe: nessuno, marketId: '0xAA' }) === false);

  // ── LA PRECEDENZA
  const doppio = righePerId({
    plan: { rows: [riga('0xAA', { capital: 10, da: 'manuale' })] },
    autoPlan: { rows: [riga('0xAA', { capital: 60, da: 'auto' })] },
  });
  ok('un mercato in ENTRAMBI → vince la riga del piano automatico', doppio.get('0xaa').da === 'auto');
  ok('  con il suo capitale, non quello dell altro', doppio.get('0xaa').capital === 60);

  // ── ROBUSTEZZA: una forma inattesa non deve far esplodere il render di una sezione intera
  ok('rows assente → nessun errore', righePerId({ plan: {}, autoPlan: {} }).size === 0);
  ok('rows non array → nessun errore', righePerId({ plan: { rows: 'x' } }).size === 0);
  ok('righe senza marketId ignorate', righePerId({ autoPlan: { rows: [{ capital: 1 }, riga('0xDD')] } }).size === 1);
  ok('marketId vuoto → il bottone non si mostra', puoAndareInCoda({ righe: soloAuto, marketId: '  ' }) === false);

  console.log('righe-piano: ' + n + ' assertions passed');
  return n;
}

module.exports = { righePerId, puoAndareInCoda, selfcheck };
