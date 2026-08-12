'use strict';
// lib/maker/chiusura-forzata-raggiungibile.test.js — LA REGOLA DELLE 3 ORE ESISTEVA E NON POTEVA SCATTARE.
//
// ═══ LA DIAGNOSI, MISURATA ═══════════════════════════════════════════════════════════════════════════
// `chiusuraForzataPreScadenza` esiste dall'11 agosto 2026 (`ORE_CHIUSURA_FORZATA = 3`) ed è cablata in
// `auto-close`. Ma aveva DUE cause che la rendevano irraggiungibile, e nessuna delle due era il numero:
//
//   ① IL POSTO NEL FILE. Il verdetto si calcolava DOPO la guardia `livello !== 1 && !== 2`, che esce
//      subito. Il livello 3 — «il tempo da maker è finito» — è l'esito PIÙ COMUNE: **1.119 occorrenze**
//      di `merge-livello-3` sui due giornali maker. Su tutte quelle la regola non veniva nemmeno
//      valutata. E `manca` veniva LETTO da `mancaAllaCoppia`, che al livello 3 non è scritto ⇒ `null`
//      ⇒ `forza:false` anche a scadenza vicina.
//
//   ② LA FONTE DELLA SCADENZA. `scadenzaMercato` leggeva SOLO il board, che tiene i primi 150 mercati
//      per montepremi. Un mercato che ne esce — per rotazione, o perché si sta avvicinando alla
//      risoluzione, che è proprio il caso — dava `null`, e una scadenza `null` vale `forza:false`.
//      Misurato: **81 mercati su 82 del catalogo sono fuori dal board**, e per 40 di essi la scadenza
//      era illeggibile e ora si legge.
//
// ⚠ «MAI SCATTATA NEGLI AUDIT» È VERO MA NON DIMOSTRA NULLA DA SOLO: zero occorrenze di
// `chiusura-forzata-pre-scadenza` su entrambi i giornali — però il codice è del tardo 11 agosto e il bot
// è FERMO+KILL dal 10, quindi non ha avuto occasione. Le due cause sopra sono dimostrate dal codice e
// dai conteggi, non dall'assenza di righe.

const fs = require('fs');
const path = require('path');
const MC = require('./modalita-chiusura');

