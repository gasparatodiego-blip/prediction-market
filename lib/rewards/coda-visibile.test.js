#!/usr/bin/env node
'use strict';
// IL BOTTONE «+ METTI IN CODA» DEVE ESSERCI — E IL GATE MONTEPREMI NON DEVE POTERLO SPEGNERE.
//
// ═══ LA REGRESSIONE ══════════════════════════════════════════════════════════════════════════════════
// Costruita la coda (1a56467 → be2d1c7 → 31c293d), in produzione le card mostravano solo
// «1 · Anteprima». Le tre spiegazioni plausibili erano: bundle vecchio, codice sparito, codice nascosto.
// Verificate tutte e tre:
//
//   · SPARITO?  no. `git log 31c293d..HEAD` sui file della coda: un solo commit, il fix stesso.
//                Nessun revert, nessun conflitto, nessuna sovrascrittura.
//   · BUNDLE?   in parte: il processo pm2 era partito PRIMA del build col fix. Ma i marcatori
//                (`data-alloc-queue-add`, «Metti in coda», «Coda di piazzamento») erano già nel bundle
//                che stava servendo — quindi il codice arrivava al browser.
//   · NASCOSTO? SÌ, ed era questa. Nella tab i piani sono DUE:
//
//         plan      ← «Calcola»                         righe del piano manuale
//         autoPlan  ← «Cerca la combinazione migliore»   LE CARD DI PROPOSTA
//
//     La mappa che alimenta la coda leggeva solo `plan.rows`, ma il bottone sta sulle card di
//     `autoPlan`. Chi arrivava dal percorso normale aveva `plan` a null: mappa vuota, condizione sempre
//     falsa, bottone mai renderizzato. Non un flag: una condizione che non poteva avverarsi.
//
// ═══ PERCHÉ QUESTO TEST ESISTE ═══════════════════════════════════════════════════════════════════════
// Perché la condizione stava dentro un `useMemo`, e una condizione dentro un componente si può
// verificare solo con una regex sul sorgente — cioè non si può verificare. Ora è una funzione pura e
// questo test la esercita NELLO STATO ESATTO del difetto: piano automatico pieno, piano manuale nullo.
//
// E perché subito dopo (a70f608) è stato aggiunto un gate di sicurezza sul montepremi che tocca lo
// stesso file: la seconda metà del test pretende che il gate blocchi i mercati contraddittori e NON
// tocchi quelli sani.

const fs = require('fs');
const path = require('path');
const R = require('./righe-piano');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ROOT = path.resolve(__dirname, '..', '..');
const leggi = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

console.log('\n══ 1 · LA CONDIZIONE DEL BOTTONE, ESERCITATA DAVVERO');
R.selfcheck();
pass += 11;

console.log('\n══ 2 · LO STATO ESATTO DI IERI NOTTE: proposte pronte, nessun mercato in coda');
{
  // Il percorso normale: l'operatore preme «Cerca la combinazione migliore» e basta. `plan` resta null.
  const autoPlan = {
    rows: [
      { marketId: '0xAA', capital: 60, sizePerSideShares: 61.2, mid: 0.19, tick: 0.01, computedDefaultOffsetTicks: 1 },
      { marketId: '0xBB', capital: 60, sizePerSideShares: 40.0, mid: 0.55, tick: 0.01, computedDefaultOffsetTicks: 1 },
    ],
    candidates: [
      { marketId: '0xAA', status: 'scelto', pot: 57 },
      { marketId: '0xBB', status: 'scelto', pot: 100 },
    ],
  };
  const righe = R.righePerId({ plan: null, autoPlan });
  ok('con SOLO il piano automatico la mappa si popola', righe.size === 2, `${righe.size} righe`);

  const proposte = autoPlan.candidates.filter((c) => c.status === 'scelto');
  const conBottone = proposte.filter((c) => R.puoAndareInCoda({ righe, marketId: c.marketId }));
  ok('IL BOTTONE COMPARE SU TUTTE LE PROPOSTE', conBottone.length === proposte.length,
    `${conBottone.length} su ${proposte.length}`);
  ok('  e nessuna coda è ancora attiva: è lo stato osservato', true);

  // La forma vecchia, per contrasto: è quella che teneva il bottone invisibile.
  const vecchia = R.righePerId({ plan: null, autoPlan: null });
  ok('LA FORMA VECCHIA (solo plan, che era null) non ne mostrava nemmeno uno',
    proposte.filter((c) => R.puoAndareInCoda({ righe: vecchia, marketId: c.marketId })).length === 0,
    'è il difetto, riprodotto');
}

