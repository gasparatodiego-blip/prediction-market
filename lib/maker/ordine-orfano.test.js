#!/usr/bin/env node
'use strict';
// lib/maker/ordine-orfano.test.js — LA GAMBA CHE NON HA PIÙ NIENTE CON CUI ACCOPPIARSI.
//
// ═══ IL GUASTO CHE QUESTO FILE DIFENDE ═══════════════════════════════════════════════════════════════
// Coppia normale: BUY YES @0,40 e BUY NO @0,60. La YES viene fillata, apre una posizione, e la posizione
// sparisce per una causa ESTERNA al ciclo (Diego la chiude a mano). La gamba NO resta sul libro.
//
// Fino al 9 agosto 2026 quell'ordine non veniva solo dimenticato: veniva **attivamente rinnovato** a ogni
// finestra GTD (23 minuti), tenuto dentro la banda premiante, e la Regola 4 lo teneva apposta perché «un
// lato solo matura comunque un terzo». `auto-close` non poteva accorgersene perché itera le POSIZIONI, e
// con zero posizioni il corpo del suo ciclo non gira nemmeno una volta.
//
// MISURATO IN PRODUZIONE: `0xd25c820d…` teneva 135,4 share, il giornale si interrompe alle 12:22:43 senza
// una riga di chiusura, e `data/merge-attese.json` portava ancora l'attesa di quel completamento
// (BUY 135,4 @ 0,45 = $60,93) nove ore dopo.
//
// ═══ COSA SI PROVA QUI ═══════════════════════════════════════════════════════════════════════════════
//   1 · il CASO SANO non viene toccato: due gambe a riposo e zero posizioni ⇒ si rinnova, sempre;
//   2 · il CASO ORFANO viene cancellato — ma solo alla CONFERMA, mai alla prima osservazione;
//   3 · la corsa del fill (gamba appena fillata, posizione non ancora pubblicata) NON produce una
//       cancellazione: è il falso positivo che costerebbe di più;
//   4 · ogni dato mancante vale RINNOVA, mai CANCELLA;
//   5 · il mercato torna in pianificazione per la STESSA strada del Lavoro B, non per una parallela.
//
// NESSUN ORDINE REALE: `cancelOrder` e `placeOrder` sono registratori, nessuna rete, nessun file.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const O = require('./ordine-orfano');
const { runAutoRepriceCycle } = require('./auto-reprice');

// Config e stato su file TEMPORANEI: questo test non deve nemmeno sfiorare la allowlist vera, che
// governa capitale reale. Stessa convenzione di `mid-stantio.test.js`.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orfano-'));
const CONFIG_FILE = path.join(TMP, 'cfg.json');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const MKT = '0x' + 'd2'.repeat(32);
const YES = 'tok-yes-135';
const NO = 'tok-no-135';

fs.writeFileSync(CONFIG_FILE, JSON.stringify({ global: { enabled: true }, markets: { [MKT]: { enabled: true } } }));

// ── UNO STATO PULITO PER OGNI GIRO, E NON E' UN DETTAGLIO ────────────────────────────────────────
// Il ciclo scrive `lastRepriceAt` per mercato, e il limite di frequenza (`minIntervalMs`) lo rilegge.
// Condividendo un solo file, il secondo giro del test si vedeva rifiutare tutto con `rate-limited` —
// cioe' il fixture misurava il limite di frequenza invece della regola in prova. Ogni giro parte da
// una memoria vuota, che e' anche la situazione vera: due rinnovi distinti sono a ~20 minuti l'uno
// dall'altro, ben oltre qualunque intervallo minimo.
let nStato = 0;
function configDepsPuliti() {
  const f = path.join(TMP, `state-${++nStato}.json`);
  fs.writeFileSync(f, JSON.stringify({ markets: {}, cycles: 0 }));
  return { configFile: CONFIG_FILE, autoStateFile: f, autoAuditFile: path.join(TMP, 'audit.jsonl') };
}

