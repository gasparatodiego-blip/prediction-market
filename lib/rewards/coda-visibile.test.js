#!/usr/bin/env node
'use strict';
// IL PERCORSO VERSO IL PIAZZAMENTO DEVE ESSERCI — E IL GATE MONTEPREMI NON DEVE POTERLO SPEGNERE.
//
// ═══ AGGIORNATO IL 6 AGOSTO 2026 ═════════════════════════════════════════════════════════════════════
// La CODA non esiste più: «+ Metti in coda» e la conferma gamba-per-gamba sono state sostituite da un
// bottone solo per proposta («Conferma e piazza — $X») con un dialog che mostra entrambe le gambe.
//
// QUESTO TEST NON È STATO CANCELLATO INSIEME ALLA CODA, ed è deliberato. La coda era il SOGGETTO; la
// GARANZIA era un'altra, e vale identica sul percorso nuovo:
//
//   · esiste davvero un percorso dalla card al piazzamento (il difetto originale era un bottone che
//     non poteva comparire — una condizione che non poteva avverarsi);
//   · il gate sul montepremi gira PRIMA che parta un ordine, e FALLISCE CHIUSO;
//   · un rifiuto si vede, col motivo, accanto alla card che l'ha causato.
//
// Le sezioni 1 e 2 sono immutate: esercitano `righe-piano`, la funzione pura che ancora alimenta le
// card (adesso via `gambeCard`). Le sezioni 3 e 4 puntano al nuovo percorso.
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

console.log('\n══ 3 · IL GATE MONTEPREMI GIRA PRIMA DELL ORDINE, E FALLISCE CHIUSO');
{
  // Il gate ora vive nella rotta che piazza, non nell'ingresso in coda. È il posto giusto: prima stava
  // su UNO dei percorsi verso il capitale e non sull'altro, che è la classe di difetto che questo file
  // esiste per trovare. Adesso il percorso è uno solo, e il gate è dentro.
  const rotta = leggi('app', 'api', 'maker', 'manual', 'place-market', 'route.ts');

  ok('la rotta interroga il venue prima di piazzare',
    /verificaMercatiAlVenue/.test(rotta));
  ok('  e le passa il montepremi che la card mostrava',
    /poolAlPiano:\s*potAtPlan/.test(rotta));
  ok('  un mercato ILLEGGIBILE ferma tutto (fail closed)',
    /venue-illeggibile/.test(rotta) && /non si piazzano ordini veri su un mercato che non si è potuto confermare/.test(rotta));
  ok('  un mercato BOCCIATO ferma tutto',
    /bocciato-dal-venue/.test(rotta));
  // L'ORDINE SI MISURA NEL CORPO DELLA FUNZIONE, non nel file: in cima ci sono gli import, e lì
  // `setAutoClose` compare per forza prima di tutto. Confrontare le posizioni nel file intero
  // misurerebbe l'ordine degli import, che non è la proprietà che interessa.
  const corpo = rotta.slice(rotta.indexOf('export async function POST'));
  const pos = (needle) => corpo.indexOf(needle);
  ok('la verifica avviene PRIMA delle scritture di preparazione',
    pos('verificaMercatiAlVenue') > -1 && pos('verificaMercatiAlVenue') < pos('setAutoClose('),
    `verifica@${pos('verificaMercatiAlVenue')} < preparazione@${pos('setAutoClose(')}`);
  ok('  e PRIMA del piazzamento',
    pos('verificaMercatiAlVenue') < pos('runBulkAllocation('),
    `verifica@${pos('verificaMercatiAlVenue')} < piazzamento@${pos('runBulkAllocation(')}`);

  // Il componente mostra il rifiuto accanto alla card, col motivo vero.
  const conf = leggi('app', 'components', 'ConfermaEPiazza.tsx');
  ok('il rifiuto si vede sotto la card', /data-conferma-errore/.test(conf));
  ok('  con il motivo, non un trattino',
    /Non è stato inviato niente/.test(conf) && /\{err\}/.test(conf));
  ok('  e un errore di rete non piazza niente: si esce dal catch senza inviare',
    /catch \(e\) \{\s*setErr\(\(e as Error\)\.message\);/.test(conf));
}

console.log('\n══ 4 · IL PERCORSO DALLA CARD AL PIAZZAMENTO ESISTE DAVVERO');
{
  const panel = leggi('app', 'components', 'RewardsAllocatePanel.tsx');
  const conf = leggi('app', 'components', 'ConfermaEPiazza.tsx');

  ok('la card monta il componente di conferma', /<ConfermaEPiazza/.test(panel));
  ok('  e gli passa le due gambe costruite dalla funzione condivisa',
    /gambe=\{gambeCard\(c\.marketId\)\}/.test(panel));
  ok('  che le chiede a `gambeDiUnaRiga`, non a una copia locale',
    /const g = gambeDiUnaRiga\(riga, off\)/.test(panel));
  ok('  e la mappa delle righe viene dalla funzione pura condivisa',
    /costruisciRighe<Row>\(\{ plan, autoPlan \}\)/.test(panel));

  // LA PROPRIETÀ CHE IL DIFETTO ORIGINALE VIOLAVA: il bottone non deve dipendere da una condizione
  // che il percorso normale non può soddisfare. `gambeCard` legge `righePerId`, che è costruita da
  // ENTRAMBI i piani — quindi chi preme solo «Cerca la combinazione migliore» lo vede comunque.
  ok('il bottone non è condizionato al piano manuale', !/plan && .{0,40}<ConfermaEPiazza/.test(panel));

  ok('con meno di due gambe il bottone NON compare, e lo dice',
    /data-conferma-no-gambe/.test(conf) && /Una gamba sola non si piazza/.test(conf));
  ok('la conferma vera è un secondo bottone, dentro il dialog',
    /data-conferma-invia/.test(conf));
}

console.log(`\npercorso dalla card al piazzamento: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
