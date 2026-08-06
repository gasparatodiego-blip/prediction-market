#!/usr/bin/env node
'use strict';
// UN MOTORE SOLO: PUÒ LEGGERE IL PROFILO, NON PUÒ RAMIFICARSI SU DI ESSO.
//
// ═══ LA FORMULAZIONE È CAMBIATA IL 6 AGOSTO 2026 ═════════════════════════════════════════════════════
// Prima questo file diceva «il motore non sa che esistono due profili». Era la versione più semplice
// della garanzia, e ha retto finché il profilo non serviva. Serviva però: senza saperlo, il motore non
// poteva applicare a ciascun mercato i controlli del suo percorso, e i due profili restavano una cosa
// della sola interfaccia.
//
// La garanzia vera non era l'ignoranza: era che NON ESISTANO DUE MOTORI. Adesso è detta con precisione —
// il motore legge il profilo e lo passa a una funzione pura, e non contiene nessun ramo sul suo valore.
// Vedi il secondo blocco. Il resto del motore continua a non nominarlo affatto.
//
// ═══ LA PROMESSA CHE LA TAB RISK FA ALL'OPERATORE ════════════════════════════════════════════════════
// Il banner in cima alla tab Risk dice, testualmente, che un mercato segnalato lì «una volta partito
// segue lo STESSO motore di esecuzione dei mercati Safe»: stesso GTD, stesso rinnovo, stesso dead-man's
// switch, stessa reconciliation, stesso kill-switch, nessuna logica diversa.
//
// Una promessa del genere non si mantiene scrivendola nel banner. Si mantiene per via strutturale: nei
// dodici moduli di esecuzione non esiste NESSUN riferimento al profilo, quindi non esiste nessun ramo
// che possa dipenderne; e nel tredicesimo — auto-reprice, l'unico che il profilo lo riceve — si verifica
// che lo trasporti senza mai confrontarlo con un valore.
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
  ok('l\'elenco del motore non è vuoto', letti === MOTORE.length && letti >= 12, `${letti} moduli letti`);
}

console.log('\n══ AUTO-REPRICE LEGGE IL PROFILO, MA NON SI RAMIFICA SU DI ESSO');
{
  // ═══ LA GARANZIA È CAMBIATA IL 6 AGOSTO 2026, E IN MEGLIO ═══════════════════════════════════════
  // Fino a oggi `auto-reprice.js` stava nell'elenco qui sopra: non nominava il profilo affatto. Era la
  // formulazione più semplice di «un motore solo», ma anche la più grossolana — impediva al motore
  // perfino di SAPERE quali controlli applicare, e quindi lasciava i due profili senza le loro regole.
  //
  // La garanzia vera non era «il motore ignora il profilo»: era «non esistono DUE MOTORI». Quelle due
  // cose coincidono finché il profilo non entra, e si separano appena entra. La formulazione precisa,
  // che è quella che questo blocco verifica:
  //
  //     il motore LEGGE il profilo e lo passa a una funzione pura;
  //     il motore non contiene nessun RAMO sul suo valore.
  //
  // Cioè: nessun `if (profilo === 'risk')`, nessun `profilo === 'safe' ? … : …`. Le due strade
  // esistono, ma vivono in regole-piazzamento.js — dove un test può esercitarle — e non dentro un
  // ciclo da 5 secondi, dove non si potrebbero verificare.
  const src = fs.readFileSync(path.join(RADICE, 'maker/auto-reprice.js'), 'utf8');

  ok('il motore delega la decisione a una funzione iniettata', /deps\.valutaPiazzamento/.test(src));
  ok('  e legge il profilo da una funzione iniettata', /deps\.leggiProfilo/.test(src));

  // I RAMI VIETATI. Il confronto col VALORE del profilo è ciò che creerebbe due motori.
  const rami = [
    /===\s*['"]risk['"]/, /===\s*['"]safe['"]/,
    /!==\s*['"]risk['"]/, /!==\s*['"]safe['"]/,
    /profilo\s*===\s*/, /profile\s*===\s*/,
  ];
  const trovati = rami.filter((re) => re.test(src)).map(String);
  ok('NESSUN ramo sul valore del profilo dentro il motore', trovati.length === 0, trovati.join(' '));

  // E il profilo non decide nessun parametro: viaggia e basta.
  ok('il profilo non sceglie soglie dentro il motore',
    !/SAFE_|RISK_/.test(src), 'le costanti dei due percorsi restano nei loro moduli');
}

console.log('\n══ IL PROFILO VIVE SOLO DOVE SI SCEGLIE, NON DOVE SI ESEGUE');
{
  // Il simmetrico: i moduli che il profilo DEVE toccare lo nominano davvero. Senza questo, il test
  // sopra passerebbe anche se i profili non fossero mai stati cablati da nessuna parte.
  const PIANIFICAZIONE = [
    'rewards/allocator-profiles.js',
    'rewards/allocator.js',
    // Da oggi anche il compositore delle regole: è LUI ad avere i due percorsi, ed è giusto che li
    // nomini — è il posto in cui un test può esercitarli uno contro l'altro.
    'maker/regole-piazzamento.js',
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
