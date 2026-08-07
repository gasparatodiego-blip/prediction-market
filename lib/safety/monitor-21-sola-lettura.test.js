#!/usr/bin/env node
'use strict';
// IL MONITOR DEI 21 NON PUÒ PIAZZARE — dimostrato camminando l'albero dei `require`.
//
// ═══ PERCHÉ NON BASTA DIRLO ═════════════════════════════════════════════════════════════════════════
// «È di sola lettura» è una promessa che invecchia: basta un `require` in più, fatto per un motivo
// legittimo, perché diventi falsa senza che nessuno se ne accorga. Questo test la verifica come si
// verifica per il guardiano delle perdite — aprendo ogni file raggiungibile dal monitor e cercando la
// superficie che piazza o cancella.
//
// Il monitor importa `market-clock`, ed è deliberato: è il lettore condiviso della data di chiusura a
// tre fonti, e riscriverne una copia sarebbe la seconda risoluzione dello stesso fatto che questo repo
// combatte. La promessa quindi non è «non importa niente da lib/maker/», che sarebbe una regola
// arbitraria: è «da qui non si arriva a un ordine», che è la cosa che conta.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ROOT = path.resolve(__dirname, '..', '..');
const MONITOR = path.join(ROOT, 'scripts', 'monitor-reti-dei-21.js');
const { soloCodice } = require(path.join(ROOT, 'scripts', 'percorsi-dati.js'));

// La superficie proibita: piazzare, firmare, cancellare. (Cancellare non è pericoloso, ma un monitor
// non deve poterlo fare comunque: il suo mestiere è guardare.)
const PROIBITE = [
  'postOrder', 'placeManualOrder', 'replaceManualOrder', 'runBulkAllocation', 'createOrder',
  'signTypedData', 'cancelManualOrder', 'cancelOrder', 'cancelMarketOrders', 'createMakerAdapter',
  'createCancelOnlyAdapter', 'PRIVATE_KEY', 'MAKER_FUNDER',
];

/** Ogni file raggiungibile dal monitor, seguendo i require relativi. */
function albero(file, visti = new Set(), prof = 0) {
  if (prof > 8 || visti.has(file)) return visti;
  visti.add(file);
  let src;
  try { src = soloCodice(fs.readFileSync(file, 'utf8')); } catch { return visti; }
  for (const m of src.matchAll(/require\(\s*(?:path\.join\([^)]*\)|['"]([^'"]+)['"])\s*\)/g)) {
    const r = m[1];
    if (!r) continue;                                   // require con path.join: risolto sotto
    if (!r.startsWith('.') && !r.startsWith('/')) continue;   // node_modules e builtin fuori
    const base = path.resolve(path.dirname(file), r);
    for (const c of [base, base + '.js', path.join(base, 'index.js')]) {
      try { if (fs.statSync(c).isFile()) { albero(c, visti, prof + 1); break; } } catch { /* avanti */ }
    }
  }
  // Il monitor risolve `market-clock` con path.join sulla radice: lo si segue esplicitamente, invece di
  // fingere che non ci sia. Un test che non vede un import non dimostra niente su quell'import.
  for (const m of src.matchAll(/path\.join\(RADICE,\s*'([^']+)',\s*'([^']+)',\s*'([^']+)'\)/g)) {
    const c = path.join(ROOT, m[1], m[2], m[3]);
    try { if (fs.statSync(c).isFile()) albero(c, visti, prof + 1); } catch { /* avanti */ }
  }
  return visti;
}

console.log('\n══ 1 · IL MONITOR GIRA E RISPONDE');
{
  const { componi, CONSENSUS } = require(MONITOR);
  const s = componi(Date.parse('2026-08-07T23:00:00Z'));
  ok('produce un referto', s && typeof s.at === 'string' && s.totali);
  ok('  con i totali coerenti', s.totali.esaminati === s.totali.coerenti + s.totali.scartati,
    `${s.totali.esaminati} = ${s.totali.coerenti} + ${s.totali.scartati}`);
  ok('  e dichiara quali fonti ha letto', s.fonti && typeof s.fonti.board === 'string', JSON.stringify(s.fonti));
  ok('il consensus è quello misurato sui 21',
    CONSENSUS.scadenzaGiorniMediana === 0.44 && CONSENSUS.nozionaleMediana === 34
    && CONSENSUS.sizeMediana === 77 && CONSENSUS.redeemPct === 94,
    'mediana 0,44g · $34 · 77 share · redeem 94%');
  ok('  e NON filtra sul montepremi', s.coerenti.every((r) => typeof r.notaMontepremi === 'string'),
    'il campione dice che la banda non e un criterio: si riporta, non si scarta');
  ok('uno scartato porta sempre il suo motivo',
    s.scartati.every((r) => Array.isArray(r.motivi) && r.motivi.length > 0));
}

console.log('\n══ 2 · UNA SCADENZA NON LETTA NON È UNA SCADENZA LONTANA (né vicina)');
{
  const { valuta } = require(MONITOR);
  const senzaData = valuta({ marketId: '0x' + '00'.repeat(32), title: 'ignoto', midpoint: 0.5, minSize: 50 }, null, Date.now());
  ok('mercato senza data ⇒ NON coerente', senzaData.coerente === false);
  ok('  e il motivo lo dice', /scadenza non leggibile/.test(senzaData.motivi.join(' ')), senzaData.motivi.join('; '));
  ok('  e `giorni` resta null, non zero', senzaData.giorni === null);
}

console.log('\n══ 3 · DA QUI NON SI ARRIVA A UN ORDINE');
{
  const files = albero(MONITOR);
  ok(`l'albero dei require è stato camminato (${files.size} file)`, files.size >= 2, [...files].map((f) => path.relative(ROOT, f)).join(', ').slice(0, 120));
  ok('  e comprende market-clock, che il monitor importa davvero',
    [...files].some((f) => /market-clock\.js$/.test(f)),
    'un test che non vede un import non dimostra niente su quell import');

  const colpevoli = [];
  for (const f of files) {
    let src;
    try { src = soloCodice(fs.readFileSync(f, 'utf8')); } catch { continue; }
    for (const p of PROIBITE) if (new RegExp(`\\b${p}\\b`).test(src)) colpevoli.push(`${path.relative(ROOT, f)} → ${p}`);
  }
  ok('nessun file raggiungibile nomina una superficie di piazzamento o cancellazione',
    colpevoli.length === 0, colpevoli.join(' · ') || `${PROIBITE.length} nomi cercati su ${files.size} file`);

  const src = soloCodice(fs.readFileSync(MONITOR, 'utf8'));
  ok('il monitor non scrive file', !/writeFileSync|appendFileSync|createWriteStream|rmSync|unlinkSync/.test(src));
  ok('  non apre connessioni', !/https?\.|net\.|WebSocket|fetch\(/.test(src));
  ok('  e legge soltanto', /readFileSync/.test(src));
}

console.log(`\nmonitor dei 21, sola lettura: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
