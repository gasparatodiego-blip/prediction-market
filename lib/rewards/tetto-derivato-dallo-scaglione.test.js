'use strict';
// lib/rewards/tetto-derivato-dallo-scaglione.test.js
//
// FISSA IL TETTO PER MERCATO E TUTTE LE SUE DERIVATE, così che una divergenza futura fallisca.
//
// Il 13 agosto 2026 il tetto è passato da $32,67 a $61,25 e la DERIVAZIONE si è invertita: prima
// `f_min` era l'ingresso e il tetto la conseguenza, adesso il tetto è il pavimento premiante dello
// scaglione che si vuole poter finanziare, e `f_min` è la conseguenza. Questo test difende
// l'inversione, non il numero: quello che non deve tornare possibile è che due moduli abbiano due
// tetti, o che una derivata resti indietro quando la leva si muove.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('./concentration');

let passati = 0, falliti = 0;
const ok = (n, c, extra) => {
  if (c) { passati += 1; console.log(`  ✓ ${n}`); }
  else { falliti += 1; console.log(`  ✗ ${n}${extra ? ' — ' + extra : ''}`); }
};

console.log('\n════ ① il tetto è DERIVATO dallo scaglione, non scelto ════');

ok('il tetto per mercato è il pavimento premiante dello scaglione finanziabile',
  C.MARKET_CAP_FIXED_USD === C.pavimentoPremiante(C.SCAGLIONE_FINANZIABILE),
  `$${C.MARKET_CAP_FIXED_USD} vs $${C.pavimentoPremiante(C.SCAGLIONE_FINANZIABILE)}`);
ok('  e TETTO_BASE_USD e MARKET_CAP_FIXED_USD sono lo stesso numero',
  C.TETTO_BASE_USD === C.MARKET_CAP_FIXED_USD);
ok('  lo scaglione scelto è finanziabile al capitale di riferimento',
  C.mercatoAmmissibile(C.CAPITALE_RIFERIMENTO_USD, C.SCAGLIONE_FINANZIABILE).ammissibile === true);
ok('  e quello IMMEDIATAMENTE successivo no: il tetto compra uno scalino, non tutti',
  C.mercatoAmmissibile(C.CAPITALE_RIFERIMENTO_USD, C.SCAGLIONE_FINANZIABILE * 2).ammissibile === false);

console.log('\n════ ② f_min è la CONSEGUENZA, e non può valere 1 ════');

// ⚠ È LA PREOCCUPAZIONE DELL'OPERATORE, ED È STRUTTURALE. `f_min` è la frazione di fill sotto la
// quale il residuo scoperto non è più piazzabile. Se un mercato venisse finanziato ESATTAMENTE al
// costo del suo minimo (`minSize × costoCoppia`), `f_min` varrebbe 1,0 e OGNI fill parziale
// lascerebbe un residuo murato per costruzione. Ciò che lo impedisce è `MARGINE_PAVIMENTO`: il
// pavimento di AMMISSIBILITÀ porta il 25% sopra il costo del minimo, quindi f_min si ferma a 1/1,25.
const fMinAlPavimento = (C.SCAGLIONE_FINANZIABILE * C.COSTO_COPPIA) / C.MARKET_CAP_FIXED_USD;
ok('f_min sullo scaglione appena sbloccato è < 1: il margine del pavimento è ciò che lo tiene giù',
  fMinAlPavimento < 1 - 1e-9, fMinAlPavimento.toFixed(3));
ok('  e vale esattamente 1/(1+MARGINE_PAVIMENTO), non un numero fortunato',
  Math.abs(fMinAlPavimento - 1 / (1 + C.MARGINE_PAVIMENTO)) < 1e-9,
  `${fMinAlPavimento.toFixed(4)} vs ${(1 / (1 + C.MARGINE_PAVIMENTO)).toFixed(4)}`);
ok('f_min sul minimo più comune migliora quando il tetto sale',
  (C.MIN_PREMIANTE_TIPICO * C.COSTO_COPPIA) / C.MARKET_CAP_FIXED_USD < 0.60,
  ((C.MIN_PREMIANTE_TIPICO * C.COSTO_COPPIA) / C.MARKET_CAP_FIXED_USD).toFixed(3));
ok('  ed è il numero che F_MIN_OBIETTIVO dichiara',
  Math.abs(C.F_MIN_OBIETTIVO - (C.MIN_PREMIANTE_TIPICO * C.COSTO_COPPIA) / C.MARKET_CAP_FIXED_USD) < 1e-4,
  String(C.F_MIN_OBIETTIVO));
ok('  e l\'identità tetto ⇄ f_min regge nei DUE versi',
  C.MARKET_CAP_FIXED_USD === +(C.MIN_PREMIANTE_TIPICO * C.COSTO_COPPIA / C.F_MIN_OBIETTIVO).toFixed(2));

