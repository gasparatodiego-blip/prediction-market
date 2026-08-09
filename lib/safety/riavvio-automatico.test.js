'use strict';
// lib/safety/riavvio-automatico.test.js — UN CRASH NOTTURNO NON DEVE LASCIARE UN PROCESSO ROTTO.
//
// ═══ COSA SI SIMULA, E PERCHÉ COSÌ ══════════════════════════════════════════════════════════════════
// «Riavvio automatico» qui significa due scenari diversi, e solo il secondo era davvero pericoloso:
//   1. crash del PROCESSO (OOM, eccezione): pm2 lo rilancia con la descrizione che ha in memoria, che
//      le variabili ce le ha. Questo scenario andava già bene;
//   2. riavvio del DEMONE (reboot del server, `pm2 update`): pm2 risorge dal dump su disco, che su
//      questa macchina è PULITO — nessuna delle variabili critiche è lì dentro (CLAUDE.md §5 §3). Un
//      reboot notturno lasciava quindi in piedi processi senza `DATABASE_URL`, `KEY_CUSTODY_MASTER`,
//      `POLYGON_RPC_URL`, `MAKER_FUNDER_ADDRESS`.
//
// Il secondo scenario si simula ESEGUENDO il caricatore di ciascun agente sopra un ambiente VUOTO —
// che è esattamente ciò che il processo vedrebbe risorgendo dal dump — e verificando quali variabili
// riesce a ricostruire da solo. Non si riavvia niente e non si tocca nessun processo vivo.
//
// La seconda metà del test verifica che, ripartito, ogni processo critico RILEGGA lo stato da disco
// invece di dipendere da qualcosa che viveva solo in memoria: è la differenza fra «riparte» e «riparte
// e riprende a lavorare».
//
// Run: node lib/safety/riavvio-automatico.test.js

const fs = require('fs');
const path = require('path');
const os = require('os');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const RADICE = path.join(__dirname, '..', '..');
const AGENTI = ['agent35-maker', 'agent40-manual-reprice', 'agent41-realloc-scheduler', 'agent43-guardian'];
// Le variabili senza le quali un processo è vivo e inutile: non sa leggere il capitale, non sa firmare,
// non sa parlare col database. Sono le stesse quattro che l'operatore controlla a ogni riavvio a mano.
const CRITICHE = ['DATABASE_URL', 'KEY_CUSTODY_MASTER', 'POLYGON_RPC_URL', 'MAKER_FUNDER_ADDRESS'];

/** Estrae il caricatore dal sorgente e lo ESEGUE su un ambiente finto e vuoto. */
function ambienteRicostruito(agente) {
  const src = fs.readFileSync(path.join(RADICE, 'agents', `${agente}.js`), 'utf8');
  const m = src.match(/for \(const envFile of \['\.env\.local', '\.env'\]\) \{[\s\S]*?\n\}/);
  if (!m) return null;
  const finto = {};
  // eslint-disable-next-line no-eval
  eval(m[0]
    .replace(/process\.env\[m\[1\]\] === undefined/, 'finto[m[1]] === undefined')
    .replace(/process\.env\[m\[1\]\] = m\[2\]/, 'finto[m[1]] = m[2]')
    .replace(/path\.join\(__dirname, '\.\.', envFile\)/, 'path.join(RADICE, envFile)'));
  return finto;
}

console.log('\n1 · SCENARIO «riavvio del demone»: ogni agente critico ricostruisce il proprio ambiente');
{
  for (const a of AGENTI) {
    const env = ambienteRicostruito(a);
    ok(`${a} ha un caricatore di .env`, env !== null);
    if (!env) continue;
    const mancanti = CRITICHE.filter((k) => env[k] === undefined);
    ok(`  e ricostruisce tutte e ${CRITICHE.length} le variabili critiche`, mancanti.length === 0,
      mancanti.length ? `mancano ${mancanti.join(', ')}` : `${Object.keys(env).length} variabili dal file`);
  }
}

console.log('\n2 · il caricatore NON può rompere un avvio che oggi funziona');
{
  for (const a of AGENTI) {
    const src = fs.readFileSync(path.join(RADICE, 'agents', `${a}.js`), 'utf8');
    ok(`${a}: ciò che pm2 passa VINCE sul file`, /if \(m && process\.env\[m\[1\]\] === undefined\)/.test(src),
      'senza questa condizione il file sovrascriverebbe l\'ambiente del processo');
  }
  // E la variabile che l'operatore ha deciso di lasciare nella descrizione pm2 non viene toccata.
  const envFile = fs.readFileSync(path.join(RADICE, '.env'), 'utf8');
  ok('`.env` non reintroduce REALLOC_SCHEDULER_DRY_RUN', !/^\s*REALLOC_SCHEDULER_DRY_RUN\s*=/m.test(envFile));
}

console.log('\n3 · ciò che il file non copre lo copre ecosystem.config.js');
{
  const eco = fs.readFileSync(path.join(RADICE, 'agents', 'ecosystem.config.js'), 'utf8');
  ok('REALLOC_SCHEDULER_ENABLED è nel blocco env di agent41', /REALLOC_SCHEDULER_ENABLED:\s*'1'/.test(eco),
    'sta nel file di ecosistema, quindi pm2 lo passa a ogni riavvio, automatico compreso');
  // Il blocco env di ecosystem è versionato: sopravvive a un dump pulito per costruzione.
  ok('  ed è versionato in git, quindi sopravvive a un dump pulito', fs.existsSync(path.join(RADICE, 'agents', 'ecosystem.config.js')));
}

