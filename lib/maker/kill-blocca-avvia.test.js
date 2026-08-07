#!/usr/bin/env node
'use strict';
// IL KILL BLOCCA AVVIA, E LO FA SUL SERVER.
//
// Il tasto AVVIA è già disabilitato a kill attivo nel pannello, ma quella è una cortesia della UI:
// chiunque abbia una sessione admin e `curl` la scavalca. Questi test provano le due metà del gate
// che la rotta monta al posto suo:
//
//   1 · IL PRIMITIVO — `checkKill` decide davvero, e fallisce CHIUSO. Si esercita con uno stato
//       iniettato, mai quello vero: un test che accende il kill di produzione per vedere se funziona
//       è un test che ferma il sistema.
//   2 · IL CABLAGGIO — la rotta chiama QUEL primitivo, solo sull'accensione, e rifiuta con 409.
//
// La 2 è a livello di sorgente e non se ne scusa: la rotta è TypeScript dentro Next, e la sola
// alternativa per esercitarla davvero sarebbe accendere il kill globale su un processo vivo.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkKill } = require('../safety/kill-switch');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kill-avvia-'));
let seq = 0;
const scrivi = (contenuto) => {
  const f = path.join(dir, `k${seq++}.json`);
  if (contenuto !== undefined) fs.writeFileSync(f, contenuto);
  return f;
};

console.log('\n── 1 · IL PRIMITIVO DECIDE, E NEL DUBBIO DICE «UCCISO»');
{
  const pulito = scrivi(JSON.stringify({ global: { killed: false }, users: {} }));
  const k = checkKill({}, { stateFile: pulito });
  ok('stato pulito → non ucciso', k.killed === false, k.scope || 'nessuno scope');
}
{
  const assente = path.join(dir, 'mai-esistito.json');
  const k = checkKill({}, { stateFile: assente });
  ok('file ASSENTE → non ucciso (è uno stato leggibile: «mai ucciso»)', k.killed === false);
}
{
  const acceso = scrivi(JSON.stringify({ global: { killed: true, reason: 'prova' }, users: {} }));
  const k = checkKill({}, { stateFile: acceso });
  ok('kill globale attivo → ucciso', k.killed === true && k.scope === 'global', k.gate);
}
{
  const rotto = scrivi('{ questo non e JSON');
  const k = checkKill({}, { stateFile: rotto });
  ok('stato ILLEGGIBILE → ucciso lo stesso (fail closed)', k.killed === true, k.gate);
  ok('  e lo dichiara invece di fingere che sia spento', /fail|clos/i.test(k.reason || ''), k.reason);
}

console.log('\n── 2 · LA ROTTA MONTA QUEL GATE, E SOLO SULL ACCENSIONE');
{
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'api', 'maker', 'bot', 'route.ts'), 'utf8');

  ok('la POST importa il chokepoint `checkKill`', /import \{[^}]*\bcheckKill\b[^}]*\} from '@\/lib\/safety\/kill-switch'/.test(src));

  // Il gate deve stare DENTRO un ramo che vale solo per l'accensione. Se un giorno qualcuno lo
  // spostasse fuori, spegnere diventerebbe rifiutabile — ed è il difetto opposto, peggiore.
  const gate = src.match(/if \(enabled === true\) \{[\s\S]*?\n {4}\}/);
  ok('il gate è dentro `if (enabled === true)`', !!gate);
  ok('  e chiama checkKill lì dentro', !!gate && /checkKill\(/.test(gate[0]));
  ok('  e rifiuta con 409', !!gate && /status: 409/.test(gate[0]));
  ok('  guardando `killed === true` (non un campo di visualizzazione)', !!gate && /killed === true/.test(gate[0]));

  // FERMA non deve avere nessun rifiuto: il solo `checkKill` del file è quello dentro il ramo sopra.
  ok('checkKill compare UNA volta sola: spegnere non ha gate',
    (src.match(/checkKill\(/g) || []).length === 1);

  // `killStatus` resta, ma solo per l'istantanea della GET: non deve diventare la guardia.
  const dentroGate = gate ? gate[0] : '';
  ok('la guardia NON usa `killStatus` (è per la visualizzazione)', !/killStatus\(/.test(dentroGate));

  ok('la risposta di rifiuto dice come sbloccarsi', /Toglilo prima, oppure usa FERMA/.test(src));
}

console.log(`\nil kill blocca avvia: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