// ⚠ IL BORDO CHE RESTA, DICHIARATO INVECE CHE NASCOSTO. `coerenza-soglie` può ridurre una riga fino
// al pavimento della RIGA (`minSize × costoCoppia`, senza il margine), e lì f_min vale 1,0 esatto.
// Sotto quel valore la riga viene SCARTATA, non finanziata: quindi 1,0 è un bordo raggiungibile ma
// non superabile, e chi legge deve saperlo.
const pavimentoRiga = C.SCAGLIONE_FINANZIABILE * C.COSTO_COPPIA;
ok('il pavimento della RIGA è il punto dove f_min tocca 1,0 — bordo raggiungibile, mai superabile',
  Math.abs((C.SCAGLIONE_FINANZIABILE * C.COSTO_COPPIA) / pavimentoRiga - 1) < 1e-9);
ok('  e sta sotto il pavimento di AMMISSIBILITÀ, che è quello con il margine',
  pavimentoRiga < C.pavimentoPremiante(C.SCAGLIONE_FINANZIABILE));

console.log('\n════ ③ le derivate seguono il tetto, e nessuno se le ricopia ════');

// ⚠ 15 AGOSTO 2026: la derivata è «la gamba più cara che il tetto per mercato consente», non «metà
// tetto». Metà è la gamba giusta solo a mid 0,49; su un mercato a mid 0,85 la gamba cara vale l'87%
// del mercato, e il vecchio tetto la rifiutava — abbandonando la coppia intera (`coppia-non-atomica`,
// prima causa misurata di gambe perse, §5 p.129-130).
const gambaPiuCara = C.MARKET_CAP_FIXED_USD * C.PREZZO_MASSIMO_QUOTABILE / C.COSTO_COPPIA;
ok('il tetto per ORDINE è la gamba più cara consentita, più il margine',
  Math.abs(C.LIVE_MIN_ORDER_CAP_USD - (gambaPiuCara + C.MARGINE_ORDINE_USD)) < 0.01,
  `$${C.LIVE_MIN_ORDER_CAP_USD}`);
ok('  e la versione parametrica sul capitale dà lo stesso numero',
  C.liveMinOrderCapUsd(C.CAPITALE_RIFERIMENTO_USD)
    === +(C.capPerMarketUsd(C.CAPITALE_RIFERIMENTO_USD) * C.PREZZO_MASSIMO_QUOTABILE / C.COSTO_COPPIA + C.MARGINE_ORDINE_USD).toFixed(2));
// ⚠ NON PIÙ «strettamente sotto il tetto per mercato», e la ragione è che quella disuguaglianza era
// esattamente il difetto: una gamba PUÒ valere quasi tutto il mercato quando il mid è sbilanciato.
// Quello che resta vero — e che va difeso — è che il tetto per ordine non autorizza più di un mercato.
ok('  e resta sotto il tetto per mercato più il margine dichiarato: una gamba non è due mercati',
  C.LIVE_MIN_ORDER_CAP_USD <= C.MARKET_CAP_FIXED_USD + C.MARGINE_ORDINE_USD + 1e-9,
  `$${C.LIVE_MIN_ORDER_CAP_USD} contro $${C.MARKET_CAP_FIXED_USD} + $${C.MARGINE_ORDINE_USD}`);

// ⚠ LA FINESTRA DI MID NON È PIÙ UN CANCELLO, dal 15 agosto 2026. Fino a ieri il tetto per ordine
// ammetteva solo i mid attorno a 0,50 ([0,43 · 0,57] al tetto di allora) e 6 righe su 7 del piano
// venivano ridotte da lui — non dal tetto per mercato. Con la derivata corretta la finestra copre
// tutto ciò che `end-of-scale` consente, quindi il tetto per ordine smette di scartare mercati e
// torna a fare la sola cosa che deve: rifiutare un ordine più grande di un mercato intero.
const f = C.finestraMid(C.CAPITALE_RIFERIMENTO_USD);
ok('la finestra di mid è simmetrica attorno a 0,5', Math.abs((f.lo + f.hi) - 1) < 1e-9, `${f.lo}–${f.hi}`);
ok('  e copre tutta la fascia che `end-of-scale` consente: non scarta più nessun mercato quotabile',
  f.hi >= 0.97 && f.lo <= 0.03, `${f.lo}–${f.hi}`);
ok('  e la dichiara leggendo il tetto per ordine dalla funzione, non ricalcolandolo',
  f.tettoOrdineUsd === C.liveMinOrderCapUsd(C.CAPITALE_RIFERIMENTO_USD),
  `$${f.tettoOrdineUsd}`);

