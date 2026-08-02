#!/usr/bin/env node
'use strict';
// Unit test dell'interruttore della CHIUSURA AUTOMATICA (Strategia A).
//
// La domanda che questo test esiste per tenere ferma: il per-mercato e' una scelta LIBERA su qualunque
// mercato, o una lista di mercati privilegiati? Ogni caso qui sotto usa conditionId inventati sul
// momento, mai visti dal codice — se qualcuno introducesse un elenco fisso, questi fallirebbero.
//
// Ogni test usa file temporanei suoi: non tocca data/, non tocca la configurazione vera, non piazza nulla.

const fs = require('fs');
const os = require('os');
const path = require('path');
const AC = require('./auto-close-config');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'acfg-'));
  return { closeConfigFile: path.join(d, 'close.json'), closeAuditFile: path.join(d, 'audit.jsonl') };
};
// Un conditionId qualunque, generato dal test. Non compare da nessuna parte nel codice sorgente.
const ID = (n) => '0x' + String(n).padStart(2, '0').repeat(32);

console.log('\n── il per-mercato accetta QUALUNQUE mercato, non una lista');
{
  const d = tmp();
  // Cinque mercati mai visti prima, accesi uno dopo l altro. Se esistesse un elenco privilegiato,
  // almeno uno di questi verrebbe rifiutato.
  for (const n of [11, 22, 33, 44, 55]) {
    const r = AC.setAutoClose({ marketId: ID(n), enabled: true, by: 'test' }, d);
    ok(`  mercato ${ID(n).slice(0, 8)}… si accende`, r.ok === true, r.error);
  }
  const cfg = AC.readAutoCloseConfig(d);
  ok('tutti e cinque risultano scelti', cfg.optedInMarketIds.length === 5, String(cfg.optedInMarketIds.length));
  ok('  e sono indipendenti: spegnerne uno non tocca gli altri',
    AC.setAutoClose({ marketId: ID(33), enabled: false }, d).ok === true
    && AC.readAutoCloseConfig(d).optedInMarketIds.length === 4);
}

console.log('\n── SERVONO ENTRAMBI gli interruttori, come per il tracking');
{
  const d = tmp();
  AC.setAutoClose({ marketId: ID(7), enabled: true }, d);
  let v = AC.isAutoCloseEnabled(ID(7), d);
  ok('mercato acceso ma generale spento ⇒ NON agisce', v.enabled === false);
  ok('  e lo dice, invece di tacere', /spenta globalmente/.test(v.reason || ''), v.reason);
  ok('  il flag del mercato resta comunque registrato', v.marketEnabled === true);

  AC.setAutoClose({ scope: 'global', enabled: true }, d);
  v = AC.isAutoCloseEnabled(ID(7), d);
  ok('acceso anche il generale ⇒ agisce', v.enabled === true);

  const altro = AC.isAutoCloseEnabled(ID(8), d);
  ok('un mercato NON scelto resta spento anche col generale acceso', altro.enabled === false);
  ok('  con il motivo giusto, non quello del generale', altro.globalEnabled === true && altro.marketEnabled === false);

  AC.setAutoClose({ scope: 'global', enabled: false }, d);
  ok('spegnere il generale spegne tutto in un colpo', AC.isAutoCloseEnabled(ID(7), d).enabled === false);
  ok('  senza cancellare le scelte per mercato', AC.readAutoCloseConfig(d).optedInMarketIds.length === 1);
}

console.log('\n── FAIL CLOSED: cio che non si legge non e acceso');
{
  const d = tmp();
  fs.writeFileSync(d.closeConfigFile, '{ non e json');
  const cfg = AC.readAutoCloseConfig(d);
  ok('file corrotto ⇒ readable false', cfg.readable === false);
  ok('  e ZERO mercati in vigore', cfg.enabledMarketIds.length === 0);
  ok('  e il generale risulta spento', cfg.globalEnabled === false);
  ok('non si ACCENDE su uno stato illeggibile', AC.setAutoClose({ marketId: ID(9), enabled: true }, d).ok === false);
  ok('nemmeno il generale si accende al buio', AC.setAutoClose({ scope: 'global', enabled: true }, d).ok === false);
  // Lo spegnimento va provato PER ULTIMO: riesce, e riuscendo RISCRIVE il file: da quel momento lo stato
  // e' di nuovo leggibile e i due controlli qui sopra non misurerebbero piu' nulla. Riparare scrivendo lo
  // stato sicuro e' il comportamento voluto — spegnere e' sempre permesso — ma va osservato in quest ordine.
  ok('  ma si SPEGNE eccome: e la direzione sicura', AC.setAutoClose({ marketId: ID(9), enabled: false }, d).ok === true);
  ok('  e spegnendo ha riportato lo stato a leggibile e vuoto',
    AC.readAutoCloseConfig(d).readable === true && AC.readAutoCloseConfig(d).optedInMarketIds.length === 0);
}

console.log('\n── un id non valido non diventa un mercato');
{
  const d = tmp();
  ok('stringa vuota rifiutata', AC.setAutoClose({ marketId: '   ', enabled: true }, d).ok === false);
  ok('marketId assente su scope market rifiutato', AC.setAutoClose({ enabled: true }, d).ok === false);
  ok('enabled non booleano rifiutato', AC.setAutoClose({ marketId: ID(1), enabled: 'sì' }, d).ok === false);
  ok('  e il registro resta vuoto', AC.readAutoCloseConfig(d).optedInMarketIds.length === 0);
}

console.log('\n── il maiuscolo/minuscolo non crea due mercati diversi');
{
  const d = tmp();
  const up = '0x' + 'AB'.repeat(32);
  AC.setAutoClose({ marketId: up, enabled: true }, d);
  ok('acceso in MAIUSCOLO, risulta acceso in minuscolo',
    AC.isAutoCloseEnabled(up.toLowerCase(), d).marketEnabled === true);
  ok('  e non ci sono due voci per lo stesso mercato', AC.readAutoCloseConfig(d).optedInMarketIds.length === 1);
}

console.log('\n── ogni accensione lascia una traccia con chi e perche');
{
  const d = tmp();
  AC.setAutoClose({ marketId: ID(5), enabled: true, by: 'operatore · pannello ordine', reason: 'test' }, d);
  AC.setAutoClose({ marketId: ID(5), enabled: false, reason: 'basta' }, d);
  const lines = fs.readFileSync(d.closeAuditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok('due righe di audit', lines.length === 2, String(lines.length));
  ok('  la prima e un accensione sul mercato giusto', lines[0].event === 'auto-close-on' && lines[0].marketId === ID(5).toLowerCase());
  ok('  con chi e perche', lines[0].by === 'operatore · pannello ordine' && lines[0].reason === 'test');
  ok('  la seconda e uno spegnimento', lines[1].event === 'auto-close-off');
}

console.log('\n── nessuna lista fissa di mercati nel sorgente');
{
  // La prova diretta della domanda posta: il modulo che autorizza la Strategia A non deve contenere
  // NESSUN conditionId. Se qualcuno ne scrivesse uno, questo test lo direbbe.
  for (const f of ['auto-close-config.js', 'auto-close.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const ids = src.match(/0x[0-9a-fA-F]{64}/g) || [];
    ok(`  ${f} non nomina nessun mercato`, ids.length === 0, ids.length ? ids.join(', ') : '');
  }
}

console.log(`\nauto-close-config: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