const REGOLE = {
  readable: true, title: 'mercato di prova', tick: 0.01, minSize: 20, maxSpreadCents: 4.5,
  negRisk: false, tokenId: YES, tokenIdNo: NO,
  // I due book sono fermi e centrati sui prezzi delle gambe: la YES riposa a 0,40 con un concorrente a
  // 0,41 davanti, la NO a 0,60 con un concorrente a 0,61. Cosi' nessuna gamba e' prima sul libro,
  // nessuna e' fuori banda, e NON c'e' nessuna ragione di muovere il prezzo — l'unico trigger che resta
  // e' il rinnovo di scadenza, che e' esattamente lo scenario da provare.
  mid: 0.42, midSource: 'live-book', midAgeSec: 1, feedAgeSec: 1,
  books: { yes: { scoringMid: 0.42, bestBid: 0.41, bestAsk: 0.44 }, no: { scoringMid: 0.62, bestBid: 0.61, bestAsk: 0.64 } },
  feedVitality: { assetsRecenti: 200, finestraSec: 30 },
};

// Un ordine a riposo con la scadenza DENTRO il margine di rinnovo: è l'istante in cui il controllo si
// esercita. 1380s di finestra, margine 180s ⇒ 120s di vita residua è «rinnovo dovuto».
const now = 3_000_000_000;
function ordine(tokenId, book, orderId, price) {
  // `source: 'manual-ui'` non e' decorativo: `selectOwnedOrders` accetta SOLO cio' che il pannello ha
  // provatamente piazzato (attribuzione positiva). Senza, l'ordine non e' nemmeno un candidato.
  // `secondsToExpiry` e' il campo su cui `decideReprice` calcola `expiring` (riga 259): 120s residui
  // contro un margine di 180 ⇒ il rinnovo e' DOVUTO, che e' l'istante in cui il controllo si esercita.
  return { orderId, tokenId, book, side: 'BUY', price, size: 121.2, source: 'manual-ui', marketId: MKT,
    secondsToExpiry: 120, orderType: 'GTD' };
}

function registro(iniziale = new Map()) {
  const m = new Map(iniziale);
  return { leggi: (k) => (m.has(k) ? m.get(k) : null), scrivi: (k, v) => m.set(k, v), pulisci: (k) => m.delete(k), _m: m };
}

/**
 * Un giro del ciclo di riprezzo con un book fermo e in banda: nessuna ragione di muovere il prezzo,
 * quindi l'UNICO trigger possibile è il rinnovo di scadenza. È lo scenario in cui il controllo vive.
 */
async function giro({ ordini, posizioni, reg = registro(), posizioniOk = true }) {
  const cancellati = [];
  const piazzati = [];
  const deps = {
    now: () => now,
    configDeps: configDepsPuliti(),
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    resolveRules: () => REGOLE,
    listOrders: async () => ({ ok: true, simulated: false, orders: ordini }),
    readPositions: async () => (posizioniOk ? { ok: true, positions: posizioni } : { ok: false, reason: 'venue muto' }),
    registroOrfani: reg,
    cancelOrder: async (spec) => { cancellati.push(spec); return { ok: true }; },
    replaceOrder: async (spec) => { piazzati.push(spec); return { ok: true, orderId: 'nuovo-' + piazzati.length }; },
    placeOrder: async (spec) => { piazzati.push(spec); return { ok: true, orderId: 'nuovo-' + piazzati.length }; },
    audit: () => {},
  };
  const res = await runAutoRepriceCycle(deps);
  return { res, cancellati, piazzati, reg,
    azioni: (res.actions || []).filter((a) => String(a.marketId) === MKT) };
}

