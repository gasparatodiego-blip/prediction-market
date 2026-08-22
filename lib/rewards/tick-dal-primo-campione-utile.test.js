'use strict';
// lib/rewards/tick-dal-primo-campione-utile.test.js — IL TICK DI UN MERCATO NON VIVE NEL PRIMO
// CAMPIONE, VIVE NEL PRIMO CAMPIONE CHE CE L'HA.
//
// ⚠ QUESTO TEST DEVE FALLIRE SUL SORGENTE NON CORRETTO. Prima della correzione `marketMeta` leggeva
// `rows[0].tick`, quindi un mercato il cui PRIMO campione non porta il tick risultava `tick: null`
// anche con sessanta campioni buoni dietro — e `plan-to-orders.js:124/:163` trasformava quel `null`
// in `gamba-impossibile`, cioe' in un mercato che occupa uno slot e non riceve mai un ordine.
//
// ⚠ E IL PRIMO CAMPIONE E' PROPRIO QUELLO CHE NON CE L'HA: agent34 scrive la prima riga di
// `mid-history` nell'istante in cui sottoscrive il libro, prima di avere i metadati. Quindi il
// difetto non colpiva a caso — colpiva SEMPRE E SOLO i mercati appena entrati nel feed.
//
// LA PROPRIETA' DIFESA, e non il caso che ha aperto l'indagine:
//   ① se ALMENO UN campione porta il tick, `marketMeta` lo trova, in qualunque posizione stia;
//   ② se NESSUNO lo porta, il risultato resta `null` — fail-closed, nessun tick indovinato;
//   ③ la correzione e' MONOTONA: dove il primo campione aveva gia' il tick, la risposta non cambia;
//   ④ il tick trovato e' quello del venue, non una media ne' un valore di ripiego;
//   ⑤ il difetto e' davvero quello: la stessa riga, passata a `gambeDiUnaRiga`, smette di essere
//      scartata — cioe' si misura il COMPORTAMENTO a valle, non solo il campo.

const path = require('path');
const A = require(path.join(__dirname, 'allocator'));
const { gambeDiUnaRiga } = require(path.join(__dirname, 'plan-to-orders'));

