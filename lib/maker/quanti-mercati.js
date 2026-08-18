'use strict';
// lib/maker/quanti-mercati.js — QUANTI MERCATI IL BOT PUO' TENERE ATTIVI. UN POSTO SOLO.
//
// ═══ LA REGOLA DELL'OPERATORE (R1, 18 agosto 2026) ═══════════════════════════════════════════════════
// «il numero lo decido io prima di ogni sessione (uno, due, tre). I mercati li sceglie il bot. Un solo
//  posto dove scrivere quel numero, letto dai processi vivi.»
// E, aggiunto dopo il confronto: «oggi il 3 e' cablato due volte».
//
// ═══ COS'ERA PRIMA, E PERCHE' NON BASTAVA ════════════════════════════════════════════════════════════
// `MAX_MERCATI_CONTEMPORANEI = 3` era una costante di sorgente, e `agent41` chiamava `decidiSelezione`
// senza passare `max`. Quindi il numero:
//   · non era scrivibile senza toccare il codice e riavviare;
//   · non era leggibile dai processi vivi — `stato.js` stampava la costante di QUESTA copia del repo,
//     che a processo riavviato con codice diverso avrebbe detto una cosa e il processo un'altra;
//   · ed era cablato DUE VOLTE, perche' `QUOTA_SCAGLIONI` dichiarava «1 basso + 2 alti» = 3 posti in
//     un secondo letterale. Cambiare il primo senza il secondo avrebbe prodotto un tetto di 2 con tre
//     posti di scaglione, o un tetto di 4 con tre: il reperto D1 su una decisione di capitale.
//
// ═══ ADESSO ══════════════════════════════════════════════════════════════════════════════════════════
// Il numero e' UNA variabile d'ambiente, `MAKER_MERCATI_CONTEMPORANEI`, dichiarata in
// `agents/ecosystem.config.js` sul solo processo che esegue la selezione (agent41). Vive nel processo,
// quindi si legge da `/proc/<pid>/environ` — la stessa disciplina delle cinture (§5-bis p.184): non si
// racconta lo stato leggendo il `.env`, si legge il processo che decide.
// E la QUOTA per scaglione si DERIVA da lui (`quotaScaglioni` in `selezione-mercati`): un letterale solo.
//
// ⚠ CAMBIARLO RICHIEDE IL RIAVVIO DAL FILE. `pm2 restart <nome> --update-env` prende l'ambiente della
// SHELL, non `ecosystem.config.js` (§5.1): per una variabile nuova serve
// `pm2 restart agents/ecosystem.config.js --only agent41-realloc-scheduler`.
//
// ⚠ E RIDURLO NON CHIUDE NIENTE DA SOLO. Portare 3 a 1 con tre mercati attivi non ne caccia due: la
// selezione non spodesta chi ha ordini vivi o una posizione (R9), quindi il numero governa quanti se
// ne APRONO, e il rientro avviene per consumo. E' la direzione prudente, ed e' bene saperlo prima.

// ⚠⚠ IL NUMERO NON E' SCRITTO QUI, E NON DEVE ESSERLO. Difetto e massimo si IMPORTANO entrambi da
// `selezione-mercati.MAX_MERCATI_CONTEMPORANEI`, che e' l'unico letterale in tutto il repo — e da cui
// `quotaScaglioni` deriva anche la composizione. Scriverlo una seconda volta qui sarebbe ricreare, il
// giorno stesso in cui lo si toglie, il difetto che R1 esiste per chiudere.
// ⚠ Questo modulo puo' importare perche' NON e' puro (legge l'ambiente); `selezione-mercati` non puo'
// importare lui, e infatti la freccia va in questa direzione sola.
const { MAX_MERCATI_CONTEMPORANEI } = require('./selezione-mercati');
const QUANTI_DI_DIFETTO = MAX_MERCATI_CONTEMPORANEI;
const QUANTI_MASSIMO = MAX_MERCATI_CONTEMPORANEI;
const ENV_QUANTI = 'MAKER_MERCATI_CONTEMPORANEI';