(async () => {

  console.log('\n══ 1 · IL VERDETTO PURO: L\'ASIMMETRIA È IL SEGNALE');
  {
    const s = O.selfcheck();
    ok('il selfcheck del modulo passa', s.fail === 0, `${s.pass} asserzioni`);

    const due = [{ tokenId: YES }, { tokenId: NO }];
    ok('due gambe + zero posizioni ⇒ SANO (coppia mai fillata)',
      O.verdettoOrfano({ ordiniARiposo: due, posizioni: [], tokenId: YES, tokenIdNo: NO, now }).verdetto === O.SANO);
    ok('una gamba + posizione presente ⇒ SANO (se ne occupa auto-close)',
      O.verdettoOrfano({ ordiniARiposo: [{ tokenId: NO }], posizioni: [{ tokenId: YES, size: 135.4 }], tokenId: YES, tokenIdNo: NO, now }).verdetto === O.SANO);
    ok('una gamba + zero posizioni ⇒ non è SANO', (() => {
      const v = O.verdettoOrfano({ ordiniARiposo: [{ tokenId: NO }], posizioni: [], tokenId: YES, tokenIdNo: NO, now });
      return v.verdetto === O.DA_CONFERMARE;
    })());
  }

  console.log('\n══ 2 · IL CASO SANO NON VIENE TOCCATO — la coppia a riposo si rinnova');
  {
    const g = await giro({
      ordini: [ordine(YES, 'yes', 'ord-yes', 0.40), ordine(NO, 'no', 'ord-no', 0.60)],
      posizioni: [],
    });
    ok('nessuna cancellazione', g.cancellati.length === 0, `${g.cancellati.length} cancellazioni`);
    // Per un riprezzo il motivo viaggia in `trigger` (auto-reprice.js:1841), non in `gate`.
    const rinnovi = g.azioni.filter((a) => a.action === 'reprice' && a.trigger === 'expiry-refresh');
    ok('entrambe le gambe vengono RINNOVATE', rinnovi.length === 2,
      g.azioni.map((a) => `${a.action}/${a.trigger || a.gate}`).join(' · '));
    ok('  e nessuna azione è una cancellazione', !g.azioni.some((a) => a.action === 'cancel'));
    ok('  il registro dell\'allarme resta VUOTO: non c\'è niente da confermare', g.reg._m.size === 0);
    ok('  e la coda dei mercati da ripianificare è vuota', (g.res.daRipianificare || []).length === 0);
  }

  console.log('\n══ 3 · IL CASO ORFANO — prima si ARMA, poi si cancella');
  {
    // Prima osservazione: una gamba sola, zero posizioni. NON deve cancellare.
    const g1 = await giro({ ordini: [ordine(NO, 'no', 'ord-no', 0.60)], posizioni: [] });
    ok('prima osservazione: NESSUNA cancellazione', g1.cancellati.length === 0);
    ok('  la gamba viene rinnovata come sempre',
      g1.azioni.some((a) => a.action === 'reprice' && a.trigger === 'expiry-refresh'),
      g1.azioni.map((a) => `${a.action}/${a.trigger || a.gate}`).join(' · '));
    ok('  ma l\'allarme è ARMATO', g1.reg._m.get(MKT) === now, String(g1.reg._m.get(MKT)));

    // Seconda osservazione, oltre la conferma: adesso si cancella.
    const reg2 = registro(new Map([[MKT, now - 61_000]]));
    const g2 = await giro({ ordini: [ordine(NO, 'no', 'ord-no', 0.60)], posizioni: [], reg: reg2 });
    ok('seconda osservazione oltre i 60s: l\'ordine viene CANCELLATO', g2.cancellati.length === 1,
      JSON.stringify(g2.cancellati[0] || null));
    ok('  ed è proprio la gamba orfana', g2.cancellati[0] && g2.cancellati[0].orderId === 'ord-no');
    ok('  con il gate che dice perché', g2.azioni.some((a) => a.gate === 'posizione-sparita'),
      g2.azioni.map((a) => `${a.action}/${a.gate}`).join(' · '));
    ok('  NON viene ripiazzato niente da questo ciclo', g2.piazzati.length === 0);
    const c = (g2.res.cancellazioni || [])[0];
    ok('  il referto visibile usa il motivo dichiarato `gamba-orfana-scaduta`',
      c && c.motivo === 'gamba-orfana-scaduta', c && c.motivo);
    ok('  e il mercato entra nella coda da ripianificare', (g2.res.daRipianificare || []).length === 1,
      JSON.stringify(g2.res.daRipianificare));
    ok('  l\'allarme viene azzerato dopo aver agito', reg2._m.size === 0);
  }

  console.log('\n══ 4 · LA CORSA DEL FILL NON PRODUCE UNA CANCELLAZIONE');
  {
    // La gamba YES è stata appena fillata: non è più a riposo (1 gamba), e la posizione ESISTE.
    // È il caso che il Lavoro B gestisce, e questo controllo deve starne fuori.
    const reg = registro(new Map([[MKT, now - 999_999]]));   // perfino con l'allarme già armato da tempo
    const g = await giro({
      ordini: [ordine(NO, 'no', 'ord-no', 0.60)],
      posizioni: [{ tokenId: YES, size: 135.4, avgPrice: 0.40 }],
      reg,
    });
    ok('posizione presente ⇒ nessuna cancellazione, nemmeno con l\'allarme armato', g.cancellati.length === 0);
    ok('  la gamba superstite viene rinnovata',
      g.azioni.some((a) => a.action === 'reprice' && a.trigger === 'expiry-refresh'),
      g.azioni.map((a) => `${a.action}/${a.trigger || a.gate}`).join(' · '));
    ok('  e l\'allarme viene DISARMATO dalla posizione ricomparsa', reg._m.size === 0);
  }

  console.log('\n══ 5 · OGNI DATO CHE MANCA VALE RINNOVA, MAI CANCELLA');
  {
    const g1 = await giro({ ordini: [ordine(NO, 'no', 'ord-no', 0.60)], posizioni: [],
      reg: registro(new Map([[MKT, now - 61_000]])), posizioniOk: false });
    ok('posizioni illeggibili ⇒ si rinnova, non si cancella', g1.cancellati.length === 0,
      g1.azioni.map((a) => `${a.action}/${a.gate}`).join(' · '));

    // Senza il lettore iniettato il comportamento è IDENTICO a quello di prima del lavoro.
    const cancellati = [];
    const res = await runAutoRepriceCycle({
      now: () => now,
      configDeps: configDepsPuliti(),
      killStatus: () => ({ effectivelyKilled: false, readable: true }),
      resolveRules: () => REGOLE,
      listOrders: async () => ({ ok: true, simulated: false, orders: [ordine(NO, 'no', 'ord-no', 0.60)] }),
      cancelOrder: async (s) => { cancellati.push(s); return { ok: true }; },
      replaceOrder: async () => ({ ok: true, orderId: 'x' }),
      audit: () => {},
    });
    ok('senza `readPositions` iniettato il comportamento è quello di PRIMA', cancellati.length === 0
      && (res.daRipianificare || []).length === 0);
  }

  console.log('\n══ 6 · IL MERCATO RIENTRA DALLA STRADA DEL LAVORO B, NON DA UNA PARALLELA');
  {
    const ac = fs.readFileSync(path.join(__dirname, 'auto-close.js'), 'utf8');
    ok('auto-close accetta la coda dei mercati orfani', /deps\.mercatiDaRipianificare/.test(ac));
    ok('  e li mette nella STESSA lista `riposizionamenti` del merge riuscito',
      /riposizionamenti\.push\(\{\s*marketId: mid[\s\S]{0,120}causa: 'gamba orfana cancellata'/.test(ac));
    ok('  quindi eredita `capitalePerRiposizionamento` senza riscriverlo',
      /capitalePerRiposizionamento\(\{/.test(ac) && (ac.match(/function capitalePerRiposizionamento/g) || []).length === 0);
    ok('  e non si accodano DUE riposizionamenti sullo stesso mercato',
      /riposizionamenti\.some\(\(r\) => String\(r\.marketId\) === mid\)/.test(ac));

    const ar = fs.readFileSync(path.join(__dirname, 'auto-reprice.js'), 'utf8');
    ok('il ciclo di riprezzo NON piazza nulla per l\'orfano: cancella e dichiara',
      !/daRipianificare\.push[\s\S]{0,400}placeOrder/.test(ar));
    ok('  e il controllo scatta SOLO sul rinnovo di scadenza, non su un inseguimento del mid',
      /d\.action === 'reprice' && d\.gate === 'expiry-refresh' && typeof deps\.readPositions === 'function'/.test(ar));

    const a40 = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent40-manual-reprice.js'), 'utf8');
    ok('agent40 riusa `leggiPosizioniVenue`, la stessa lettura della chiusura automatica',
      /readPositions: async \(\) => \{[\s\S]{0,200}leggiPosizioniVenue\(\)/.test(a40));
    ok('  e la coda viene DRENATA alla lettura (nessun riposizionamento ripetuto)',
      /daRipianificareCoda\.clear\(\)/.test(a40));
    ok('  il registro dell\'allarme sta in memoria, non su disco', /const registroOrfani = \(\(\) => \{[\s\S]{0,200}new Map\(\)/.test(a40));
  }

  console.log('\n══ 6-bis · E IL RIENTRO IN PIANIFICAZIONE AVVIENE DAVVERO (ciclo di chiusura VERO)');
  {
    // Non basta che la coda esista: va provato che `runAutoCloseCycle` la consumi e produca un
    // riposizionamento con il tetto in vigore. E' anche la prova che la convenzione di `resolveRules`
    // e' quella giusta — la prima stesura passava `{marketId}` invece del valore posizionale, e il
    // riposizionamento sarebbe fallito in silenzio con «regole non leggibili».
    const { runAutoCloseCycle } = require('./auto-close');
    const piazzati = [];
    const res = await runAutoCloseCycle({
      now: () => now,
      marketIds: [],                          // NESSUNA posizione da gestire: e' il caso dell'orfano
      killStatus: () => ({ effectivelyKilled: false, readable: true }),
      isEnabled: () => ({ enabled: true }),
      isManual: () => ({ manual: true, readable: true }),
      resolveRules: (marketId) => (String(marketId) === MKT ? REGOLE : { readable: false }),
      readVenue: async () => ({ readable: true, closed: false, acceptingOrders: true }),
      readPositions: async () => ({ ok: true, positions: [] }),
      listOrders: async () => ({ ok: true, orders: [] }),
      placeOrder: async (spec) => { piazzati.push(spec); return { ok: true, sent: true, orderId: 'r' + piazzati.length }; },
      cancelOrder: async () => ({ ok: true }),
      mercatiDaRipianificare: () => ([{ marketId: MKT, motivo: 'orfano-alla-scadenza' }]),
      tettoMercato: () => ({ readable: true, capUsd: 130, stale: false, ageSec: 5 }),
      capitaleLibero: () => 500,
      audit: () => {},
    });
    const rip = (res.actions || []).find((a) => a.action === 'riposizionamento-dopo-chiusura');
    ok('il mercato orfano produce un riposizionamento', !!rip && rip.ok === true, rip && rip.reason);
    ok('  con la causa dichiarata', rip && rip.causa === 'gamba orfana cancellata', rip && rip.causa);
    ok('  al tetto in vigore ($130), non a una cifra inventata', rip && rip.capitaleUsd === 130,
      String(rip && rip.capitaleUsd));
    ok('  e due gambe tornano sul libro', piazzati.length === 2,
      piazzati.map((p) => `${p.book} ${p.size}@${p.price}`).join(' · '));
    ok('  entrambe con `inCoda`: «mai primo sul libro» resta attivo qui',
      piazzati.length === 2 && piazzati.every((p) => p.inCoda === true));
  }

  console.log('\n══ 7 · NESSUN CONFLITTO CON IL LAVORO B — sono due momenti diversi');
  {
    // Lavoro B agisce SUL FILL, quando la posizione ESISTE. Questo agisce al rinnovo GTD, quando la
    // posizione NON esiste. Le due condizioni sono mutuamente esclusive per costruzione, e la sezione 4
    // lo prova sul ciclo vero. Qui si verifica che non condividano stato né percorso di piazzamento.
    const rf = fs.readFileSync(path.join(__dirname, 'risposta-al-fill.js'), 'utf8');
    ok('risposta-al-fill NON conosce l\'ordine orfano', !/ordine-orfano/.test(rf));
    const oo = fs.readFileSync(path.join(__dirname, 'ordine-orfano.js'), 'utf8');
    ok('ordine-orfano NON conosce risposta-al-fill', !/risposta-al-fill/.test(oo));
    ok('  ed è PURO: nessuna rete, nessun disco, nessun orologio proprio',
      !/require\('\.\/(manual-order|live-providers|ctf-relayer)'\)/.test(oo)
      && !/readFileSync|writeFileSync|fetch\(/.test(oo)
      && !/Date\.now\(\)\s*\)/.test(oo.replace(/now = Date\.now\(\)/g, '')));
    ok('le due condizioni sono mutuamente esclusive: posizione presente ⇒ mai orfano',
      O.verdettoOrfano({ ordiniARiposo: [{ tokenId: NO }], posizioni: [{ tokenId: YES, size: 1 }],
        tokenId: YES, tokenIdNo: NO, armatoDa: 0, now }).verdetto === O.SANO);
  }

  console.log(`\nordine orfano: ${pass} passati, ${fail} falliti\n`);
  assert.strictEqual(fail, 0, `${fail} asserzioni fallite`);
})();