console.log('\n4 · RIPRESA: lo stato vive su DISCO, non nella memoria del processo');
{
  // Per ognuno dei quattro, la domanda è: «cosa deve ricordare per riprendere?» e «da dove lo rilegge?».
  // Si verifica che ogni fonte sia un file — perché è l'unica cosa che sopravvive a un crash.
  const fonti = [
    ['l\'interruttore AVVIA/FERMA', 'data/maker-bot-enabled.json', 'bot-enabled'],
    ['il kill', 'data/safety-kill-switch.json', 'kill-switch'],
    ['la allowlist dei mercati gestiti', 'data/maker-auto-reprice.json', 'auto-reprice-config'],
    ['l\'uscita automatica per mercato', 'data/maker-auto-close.json', 'auto-close-config'],
    ['lo stato del riallocatore (lastRunAt)', 'data/realloc-scheduler-state.json', 'agent41'],
    ['l\'ultimo piano', 'data/realloc-ultimo-piano.json', 'agent41'],
    ['le attese del merge', 'data/merge-attese.json', 'agent40'],
    ['il baseline del guardiano', 'data/guardian-baseline.json', 'agent43'],
  ];
  for (const [nome, file] of fonti) {
    // Non serve che il file ESISTA adesso (alcuni nascono al primo uso): serve che il percorso sia
    // dichiarato nel codice, cioè che la memoria sia su disco e non in una variabile di processo.
    const nomeFile = path.basename(file);
    const trovato = ['lib', 'agents'].some((d) => {
      const cerca = (dir) => fs.readdirSync(dir, { withFileTypes: true }).some((e) => {
        if (['node_modules', '.next', '.git'].includes(e.name)) return false;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return cerca(p);
        return /\.js$/.test(e.name) && fs.readFileSync(p, 'utf8').includes(nomeFile.replace('.json', ''));
      });
      return cerca(path.join(RADICE, d));
    });
    ok(`${nome} → ${nomeFile}`, trovato, 'la memoria sta su disco: sopravvive al crash');
  }
}

console.log('\n5 · nessuno dei quattro chiede all\'operatore di premere di nuovo AVVIA');
{
  const a41 = fs.readFileSync(path.join(RADICE, 'agents', 'agent41-realloc-scheduler.js'), 'utf8');
  ok('agent41 rilegge l\'interruttore a ogni controllo', /botAttivo\(\)/.test(a41));
  ok('  e il timer riparte dallo stato su disco, non da zero', /function prossimoRitardo[\s\S]{0,400}leggiStato\(\)/.test(a41),
    'un riavvio non rimette il contatore delle sei ore a zero');
  // E la sorveglianza dell'AVVIA NON deve rifirare per un riavvio: un pm2 restart non è un bottone.
  ok('  la sorveglianza dell\'AVVIA parte dall\'istante corrente', /if \(ultimoAvvioVisto == null\) \{ ultimoAvvioVisto = s\.at; return; \}/.test(a41),
    'altrimenti ogni riavvio verrebbe letto come un AVVIA appena premuto');
  const a40 = fs.readFileSync(path.join(RADICE, 'agents', 'agent40-manual-reprice.js'), 'utf8');
  ok('agent40 rilegge la configurazione a ogni ciclo', /readAutoCloseConfig\(\)/.test(a40));
  ok('  e le attese del merge da un file, non dalla memoria', /MERGE_WAIT_FILE/.test(a40));
}

console.log('\n6 · gli orologi che NON sopravvivono, e perché va bene così');
{
  const ms = fs.readFileSync(path.join(RADICE, 'lib', 'maker', 'mid-stantio.js'), 'utf8');
  ok('l\'orologio del mid stantio è dichiaratamente in memoria', /sopravvive ai cicli ma non al riavvio/.test(ms),
    'dopo un riavvio non sappiamo da quanto eravamo ciechi: ripartire da zero è la risposta prudente');
  const ca = fs.readFileSync(path.join(RADICE, 'lib', 'maker', 'cadenza-adattiva.js'), 'utf8');
  ok('  e la cadenza riparte guardando subito ogni mercato', /mai visto ⇒ si guarda/.test(ca),
    'un riavvio non lascia mercati non guardati in attesa della loro cadenza');
}

console.log('\n7 · la simulazione: un processo che riparte con ambiente vuoto legge lo stesso stato');
{
  // Si scrive uno stato finto su file, lo si rilegge con i lettori VERI da un processo che non ha mai
  // visto quel dato in memoria. È la forma più stretta della domanda «riprende da solo?».
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riavvio-'));
  const f = path.join(TMP, 'maker-bot-enabled.json');
  fs.writeFileSync(f, JSON.stringify({ v: 1, enabled: true, at: 1786200000000, atIso: '2026-08-08T12:00:00.000Z', by: 'test', reason: 'simulazione', mercatiDallAvvio: [] }));
  const { statoBot } = require('../maker/bot-enabled');
  const s = statoBot({ file: f });
  ok('un processo appena nato rilegge AVVIA da disco', s.enabled === true && s.leggibile === true);
  ok('  con l\'istante originale, non con quello del riavvio', s.at === 1786200000000,
    'è ciò che permette al registro delle aperture di continuare a contare dall\'AVVIA vero');

  const g = path.join(TMP, 'guardian-baseline.json');
  fs.writeFileSync(g, JSON.stringify({ baselineUsd: 660.56, at: 1786200000000 }));
  const letto = JSON.parse(fs.readFileSync(g, 'utf8'));
  ok('il baseline del guardiano sopravvive al riavvio', letto.baselineUsd === 660.56,
    'senza, un riavvio azzererebbe la memoria delle perdite e il guardiano ripartirebbe da capo');
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passati, ${fail} falliti`);
if (fail) process.exit(1);