/**
 * QUANTI MERCATI CONTEMPORANEI, da un ambiente qualunque.
 *
 * ⚠ UN VALORE CHE NON SI CAPISCE VALE IL DIFETTO, NON ZERO. E' la stessa regola di `end-of-scale` e
 * del margine dal bordo: un `.env` sbagliato non puo' spegnere il bot ne' aprirlo di piu'. Zero
 * significherebbe «nessun mercato», cioe' un errore di battitura che ferma il giro senza dirlo; un
 * numero enorme significherebbe il contrario, ed e' peggio.
 *
 * ⚠ SI ACCETTA SOLO UN INTERO FRA 1 E `QUANTI_MASSIMO`. `2.5` non e' «due e mezzo»: e' un valore che
 * qualcuno ha scritto male, e si risponde col difetto dichiarando perche'.
 *
 * @param {object} env  di solito `process.env`, oppure l'ambiente letto da `/proc/<pid>/environ`
 * @returns {{quanti:number, fonte:'ambiente'|'difetto', grezzo:(string|null), motivo:string}}
 */
function quantiMercati(env = process.env) {
  const grezzoRaw = env ? env[ENV_QUANTI] : undefined;
  const grezzo = (grezzoRaw === undefined || grezzoRaw === null) ? null : String(grezzoRaw).trim();
  if (grezzo === null || grezzo === '') {
    return { quanti: QUANTI_DI_DIFETTO, fonte: 'difetto', grezzo: null,
      motivo: `${ENV_QUANTI} non dichiarata: vale il difetto ${QUANTI_DI_DIFETTO}` };
  }
  const n = Number(grezzo);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > QUANTI_MASSIMO) {
    return { quanti: QUANTI_DI_DIFETTO, fonte: 'difetto', grezzo,
      motivo: `${ENV_QUANTI}="${grezzo}" non e' un intero fra 1 e ${QUANTI_MASSIMO}: vale il difetto`
        + ` ${QUANTI_DI_DIFETTO} — un valore che non si capisce non puo' cambiare quanto capitale si espone` };
  }
  return { quanti: n, fonte: 'ambiente', grezzo,
    motivo: `${ENV_QUANTI}=${n}, dichiarata nell'ambiente del processo` };
}

/** Prove interne. Girano con `node lib/maker/quanti-mercati.js`. */
function selfcheck() {
  let pass = 0; let fail = 0;
  const ok = (nome, cond, extra) => {
    if (cond) { pass += 1; console.log(`  ok  ${nome}`); }
    else { fail += 1; console.log(`FAIL  ${nome}${extra ? ' — ' + extra : ''}`); }
  };

  ok('ambiente vuoto ⇒ difetto', quantiMercati({}).quanti === QUANTI_DI_DIFETTO);
  ok('  e la fonte lo dichiara', quantiMercati({}).fonte === 'difetto');
  for (const n of [1, 2, 3]) {
    const r = quantiMercati({ [ENV_QUANTI]: String(n) });
    ok(`"${n}" ⇒ ${n}, fonte ambiente`, r.quanti === n && r.fonte === 'ambiente');
  }
  ok('spazi attorno al numero non contano', quantiMercati({ [ENV_QUANTI]: ' 2 ' }).quanti === 2);

  // ⚠ TUTTI I MODI DI SBAGLIARE VALGONO IL DIFETTO, MAI ZERO E MAI UN NUMERO GRANDE.
  for (const v of ['0', '-1', '4', '99', '2.5', 'due', '', '  ', 'true', 'NaN', 'Infinity']) {
    const r = quantiMercati({ [ENV_QUANTI]: v });
    ok(`"${v}" ⇒ difetto ${QUANTI_DI_DIFETTO}`, r.quanti === QUANTI_DI_DIFETTO && r.fonte === 'difetto',
      `${r.quanti}/${r.fonte}`);
  }
  // ⚠ `Number(null) === 0` e' il difetto piu' ricorrente di questo repo (§5.3): qui non deve poter
  // produrre «zero mercati», che sarebbe un bot fermo senza che nessuno l'abbia chiesto.
  ok('null ⇒ difetto, NON zero', quantiMercati({ [ENV_QUANTI]: null }).quanti === QUANTI_DI_DIFETTO);
  ok('env assente del tutto ⇒ difetto', quantiMercati(null).quanti === QUANTI_DI_DIFETTO);
  ok('il grezzo viaggia sempre, per poter dire cosa c\'era scritto',
    quantiMercati({ [ENV_QUANTI]: 'due' }).grezzo === 'due');

  console.log(`\nquanti mercati: ${pass} passati, ${fail} falliti\n`);
  return fail === 0;
}

if (require.main === module) process.exit(selfcheck() ? 0 : 1);

module.exports = { quantiMercati, QUANTI_DI_DIFETTO, QUANTI_MASSIMO, ENV_QUANTI };
