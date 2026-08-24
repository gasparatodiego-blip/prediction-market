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

// ⚠⚠⚠ IL DIFETTO E' STATO TOLTO IL 24 AGOSTO 2026. Prima questo modulo importava
// `MAX_MERCATI_CONTEMPORANEI` e ne faceva DUE cose: il massimo (giusto) e il DIFETTO (sbagliato).
// Il difetto era la parte velenosa — significava che `MAKER_MERCATI_CONTEMPORANEI` assente, vuota,
// non numerica o fuori scala produceva **lo stesso identico comportamento** di una variabile scritta
// bene, e il processo partiva a quotare capitale vero su un numero che nessuno aveva deciso.
// «Un valore che non si capisce vale il difetto» e' la regola giusta per una soglia di prezzo, dove
// il difetto e' prudente; qui il difetto NON e' prudente, perche' e' il numero di mercati su cui si
// espone denaro. Adesso: **si solleva, e il processo non parte.**
// ⚠ Questo modulo puo' importare perche' NON e' puro (legge l'ambiente); `selezione-mercati` non puo'
// importare lui, e infatti la freccia va in questa direzione sola.
const { LIMITE_SLOT, esigiSlot, partizionaSlot } = require('./selezione-mercati');
const ENV_QUANTI = 'MAKER_MERCATI_CONTEMPORANEI';

/**
 * QUANTI MERCATI CONTEMPORANEI, da un ambiente qualunque.
 *
 * ⚠ UN VALORE CHE NON SI CAPISCE VALE IL DIFETTO, NON ZERO. E' la stessa regola di `end-of-scale` e
 * del margine dal bordo: un `.env` sbagliato non puo' spegnere il bot ne' aprirlo di piu'. Zero
 * significherebbe «nessun mercato», cioe' un errore di battitura che ferma il giro senza dirlo; un
 * numero enorme significherebbe il contrario, ed e' peggio.
 *
 * ⚠ SI ACCETTA SOLO UN INTERO IN `LIMITE_SLOT` (1..20). `2.5` non e' «due e mezzo»: e' un valore che
 * qualcuno ha scritto male, e si risponde col difetto dichiarando perche'.
 *
 * @param {object} env  di solito `process.env`, oppure l'ambiente letto da `/proc/<pid>/environ`
 * @returns {{quanti:number, fonte:'ambiente'|'difetto', grezzo:(string|null), motivo:string}}
 */
function quantiMercati(env = process.env) {
  const grezzoRaw = env ? env[ENV_QUANTI] : undefined;
  const grezzo = (grezzoRaw === undefined || grezzoRaw === null) ? null : String(grezzoRaw).trim();
  if (grezzo === null || grezzo === '') {
    throw new Error(
      `${ENV_QUANTI} ${grezzo === null ? 'NON E\' DICHIARATA' : 'e\' VUOTA'} nell'ambiente del processo`
      + ` (letto ${JSON.stringify(grezzoRaw === undefined ? null : grezzoRaw)}).`
      + ' Non c\'e\' nessun difetto: quanti mercati aprire e\' una decisione sull\'esposizione di capitale'
      + ' vero, e un processo che la indovina e\' peggio di un processo che non parte.'
      + ` Si dichiara in agents/ecosystem.config.js (un intero fra ${LIMITE_SLOT.min} e ${LIMITE_SLOT.max})`
      + ' e si riavvia DAL FILE: `pm2 restart agents/ecosystem.config.js --only <nome>` —'
      + ' `--update-env` prende l\'ambiente della shell e NON rilegge l\'ecosystem (§5.1).');
  }
  // ⚠ UNA SOLA ARITMETICA DI VALIDAZIONE, ed e' quella del modulo puro: `esigiSlot` e' la STESSA
  // funzione che `quotaScaglioni`, `partizionaSlot` e `decidiSelezione` chiamano. Ricopiarne il
  // controllo qui sarebbe il reperto D1 sul cancello che esiste per impedire il reperto D1.
  const n = esigiSlot(grezzo, `${ENV_QUANTI}="${grezzo}"`);
  return { quanti: n, fonte: 'ambiente', grezzo,
    motivo: `${ENV_QUANTI}=${n}, dichiarata nell'ambiente del processo` };
}

/**
 * LA VARIANTE CHE NON SOLLEVA, **per chi RACCONTA lo stato e non per chi DECIDE**.
 *
 * ⚠ Esiste per una ragione sola: `scripts/cli/stato.js` deve poter *dichiarare* che la variabile
 * manca, e un reporter che muore non riporta niente. ⚠ NON si usa nei percorsi che decidono: li'
 * l'assenza deve fermare il processo, ed e' il motivo per cui le due funzioni hanno nomi diversi e
 * non un flag — un flag si passa per sbaglio, un nome no.
 *
 * @returns {{ok:boolean, quanti:(number|null), fonte:string, grezzo:(string|null), errore:(string|null), motivo:string}}
 */
