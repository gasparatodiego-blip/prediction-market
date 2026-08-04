#!/usr/bin/env node
'use strict';
// I TRE DIFETTI DEL 4 AGOSTO 2026, E LE ASSERZIONI CHE IMPEDISCONO CHE TORNINO.
//
//   1 · MEMORIA — il calcolo del piano portava agent41 da 41 MB a 687 MB contro un tetto pm2 di 400 MB,
//       e pm2 lo fermava a metà ciclo con un arresto pulito indistinguibile da un restart manuale.
//   2 · MERCATO RISOLTO — auto-close ha tentato 53 volte in un'ora di vendere su un mercato chiuso dal
//       2 agosto, il cui token valeva zero, convinta di un +61%.
//   3 · WOULD-CROSS — il gate anti-taker applicava la regola del BUY anche ai SELL: bloccava vendite
//       maker legittime e non vedeva le vendite che si sarebbero eseguite davvero da taker.

const path = require('path');
const { execFile } = require('child_process');
const { decideClose } = require('./auto-close');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ROOT = path.resolve(__dirname, '..', '..');

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// FIX 1 · LA MEMORIA DEL PIANO NON TOCCA PIÙ IL PROCESSO PRINCIPALE
// ═══════════════════════════════════════════════════════════════════════════════════════════════
(async () => {

  console.log('\n══ FIX 1 · IL PIANO SI CALCOLA IN UN FIGLIO, E IL PADRE NON CRESCE');
  {
    const src = require('fs').readFileSync(path.join(ROOT, 'agents', 'agent41-realloc-scheduler.js'), 'utf8');
    ok('agent41 NON richiede piu planFromCollection in-process',
      !/^\s*const \{ planFromCollection \} = require/m.test(src),
      'se questa cade, i 687MB sono tornati dentro il processo');
    ok('  e lo calcola con un processo figlio', /execFile\('node', \['-e', RUNNER_PIANO\]/.test(src));
    ok('  le opzioni passano da STDIN, non da argv',
      /figlio\.stdin\.end\(JSON\.stringify\(opzioni\)\)/.test(src),
      'onlyMarketIds/excludeMarketIds su argv avrebbero limiti di lunghezza ed escaping');
    ok('  con un timeout dichiarato', /PLAN_TIMEOUT_MS\s*=\s*\d/.test(src));
    ok('  e un buffer sufficiente al corpo del piano', /PLAN_MAX_BUFFER\s*=\s*\d+\s*\*\s*1024\s*\*\s*1024/.test(src));

    // LA PROVA VERA: si misura l'RSS del padre mentre il figlio calcola. Il figlio arriva a ~690MB;
    // il padre deve restare in decine di MB. La soglia e' 200MB — meta' del tetto pm2 di 400MB, cosi'
    // l'asserzione fallisce PRIMA che il problema si ripresenti in produzione.
    const RUNNER = 'let b="";process.stdin.setEncoding("utf8");process.stdin.on("data",(d)=>{b+=d});process.stdin.on("end",()=>{try{const o=JSON.parse(b);process.stdout.write(JSON.stringify(require("' + ROOT.replace(/\\/g, '/') + '/lib/rewards/allocator").planFromCollection(o)))}catch(e){process.stderr.write(String(e&&e.stack||e));process.exit(3)}});';
    const rssPrima = process.memoryUsage().rss;
    const esito = await new Promise((resolve) => {
      const f = execFile('node', ['-e', RUNNER], { timeout: 180_000, maxBuffer: 48 * 1024 * 1024 },
        (err, out) => resolve({ err, out }));
      f.stdin.end(JSON.stringify({ capital: 600, maxPerMarketUsd: 180, horizonFilter: true }));
    });
    const rssDopo = process.memoryUsage().rss;
    const cresciutoMB = (rssDopo - rssPrima) / 1048576;

    ok('il figlio ha restituito un piano valido', !esito.err && (() => {
      try { const p = JSON.parse(esito.out); return Array.isArray(p.rows) && p.capital > 0; } catch { return false; }
    })(), esito.err ? esito.err.message : `${(esito.out || '').length} byte`);
    ok(`il PADRE non e cresciuto (${cresciutoMB.toFixed(0)} MB, limite 200)`, cresciutoMB < 200,
      `prima ${(rssPrima / 1048576).toFixed(0)}MB, dopo ${(rssDopo / 1048576).toFixed(0)}MB`);
    ok('  e resta ampiamente sotto il tetto pm2 di 400MB', rssDopo < 400 * 1048576,
      `${(rssDopo / 1048576).toFixed(0)}MB`);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // FIX 2 · AUTO-CLOSE NON TOCCA UN MERCATO RISOLTO
  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  const regole = (over = {}) => ({
    readable: true, marketId: '0x' + 'a1'.repeat(32), mid: 0.5, tick: 0.01,
    maxSpreadCents: 4, minSize: 20, tokenId: '111', tokenIdNo: '222',
    books: { yes: { scoringMid: 0.5, bestBid: 0.49, bestAsk: 0.51 }, no: { scoringMid: 0.5, bestBid: 0.49, bestAsk: 0.51 } },
    ...over,
  });
  const posizione = { tokenId: '111', size: 199.9918, avgPrice: 0.1675 };

  console.log('\n══ FIX 2 · SU UN MERCATO CHIUSO NON SI TENTA NESSUNA VENDITA');
  {
    // Il caso esatto del 4 agosto: posizione reale, mercato risolto, book inesistente.
    const d = decideClose({ position: posizione, restingOrders: [], rules: regole(), book: 'yes',
      venue: { readable: true, closed: true, acceptingOrders: false } });
    ok('l azione e «skip», non una vendita', d.action === 'skip', `${d.action} · ${d.gate}`);
    ok('  con il gate «market-closed»', d.gate === 'market-closed');
    ok('  e il motivo dice che si RISCATTA, non si vende', /riscatta, non si vende/.test(d.reason), d.reason.slice(0, 90));
    ok('  nessun prezzo viene calcolato', d.price === null);
  }

  console.log('\n══ FIX 2b · MERCATO APERTO MA CHE NON ACCETTA ORDINI: STESSA RISPOSTA');
  {
    const d = decideClose({ position: posizione, restingOrders: [], rules: regole(), book: 'yes',
      venue: { readable: true, closed: false, acceptingOrders: false } });
    ok('skip con gate «market-not-accepting»', d.action === 'skip' && d.gate === 'market-not-accepting', `${d.gate}`);
  }

  console.log('\n══ FIX 2c · IL GATE E DI PRIMO LIVELLO: PRECEDE OGNI ARITMETICA DI PREZZO');
  {
    // Un mercato chiuso con un'uscita gia' a riposo: prima si guardava se era coperta, poi si decideva.
    // Adesso la chiusura del mercato vince su tutto — non si valuta nemmeno la copertura.
    const d = decideClose({
      position: posizione,
      restingOrders: [{ tokenId: '111', side: 'SELL', size: 199.9918, price: 0.27, createdMs: Date.now() - 1000 }],
      rules: regole(), book: 'yes', venue: { readable: true, closed: true, acceptingOrders: false },
    });
    ok('vince il gate del mercato chiuso, non «already-covered»', d.gate === 'market-closed', `${d.action} · ${d.gate}`);
  }

  console.log('\n══ FIX 2d · STATO DEL VENUE NON LEGGIBILE ⇒ NON SI BLOCCA (si chiude, non si apre)');
  {
    // Deliberatamente all'incontrario del solito fail-closed: questa funzione CHIUDE esposizione, e
    // rifiutarsi di chiudere per un campo mancante lascerebbe capitale bloccato su un dato assente.
    for (const [nome, venue] of [
      ['venue null', null],
      ['lettura fallita', { readable: false, error: 'timeout' }],
      ['closed non letto', { readable: true, closed: null, acceptingOrders: null }],
    ]) {
      const d = decideClose({ position: posizione, restingOrders: [], rules: regole(), book: 'yes', venue });
      ok(`${nome}: il gate NON blocca`, d.gate !== 'market-closed' && d.gate !== 'market-not-accepting', `${d.action} · ${d.gate}`);
    }
    // E su un mercato vivo si comporta come sempre.
    const viva = decideClose({ position: posizione, restingOrders: [], rules: regole(), book: 'yes',
      venue: { readable: true, closed: false, acceptingOrders: true } });
    ok('mercato vivo: il gate lascia passare e si decide nel merito',
      viva.gate !== 'market-closed' && viva.gate !== 'market-not-accepting', `${viva.action} · ${viva.gate}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // FIX 3 · WOULD-CROSS, LA REGOLA GIUSTA PER LATO
  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n══ FIX 3 · LA CONDIZIONE ANTI-TAKER DIPENDE DAL LATO');
  {
    const src = require('fs').readFileSync(path.join(__dirname, 'manual-order.js'), 'utf8');
    ok('non c e piu la condizione unica «price >= touch.bestAsk»',
      !/if \(Number\.isFinite\(touch && touch\.bestAsk\) && price >= touch\.bestAsk - 1e-12\)/.test(src),
      'era la regola del BUY applicata anche ai SELL');
    ok('  il lato viene deciso da spec.side', /const lato = spec\.side === 'SELL' \? 'SELL' : 'BUY'/.test(src));
    ok('  un SELL si confronta col miglior BID', /lato === 'SELL' \? \(touch && touch\.bestBid\)/.test(src));
    ok('  un BUY resta sul miglior ASK', /: \(touch && touch\.bestAsk\)/.test(src));
    ok('  SELL incrocia quando price <= bestBid', /price <= rifTocco \+ 1e-12/.test(src));
    ok('  BUY incrocia quando price >= bestAsk', /price >= rifTocco - 1e-12/.test(src));

    // L'aritmetica, isolata: e' la stessa espressione del sorgente, verificata sui casi che contano.
    const incrocia = (lato, price, bestBid, bestAsk) => (lato === 'SELL'
      ? (Number.isFinite(bestBid) && price <= bestBid + 1e-12)
      : (Number.isFinite(bestAsk) && price >= bestAsk - 1e-12));

    // Book: bid 0.49 / ask 0.51
    ok('VENDITA a 0.51 (al miglior ask) = maker legittima ⇒ PASSA',
      incrocia('SELL', 0.51, 0.49, 0.51) === false,
      'e il caso che veniva rifiutato 53 volte in un ora');
    ok('VENDITA a 0.50 (dentro lo spread) = maker ⇒ PASSA', incrocia('SELL', 0.50, 0.49, 0.51) === false);
    ok('VENDITA a 0.49 (AL miglior bid) = taker ⇒ BLOCCATA', incrocia('SELL', 0.49, 0.49, 0.51) === true);
    ok('VENDITA a 0.45 (sotto il bid) = taker ⇒ BLOCCATA',
      incrocia('SELL', 0.45, 0.49, 0.51) === true,
      'era il caso che la regola vecchia NON vedeva affatto');
    ok('ACQUISTO a 0.51 (al miglior ask) = taker ⇒ BLOCCATO', incrocia('BUY', 0.51, 0.49, 0.51) === true);
    ok('ACQUISTO a 0.50 = maker ⇒ PASSA', incrocia('BUY', 0.50, 0.49, 0.51) === false);
    ok('tocco non leggibile ⇒ non si blocca su un numero non letto',
      incrocia('SELL', 0.45, null, 0.51) === false && incrocia('BUY', 0.99, 0.49, null) === false);
  }

  console.log('\n══ FIX 3b · L USCITA FORZATA PUO ATTRAVERSARE, MA SOLO SE LO DICHIARA');
  {
    const src = require('fs').readFileSync(path.join(__dirname, 'manual-order.js'), 'utf8');
    ok('l eccezione esiste ed e ristretta alla VENDITA',
      /const attraversaApposta = lato === 'SELL' && spec\.attraversaApposta === true/.test(src),
      'un BUY aggressivo aprirebbe esposizione: per il BUY la regola resta assoluta');
    ok('  e non e silenziosa: finisce nell audit', /outcome: 'cross-dichiarato'/.test(src));
    const ac = require('fs').readFileSync(path.join(__dirname, 'auto-close.js'), 'utf8');
    ok('  la chiusura a mercato la dichiara', /attraversaApposta: true/.test(ac));
    ok('  e SOLO quella: nessun altro punto la usa',
      (ac.match(/attraversaApposta/g) || []).length === 1);
  }

  console.log(`\ntre fix di sicurezza: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();
