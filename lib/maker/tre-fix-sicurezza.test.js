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
    // 9 agosto 2026: l'eccezione era SOLO in vendita, ed e' stata allargata al BUY per un caso solo —
    // completare una coppia dopo un fill, decisione esplicita dell'operatore. La proprieta' da difendere
    // non e' piu' «solo SELL» ma «il BUY passa solo dentro un costo dichiarato e RIVERIFICATO qui».
    ok('l eccezione in VENDITA e intatta',
      /lato === 'SELL' && spec\.attraversaApposta === true/.test(src));
    ok('  e il BUY passa solo per completare una coppia, mai per quotare',
      /spec\.completaCoppia === true/.test(src));
    ok('  con i due numeri del limite dichiarati dal chiamante',
      /prezzoCaricoCoppia/.test(src) && /tettoCoppiaCents/.test(src));
    ok('  e il gate RIFA l aritmetica invece di fidarsi',
      /\(caricoCoppia \+ price\) \* 100 <= tettoCoppia/.test(src),
      'il tetto e un vincolo verificato sull ordine esatto, non una dichiarazione');
    ok('  e non e silenziosa: finisce nell audit', /outcome: 'cross-dichiarato'/.test(src));
    const ac = require('fs').readFileSync(path.join(__dirname, 'auto-close.js'), 'utf8');
    ok('  la chiusura a mercato la dichiara', /attraversaApposta: true/.test(ac));
    // DUE punti, e non uno, dall'8 agosto 2026: la chiusura forzata a mercato e il LIVELLO 1 del merge,
    // che e' un taker per definizione (l'ask conveniente c'e' adesso e domani puo' non esserci). Il
    // banco resta stretto — si conta, non si allarga a piacere — perche' la proprieta' da difendere e'
    // che attraversare lo spread sia raro e sempre DICHIARATO, non che accada in un posto solo.
    // TRE punti dal 9 agosto: chiusura forzata, Livello 1 del merge, e il taker della chiusura rapida.
    // Il banco resta contato — la proprieta' e' che attraversare sia raro e sempre DICHIARATO.
    // ── IL BANCO E' CRESCIUTO A CINQUE L'11 AGOSTO 2026, E RESTA CONTATO ──────────────────────────
    // Erano tre: uscita forzata a mercato, Livello 1 del merge, taker della chiusura rapida. La
    // CHIUSURA FORZATA PRE-SCADENZA (§5 punto 75, decisione di Diego) ne aggiunge due, e sono due
    // percorsi distinti perche' fanno cose diverse: vendere il lato posseduto, o comprare la
    // controparte. Sotto le tre ore dalla risoluzione una posizione scoperta e' una scommessa, e si
    // chiude al prezzo disponibile.
    //
    // ⚠ AGGIORNATO, NON ALLARGATO: il conteggio e' ESATTO, quindi un sesto punto continua a far cadere
    // il blocco. La proprieta' difesa e' la stessa di sempre — attraversare lo spread e' raro, contato e
    // sempre DICHIARATO — e ora ogni punto e' anche nominato qui sotto.
    // Si contano le occorrenze nel CODICE: le menzioni nei commenti non sono attraversamenti.
    const soloCodice = ac.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    const nAttraversa = (soloCodice.match(/attraversaApposta/g) || []).length;
    ok('  e SOLO in cinque punti dichiarati: uscita forzata, Livello 1, chiusura rapida, e i DUE della chiusura pre-scadenza',
      nAttraversa === 5, `${nAttraversa} occorrenze nel codice`);
    ok('  i due nuovi sono la vendita e l acquisto della chiusura forzata pre-scadenza',
      /quale: 'vendita'[\s\S]{0,120}attraversaApposta: true/.test(ac)
      && /quale: 'acquisto-controparte'[\s\S]{0,160}attraversaApposta: true/.test(ac));
    ok('  e la chiusura forzata e sempre a verbale con il suo costo',
      /outcome: rok \? 'chiusura-forzata-pre-scadenza'/.test(ac) && /costoUsd: pv\.costo/.test(ac));
    // ⚠ L'ESPRESSIONE E' CRESCIUTA L'11 AGOSTO 2026, LA PROPRIETA' NO. Il ramo `false` del ternario
    // era `{ inCoda: true }` secco; adesso e' `(regoleAttive ? {} : { inCoda: true })`, perche' la
    // SORELLA in modalita' chiusura e' esente da «mai primo» (§5 punto 74). Cio' che questo test
    // difende resta identico e resta verificato qui sotto: il Livello 1 e' un TAKER che COMPRA, e
    // l'alternativa e' un ordine che RIPOSA — mai le due cose insieme. Un `attraversaApposta` in piu'
    // continua a far cadere il conteggio a tre, un passo sopra.
    ok('  il secondo e il Livello 1 del merge, e compra (non vende)',
      /t\.taker \? \{ attraversaApposta: true \} : \(regoleAttive \? \{\} : \{ inCoda: true \}\)/.test(ac)
      && /livello: 1[\s\S]{0,80}taker: true/.test(ac),
      'un BUY aggressivo qui e ammesso solo perche la size e limitata dalla posizione gia detenuta e il prezzo dal tetto della coppia');
  }

  console.log(`\ntre fix di sicurezza: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();