function provaQuantiMercati(env = process.env) {
  try {
    const r = quantiMercati(env);
    return { ok: true, quanti: r.quanti, fonte: r.fonte, grezzo: r.grezzo, errore: null, motivo: r.motivo };
  } catch (e) {
    const grezzoRaw = env ? env[ENV_QUANTI] : undefined;
    const msg = e && e.message ? e.message : String(e);
    return { ok: false, quanti: null, fonte: 'assente-o-invalida',
      grezzo: (grezzoRaw === undefined || grezzoRaw === null) ? null : String(grezzoRaw),
      errore: msg, motivo: msg };
  }
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

  // ⚠⚠ LA PROPRIETA' E' CAMBIATA IL 24/08 E IL SELFCHECK CON LEI, RISCRITTO E NON AMMORBIDITO:
  // prima si asseriva «assente ⇒ difetto», adesso si assicura «assente ⇒ SOLLEVA». Un selfcheck
  // lasciato a difendere la proprieta' vecchia sarebbe rimasto verde proprio sul difetto che si
  // sta chiudendo (§5-bis p.181, tre difese inerti col verde).
  const solleva = (env, etichetta) => {
    let alzata = null;
    try { quantiMercati(env); } catch (e) { alzata = e; }
    ok(`${etichetta} ⇒ SOLLEVA, nessun difetto`, alzata !== null);
    if (alzata) ok(`  e il messaggio nomina ${ENV_QUANTI}`, String(alzata.message).includes(ENV_QUANTI),
      String(alzata.message).slice(0, 80));
    return alzata;
  };
  solleva({}, 'ambiente vuoto');
  solleva(null, 'env assente del tutto');
  // ⚠ `Number(null) === 0` e' il difetto piu' ricorrente di questo repo (§5.3): qui non deve poter
  // produrre «zero mercati» e nemmeno un difetto — deve fermare il processo.
  solleva({ [ENV_QUANTI]: null }, 'valore null');
  const eVuota = solleva({ [ENV_QUANTI]: '' }, 'valore vuoto');
  ok('  e il messaggio del vuoto lo distingue dall\'assenza',
    !!eVuota && /VUOTA/.test(eVuota.message));
  // ⚠ La variante che NON solleva esiste per i REPORTER, e deve dire ok:false invece di indovinare.
  const prova = provaQuantiMercati({});
  ok('provaQuantiMercati su ambiente vuoto ⇒ ok:false, quanti:null',
    prova.ok === false && prova.quanti === null && typeof prova.errore === 'string');
  ok('  e non inventa un numero', prova.quanti === null);
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
  for (const v of ['0', '-1', String(LIMITE_SLOT.max + 1), '99', '2.5', 'due', '', '  ', 'true', 'NaN', 'Infinity']) {
    let alzata = null;
    try { quantiMercati({ [ENV_QUANTI]: v }); } catch (e) { alzata = e; }
    ok(`"${v}" ⇒ SOLLEVA`, alzata !== null);
    if (alzata) ok(`  e il messaggio riporta il valore letto`,
      String(alzata.message).includes(ENV_QUANTI), String(alzata.message).slice(0, 60));
  }
  ok(`il limite superiore e' ${LIMITE_SLOT.max} e ${LIMITE_SLOT.max} stesso e' AMMESSO dal range`,
    quantiMercati({ [ENV_QUANTI]: String(LIMITE_SLOT.max) }).quanti === LIMITE_SLOT.max);
  ok('il grezzo viaggia sempre nella variante che non solleva, per dire cosa c\'era scritto',
    provaQuantiMercati({ [ENV_QUANTI]: 'due' }).grezzo === 'due');

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
  for (let T = 1; T <= LIMITE_SLOT.max; T += 1) {
    for (const v of ['0', '1', '5', '12', '99', '-1', 'x', '']) {
      const r = slotDiFascia({ [ENV_QUANTI]: String(T), [ENV_SLOT_CORTI]: v }, T);
      if (!(r.corti + r.lunghi === T && r.corti >= 0 && r.lunghi >= 0)) {
        ok(`somma = tetto per T=${T}, corti="${v}"`, false, JSON.stringify(r)); T = 99; break;
      }
    }
  }
  ok('la somma dei due contatori e\' SEMPRE il tetto (prova esaustiva 1..' + LIMITE_SLOT.max + ')', true);

  console.log(`\nquanti mercati: ${pass} passati, ${fail} falliti\n`);
  return fail === 0;
}

if (require.main === module) process.exit(selfcheck() ? 0 : 1);

module.exports = { quantiMercati, provaQuantiMercati, LIMITE_SLOT, ENV_QUANTI,
  slotDiFascia, SLOT_CORTI_DI_DIFETTO, ENV_SLOT_CORTI };
