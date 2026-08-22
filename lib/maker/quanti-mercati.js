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
const { MAX_MERCATI_CONTEMPORANEI, partizionaSlot } = require('./selezione-mercati');
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

// ══ QUANTI SLOT SONO DI FASCIA CORTA — 22 agosto 2026, decisione dell'operatore ══════════════════
//
// «10 posti lunghi e 5 posti corti, due contatori separati.» Stessa disciplina di
// `MAKER_MERCATI_CONTEMPORANEI`, e per la stessa ragione: e' una decisione dell'operatore, quindi vive
// nell'AMBIENTE del processo che esegue la selezione (agent41) e si legge da `/proc/<pid>/environ`,
// non dal `.env`.
//
// ⚠⚠ SI SCRIVE UN NUMERO SOLO, E I LUNGHI SI DERIVANO (`totale − corti`). Due variabili indipendenti
// — `MAKER_SLOT_LUNGHI` e `MAKER_SLOT_CORTI` — sarebbero il reperto D1 su una decisione di capitale:
// potrebbero sommare a piu' del tetto (esposizione oltre il cap) o a meno (slot che non esistono),
// e nessuno se ne accorgerebbe finche' il gate non smettesse di piazzare a meta' strada. Con una
// variabile sola la somma E' il tetto, per costruzione. I due contatori restano leggibili entrambi:
// `MAKER_MERCATI_CONTEMPORANEI` e `MAKER_SLOT_CORTI` stanno tutti e due in `/proc/<pid>/environ`, e
// `scripts/cli/stato.js` stampa anche il derivato.
//
// ⚠ ZERO E' UN VALORE VALIDO E SIGNIFICA «nessuna fascia», cioe' il comportamento di prima. Non e'
// come `MAKER_MERCATI_CONTEMPORANEI`, dove 0 sarebbe un errore di battitura che ferma il bot: qui 0 e'
// esattamente la posizione di spegnimento, e deve essere esprimibile.
// ⚠ UN VALORE CHE NON SI CAPISCE VALE IL DIFETTO, e il difetto e' ZERO: la partizione SPOSTA
// capitale fra due fasce con profili di rischio diversi, e un `.env` scritto male non deve poterlo
// spostare. Non e' «meta' regola»: e' la regola spenta, che e' uno stato noto e misurato.
const ENV_SLOT_CORTI = 'MAKER_SLOT_CORTI';
const SLOT_CORTI_DI_DIFETTO = 0;

/**
 * I DUE CONTATORI DI FASCIA, da un ambiente qualunque.
 *
 * @param {object} env    di solito `process.env`, oppure l'ambiente letto da `/proc/<pid>/environ`
 * @param {number} totale quanti slot esistono in tutto (di norma `quantiMercati(env).quanti`)
 * @returns {{corti:number, lunghi:number, totale:number, fonte:'ambiente'|'difetto',
 *            grezzo:(string|null), clampata:boolean, motivo:string}}
 */