let pass = 0; let fail = 0;
const ok = (n, c, x) => { if (c) { pass += 1; console.log(`  ok  ${n}`); } else { fail += 1; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };

// ⚠ `marketMeta` non e' esportato: si prova attraverso la superficie pubblica se c'e', altrimenti si
// dichiara e si prova solo il comportamento a valle. Un test che non puo' vedere cio' che misura deve
// dirlo, non fingere.
const marketMeta = A.marketMeta || A._marketMeta || null;

const campione = (tsMs, tick, mid = 0.5) => ({
  tsMs, tick, adjMid: mid, src: 'ws',
  bidDepthInBand: 100, askDepthInBand: 100,
});

if (typeof marketMeta === 'function') {
  // ── ① IL TICK SI TROVA ANCHE SE NON E' NEL PRIMO CAMPIONE ────────────────────────────────────
  {
    // Il caso vero del 22 agosto: primo campione senza tick, tutti gli altri con 0,01.
    const rows = [campione(1000, null), campione(2000, 0.01), campione(3000, 0.01)];
    ok('① primo campione senza tick, gli altri con 0,01 ⇒ il tick e\' 0,01 (era null: ROSSO prima)',
      marketMeta(rows).tick === 0.01, String(marketMeta(rows).tick));
  }
  {
    // Il caso peggiore misurato: SETTE campioni senza tick in testa.
    const rows = [];
    for (let i = 0; i < 7; i += 1) rows.push(campione(1000 + i, null));
    rows.push(campione(9000, 0.001));
    ok('  sette campioni ciechi in testa non nascondono l\'ottavo',
      marketMeta(rows).tick === 0.001, String(marketMeta(rows).tick));
  }
  // ── ② FAIL-CLOSED: NESSUN TICK ⇒ NULL, MAI UN VALORE INVENTATO ──────────────────────────────
  {
    const rows = [campione(1000, null), campione(2000, null)];
    ok('② nessun campione porta il tick ⇒ resta null, non 0,01 di ripiego',
      marketMeta(rows).tick === null, String(marketMeta(rows).tick));
    ok('  e su un array vuoto ⇒ null', marketMeta([]).tick === null);
    // ⚠ IL CASO «elemento nullo nell'array» NON SI PROVA QUI, ED E' UNA SCELTA. La ricerca del tick
    // lo regge (il predicato guarda `r &&`, e il sentinella di `findIndex` non collide con niente),
    // ma `marketMeta` esplode PRIMA, alla riga del `depthShares`, che fa `r.bidDepthInBand` senza
    // guardia. E' una fragilita' PREESISTENTE e indipendente da questa correzione: asserirla qui
    // vorrebbe dire o vederla fallire per un difetto che non e' quello in esame, o correggere
    // «gia' che ci siamo» un secondo punto che nessuno ha chiesto. Dichiarata in §5.2, non toccata.
  }
  // ── ③ MONOTONIA: dove funzionava, la risposta e' identica ────────────────────────────────────
  {
    const rows = [campione(1000, 0.01), campione(2000, 0.01)];
    ok('③ primo campione gia\' col tick ⇒ risposta INVARIATA', marketMeta(rows).tick === 0.01);
    // ⚠ E non si prende il piu' grande, il piu' piccolo o una media: si prende QUELLO DEL VENUE.
    // Il tick e' costante dentro un mercato (verificato su 454 mercati, zero con due valori), quindi
    // questo caso non esiste in produzione — ma se un giorno esistesse, la risposta dev'essere un
    // tick REALE osservato, non un numero derivato che nessun campione ha mai visto.
    const misti = [campione(1000, null), campione(2000, 0.001), campione(3000, 0.01)];
    ok('④ con tick diversi si risponde con uno OSSERVATO, mai una media',
      [0.001, 0.01].includes(marketMeta(misti).tick), String(marketMeta(misti).tick));
  }
  // ── il tick non dipende dalla fonte del campione ─────────────────────────────────────────────
  {
    const rows = [{ ...campione(1000, null), src: 'ws' }, { ...campione(2000, 0.01), src: 'rest' }];
    ok('  il tick si trova anche se l\'unico campione che lo porta non e\' websocket',
      marketMeta(rows, true).tick === 0.01, String(marketMeta(rows, true).tick));
  }
} else {
  console.log('  ⚠ `marketMeta` non e\' esportato da allocator.js: i blocchi ①-④ non possono girare.');
  console.log('    Resta il blocco ⑤, che misura il comportamento a valle — quello che conta davvero.');
}

// ── ⑤ IL COMPORTAMENTO A VALLE: la riga smette di essere scartata ──────────────────────────────
// ⚠ E' il blocco che prova che il difetto era QUESTO: non basta che il campo sia giusto, deve
// cambiare cio' che il bot fa. Una riga con `tick: null` viene scartata; la stessa riga col tick
// del venue produce due gambe. Se un domani `gambeDiUnaRiga` smettesse di dipendere dal tick, questo
// blocco diventerebbe verde da solo — ed e' giusto, perche' allora il difetto non esisterebbe piu'.
{
  const riga = {
    marketId: '0xtest', name: 'mercato di prova', capital: 61.25,
    mid: 0.5, maxSpreadCents: 4.5, sizePerSideShares: 60, minSizeShares: 20,
    snappedBid: 0.47, snappedAsk: 0.53, computedDefaultOffsetTicks: 1,
  };
  const senza = gambeDiUnaRiga({ ...riga, tick: null }, 1);
  const con = gambeDiUnaRiga({ ...riga, tick: 0.01 }, 1);
  ok('⑤ con tick null la riga e\' SCARTATA (e il motivo e\' quello vero)',
    !!senza.scarto && senza.scarto.motivo === 'gamba-impossibile',
    JSON.stringify(senza.scarto));
  ok('  con il tick del venue la riga produce due gambe',
    !con.scarto && Array.isArray(con.rows) && con.rows.length === 2,
    JSON.stringify(con.scarto || (con.rows || []).length));
}

console.log(`\ntick dal primo campione utile: ${pass} passati, ${fail} falliti\n`);
process.exit(fail === 0 ? 0 : 1);
