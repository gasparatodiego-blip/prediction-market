'use strict';
// lib/safety/percorsi-critici.js — I PERCORSI SI VERIFICANO ALL'AVVIO, E SI FALLISCE RUMOROSAMENTE.
//
// ═══ IL GUASTO CHE QUESTO CHIUDE (17 agosto 2026) ═══════════════════════════════════════════════════
// In un giorno solo questo repo ha maturato **dodici percorsi assoluti** diventati puntatori a niente
// (la migrazione da `root` a `bot`, §5-bis p.188) e **nove file di servizio in `/tmp` non piu'
// scrivibili** (stesso giorno: i file erano di `root`, `/tmp` ha lo sticky bit, l'utente nuovo non
// poteva ne' riscriverli ne' cancellarli).
//
// ⚠ E NESSUNO DEI VENTUNO FALLIVA RUMOROSAMENTE, che e' la parte che conta. La forma del guasto non e'
// «il file manca»: e' che **ogni lettore ha gia' un ramo per "non l'ho letto"**, e quel ramo si prende
// la scena presentandosi come uno stato normale:
//
//   `readJson(board)` → `null`               ⇒ «board VUOTO», non «board illeggibile»
//   `codaNuova(log guardiano)` → `''`        ⇒ «il guardiano non ha detto niente» = «sta bene»
//   `diff` che esce 2 (dir illeggibile)      ⇒ «zero differenze» ⇒ un cancello che si APRE
//   scrittura in EACCES su `/tmp`            ⇒ lo scrittore fallisce e **i lettori continuano a leggere
//                                              la copia vecchia**, che non invecchia mai piu'
//
// L'ultimo e' il peggiore, ed e' quello osservato: non «il bot si ferma», ma **il bot che decide un
// prezzo su una fotografia di quaranta minuti fa credendo che sia di adesso**.
//
// ═══ COSA CONTROLLA, E COSA DELIBERATAMENTE NO ═════════════════════════════════════════════════════
// Si controllano le **precondizioni strutturali**, non lo stato:
//
//   · la RADICE del package — se non si risolve, `DATA_DIR` e ogni percorso derivato sono sbagliati;
//   · `data/` — esiste ed e' SCRIVIBILE (ci vivono piano, tetti, allowlist, giornali);
//   · la directory di servizio (`lib/percorsi-runtime`) — creabile e scrivibile;
//   · ogni file di servizio **che gia' esiste** — scrivibile DA NOI.
//
// ⚠ UN FILE ASSENTE NON E' UN ERRORE, mai. `data/guardian-state.json` assente *e'* lo stato sano;
// `clob-live-books.json` assente al primo avvio e' normale. Si controlla che si POSSA scrivere, non che
// sia gia' stato scritto — confondere le due cose farebbe fallire ogni avvio da zero.
// ⚠ E NON SI CONTROLLA IL CONTENUTO: un file scrivibile ma con dentro una fotografia vecchia e' un
// problema di FRESCHEZZA, e la freschezza ha gia' i suoi presidi (mid stantio 120 s, eta' del board
// 25 min, snapshot posizioni 180 s). Questo modulo risponde a una domanda sola: «i percorsi su cui
// questo processo sta per lavorare sono quelli giusti, e li posso usare?».
//
// ═══ FAIL-CLOSED, E RUMOROSO ═══════════════════════════════════════════════════════════════════════
// `verifica()` e' PURA e restituisce il verdetto. `verificaOMuori()` lo stampa su stderr e chiama
// `process.exit(1)`: sotto pm2 questo diventa un riavvio, e dopo `max_restarts` un processo `errored`
// che `pm2 list` mostra in rosso. E' il rumore che serve — molto meglio di undici agent «online» che
// leggono file che nessuno riscrive.
// ⚠ Un controllo che non sa fallire non e' un controllo: `percorsi-critici.test.js` lo fa cadere
// davvero, su ognuno dei casi, prima di dichiararlo verde.

const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('./store');
const { dirRuntime, fileRuntime, NOMI } = require('../percorsi-runtime');

/** Si puo' scrivere qui? `fs.accessSync` e' la domanda giusta: i permessi VERI di QUESTO processo. */
function scrivibile(p, deps = {}) {
  const acc = deps.accessSync || fs.accessSync;
  try { acc(p, fs.constants.W_OK); return true; } catch { return false; }
}
function esiste(p, deps = {}) {
  const st = deps.statSync || fs.statSync;
  try { return st(p); } catch { return null; }
}

/**
 * Il verdetto sui percorsi critici di QUESTO processo.
 *
 * @returns {{ok:boolean, guasti:Array<{percorso:string, cosa:string, perche:string}>, controllati:number,
 *            radice:string, dataDir:string, runtimeDir:string}}
 */