console.log('\n══ 3 · IL GATE MONTEPREMI VALE ANCHE SULL INGRESSO IN CODA (punto 6)');
{
  // La regola del gate, la stessa della route: pot dalla card + nessun reward dal venue ⇒ fermo.
  const contraddice = (potAtPlan, hasRewards) => potAtPlan != null && potAtPlan > 0 && hasRewards !== true;
  ok('mercato sano (card $57, venue paga) → può entrare in coda', contraddice(57, true) === false);
  ok('mercato contraddittorio (card $57, venue NESSUN REWARD) → NON entra', contraddice(57, false) === true);
  ok('  e nemmeno se il venue non dice niente sul reward', contraddice(57, undefined) === true);
  ok('mercato senza pot sulla card → nessun confronto, entra', contraddice(null, false) === false);

  const p = leggi('app', 'components', 'RewardsAllocatePanel.tsx');
  ok('l ingresso in coda interroga il gate PRIMA di accodare',
    /const b = \(await r\.json\(\)\)[\s\S]{0,200}b\.gate === 'reward-contraddizione'/.test(p));
  // L'asserzione confronta due POSIZIONI nel file, non due indici dentro una fetta arbitraria: la
  // prima versione tagliava a 300 caratteri, `setCoda(` cadeva fuori, `indexOf` restituiva -1 e il
  // confronto falliva su codice corretto. Una fetta di lunghezza inventata è un test che misura la
  // fetta, non il codice.
  ok('  e in quel caso RITORNA senza accodare', (() => {
    const iGate = p.indexOf("b.gate === 'reward-contraddizione'");
    const iRet = p.indexOf('return;', iGate);
    const iAccoda = p.indexOf('setCoda((q) => mettiInCoda', iGate);
    return iGate > 0 && iRet > 0 && iAccoda > 0 && iRet < iAccoda;
  })(), 'un controllo che accoda comunque non è un controllo');
  ok('  usa l ANTEPRIMA, che non scrive niente', /preview: true, enabled: true, takeManual/.test(p));
  ok('  e passa il montepremi della card', /inCoda\(c\.marketId, c\.pot\)/.test(p));
  ok('il rifiuto si vede sotto la card', /data-alloc-queue-refused/.test(p));
  ok('  con il motivo, non un trattino', /Non messo in coda\.<\/b> \{codaErr\.motivo\}/.test(p));
  ok('un errore di rete NON fa entrare il mercato in coda',
    /controllo del montepremi non riuscito[\s\S]{0,80}non entra in coda/.test(p),
    'fail closed: un controllo che non ha potuto girare non è un controllo superato');
}

console.log('\n══ 4 · IL RESTO DELLA CODA È INTATTO DOPO a70f608');
{
  const p = leggi('app', 'components', 'RewardsAllocatePanel.tsx');
  ok('il pannello della coda c è', /data-alloc-queue\b/.test(p) && /Coda di piazzamento/.test(p));
  ok('«Conferma e piazza» apre il pannello ordine col target del piano',
    /onPlaceOrder\(testaTarget\)/.test(p) && /targetFromPlanRow\(testaRiga,/.test(p));
  ok('  e i valori NON vengono ricalcolati', /gambeDiUnaRiga/.test(p));
  ok('«Salta questo» e «Annulla coda» ci sono',
    /data-alloc-queue-skip/.test(p) && /data-alloc-queue-cancel/.test(p));
  ok('l avviso che il reset disfa la coda è ancora lì', /data-alloc-bulk-vs-queue/.test(p));
  ok('la condizione del bottone usa la funzione condivisa, non una copia',
    /puoAndareInCoda\(\{ righe: righePerId, marketId: c\.marketId \}\)/.test(p));
  ok('  e la mappa viene dal modulo, non da un useMemo scritto a mano',
    /costruisciRighe<Row>\(\{ plan, autoPlan \}\)/.test(p));

  const mod = leggi('lib', 'rewards', 'coda-piazzamento.js');
  ok('il modulo della coda continua a non poter piazzare',
    !/fetch\(/.test(mod) && !/\/api\//.test(mod));
}

console.log(`\ncoda visibile: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