console.log('\n════ ④ i presidi di sicurezza restano più stretti o compatibili ════');

const limiti = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'safety-risk-limits.json'), 'utf8'));
ok('il tetto per ordine derivato sta sotto il tetto di safety per ordine',
  C.LIVE_MIN_ORDER_CAP_USD < limiti.global.maxOrderNotionalUsd,
  `$${C.LIVE_MIN_ORDER_CAP_USD} < $${limiti.global.maxOrderNotionalUsd}`);
ok('  e un MERCATO intero sta comunque sotto il tetto di safety per ordine',
  C.MARKET_CAP_FIXED_USD < limiti.global.maxOrderNotionalUsd);
// ⚠ `maxOpenNotionalUsd` misura i fill RICONCILIATI, non gli ordini a riposo (lib/safety/fills.js):
// non limita quanti mercati si possono QUOTARE, limita quanto può riempirsi. Si difende comunque
// che il tetto per mercato non lo saturi da solo, o un singolo mercato pieno chiuderebbe il bot.
ok('un solo mercato al tetto non satura l\'esposizione aperta consentita',
  C.MARKET_CAP_FIXED_USD * 4 < limiti.global.maxOpenNotionalUsd,
  `4 mercati pieni $${(C.MARKET_CAP_FIXED_USD * 4).toFixed(2)} vs $${limiti.global.maxOpenNotionalUsd}`);

console.log('\n════ ⑤ nessun modulo si ricopia il tetto ════');

// La stessa forma di difesa di lib/banda-premiante.test.js: si cerca ARITMETICA, non prosa, quindi
// si filtrano commenti e letterali di stringa. Un valore cablato qui è il reperto D1 sul parametro
// che decide quanto capitale va su un mercato.
const ROOT = path.join(__dirname, '..', '..');
// ⚠ `_archivio` È ESCLUSO (15 agosto 2026): contiene i file che la riduzione ha messo da parte —
// codice non servito da nessun processo, script di ricerca che cablano di proposito il valore che
// stavano studiando. Scandirlo fa dire a un test strutturale che una costante è ricopiata «nel repo»
// quando è ricopiata in un museo. Non è un allentamento: il perimetro difeso è il codice VIVO.
const SALTA = new Set(['node_modules', '.next', '.git', 'data', 'public', 'docs', '_archivio']);
const ESENTI = new Set([
  path.join('lib', 'rewards', 'concentration.js'),
  path.join('lib', 'rewards', 'tetto-derivato-dallo-scaglione.test.js'),
  // Riproduce l'incidente del 13 agosto: il tetto di QUELLA NOTTE è un fatto storico, non una copia.
  path.join('lib', 'maker', 'piano-non-si-svuota.test.js'),
]);
const file = [];
(function cammina(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (SALTA.has(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) cammina(p);
    else if (/\.(js|ts|tsx)$/.test(e.name)) file.push(p);
  }
})(ROOT);

const VALORE = new RegExp(`(?<![\\d.])${String(C.MARKET_CAP_FIXED_USD).replace('.', '\\.')}(?![\\d])`);
const colpevoli = [];
for (const p of file) {
  const rel = path.relative(ROOT, p);
  if (ESENTI.has(rel) || rel.startsWith(`scripts${path.sep}ricerca`)) continue;
  fs.readFileSync(p, 'utf8').split('\n').forEach((l, i) => {
    const t = l.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    const codice = l.split('//')[0]
      .replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/`(?:[^`\\]|\\.)*`/g, '``');
    if (VALORE.test(codice)) colpevoli.push(`${rel}:${i + 1}  ${t.slice(0, 90)}`);
  });
}
if (colpevoli.length) for (const c of colpevoli) console.log(`      ${c}`);
ok(`nessun modulo cabla il valore del tetto ($${C.MARKET_CAP_FIXED_USD}) — trovati ${colpevoli.length}`,
  colpevoli.length === 0);

// E il verso opposto: i decisori devono IMPORTARLO.
for (const rel of [
  path.join('lib', 'maker', 'motore-unico.js'),
  path.join('lib', 'maker', 'manual-order.js'),
  path.join('lib', 'maker', 'realloc-cycle.js'),
  path.join('lib', 'maker', 'trigger-capitale-fermo.js'),
  path.join('lib', 'venues', 'polymarket-clob-maker', 'adapter.js'),
]) {
  ok(`${rel} prende il tetto dalla fonte unica`,
    /rewards\/concentration/.test(fs.readFileSync(path.join(ROOT, rel), 'utf8')));
}

console.log(`\ntetto derivato dallo scaglione: ${passati} passati, ${falliti} falliti\n`);
assert.strictEqual(falliti, 0, `${falliti} asserzioni fallite`);