let passati = 0; let falliti = 0;
function ok(nome, cond, extra) {
  if (cond) { passati += 1; console.log(`  ✓ ${nome}${extra ? ` — ${extra}` : ''}`); }
  else { falliti += 1; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
}

console.log('── 1 · LA REGOLA IN SÉ NON È CAMBIATA');
{
  const ORA = 1_800_000_000_000;
  const h = (n) => ORA + n * 3_600_000;
  ok('3 ore è la soglia', MC.ORE_CHIUSURA_FORZATA === 3);
  ok('a 4 ore non si forza', MC.chiusuraForzataPreScadenza({ scadenzaMs: h(4), manca: 40, ora: ORA }).forza === false);
  ok('a 2 ore si forza', MC.chiusuraForzataPreScadenza({ scadenzaMs: h(2), manca: 40, ora: ORA }).forza === true);
  ok('a 3 ore esatte si forza (confine inclusivo)', MC.chiusuraForzataPreScadenza({ scadenzaMs: h(3), manca: 40, ora: ORA }).forza === true);
  // ⚠ LA COPPIA COMPLETA NON SI FORZA, ed è deliberato e giusto: alla risoluzione vale $1 qualunque
  // sia l'esito, quindi venderla sarebbe una perdita gratuita. Non è una lacuna della regola.
  ok('coppia completa (`manca <= 0`) ⇒ NON si forza', MC.chiusuraForzataPreScadenza({ scadenzaMs: h(2), manca: 0, ora: ORA }).forza === false);
  ok('scadenza non leggibile ⇒ NON si forza (non si vende su un\'ipotesi)',
    MC.chiusuraForzataPreScadenza({ scadenzaMs: null, manca: 40, ora: ORA }).forza === false);
}

console.log('\n── 2 · CAUSA ①: IL VERDETTO SI CALCOLA PRIMA DELLA GUARDIA DI LIVELLO');
{
  const src = fs.readFileSync(path.join(__dirname, 'auto-close.js'), 'utf8');
  const iForza = src.indexOf('const forza = MC.chiusuraForzataPreScadenza(');
  const iGuardia = src.indexOf("if (!forza.forza && (!liv || (liv.livello !== 1 && liv.livello !== 2)))");
  ok('la guardia esiste ancora, ma è condizionata', iGuardia > 0);
  ok('IL VERDETTO VIENE PRIMA DELLA GUARDIA', iForza > 0 && iForza < iGuardia, `forza@${iForza} guardia@${iGuardia}`);
  ok('  quindi il livello 3 non salta più la regola', /!forza\.forza &&/.test(src));
  ok('il verdetto si calcola UNA volta sola', (src.match(/MC\.chiusuraForzataPreScadenza\(/g) || []).length === 1);

  // `manca` DERIVATO invece che letto.
  ok('`manca` si deriva da sizePosseduta − sizeAltroLato', src.includes('const mancaOra ='));
  ok('  con `mancaAllaCoppia` come prima scelta quando c\'è', src.includes('numeriLiv.mancaAllaCoppia'));
  ok('  e i due addendi esistono a OGNI livello',
    fs.readFileSync(path.join(__dirname, 'strategia-merge.js'), 'utf8')
      .includes('numeri: { book, altroLato: altro, sizePosseduta, prezzoCarico, sizeAltroLato }'));

  // Il registro delle attese non deve poter bloccare una chiusura a scadenza.
  ok('il fail-closed sul registro NON blocca una chiusura forzata', src.includes('if (!reg && !forza.forza)'));
  ok('  e la pulizia dell\'attesa tollera un registro assente', src.includes("liv.livello === 1 && reg)"));
}

console.log('\n── 3 · CAUSA ②: LA SCADENZA SI LEGGE DA BOARD ∪ CATALOGO DI RIPIEGO');
{
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent40-manual-reprice.js'), 'utf8');
  const i = src.indexOf('function scadenzaMercato(');
  const blocco = src.slice(i, i + 2600);
  ok('il board resta la PRIMA fonte (è la più fresca)', blocco.indexOf('BOARD_FILE') < blocco.indexOf('readMarketCatalog'));
  ok('e il catalogo di ripiego è la seconda', blocco.includes('readMarketCatalog()'));
  ok('  che è la fonte pensata per «fuori dal board ma con capitale dentro»', blocco.includes('CATALOGO DI RIPIEGO'));
  ok('nessuna delle due leggibile ⇒ `null`, e la chiusura forzata non scatta', /return null;\s*\n\}/.test(blocco));

  // ── LA MISURA SUI DATI VERI, non su una fixture ────────────────────────────────────────────────
  const { readMarketCatalog } = require('./market-catalog');
  const cat = readMarketCatalog();
  let board = new Set();
  try {
    const b = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'liquidity-rewards.json'), 'utf8'));
    (Array.isArray(b) ? b : (b.markets || [])).forEach((x) => {
      const id = String((x && (x.conditionId || x.marketId)) || '').toLowerCase(); if (id) board.add(id);
    });
  } catch { board = new Set(); }
  const chiavi = Object.keys((cat && cat.markets) || {});
  const fuori = chiavi.filter((k) => !board.has(k));
  const recuperati = fuori.filter((k) => Number.isFinite(Date.parse(cat.markets[k].endDate || '')));
  ok(`il catalogo copre mercati fuori dal board (${fuori.length} su ${chiavi.length})`, fuori.length > 0);
  ok(`  e per ${recuperati.length} di essi la scadenza ORA si legge, dove prima era null`, recuperati.length > 0);
}

console.log('\n── 4 · LA REGOLA DI COPERTURA, DICHIARATA DOVE VALE');
{
  // «board ∪ mercati con posizione, mai solo board» è già applicata in quattro punti. Questo è il
  // quinto: se un giorno qualcuno riporta `scadenzaMercato` al solo board, questo test lo dice.
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent40-manual-reprice.js'), 'utf8');
  const i = src.indexOf('function scadenzaMercato(');
  const j = src.indexOf('\n}', src.indexOf('return null;', i));
  const blocco = src.slice(i, j);
  ok('`scadenzaMercato` consulta DUE fonti, non una',
    (blocco.match(/readFileSync\(BOARD_FILE/g) || []).length === 1 && blocco.includes('readMarketCatalog'));
  ok('  e nomina la regola di copertura, così un riordino non la perde in silenzio',
    blocco.includes('REGOLA DI COPERTURA') || blocco.includes('board ∪ mercati con posizione'));
}

console.log(`\n${falliti === 0 ? '✅ TUTTI VERDI' : '❌ ROSSI'}: ${passati} passati, ${falliti} falliti`);
process.exit(falliti === 0 ? 0 : 1);
