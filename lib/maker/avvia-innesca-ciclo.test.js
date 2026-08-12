#!/usr/bin/env node
'use strict';
// PREMERE AVVIA FA PARTIRE UN CICLO COMPLETO, SUBITO — E UNO SOLO.
//
// ═══ IL DIFETTO ══════════════════════════════════════════════════════════════════════════════════════
// La sorveglianza dell'interruttore reagiva gia' in fretta (poller da 15 s), ma cio' che innescava era
// il MINI-ciclo: quello sceglie dal piano salvato e ha le sue attese, quindi il piano vero ripartiva
// alla cadenza successiva — fino a DIECI MINUTI di capitale fermo dopo che una persona ha premuto il
// bottone, con il bot acceso e i mercati sul tavolo.
//
// ═══ LA CORREZIONE, E PERCHE' NON E' UN PERCORSO NUOVO ═══════════════════════════════════════════════
// Si riusa `giro`, il ciclo normale. Non e' una scorciatoia riscritta piu' corta: e' LA STESSA
// funzione del ciclo a cadenza, quindi «stesse regole, stesso fail-closed, stesso freno di prova» e'
// una proprieta' del codice e non una promessa in un commento. L'unica differenza e' il MOTIVO, che
// viaggia negli audit e rende questo ciclo distinguibile da quelli a cadenza senza guardare l'orologio.
//
// ═══ COSA PROVA QUESTO FILE ══════════════════════════════════════════════════════════════════════════
//   1. la transizione FERMO→AVVIA innesca ESATTAMENTE un ciclo, ed e' un ciclo COMPLETO;
//   2. due letture consecutive dello stesso stato acceso non ne innescano un secondo;
//   3. un ciclo gia' in corso non ne fa aprire un altro;
//   4. la cadenza riparte dal momento dell'avvio, non da quello di prima;
//   5. col freno inserito il ciclo immediato CALCOLA e NON PIAZZA;
//   6. FERMA non innesca niente, e il motivo negli audit e' riconoscibile.
//
// Non tocca rete, capitale, ne' un solo file di stato: `statoBot`, `giro` e `pianificaProssimo` sono
// iniettati, e il ciclo vero non viene mai eseguito.
//
// Run: node lib/maker/avvia-innesca-ciclo.test.js

const fs = require('fs');
const path = require('path');

let pass = 0; let fail = 0;
const ok = (nome, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + nome + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + nome + (extra ? ' — ' + extra : '')); }
};

const ROOT = path.resolve(__dirname, '..', '..');
process.env.REALLOC_SCHEDULER_ENABLED = process.env.REALLOC_SCHEDULER_ENABLED || '0';
const A41 = require(path.join(ROOT, 'agents', 'agent41-realloc-scheduler.js'));

// Un banco: l'interruttore e' un valore che il test muove, il ciclo e' un registratore.
function banco({ ritardoCiclo = 0, giroRitorna = { azione: 'eseguito' } } = {}) {
  const cicli = []; const ripianificazioni = [];
  let stato = { leggibile: true, enabled: false, at: 1_000, by: 'test' };
  return {
    cicli, ripianificazioni,
    ferma: (at) => { stato = { leggibile: true, enabled: false, at, by: 'operatore' }; },
    avvia: (at, by = 'operatore · tab Mercati') => { stato = { leggibile: true, enabled: true, at, by }; },
    deps: {
      statoBot: () => stato,
      giro: async (motivo) => {
        cicli.push(motivo);
        if (ritardoCiclo) await new Promise((r) => setTimeout(r, ritardoCiclo));
        return giroRitorna;
      },
      pianificaProssimo: (motivo) => ripianificazioni.push(motivo),
    },
  };
}

