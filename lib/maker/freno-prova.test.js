'use strict';
// lib/maker/freno-prova.test.js — IL FRENO ESISTE, È FAIL-CLOSED, ED È CABLATO SU TUTTI I PERCORSI.
//
// Il difetto che difende: per due giorni `REALLOC_SCHEDULER_DRY_RUN` è stato letto da NESSUNA riga di
// codice mentre l'operatore credeva che agent41 fosse in prova. Questo test fallisce se qualcuno
// rimuove la lettura del flag da uno qualsiasi dei percorsi che possono arrivare al venue — cioè
// esattamente il modo in cui il difetto potrebbe tornare.
//
// Run: node lib/maker/freno-prova.test.js

const fs = require('fs');
const path = require('path');
const F = require('./freno-prova');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent41-realloc-scheduler.js'), 'utf8');

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n1 · FAIL-CLOSED: tutto ciò che non è uno spegnimento esplicito lascia il freno inserito');
{
  for (const [env, etichetta] of [
    [{}, 'flag ASSENTE'],
    [{ REALLOC_SCHEDULER_DRY_RUN: '' }, 'flag vuoto'],
    [{ REALLOC_SCHEDULER_DRY_RUN: 'boh' }, 'valore non riconosciuto'],
    [{ REALLOC_SCHEDULER_DRY_RUN: '2' }, 'numero ambiguo'],
    [{ REALLOC_SCHEDULER_DRY_RUN: 'FALSO' }, 'parola italiana non in elenco'],
    [{ REALLOC_SCHEDULER_DRY_RUN: '1' }, 'flag ATTIVO (il caso di oggi)'],
    [{ REALLOC_SCHEDULER_DRY_RUN: 'true' }, 'true'],
    [{ REALLOC_SCHEDULER_DRY_RUN: ' ON ' }, 'con spazi e maiuscole'],
  ]) {
    const s = F.statoFreno(env);
    ok(`${etichetta} ⇒ freno INSERITO`, s.attivo === true, s.motivo.slice(0, 74));
  }
  ok('un ambiente che ESPLODE in lettura ⇒ freno INSERITO',
    F.statoFreno(new Proxy({}, { get() { throw new Error('boom'); } })).attivo === true);
}

console.log('\n2 · e i soli valori che lo disinseriscono sono quelli dichiarati');
{
  for (const v of F.SPENTO) {
    const s = F.statoFreno({ REALLOC_SCHEDULER_DRY_RUN: v });
    ok(`«${v}» ⇒ freno DISINSERITO`, s.attivo === false && s.riconosciuto === true);
  }
  ok('e sono cinque, non «qualunque cosa falsy»', F.SPENTO.length >= 4 && !F.SPENTO.includes(''),
    F.SPENTO.join(', '));
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n3 · IL CABLAGGIO: tutti i percorsi di agent41 verso il venue leggono il freno');
{
  // I DUE percorsi trovati cercandoli tutti, non fermandosi al primo:
  //   · il ciclo da 6 ore  → `soloRacconto`, che diventa `dryRunOnly` a valle;
  //   · il mini-ciclo da 10 minuti → la corsia di piazzamento, che aveva `dryRunOnly: false` CABLATO.
  ok('agent41 importa il freno', /require\('\.\.\/lib\/maker\/freno-prova'\)/.test(SRC));

  ok('PERCORSO 1 — il ciclo da 6h: il freno entra in `soloRacconto`',
    /const soloRacconto = !bot\.enabled \|\| frenoGiro\.attivo;/.test(SRC),
    'basta uno fra bot FERMO e freno inserito');

  ok('PERCORSO 2 — il mini-ciclo: `dryRunOnly` viene dal freno',
    /dryRunOnly: FRENO\.statoFreno\(\)\.attivo/.test(SRC));

  // LA REGRESSIONE CHE QUESTO TEST ESISTE PER PRENDERE: il `false` cablato che c'era prima.
  // Si guarda il CODICE, non i commenti — altrimenti il commento che RACCONTA il difetto corretto
  // farebbe fallire il test che lo difende (è successo alla prima esecuzione).
  const codice = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok('e NON esiste più un `dryRunOnly: false` cablato in agent41',
    !/dryRunOnly:\s*false/.test(codice),
    'era la riga con cui il mini-ciclo piazzava a prescindere da qualunque flag');

  // Il conteggio: se domani nasce un terzo percorso verso il venue, questa asserzione non basta a
  // vederlo — ma il numero di letture del freno è il posto dove ci si accorge che qualcosa è cambiato.
  const letture = (SRC.match(/FRENO\.statoFreno\(\)/g) || []).length;
  ok('il freno viene letto in almeno tre punti (2 percorsi + log d\'avvio)', letture >= 3, `${letture} letture`);

  ok('lo stato del freno finisce nel log d\'avvio', /FRENO\.rigaLog\(/.test(SRC));
  ok('  e su disco, perché il pannello non può leggere l\'ambiente di un altro processo',
    /freno-prova\.json/.test(SRC));
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n4 · il flag NON è più decorativo — è la proprietà che il difetto violava');
{
  // Prima di oggi le uniche occorrenze in codice vivo erano commenti. Adesso ce n'è una che DECIDE.
  const vivo = fs.readFileSync(path.join(__dirname, 'freno-prova.js'), 'utf8');
  ok('esiste un modulo che LEGGE il flag e ne ricava una decisione',
    /env\[FLAG\]/.test(vivo) && /attivo:/.test(vivo));
  ok('  e il nome del flag è quello vero', F.FLAG === 'REALLOC_SCHEDULER_DRY_RUN');
  ok('la riga di log dice a una persona cosa sta succedendo',
    /FRENO DI PROVA INSERITO/.test(F.rigaLog(F.statoFreno({})))
    && /FRENO DI PROVA DISINSERITO/.test(F.rigaLog(F.statoFreno({ REALLOC_SCHEDULER_DRY_RUN: '0' }))));
}

console.log(`\n===== freno-prova: ${pass} passati, ${fail} falliti =====\n`);
process.exit(fail === 0 ? 0 : 1);
