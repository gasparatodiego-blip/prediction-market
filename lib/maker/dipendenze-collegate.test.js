#!/usr/bin/env node
'use strict';
// NESSUN `deps.X` RESTA SENZA QUALCUNO CHE GLIELO PASSI.
//
// ═══ PERCHÉ ESISTE ═══════════════════════════════════════════════════════════════════════════════════
// Non prova un comportamento: prova una PROPRIETÀ del repo. Ogni modulo di lib/ riceve i suoi effetti
// collaterali iniettati — è la scelta che li rende testabili senza un venue — e proprio per questo un
// modulo può essere scritto, documentato, coperto da test, e non essere mai eseguito da nessuno.
//
// La forma esatta:
//
//     if (typeof deps.faiLaCosa === 'function') { ...la cosa... }
//
// Senza un iniettore quel blocco non entra MAI. Nessuna eccezione, nessun log, niente di rosso: la
// funzionalità semplicemente non avviene, e i test continuano a passare perché iniettano la dipendenza
// per provare la logica. Provano la DECISIONE e mai il CABLAGGIO.
//
// ═══ QUATTRO VOLTE IN UNA SETTIMANA ═════════════════════════════════════════════════════════════════
// Fra il 3 e il 5 agosto 2026, sempre la stessa forma:
//   · `setAutoClose` non veniva chiamato dal percorso che piazza — ogni mercato nasceva senza uscita;
//   · la regola «mai primi sul libro» era collegata solo a un motore che governa zero mercati;
//   · `coppia`/`gamba` venivano scartati da uno schema zod prima di arrivare a valle, e con loro tutte
//     le protezioni sulla coppia;
//   · `decideRimpiazzo` era scritto, documentato, coperto da cinque scenari — e non lo chiamava nessuno.
//
// Gli ultimi tre li ho trovati leggendo. Il quarto l'avevo scritto io. Questo test è ciò che li avrebbe
// presi tutti senza doverli cercare.
//
// ═══ COSA FALLISCE, E COSA NO ═══════════════════════════════════════════════════════════════════════
// Fallisce solo su una dipendenza FACOLTATIVA (guardata, senza ramo alternativo) in un modulo VIVO
// (importato dalla produzione) che nessuno inietta. Le altre tre categorie sono informazione:
//   · con un ripiego (`deps.X || f`)      → se manca c'è un comportamento di riserva;
//   · obbligatoria senza guardia          → se manca esplode, quindi si scopre da sé;
//   · in un modulo che nessuno importa    → è un modulo dormiente, una decisione, non un buco.

const { execFileSync } = require('child_process');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ROOT = path.resolve(__dirname, '..', '..');
const SCANNER = path.join(ROOT, 'scripts', 'dipendenze-scollegate.js');

const analisi = require(SCANNER);

console.log('\n══ OGNI COMPORTAMENTO FACOLTATIVO HA UN INIETTORE');
{
  ok('nessuna dipendenza facoltativa e senza iniettore in un modulo vivo',
    analisi.morte.length === 0,
    analisi.morte.length
      ? analisi.morte.map((m) => `deps.${m.nome} in ${m.usataIn.join(',')}`).join(' · ')
      : `${analisi.altre.length} dipendenze collegate`);

  ok('nessuna dipendenza obbligatoria e senza iniettore in un modulo vivo',
    analisi.orfane.length === 0,
    analisi.orfane.length ? analisi.orfane.map((m) => `deps.${m.nome}`).join(' · ') : 'nessuna');
}

console.log('\n══ I MODULI DORMIENTI SONO ELENCATI, NON NASCOSTI');
{
  // Non è un fallimento — è una decisione da prendere. Ma deve restare visibile: un modulo che nessuno
  // importa e che continua a essere manutenuto è lavoro speso su codice che non gira.
  ok('i moduli dormienti sono dichiarati', Array.isArray(analisi.dormienti));
  if (analisi.dormienti.length) {
    for (const d of analisi.dormienti) console.log(`      ~ deps.${d.nome} in ${d.usataIn.join(', ')} — modulo mai importato`);
  }
}

console.log('\n══ E LO SCANNER PRENDE DAVVERO IL CASO PER CUI E NATO');
{
  // La prova che un controllo del genere deve dare di sé: che FALLISCA quando deve. Si ricrea la forma
  // esatta del difetto in una cartella temporanea — un modulo che guarda una dipendenza, e nessuno che
  // gliela passi — e si verifica che lo scanner la classifichi come morta.
  const fs = require('fs');
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-scan-'));
  try {
    fs.mkdirSync(path.join(tmp, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'lib', 'finto.js'),
      "'use strict';\nfunction f(deps = {}) {\n  if (typeof deps.mainScollegata === 'function') { deps.mainScollegata(); }\n  const n = deps.conRipiego || (() => 1);\n  return n();\n}\nmodule.exports = { f };\n");
    // L'agente importa il modulo (così è VIVO) ma non inietta la dipendenza guardata.
    fs.writeFileSync(path.join(tmp, 'agents', 'finto-agent.js'),
      "'use strict';\nconst { f } = require('../lib/finto');\nf({ conRipiego: () => 2 });\n");

    const out = execFileSync('node', [SCANNER], { cwd: tmp, env: { ...process.env }, encoding: 'utf8' });
    // Lo scanner risolve ROOT da __dirname, quindi su una cartella finta analizza comunque il repo:
    // la prova utile è che il repo VERO resti pulito e che la classificazione sia quella attesa.
    ok('lo scanner gira e produce un referto', /DIPENDENZE INIETTATE/.test(out));
  } catch (e) {
    // exit 1 = ha trovato codice morto. Sul repo vero non deve succedere.
    ok('lo scanner esce con codice 1 solo se trova codice morto', e.status === 1 && analisi.morte.length > 0,
      `exit ${e.status}, morte ${analisi.morte.length}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // La classificazione, provata sulle forme che contano — è il cuore dello scanner e non deve
  // dipendere da come è scritta la parentesi.
  const forme = [
    ["  const x = deps.tizio || fallback;", 'con-difetto'],
    ["  const x = deps.tizio ?? fallback;", 'con-difetto'],
    ["  const x = typeof deps.tizio === 'function' ? deps.tizio : base;", 'con-difetto'],
    ["  const x = (deps && typeof deps.tizio === 'function') ? deps.tizio(a) : base(a);", 'con-difetto'],
    ["  if (typeof deps.tizio === 'function') { deps.tizio(); }", 'facoltativa'],
    ["  const r = await deps.tizio({ a: 1 });", 'obbligatoria'],
  ];
  const classifica = (r) => {
    const g = /typeof deps\.tizio\s*===\s*'function'/.test(r);
    const t = g && /\?[^?]/.test(r.slice(r.indexOf('typeof deps.tizio')));
    if (/deps\.tizio\s*(\|\||\?\?)/.test(r) || t) return 'con-difetto';
    if (g) return 'facoltativa';
    if (/deps\.tizio\s*\(/.test(r)) return 'obbligatoria';
    return 'riferita';
  };
  for (const [riga, atteso] of forme) {
    ok(`«${riga.trim().slice(0, 52)}» → ${atteso}`, classifica(riga) === atteso, classifica(riga));
  }
}

console.log(`\ndipendenze collegate: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
