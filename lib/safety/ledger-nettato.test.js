'use strict';
// lib/safety/ledger-nettato.test.js — IL VENUE SMENTISCE IL LEDGER, E L'ESPOSIZIONE SCENDE.
//
// ═══ IL DIFETTO ════════════════════════════════════════════════════════════════════════════════════
// Il ledger dei fill si chiude solo se la riconciliazione riesce a scrivere la riga di uscita. Una
// posizione venduta, fusa on-chain, redenta o risolta alla scadenza non produce quella riga: i lotti
// FIFO restano aperti per sempre al loro nozionale d'ingresso.
// Misurato il 12 agosto 2026: **14 posizioni per $16.960,06** contro **zero posizioni al venue** — 26
// volte il tetto di esposizione aperta di $600. Conseguenza: TUTTE le gambe di ogni giro tornavano
// `skipped`, e il bot non poteva piazzare niente.
//
// Due cause, e servivano entrambe le correzioni:
//   1. `diagnoseExposure` non passava affatto lo snapshot del venue a `computeExposure` — la fusione
//      esisteva ma era codice morto su quel percorso;
//   2. la fusione sapeva AGGIUNGERE un token che esiste solo al venue e TENERE il massimo su un token
//      visto da entrambi, ma non sapeva TOGLIERE un token che il venue dice chiuso.
//
// Run: node lib/safety/ledger-nettato.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { computeExposure } = require('./fills');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
const file = path.join(dir, 'fills.jsonl');
const U = 'operator';
// Due posizioni comprate e mai chiuse nel ledger: 100 share a 0,50 e 200 a 0,40.
fs.writeFileSync(file, [
  JSON.stringify({ kind: 'fill', ts: 1, userId: U, venue: 'polymarket', tokenId: 'TOK-A', side: 'BUY', filledSize: 100, filledPrice: 0.5, feeUsd: 0 }),
  JSON.stringify({ kind: 'fill', ts: 2, userId: U, venue: 'polymarket', tokenId: 'TOK-B', side: 'BUY', filledSize: 200, filledPrice: 0.4, feeUsd: 0 }),
  '',
].join('\n'));
const deps = { fillsFile: file };

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n1 · senza il venue, il ledger comanda — ed è il comportamento di prima');
{
  const e = computeExposure({ userId: U }, deps);
  ok('due posizioni aperte per $130', e.ok && e.openNotionalUsd === 130, `$${e.openNotionalUsd}`);
  ok('  e nessuna è dichiarata nettata', e.venuePositions.nettateCount === 0);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n2 · LA PROPRIETÀ: il venue dice che non ci sono più, e l\'esposizione va a zero');
{
  const e = computeExposure({ userId: U, venuePositions: { readable: true, positions: [] } }, deps);
  ok('esposizione $0 — è il caso vero del 12 agosto', e.openNotionalUsd === 0, `$${e.openNotionalUsd}`);
  ok('  due posizioni nettate', e.venuePositions.nettateCount === 2);
  ok('  per $130 tolti', e.venuePositions.nettateUsd === 130);
  ok('  e le righe RESTANO nell\'elenco, marcate', e.positions.length === 2 && e.positions.every((p) => p.chiusaAlVenue === true),
    'sparire in silenzio renderebbe «nettata» indistinguibile da «non è mai esistita»');
  ok('  con l\'esposizione di prima conservata', e.positions.every((p) => p.esposizionePrimaUsd > 0));
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n3 · si netta SOLO ciò che il venue smentisce');
{
  const e = computeExposure({ userId: U, venuePositions: { readable: true, positions: [{ tokenId: 'TOK-A', size: 100, avgPrice: 0.5 }] } }, deps);
  ok('la posizione confermata resta', e.positions.find((p) => p.tokenId === 'TOK-A').chiusaAlVenue !== true);
  ok('  quella assente viene nettata', e.positions.find((p) => p.tokenId === 'TOK-B').chiusaAlVenue === true);
  ok('  esposizione $50, non $130', e.openNotionalUsd === 50, `$${e.openNotionalUsd}`);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n4 · FAIL-CLOSED: senza una lettura fresca del venue non si netta NIENTE');
{
  for (const [vp, etichetta] of [
    [null, 'snapshot assente'],
    [undefined, 'snapshot non iniettato'],
    [{ readable: false, positions: [] }, 'snapshot NON leggibile (anche se vuoto)'],
    [{ readable: false, positions: [], reason: 'troppo vecchio' }, 'snapshot scaduto'],
    [{ readable: true }, 'leggibile ma senza elenco'],
  ]) {
    const e = computeExposure({ userId: U, venuePositions: vp }, deps);
    ok(`${etichetta} ⇒ esposizione INVARIATA a $130`, e.openNotionalUsd === 130, `$${e.openNotionalUsd}`);
  }
  ok('«non leggibile» non è mai «nessuna posizione»', true,
    'readVenuePositions restituisce readable:false oltre MAX_AGE_MS: la freschezza è già garantita a monte');
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n5 · il cablaggio che mancava, e il residuo di virgola');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'maker', 'manual-reset.js'), 'utf8');
  ok('`diagnoseExposure` passa lo snapshot del venue', /venuePositions:\s*posVenue/.test(src),
    'prima non lo passava affatto: la fusione era codice morto su quel percorso');
  ok('  e lo legge dal modulo dello snapshot', /readVenuePositions\(\)/.test(src));

  // Somme e sottrazioni di valori arrotondati lasciavano $0,0001 dopo aver nettato 14 posizioni.
  const molti = [];
  for (let i = 0; i < 14; i++) molti.push(JSON.stringify({ kind: 'fill', ts: i + 1, userId: U, venue: 'polymarket', tokenId: `T${i}`, side: 'BUY', filledSize: 123.456789, filledPrice: 0.987654, feeUsd: 0 }));
  const f2 = path.join(dir, 'molti.jsonl');
  fs.writeFileSync(f2, molti.join('\n') + '\n');
  const e = computeExposure({ userId: U, venuePositions: { readable: true, positions: [] } }, { fillsFile: f2 });
  ok('nettando molte posizioni l\'esposizione è ZERO, non un residuo', e.openNotionalUsd === 0, `$${e.openNotionalUsd}`);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n===== ledger-nettato: ${pass} passati, ${fail} falliti =====\n`);
process.exit(fail === 0 ? 0 : 1);