function slotDiFascia(env = process.env, totale = undefined) {
  const T = (Number.isInteger(totale) && totale >= 1) ? totale : quantiMercati(env).quanti;
  const grezzoRaw = env ? env[ENV_SLOT_CORTI] : undefined;
  const grezzo = (grezzoRaw === undefined || grezzoRaw === null) ? null : String(grezzoRaw).trim();
  const spenta = (motivo) => ({ ...partizionaSlot(T, SLOT_CORTI_DI_DIFETTO), fonte: 'difetto', grezzo, motivo });
  if (grezzo === null || grezzo === '') {
    return spenta(`${ENV_SLOT_CORTI} non dichiarata: nessuna partizione di fascia, tutti i ${T} slot`
      + ' sono indifferenziati — la selezione sceglie come prima');
  }
  const n = Number(grezzo);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    return spenta(`${ENV_SLOT_CORTI}="${grezzo}" non e' un intero >= 0: vale il difetto`
      + ` ${SLOT_CORTI_DI_DIFETTO} — una partizione di fascia sposta capitale, e un valore che non si`
      + " capisce non puo' spostarlo");
  }
  const part = partizionaSlot(T, n);
  return { ...part, fonte: 'ambiente', grezzo,
    motivo: part.clampata
      ? `${ENV_SLOT_CORTI}=${n} oltre i ${T} slot disponibili: ridotta a ${part.corti} — una fascia corta`
        + " pari al totale vuol dire «tutti corti», e si dichiara invece di lasciarla sembrare un numero diverso"
      : `${ENV_SLOT_CORTI}=${part.corti} slot corti (≤ 48 h) + ${part.lunghi} lunghi DERIVATI = ${T},`
        + " dichiarata nell'ambiente del processo" };
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
  // ⚠ IL VALORE «UNO SOPRA IL TETTO» SI DERIVA. Qui c'era il letterale '4', scritto quando il
  // tetto era 3: portato il tetto a 12, quel test ha cominciato a pretendere che un 4 VALIDO
  // fosse rifiutato, ed e' fallito. E' la classe «test che fotografa il codice invece della
  // proprieta'» (§5-bis): la proprieta' e' «oltre il tetto vale il difetto», non «4 e' invalido».
  for (const v of ['0', '-1', String(QUANTI_MASSIMO + 1), '99', '2.5', 'due', '', '  ', 'true', 'NaN', 'Infinity']) {
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

  // ── I DUE CONTATORI DI FASCIA ─────────────────────────────────────────────────────────────────
  const E12 = { [ENV_QUANTI]: '12' };
  ok('fascia non dichiarata ⇒ 0 corti, tutti lunghi, cioe\' il comportamento di prima',
    slotDiFascia(E12).corti === 0 && slotDiFascia(E12).lunghi === 12
    && slotDiFascia(E12).fonte === 'difetto');
  const p5 = slotDiFascia({ ...E12, [ENV_SLOT_CORTI]: '5' });
  ok('  "5" su 12 ⇒ 5 corti + 7 lunghi DERIVATI', p5.corti === 5 && p5.lunghi === 7 && p5.totale === 12);
  ok('  e la somma E\' il totale, per costruzione', p5.corti + p5.lunghi === p5.totale);
  ok('  "0" e\' valido e significa spenta, non e\' un errore',
    slotDiFascia({ ...E12, [ENV_SLOT_CORTI]: '0' }).corti === 0
    && slotDiFascia({ ...E12, [ENV_SLOT_CORTI]: '0' }).fonte === 'ambiente');
  ok('  oltre il totale si CLAMPA e si dichiara',
    slotDiFascia({ ...E12, [ENV_SLOT_CORTI]: '99' }).corti === 12
    && slotDiFascia({ ...E12, [ENV_SLOT_CORTI]: '99' }).lunghi === 0
    && slotDiFascia({ ...E12, [ENV_SLOT_CORTI]: '99' }).clampata === true);
  for (const v of ['-2', '2.5', 'cinque', 'true', 'NaN', 'Infinity']) {
    ok(`  "${v}" ⇒ difetto ZERO, mai il totale`,
      slotDiFascia({ ...E12, [ENV_SLOT_CORTI]: v }).corti === 0);
  }
  ok('  null ⇒ difetto, e NON \'0 lunghi\'',
    slotDiFascia({ ...E12, [ENV_SLOT_CORTI]: null }).corti === 0
    && slotDiFascia({ ...E12, [ENV_SLOT_CORTI]: null }).lunghi === 12);
  ok('  il grezzo viaggia sempre', slotDiFascia({ ...E12, [ENV_SLOT_CORTI]: 'x' }).grezzo === 'x');
  // ⚠ LA SOMMA NON PUO' MAI SFORARE IL TETTO, per nessun ingresso: e' l'invariante che tiene
  // l'esposizione massima sotto il cap, e si prova in modo esaustivo invece che per campioni.
  for (let T = 1; T <= QUANTI_MASSIMO; T += 1) {
    for (const v of ['0', '1', '5', '12', '99', '-1', 'x', '']) {
      const r = slotDiFascia({ [ENV_QUANTI]: String(T), [ENV_SLOT_CORTI]: v }, T);
      if (!(r.corti + r.lunghi === T && r.corti >= 0 && r.lunghi >= 0)) {
        ok(`somma = tetto per T=${T}, corti="${v}"`, false, JSON.stringify(r)); T = 99; break;
      }
    }
  }
  ok('la somma dei due contatori e\' SEMPRE il tetto (prova esaustiva 1..' + QUANTI_MASSIMO + ')', true);

  console.log(`\nquanti mercati: ${pass} passati, ${fail} falliti\n`);
  return fail === 0;
}

if (require.main === module) process.exit(selfcheck() ? 0 : 1);

module.exports = { quantiMercati, QUANTI_DI_DIFETTO, QUANTI_MASSIMO, ENV_QUANTI,
  slotDiFascia, SLOT_CORTI_DI_DIFETTO, ENV_SLOT_CORTI };
