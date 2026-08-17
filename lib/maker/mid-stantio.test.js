'use strict';
// lib/maker/mid-stantio.test.js — DOPO UN TIMEOUT DI CECITÀ L'ORDINE SI RITIRA.
//
// Il rifiuto `mid-stale` era giusto e senza fine: si ripeteva a ogni ciclo e il capitale restava
// esposto su un mercato che non vedevamo. Questo test copre le tre cose che il timeout deve garantire:
//   · sotto il timeout non cambia NIENTE rispetto a prima (il buco del feed si richiude da solo);
//   · sopra, gli ordini di quel mercato si cancellano — e cancellare è l'unica azione del percorso;
//   · l'orologio si azzera solo su una lettura buona, e una cancellazione fallita non lo azzera.
//
// ⚠ L'INTESTAZIONE DICEVA «VENTI SECONDI» e il difetto vale 120 s dal 16 agosto 2026: era un reperto
// D7, cioè un commento che descrive un comportamento inesistente. Adesso il testo non nomina nessun
// numero e il numero sta in UN punto solo, dentro il blocco 1 — vedi la nota lì.
//
// Run: node lib/maker/mid-stantio.test.js

const fs = require('fs');
const path = require('path');
const { decidiStantio, registroStantio, timeoutMs, eCieco, GATE_CIECHI, TIMEOUT_DEFAULT_MS } = require('./mid-stantio');
const { runAutoRepriceCycle } = require('./auto-reprice');

// Il ciclo prende i mercati abilitati e il proprio stato da DUE FILE, non da un parametro. Si puntano
// entrambi a file temporanei: il test usa i lettori VERI (non una loro imitazione) e non tocca — né
// legge — lo stato della macchina. È la stessa disciplina degli altri test di questo modulo.
const MERCATO_TEST = '0x' + 'cd'.repeat(32);
const TMP = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mid-stantio-'));
const CONFIG_FILE = path.join(TMP, 'maker-auto-reprice.json');
const STATE_FILE = path.join(TMP, 'maker-auto-reprice-state.json');
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ global: { enabled: true }, markets: { [MERCATO_TEST]: { enabled: true } } }));
fs.writeFileSync(STATE_FILE, JSON.stringify({ markets: {}, cycles: 0 }));
const CONFIG_DEPS = { configFile: CONFIG_FILE, autoStateFile: STATE_FILE, autoAuditFile: path.join(TMP, 'audit.jsonl') };

let pass = 0; let fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

console.log('\n1 · la decisione pura');
{
  const NOW = 1_000_000;
  // ⚠ IL VALORE SI ASSERISCE IN UN PUNTO SOLO, E TUTTO IL RESTO LO DERIVA (CLAUDE.md §5.3).
  // Fin qui questo blocco ripeteva `20_000` in otto punti: quando il 16 agosto la soglia e' passata a
  // 120 s — perche' a 20 s si cancellava cio' che `decideReprice` non era disposto a riprezzare prima
  // di 60 s — otto asserzioni sono diventate rosse insieme, tutte per lo stesso motivo, e nessuna di
  // loro difendeva una proprieta'. Adesso c'e' UNA riga che dice quanto vale la decisione, e i
  // confini si calcolano da `TIMEOUT_DEFAULT_MS`: cambiare il difetto domani rende rossa quella riga
  // sola, che e' esattamente l'avviso che serve.
  const DECISO_MS = 120_000;   // ← la decisione del 16 agosto 2026, l'unica costante scritta a mano qui
  ok(`il timeout di difetto è ${DECISO_MS / 1000} s`, TIMEOUT_DEFAULT_MS === DECISO_MS,
    `letto ${TIMEOUT_DEFAULT_MS}`);

  // ⚠ IL CLAMP HA IL SUO ESTREMO ALTO SUL DIFETTO, e va detto o l'asserzione sembra piu' forte di
  // quello che e': un valore SOPRA 120 s ricade sul difetto, che vale anch'esso 120 s — i due numeri
  // coincidono per costruzione. Il caso che discrimina davvero e' quello SOTTO il minimo.
  ok('un env fuori scala viene scartato',
    timeoutMs({ MAKER_MID_STANTIO_TIMEOUT_MS: '1' }) === TIMEOUT_DEFAULT_MS
    && timeoutMs({ MAKER_MID_STANTIO_TIMEOUT_MS: String(TIMEOUT_DEFAULT_MS * 10) }) === TIMEOUT_DEFAULT_MS
    && timeoutMs({ MAKER_MID_STANTIO_TIMEOUT_MS: 'boh' }) === TIMEOUT_DEFAULT_MS);
  ok('  ma un valore sensato passa', timeoutMs({ MAKER_MID_STANTIO_TIMEOUT_MS: '30000' }) === 30_000);

  ok('mid buono ⇒ niente', decidiStantio({ stantio: false, now: NOW }).azione === 'niente');
  const primo = decidiStantio({ stantio: true, daMs: null, now: NOW });
  ok('primo ciclo cieco ⇒ attendi, cecità 0', primo.azione === 'attendi' && primo.cecitaMs === 0);
  const meta = Math.floor(TIMEOUT_DEFAULT_MS / 2);
  const aMeta = decidiStantio({ stantio: true, daMs: NOW - meta, now: NOW });
  ok(`a metà timeout (${meta / 1000} s) ⇒ attendi ancora`,
    aMeta.azione === 'attendi' && aMeta.restaMs === TIMEOUT_DEFAULT_MS - meta, `restano ${aMeta.restaMs}ms`);
  const aQuasi = decidiStantio({ stantio: true, daMs: NOW - (TIMEOUT_DEFAULT_MS - 1), now: NOW });
  ok('un millisecondo prima ⇒ ancora attendi (il confine non si anticipa)', aQuasi.azione === 'attendi');
  const aPunto = decidiStantio({ stantio: true, daMs: NOW - TIMEOUT_DEFAULT_MS, now: NOW });
  ok('al timeout esatto ⇒ cancella', aPunto.azione === 'cancella', aPunto.motivo.slice(0, 60));
  const aOltre = decidiStantio({ stantio: true, daMs: NOW - TIMEOUT_DEFAULT_MS * 3, now: NOW });
  ok('al triplo del timeout ⇒ cancella (non esplode né si ferma)', aOltre.azione === 'cancella');
}

