#!/usr/bin/env node
'use strict';
// IL MOTORE DI ESECUZIONE NON SA CHE ESISTONO DUE PROFILI, E DEVE RESTARE COSÌ.
//
// ═══ LA PROMESSA CHE LA TAB RISK FA ALL'OPERATORE ════════════════════════════════════════════════════
// Il banner in cima alla tab Risk dice, testualmente, che un mercato segnalato lì «una volta partito
// segue lo STESSO motore di esecuzione dei mercati Safe»: stesso GTD, stesso rinnovo, stesso dead-man's
// switch, stessa reconciliation, stesso kill-switch, nessuna logica diversa.
//
// Una promessa del genere non si mantiene scrivendola nel banner. Si mantiene rendendo IMPOSSIBILE al
// motore di sapere da quale profilo viene un ordine — e il modo per verificarlo è strutturale, non
// comportamentale: se nei moduli di esecuzione non esiste NESSUN riferimento al profilo, allora non
// esiste nessun ramo che possa dipenderne, e non serve enumerare i comportamenti uno per uno.
//
// ═══ PERCHÉ UN TEST SUL SORGENTE E NON SUL COMPORTAMENTO ═════════════════════════════════════════════
// Perché «non esiste un ramo» è una proprietà universale, e un test comportamentale può solo campionare.
// Questo file legge i moduli e cerca la parola: è l'unico modo di dimostrare un'ASSENZA. È la stessa
// ragione per cui lib/rewards/righe-piano.js è un modulo invece che una condizione dentro un useMemo.
//
// SE QUESTO TEST FALLISCE non vuol dire per forza che c'è un bug: vuol dire che qualcuno ha portato il
// concetto di profilo dentro il motore, e che quella scelta va guardata da un umano prima di passare.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

// ── I MODULI CHE COMPONGONO IL MOTORE DI ESECUZIONE ───────────────────────────────────────────────
// Piazzamento, ciclo di vita dell'ordine, uscita, sorveglianza, e i due interruttori di sicurezza.
// L'elenco è esplicito di proposito: un modulo nuovo che entra nel motore va aggiunto qui a mano, e
// quel gesto è il momento in cui ci si chiede se il profilo lo tocca.
const MOTORE = [
  ['maker/manual-order.js', 'piazzamento — l\'unica strada verso POST /order'],
  ['maker/bulk-allocate.js', 'la sequenza, il cap cumulativo, il ritiro della gamba orfana'],
  ['maker/order-ttl.js', 'GTD: expiration firmata, pavimento del venue'],
  ['maker/auto-reprice.js', 'rinnovo e inseguimento del mid'],
  ['maker/auto-close.js', 'uscita automatica'],
  ['maker/cancel-all.js', 'cancellazione di massa'],
  ['maker/cancellazione-di-emergenza.js', 'dead-man\'s switch'],
  ['maker/reconcile.js', 'reconciliation'],
  ['maker/allocation-reset.js', 'il reset che precede il piazzamento di un piano'],
  ['maker/mm-tracking.js', 'tracking dei quote'],
  ['maker/risk-rails.js', 'le rail di rischio del motore'],
  ['maker/kill.js', 'kill switch del maker'],
  ['safety/kill-switch.js', 'kill switch globale'],
];

// Le parole che tradirebbero un ramo per profilo. `profilo`/`profile` da soli bastano: nel motore non
// hanno nessun altro significato legittimo, e un falso positivo qui costa una riga di commento
// riformulata — molto meno di un ramo per profilo che passa inosservato.
const SPIE = [
  /\bSAFE_PROFILE\b/, /\bRISK_PROFILE\b/, /allocator-profiles/,
  /\bminTimeToCloseRule\b/, /\bisRisk\b/, /\bprofile\b/i, /\bprofilo\b/i,
];

const RADICE = path.join(__dirname, '..');

console.log('\n══ NESSUN MODULO DEL MOTORE NOMINA IL PROFILO');
{
  let letti = 0;
  for (const [rel, ruolo] of MOTORE) {
    const p = path.join(RADICE, rel);
    if (!fs.existsSync(p)) { ok(`${rel} — il file esiste`, false, 'ASSENTE: l\'elenco del motore è disallineato'); continue; }
    letti++;
    const src = fs.readFileSync(p, 'utf8');
    const colpevoli = SPIE.filter((re) => re.test(src)).map((re) => String(re));
    ok(`${rel} (${ruolo})`, colpevoli.length === 0, colpevoli.join(' '));
  }
  ok('l\'elenco del motore non è vuoto', letti === MOTORE.length && letti >= 13, `${letti} moduli letti`);
}

console.log('\n══ IL PROFILO VIVE SOLO DOVE SI SCEGLIE, NON DOVE SI ESEGUE');
{
  // Il simmetrico: i moduli che il profilo DEVE toccare lo nominano davvero. Senza questo, il test
  // sopra passerebbe anche se i profili non fossero mai stati cablati da nessuna parte.
  const PIANIFICAZIONE = [
    'rewards/allocator-profiles.js',
    'rewards/allocator.js',
  ];
  for (const rel of PIANIFICAZIONE) {
    const src = fs.readFileSync(path.join(RADICE, rel), 'utf8');
    ok(`${rel} conosce il profilo (è il suo mestiere)`, /profile|profilo/i.test(src));
  }
}

console.log('\n══ E IL CLASSIFICATORE NON IMPORTA NIENTE CHE PIAZZI');
{
  const src = fs.readFileSync(path.join(RADICE, 'maker/risk-classifier.js'), 'utf8');
  const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  ok('importa solo tre moduli, e sono i tre che possiedono le soglie',
    requires.length === 3, requires.join(' '));
  ok('  order-ttl (pavimento del venue)', requires.includes('./order-ttl'));
  ok('  horizon (soglia Safe)', requires.includes('../rewards/horizon'));
  ok('  plan-to-orders (staleness)', requires.includes('../rewards/plan-to-orders'));
  ok('non tocca fs, né rete, né adapter del venue',
    !/require\(['"]fs['"]\)|require\(['"]https?['"]\)|venues\//.test(src));
}

console.log(`\nmotore condiviso fra i profili: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