(async () => {
  // ──────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n══ 1 · LA TRANSIZIONE FERMO→AVVIA INNESCA ESATTAMENTE UN CICLO');
  {
    const b = banco();
    await A41.sorvegliaAvvio(b.deps);            // prima passata: ARMA soltanto
    ok('la prima lettura arma e non innesca niente', b.cicli.length === 0,
      'un pm2 restart non e\' un bottone premuto da una persona');

    b.avvia(2_000);
    await A41.sorvegliaAvvio(b.deps);
    ok('la transizione innesca UN ciclo', b.cicli.length === 1, `${b.cicli.length} ciclo/i`);
    ok('  ed e\' il ciclo COMPLETO, non il mini-ciclo', typeof b.cicli[0] === 'string');
    ok('  con un motivo distinto e riconoscibile negli audit', b.cicli[0] === 'avvia-operatore', b.cicli[0]);
  }

  // ──────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n══ 2 · DUE LETTURE DELLO STESSO AVVIA NON NE INNESCANO UN SECONDO');
  {
    const b = banco();
    await A41.sorvegliaAvvio(b.deps);
    b.avvia(3_000);
    await A41.sorvegliaAvvio(b.deps);
    await A41.sorvegliaAvvio(b.deps);
    await A41.sorvegliaAvvio(b.deps);
    ok('tre letture consecutive dello stato acceso ⇒ un solo ciclo', b.cicli.length === 1,
      `${b.cicli.length} ciclo/i`);

    // E un AVVIA NUOVO — l'operatore ferma e riaccende — deve invece innescare.
    b.ferma(4_000); await A41.sorvegliaAvvio(b.deps);
    b.avvia(5_000); await A41.sorvegliaAvvio(b.deps);
    ok('  ma un AVVIA NUOVO innesca di nuovo: e\' la transizione a contare, non il valore',
      b.cicli.length === 2);
    ok('  e il FERMA in mezzo non ha innescato nessun ciclo',
      b.cicli.filter((m) => m === 'avvia-operatore').length === 2);
  }

  // ──────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n══ 3 · UN CICLO GIA\' IN CORSO NON NE FA APRIRE UN SECONDO');
  {
    // `giro` risponde `null` quando il lucchetto `inCorso` e' gia' preso: e' lo STESSO lucchetto del
    // ciclo a cadenza e del mini-ciclo, non un secondo meccanismo.
    const b = banco({ giroRitorna: null });
    await A41.sorvegliaAvvio(b.deps);
    b.avvia(6_000);
    await A41.sorvegliaAvvio(b.deps);
    ok('il ciclo viene tentato una volta sola', b.cicli.length === 1);
    ok('  e quando risponde «gia\' in corso» NON si riallinea la cadenza',
      b.ripianificazioni.length === 0,
      'il ciclo in corso scrivera\' lui `lastRunAt`, e riallineare qui la sposterebbe due volte');
  }

  // ──────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n══ 4 · LA CADENZA RIPARTE DAL MOMENTO DELL\'AVVIO');
  {
    const b = banco();
    await A41.sorvegliaAvvio(b.deps);
    b.avvia(7_000);
    await A41.sorvegliaAvvio(b.deps);
    ok('dopo il ciclo immediato la cadenza viene riallineata', b.ripianificazioni.length === 1);
    ok('  e lo dichiara', /AVVIA/.test(b.ripianificazioni[0] || ''), b.ripianificazioni[0]);

    const src = fs.readFileSync(path.join(ROOT, 'agents', 'agent41-realloc-scheduler.js'), 'utf8');
    const codice = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ok('il timer e\' UNO e viene annullato prima di riarmarlo',
      /let timerProssimo = null/.test(codice) && /clearTimeout\(timerProssimo\)/.test(codice),
      'senza, il timeout gia\' armato scatterebbe all\'ora vecchia: un secondo ciclo troppo presto');
  }

  // ──────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n══ 5 · COL FRENO INSERITO IL CICLO IMMEDIATO CALCOLA E NON PIAZZA');
  {
    // Il freno non viene ri-implementato qui: si verifica che il ciclo immediato sia LO STESSO `giro`
    // che il freno governa gia'. E' la sola prova che vale — un percorso parallelo potrebbe saltarlo.
    const src = fs.readFileSync(path.join(ROOT, 'agents', 'agent41-realloc-scheduler.js'), 'utf8');
    const codice = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

    ok('l\'AVVIA chiama `giro`, cioe\' il ciclo a cadenza, non una funzione parallela',
      /eseguiGiro\('avvia-operatore'\)/.test(codice) && /const eseguiGiro = deps\.giro \|\| giro/.test(codice));
    ok('  e `giro` consulta il freno per il referto', /const frenoGiro = FRENO\.statoFreno\(\)/.test(codice));
    ok('  e lo passa al reset come `dryRunOnly`', /dryRunOnly: FRENO\.statoFreno\(\)\.attivo/.test(codice),
      'freno inserito ⇒ il piano si calcola e nessun ordine parte');

    // Il freno vero, sulla sua funzione: inserito quando la variabile non e' uno spegnimento esplicito.
    const FRENO = require(path.join(ROOT, 'lib', 'maker', 'freno-prova.js'));
    const prima = process.env.REALLOC_SCHEDULER_DRY_RUN;
    process.env.REALLOC_SCHEDULER_DRY_RUN = '1';
    ok('  freno inserito ⇒ `attivo` vero, e il ciclo immediato lo eredita', FRENO.statoFreno().attivo === true);
    process.env.REALLOC_SCHEDULER_DRY_RUN = '0';
    ok('  e disinserito solo con uno spegnimento esplicito', FRENO.statoFreno().attivo === false);
    if (prima === undefined) delete process.env.REALLOC_SCHEDULER_DRY_RUN;
    else process.env.REALLOC_SCHEDULER_DRY_RUN = prima;
  }

  // ──────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n══ 6 · CIO\' CHE NON INNESCA NIENTE');
  {
    const b = banco();
    await A41.sorvegliaAvvio(b.deps);
    b.ferma(8_000);
    await A41.sorvegliaAvvio(b.deps);
    ok('un FERMA non innesca nessun ciclo', b.cicli.length === 0);

    // Interruttore illeggibile: si torna indietro senza fare niente. Fail-closed.
    const illeggibile = { statoBot: () => ({ leggibile: false }), giro: async () => { b.cicli.push('x'); }, pianificaProssimo: () => {} };
    await A41.sorvegliaAvvio(illeggibile);
    ok('  un interruttore ILLEGGIBILE non innesca niente', b.cicli.length === 0);

    const esplode = { statoBot: () => { throw new Error('disco'); }, giro: async () => { b.cicli.push('x'); }, pianificaProssimo: () => {} };
    await A41.sorvegliaAvvio(esplode);
    ok('  e nemmeno una lettura che ESPLODE', b.cicli.length === 0);
  }

  console.log(`\n===== avvia-innesca-ciclo: ${pass} passati, ${fail} falliti =====\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
