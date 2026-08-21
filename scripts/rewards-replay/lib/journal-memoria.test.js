'use strict';
// scripts/rewards-replay/lib/journal-memoria.test.js — D-C, 21 agosto 2026.
//
// LA PROPRIETA' DIFESA, e non la costante: **caricare il giornale sulla finestra VERA del ciclo
// pesante (48 h) deve stare sotto una soglia di memoria dichiarata**, su questa macchina e su questi
// dati. Fino al 21 agosto non ci stava: il figlio del piano moriva in OOM a 924 MB, 4 cicli su 4 al
// giorno dal 19 agosto, e con ~430 MB liberi non c'era margine per alzare il limite.
//
// ⚠ IL TEST MISURA, NON LEGGE IL SORGENTE. Lancia un figlio con l'heap CAPATO e ne legge il picco
// REALE da `/proc/<pid>/status` (VmHWM). Un test che cercasse `scartaCampi` nel sorgente passerebbe
// anche con un commento (§5.3), e soprattutto non direbbe niente su quanta memoria serve davvero.
//
// ⚠ IL CAP DEL FIGLIO E' UNA PROTEZIONE, NON UN DETTAGLIO: senza, un test che sbaglia mette l'OOM
// killer sulla flotta, cioe' su agent40/agent41 che tengono gli ordini veri.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let passati = 0, falliti = 0;
const ok = (m, c, extra) => { if (c) { passati++; console.log('  ok  ' + m); } else { falliti++; console.log('  NO  ' + m + (extra ? ' — ' + extra : '')); } };

// ── LE DUE SOGLIE, DICHIARATE E MOTIVATE ────────────────────────────────────────────────────────
// `CAP_FIGLIO` e' il tetto dell'heap del figlio: sopra, muore invece di mangiare la macchina.
// `SOGLIA_PICCO` e' cio' che il test PRETENDE. 450 MB e' scelto cosi': il picco misurato il 21 agosto
// e' **303 MB**, quindi c'e' il 48% di margine per la crescita del giornale; e resta sotto i ~663 MB
// liberi con la flotta armata, che e' il vincolo vero. Non e' un numero tondo scelto a occhio: e' il
// misurato piu' meta'.
const CAP_FIGLIO_MB = 700;
const SOGLIA_PICCO_MB = 450;
const FINESTRA_ORE = 48;          // la finestra del ciclo pesante (allocator.js:1290, WINDOW_MS)

const RADICE = path.join(__dirname, '..', '..', '..');
const CODICE = `
const J = require(${JSON.stringify(path.join(__dirname, 'journal.js'))});
const to = Date.now(), from = to - ${FINESTRA_ORE} * 3600e3;
const r = J.loadJournal({ fromMs: from, toMs: to, scartaCampi: ['levels', 'no'] });
let picco = null;
try { picco = Number(require('fs').readFileSync('/proc/self/status','utf8').match(/VmHWM:\\s+(\\d+)/)[1]) / 1024; } catch (e) {}
process.stdout.write(JSON.stringify({ picco, righe: r.rows, mercati: r.byMarket.size,
  fileLetti: r.fileLetti, fileTotali: r.fileTotali, campiScartati: r.campiScartati }));
`;

console.log(`① IL PICCO SULLA FINESTRA VERA (${FINESTRA_ORE} h), misurato nel figlio`);
const giornali = fs.readdirSync(path.join(RADICE, 'data')).filter(f => /^mid-history-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
if (giornali.length === 0) {
  // ⚠ NON si finge un verde: senza giornale la proprieta' non e' verificabile su questa macchina.
  console.log('  -- nessun mid-history sul disco: la misura non e` possibile, e non si finge che lo sia');
  console.log(`\n${passati} passati, ${falliti} falliti (misura non eseguibile)`);
  process.exit(0);
}
const t0 = Date.now();
const r = spawnSync(process.execPath, [`--max-old-space-size=${CAP_FIGLIO_MB}`, '-e', CODICE],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 300000 });
const durata = (Date.now() - t0) / 1000;
let out = null; try { out = JSON.parse(r.stdout); } catch (_) {}

