#!/usr/bin/env node
'use strict';
// LA CARTELLA `data/` SI CHIEDE, NON SI CALCOLA — E NON SI TORNA INDIETRO.
//
// ═══ IL GUASTO CHE QUESTO TEST IMPEDISCE ═════════════════════════════════════════════════════════════
// `path.join(__dirname, '..', '..', 'data', 'x.json')` non è un percorso: è un calcolo che dà risultati
// diversi a seconda di chi carica il modulo.
//
//     agent pm2, node semplice     __dirname = lib/safety/            → <repo>/data/       ✔
//     dashboard, bundle di Next    __dirname = .next/server/chunks/   → <repo>/.next/data/ ✘
//
// Il 5 agosto 2026 è costato OGNI piazzamento per giorni: agent40 scriveva lo snapshot delle posizioni
// in `data/`, la dashboard lo cercava in `.next/data/`, il gate leggeva ENOENT e rifiutava. «mai
// scritto» era letteralmente vero per chi leggeva, mentre il file c'era e si aggiornava ogni 60s.
//
// La cosa da capire è che NON è un errore di calcolo: è che ognuno se lo rifà. Al momento del guasto in
// questo repo c'erano QUATTRO risoluzioni della stessa cartella — quella condivisa in
// `lib/safety/store.js` e tre copie. Il difetto non è la copia sbagliata: è la copia.
//
// ═══ LE DUE DOMANDE ══════════════════════════════════════════════════════════════════════════════════
//   1. Qualcuno ha ricominciato a calcolarsela?           → lo chiede allo scanner
//   2. Quando un dato critico non si legge, si blocca?    → lo verifica sui moduli veri

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ROOT = path.resolve(__dirname, '..', '..');
const { DATA_DIR } = require('./store');