console.log('\n2 · i tre modi di essere ciechi contano insieme');
{
  for (const g of GATE_CIECHI) ok(`«${g}» è cecità`, eCieco(g) === true);
  for (const g of ['out-of-band', 'refresh-invalid', 'rate-limited', '', null]) ok(`«${g}» NON è cecità`, eCieco(g) === false);
}

console.log('\n3 · il registro');
{
  const r = registroStantio();
  ok('un mercato mai visto non ha orologio', r.da('m1') === null);
  ok('segna restituisce l\'istante del PRIMO ciclo cieco', r.segna('m1', 100) === 100 && r.segna('m1', 500) === 100);
  ok('  e il registro lo conserva', r.da('m1') === 100);
  ok('azzera restituisce quanto era durata', r.azzera('m1') === 100 && r.da('m1') === null);
  ok('azzerare due volte non esplode', r.azzera('m1') === null);
}

// ── IL CICLO VERO, con ogni effetto iniettato ─────────────────────────────────────────────────────
const MERCATO = MERCATO_TEST;
// `selectOwnedOrders` considera solo gli ordini con `source: 'manual-ui'` — è la corsia del pannello,
// cioè quella che questo watcher sorveglia. Un ordine con un'altra origine non entra nel ciclo.
const ORDINE = { orderId: 'o1', marketId: MERCATO, book: 'yes', side: 'BUY', price: 0.5, size: 40, sizeRemaining: 40, createdMs: 0, source: 'manual-ui', orderType: 'GTD', secondsToExpiry: 1200,
  // Il book si risolve confrontando il token con i due del mercato: senza, l'ordine non è attribuibile.
  tokenId: '1' };

/** `midAgeSec` alto ⇒ il gate mid-stale scatta; basso ⇒ il mercato torna visibile. */
async function ciclo({ etaMid, registro, now, cancellatore = async () => ({ ok: true }) }) {
  const cancellati = []; const piazzati = [];
  const res = await runAutoRepriceCycle({
    now: () => now,
    configDeps: CONFIG_DEPS,
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    listOrders: async () => ({ ok: true, orders: [ORDINE] }),
    resolveRules: () => ({
      readable: true, title: 'prova', tick: 0.01, minSize: 5, maxSpreadCents: 4.5,
      mid: 0.5, midSource: 'live-book', midAgeSec: etaMid, feedAgeSec: etaMid,
      tokenId: '1', tokenIdNo: '2',
      books: { yes: { scoringMid: 0.5, bestBid: 0.49, bestAsk: 0.51 }, no: { scoringMid: 0.5, bestBid: 0.49, bestAsk: 0.51 } },
      feedVitality: { assetsRecenti: 200, finestraSec: 30 },
    }),
    readVenue: async () => ({ readable: true, closed: false, acceptingOrders: true }),
    replaceOrder: async (s) => { piazzati.push(s); return { ok: true, place: { orderId: 'n1', sent: true } }; },
    cancelOrder: async (s) => { cancellati.push(s); return cancellatore(s); },
    registroStantio: registro,
    audit: () => {},
  });
  return { res, cancellati, piazzati };
}