// ⚠ QUESTA E` L'ASSERZIONE CHE FALLISCE SUL SORGENTE VECCHIO: senza il filtro sui file e senza lo
// scarto dei campi, il figlio non arriva alla fine — muore in OOM e `stdout` resta vuoto.
ok('il figlio SOPRAVVIVE alla finestra del ciclo pesante', out != null,
  `uscita ${r.status} · ${(r.stderr || '').trim().split('\n').slice(-1)[0] || 'nessun stderr'}`);

if (out) {
  console.log(`      picco ${out.picco != null ? out.picco.toFixed(0) : '?'} MB · righe ${out.righe} · mercati ${out.mercati}`
    + ` · file ${out.fileLetti}/${out.fileTotali} · ${durata.toFixed(0)}s`);
  ok(`il picco sta sotto ${SOGLIA_PICCO_MB} MB`, out.picco != null && out.picco < SOGLIA_PICCO_MB,
    `misurato ${out.picco != null ? out.picco.toFixed(0) : '?'} MB`);
  ok('ha davvero elaborato un numero realistico di righe (non un giornale vuoto)', out.righe > 1000,
    String(out.righe));
  ok('ha letto MENO file di quelli sul disco (il filtro sulla finestra morde)',
    out.fileTotali > out.fileLetti || out.fileTotali <= 3,
    `letti ${out.fileLetti} di ${out.fileTotali}`);
  ok('e ha davvero scartato i due campi pesanti',
    Array.isArray(out.campiScartati) && out.campiScartati.includes('levels') && out.campiScartati.includes('no'),
    JSON.stringify(out.campiScartati));
}

console.log('② SENZA `scartaCampi` il comportamento resta QUELLO DI PRIMA (la corsia del backtest non cambia)');
const J = require('./journal.js');
const to = Date.now(), from = to - 2 * 3600e3;     // finestra corta: sicura anche coi campi interi
const a = J.loadJournal({ fromMs: from, toMs: to });
const b = J.loadJournal({ fromMs: from, toMs: to, scartaCampi: ['levels', 'no'] });
ok('  stesse righe e stessi mercati', a.rows === b.rows && a.byMarket.size === b.byMarket.size,
  `${a.rows}/${a.byMarket.size} contro ${b.rows}/${b.byMarket.size}`);
ok('  campiScartati e` null quando non si chiede niente', a.campiScartati === null);
let divergenze = 0, confronti = 0, portavanoIlCampo = 0;
for (const [m, ra] of a.byMarket) {
  const rb = b.byMarket.get(m) || [];
  if (ra.length !== rb.length) { divergenze++; continue; }
  for (let i = 0; i < ra.length; i++) {
    if (ra[i].levels !== undefined || ra[i].no !== undefined) portavanoIlCampo++;
    for (const k of Object.keys(ra[i])) {
      if (k === 'levels' || k === 'no') continue;
      confronti++;
      if (JSON.stringify(ra[i][k]) !== JSON.stringify(rb[i][k])) divergenze++;
    }
  }
}
ok(`  ogni altro campo e' identico (${confronti} confronti)`, divergenze === 0, `divergenze ${divergenze}`);
ok('  e le righe portavano davvero i campi scartati (o il confronto non proverebbe niente)',
  portavanoIlCampo > 0, String(portavanoIlCampo));

console.log('③ lo streaming non perde righe e non ne inventa');
ok('  nessuna riga malformata sulla finestra corta', a.malformed === 0, String(a.malformed));
ok('  lo schema resta confermato', a.schemaConfirmed === true);

console.log(`\n${passati} passati, ${falliti} falliti`);
process.exit(falliti ? 1 : 0);