function verifica(deps = {}) {
  const env = deps.env || process.env;
  const dataDir = deps.dataDir || DATA_DIR;
  const runtimeDir = deps.runtimeDir || dirRuntime(env);
  const radice = path.dirname(dataDir);
  const guasti = [];
  let controllati = 0;

  // ① LA RADICE. Se `DATA_DIR` non e' ancorato a un package root vero, tutto il resto e' derivato male —
  //    ed e' il difetto che il 17 agosto ha prodotto board vuoti e watchlist vuote in silenzio.
  controllati += 1;
  if (!esiste(path.join(radice, 'package.json'), deps)) {
    guasti.push({ percorso: radice, cosa: 'radice del package',
      perche: 'non contiene `package.json`: DATA_DIR non e\' ancorato a un repo vero, e ogni percorso derivato punta altrove' });
  }

  // ② `data/`. Deve esistere ED essere scrivibile: e' dove vivono piano, tetti, allowlist e giornali.
  controllati += 1;
  const stData = esiste(dataDir, deps);
  if (!stData || !stData.isDirectory()) {
    guasti.push({ percorso: dataDir, cosa: 'directory dei dati', perche: 'assente o non e\' una directory' });
  } else if (!scrivibile(dataDir, deps)) {
    guasti.push({ percorso: dataDir, cosa: 'directory dei dati',
      perche: 'esiste ma NON e\' scrivibile da questo processo: ogni scrittura di stato fallirebbe, e i lettori continuerebbero a leggere la versione vecchia' });
  }

  // ③ LA DIRECTORY DI SERVIZIO. Si prova a crearla — `fileRuntime` lo fa gia' — e poi a scriverci.
  controllati += 1;
  try { (deps.mkdirSync || fs.mkdirSync)(runtimeDir, { recursive: true, mode: 0o700 }); } catch { /* lo dira' il controllo qui sotto */ }
  const stRun = esiste(runtimeDir, deps);
  if (!stRun || !stRun.isDirectory()) {
    guasti.push({ percorso: runtimeDir, cosa: 'directory di servizio', perche: 'non si e\' potuta creare' });
  } else if (!scrivibile(runtimeDir, deps)) {
    guasti.push({ percorso: runtimeDir, cosa: 'directory di servizio',
      perche: 'esiste ma NON e\' scrivibile da questo processo' });
  }

  // ④ I FILE DI SERVIZIO CHE GIA' ESISTONO. ⚠ QUESTO E' IL CONTROLLO CHE IL 17 AGOSTO MANCAVA: i file
  //    c'erano, erano leggibili, ed erano di un ALTRO utente. Gli scrittori prendevano EACCES e i lettori
  //    leggevano felici la copia ferma. Un file assente NON e' un guasto: e' il primo avvio.
  for (const nome of Object.values(NOMI)) {
    const p = deps.fileRuntime ? deps.fileRuntime(nome) : fileRuntime(nome, env);
    const st = esiste(p, deps);
    if (!st) continue;              // assente ⇒ verra' creato, e va bene
    controllati += 1;
    if (!scrivibile(p, deps)) {
      guasti.push({ percorso: p, cosa: 'file di servizio',
        perche: 'ESISTE ma non e\' scrivibile da questo processo: chi lo scrive fallira\' in silenzio e chi lo legge continuera\' a leggere questa copia, che da adesso non invecchia piu\'' });
    }
  }

  return { ok: guasti.length === 0, guasti, controllati, radice, dataDir, runtimeDir };
}

/**
 * Il controllo all'avvio: verifica, e se qualcosa non va **si ferma rumorosamente**.
 * @param {string} chi  il nome del processo, per il messaggio
 */
function verificaOMuori(chi = 'processo', deps = {}) {
  const v = verifica(deps);
  if (v.ok) return v;
  const err = deps.stderr || ((s) => process.stderr.write(s));
  err(`\n🔴 ${chi}: PERCORSI CRITICI NON UTILIZZABILI — non parto.\n`);
  err(`   radice ${v.radice}\n   data   ${v.dataDir}\n   servizio ${v.runtimeDir}\n\n`);
  for (const g of v.guasti) err(`   · ${g.cosa}: ${g.percorso}\n     ${g.perche}\n`);
  err('\n   Fermarsi qui e\' voluto: ogni lettore di questo repo ha un ramo per «non l\'ho letto», e\n'
    + '   proseguire vorrebbe dire lavorare su dati che sembrano freschi e non lo sono. (§5.3)\n\n');
  const esci = deps.exit || ((c) => process.exit(c));
  esci(1);
  return v;
}

module.exports = { verifica, verificaOMuori, scrivibile };