(async () => {
  console.log('\n4 · nel ciclo vero: sotto il timeout non cambia niente');
  {
    const reg = registroStantio();
    const T = 5_000_000;
    const a = await ciclo({ etaMid: 300, registro: reg, now: T });          // 300 s ⇒ ben oltre ogni limite
    ok('primo ciclo cieco ⇒ nessuna cancellazione', a.cancellati.length === 0);
    ok('  e nessun piazzamento', a.piazzati.length === 0);
    ok('  l\'orologio è partito', reg.da(MERCATO) === T);
    const b = await ciclo({ etaMid: 300, registro: reg, now: T + 10_000 });
    ok('  ben prima del timeout ⇒ ancora nessuna cancellazione', b.cancellati.length === 0);
    ok('  e il mercato dichiara l\'attesa', b.res.markets.some((m) => m.midStantio && m.midStantio.attesa === true));
  }

  console.log('\n5 · superato il timeout: si cancella');
  {
    const reg = registroStantio();
    const T = 6_000_000;
    await ciclo({ etaMid: 300, registro: reg, now: T });
    const c = await ciclo({ etaMid: 300, registro: reg, now: T + TIMEOUT_DEFAULT_MS });
    ok('al timeout ⇒ l\'ordine viene cancellato', c.cancellati.length === 1 && c.cancellati[0].orderId === 'o1');
    ok('  e NON viene piazzato niente al suo posto da qui', c.piazzati.length === 0,
      'chi rimette al lavoro il capitale è il trigger di agent41, con i suoi cancelli');
    ok('  il mercato porta il gate «mid-stantio»', c.res.markets.some((m) => m.gate === 'mid-stantio'));
    ok('  e l\'azione è tracciata', c.res.actions.some((x) => x.action === 'mid-stantio-cancel' && x.ok === true));
    ok('  l\'orologio si azzera dopo una cancellazione riuscita', reg.da(MERCATO) === null);
  }

  console.log('\n6 · una cancellazione FALLITA non azzera l\'orologio');
  {
    const reg = registroStantio();
    const T = 7_000_000;
    await ciclo({ etaMid: 300, registro: reg, now: T });
    const c = await ciclo({ etaMid: 300, registro: reg, now: T + TIMEOUT_DEFAULT_MS + 5_000, cancellatore: async () => ({ ok: false, reason: 'venue muto' }) });
    ok('la cancellazione è stata tentata', c.cancellati.length === 1);
    ok('  ma l\'orologio resta, così il giro dopo riprova subito', reg.da(MERCATO) === T,
      'azzerarlo farebbe ricominciare da capo un altro timeout intero di esposizione cieca');
    ok('  e l\'esito è dichiarato', c.res.actions.some((x) => x.action === 'mid-stantio-cancel' && x.ok === false));
  }

  console.log('\n7 · se il feed torna fresco, il ciclo riprende — e l\'orologio si azzera');
  {
    const reg = registroStantio();
    const T = 8_000_000;
    await ciclo({ etaMid: 300, registro: reg, now: T });
    ok('l\'orologio è partito', reg.da(MERCATO) === T);
    const b = await ciclo({ etaMid: 2, registro: reg, now: T + 10_000 });   // mid fresco
    ok('mid tornato fresco ⇒ orologio azzerato', reg.da(MERCATO) === null);
    ok('  nessuna cancellazione', b.cancellati.length === 0);
    ok('  e il mercato dichiara la risoluzione', b.res.markets.some((m) => m.midStantio && m.midStantio.risolto === true));
    // E se torna cieco DOPO, riparte da zero: non eredita i secondi di prima.
    const c = await ciclo({ etaMid: 300, registro: reg, now: T + TIMEOUT_DEFAULT_MS });
    ok('  una nuova cecità riparte da zero', reg.da(MERCATO) === T + TIMEOUT_DEFAULT_MS && c.cancellati.length === 0);
  }

  console.log('\n8 · il percorso conosce SOLO la cancellazione');
  {
    const src = fs.readFileSync(path.join(__dirname, 'mid-stantio.js'), 'utf8');
    for (const vietato of ['placeOrder', 'replaceOrder', 'placeManualOrder', 'runBulkAllocation', 'require(']) {
      ok(`mid-stantio non nomina «${vietato}»`, !src.includes(vietato));
    }
    const ac = fs.readFileSync(path.join(__dirname, 'auto-reprice.js'), 'utf8');
    const i = ac.indexOf('MID STANTIO: VENTI SECONDI');
    const j = ac.indexOf('REGOLA 4 · UN LATO SOLO', i);
    const blocco = ac.slice(i, j);
    ok('il ramo nel ciclo cancella e basta', /deps\.cancelOrder/.test(blocco) && !/replaceOrder|placeOrder/.test(blocco));
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passati, ${fail} falliti`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