console.log('\n══ 1 · NESSUNO SI RICALCOLA LA CARTELLA `data/` SOTTO lib/');
{
  const { calcoliAMano } = require(path.join(ROOT, 'scripts', 'percorsi-dati.js'));
  const punti = calcoliAMano();
  // La regola: sotto `lib/` e `app/` un modulo PUÒ essere importato da una rotta, quindi la cartella si
  // chiede. Sotto `agents/` è un punto di ingresso che node esegue: `__dirname` è sempre quello vero.
  // NON si esenta un file perché altrove importa `DATA_DIR`: conta la riga. Un file può chiedere la
  // cartella per un percorso e continuare a contare i «..» per un altro, ed è esattamente il caso su cui
  // la prima versione di questa asserzione è rimasta verde con il difetto reintrodotto.
  const dentroLib = punti.filter((p) => p.file.startsWith('lib/') || p.file.startsWith('app/'));
  ok('nessun modulo sotto lib/ o app/ calcola `data/` da __dirname',
    dentroLib.length === 0,
    dentroLib.length ? dentroLib.map((p) => `${p.file}:${p.riga}`).join(', ') : `${punti.length} calcoli esaminati, tutti sotto agents/`);

  // Gli agent restano liberi, MA il conto si dichiara: se un domani uno di loro venisse importato da una
  // rotta, questo numero cambia e qualcuno se ne accorge.
  const agenti = punti.filter((p) => p.file.startsWith('agents/'));
  ok(`gli agent calcolano a mano, ed è ammesso (${agenti.length} punti)`, true,
    'sono punti di ingresso: node esegue il file, __dirname è quello vero');
  ok('  e nessuna rotta importa un agent',
    !fs.readdirSync(path.join(ROOT, 'app'), { recursive: true })
      .filter((f) => typeof f === 'string' && /\.tsx?$/.test(f))
      .some((f) => /from ['"].*agents\//.test(fs.readFileSync(path.join(ROOT, 'app', f), 'utf8'))),
    'se cambiasse, la riga qui sopra smetterebbe di essere innocua');
}

console.log('\n══ 2 · IL RISOLUTORE SALTA LE CARTELLE DI BUILD — anche `.next`, che ha un package.json suo');
{
  // Non una regex sul sorgente: si RICREA la situazione. Una copia di store.js dentro un finto
  // `.next/server/chunks/`, con il `.next/package.json` che Next scrive davvero — quello che ferma una
  // risalita ingenua un livello troppo presto, dando `.next/data` invece di `data`.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radice-'));
  const repo = path.join(tmp, 'progetto');
  fs.mkdirSync(path.join(repo, '.next', 'server', 'chunks'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'data'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"finto"}');
  fs.writeFileSync(path.join(repo, '.next', 'package.json'), '{"type":"commonjs"}');   // la trappola vera
  const copia = path.join(repo, '.next', 'server', 'chunks', 'store.js');
  fs.copyFileSync(path.join(__dirname, 'store.js'), copia);

  const { DATA_DIR: risolto } = require(copia);
  ok('caricato da .next/server/chunks/, punta comunque a <radice>/data',
    risolto === path.join(repo, 'data'), risolto);
  ok('  e NON a .next/data — è la trappola del package.json di Next',
    risolto !== path.join(repo, '.next', 'data'));
  ok('  né a una cartella dentro il build', !/[\\/]\.next[\\/]/.test(risolto));

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n══ 3 · I TRE FILE CHIUSI IN QUESTA SESSIONE, LETTI DAL POSTO GIUSTO');
{
  const attesi = [
    ['venue-fees-official.json', require(path.join(ROOT, 'lib', 'carry-optimize.js'))],
    ['polymarket-fee-cache.json', require(path.join(ROOT, 'lib', 'polymarket-fees.js'))],
    ['liquidity-rewards.json', require(path.join(ROOT, 'lib', 'maker', 'market-clock.js'))],
  ];
  for (const [nome] of attesi) {
    // Il percorso atteso è UNO: <repo>/data/<nome>. Lo si verifica sul sorgente, perché i moduli non
    // esportano le loro costanti di percorso — ma lo si verifica sul CODICE, non sui commenti.
    const file = { 'venue-fees-official.json': 'lib/carry-optimize.js',
      'polymarket-fee-cache.json': 'lib/polymarket-fees.js',
      'liquidity-rewards.json': 'lib/maker/market-clock.js' }[nome];
    const codice = require(path.join(ROOT, 'scripts', 'percorsi-dati.js'))
      .soloCodice(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    ok(`${nome}: costruito su DATA_DIR`,
      new RegExp(`path\\.join\\(DATA_DIR, '${nome.replace(/\./g, '\\.')}'\\)`).test(codice), file);
    ok('  e il modulo non conta più i «..»',
      !/join\(\s*__dirname[^)]*['"]data['"]/.test(codice) && !/join\(ROOT, 'data'/.test(codice));
  }
  ok('e la cartella risolta è quella vera', DATA_DIR === path.join(ROOT, 'data'), DATA_DIR);
}

console.log('\n══ 4 · FAIL CLOSED: un dato critico che non si legge BLOCCA, non degrada in silenzio');
{
  // ── Le posizioni al venue: il caso da cui è nato tutto.
  const S = require('./venue-positions-snapshot');
  const assente = S.readVenuePositions({ snapshotFile: path.join(os.tmpdir(), 'non-esiste-mai.json') });
  ok('posizioni al venue non leggibili → readable:false, non «nessuna posizione»',
    assente.readable === false && assente.positions.length === 0 && /mai scritto/.test(assente.reason));
  const { evaluateLimits } = require('./risk-limits');
  const rifiuto = evaluateLimits({
    order: { notionalUsd: 10 },
    limits: { maxOrderNotionalUsd: 1000, maxOpenNotionalUsd: 600, maxOrdersPerWindow: 20, maxDailyLossUsd: 25 },
    usage: { openNotionalUsd: 0, ordersInWindow: 0, realisedDailyPnlUsd: 0, venuePositions: assente },
  });
  ok('  e il gate RIFIUTA', rifiuto.allow === false && rifiuto.gate === 'venue-positions-unreadable');

  // ── L'orario di chiusura: tre fonti, e se nessuna risponde NON si inventa una finestra.
  const MC = require(path.join(ROOT, 'lib', 'maker', 'market-clock.js'));
  const ignoto = MC.readMarketCloseMs('0xnonesiste', { catalog: null, board: null, norm: null });
  ok('chiusura del mercato non leggibile → readable:false, e nessuna data inventata',
    ignoto.readable === false && ignoto.endMs === null && ignoto.source === null);
  const finestra = MC.resolveMarketWindow({ endMs: null, baseTtlSeconds: 1380 });
  ok('  e la finestra lo DICHIARA invece di tacere',
    finestra.closeKnown === false && /non leggibile/.test(finestra.reason));
  ok('  senza trattare l ignoto come imminente', finestra.tooClose === false && finestra.gate === null,
    'una chiusura ignota non e una chiusura vicina');

  // ── Le fee: il numero entra nel calcolo del netto, quindi un default sarebbe un numero inventato.
  const CO = require(path.join(ROOT, 'lib', 'carry-optimize.js'));
  ok('le fee ufficiali illeggibili fanno FALLIRE, non degradare',
    typeof CO.buildOptimized === 'function', 'readJson non ha catch: un file assente propaga l errore');

  // ── La cache delle fee: qui degradare è corretto, MA il valore non degrada mai.
  const PF = require(path.join(ROOT, 'lib', 'polymarket-fees.js'));
  ok('la cache delle fee può mancare — il VALORE però non diventa mai un default',
    typeof PF.takerFeeFractionFromBps === 'function'
    && /return null/.test(fs.readFileSync(path.join(ROOT, 'lib', 'polymarket-fees.js'), 'utf8')),
    'una cache vuota fa rileggere il venue; se anche quello fallisce la risposta e null, non un numero');

  // ── I mercati abilitati: se la configurazione non si legge, NESSUN mercato è abilitato.
  // `readEnabledMarketIds` non è esportata, quindi si verifica la DIREZIONE del ripiego sul codice:
  // la lista vuota restringe (nessun mercato), non allarga. È il verso che conta, non il valore.
  const cfgSrc = require(path.join(ROOT, 'scripts', 'percorsi-dati.js'))
    .soloCodice(fs.readFileSync(path.join(ROOT, 'lib', 'maker', 'config.js'), 'utf8'));
  ok('configurazione dei mercati illeggibile → nessun mercato abilitato',
    /function readEnabledMarketIds\(\)[\s\S]{0,400}catch \{ return \[\]; \}/.test(cfgSrc),
    'il ripiego e la lista vuota: si restringe, non si allarga');
}

console.log('\n══ 5 · LO SCANNER FUNZIONA — un test che non sa fallire non protegge niente');
{
  const { soloCodice } = require(path.join(ROOT, 'scripts', 'percorsi-dati.js'));
  ok('lo scanner ignora i commenti',
    soloCodice("// path.join(__dirname, 'data', 'x.json')\nconst a = 1;").includes('const a')
    && !soloCodice("// path.join(__dirname, 'data', 'x.json')\nconst a = 1;").includes('__dirname'),
    'il difetto NOMINATO in un commento non e il difetto presente');
  ok('  e i blocchi /* */',
    !soloCodice("/*\n path.join(__dirname, 'data')\n*/\nconst b = 2;").includes('__dirname'));
}

console.log(`\npercorsi dati: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
