#!/usr/bin/env node
'use strict';
// scripts/ripulisci-fill-duplicati.js — TOGLIE DAL LEDGER I FILL CHE IL BUG HA REGISTRATO N VOLTE.
//
// ═══ COSA RIPARA ════════════════════════════════════════════════════════════════════════════════════
// `planReconcile` confrontava il volume dei trade del venue su un token+lato (una grandezza per TOKEN)
// con quanto risultava registrato per una singola `idempotencyKey`. Il ciclo di riprezzo sostituisce la
// stessa gamba ogni ~60 secondi e ogni sostituzione porta una chiave NUOVA: ognuna ritrovava lo stesso
// identico volume e lo registrava INTERO come fill proprio.
//
// Misurato su Chengdu 37°C il 9 agosto 2026: 136 righe di fill, 136 chiavi distinte, `filledSize` sempre
// lo stesso valore reale (21,69 · 14 · 7,69). Il codice è stato corretto; questo script ripara lo STATO
// che il bug ha già scritto, che altrimenti resterebbe gonfio per sempre.
//
// ═══ IL CRITERIO, E IL SUO LIMITE DICHIARATO ════════════════════════════════════════════════════════
// Si tiene UNA riga per ogni combinazione (userId, venue, tokenId, side, filledSize, filledPrice) —
// la PIÙ VECCHIA, cioè la registrazione originale — e si scartano le successive identiche.
//
// È il criterio che corrisponde al difetto: il bug riscriveva un volume IDENTICO. Il limite, dichiarato
// perché non venga scoperto dopo: due fill genuinamente identici (stesso token, lato, size e prezzo, in
// momenti diversi) verrebbero collassati in uno, e questo SOTTOSTIMA l'esposizione. È il verso
// pericoloso, quindi lo script:
//   · stampa ESATTAMENTE cosa toglierebbe, riga per riga, prima di toccare qualunque cosa;
//   · gira in ANTEPRIMA di difetto — scrive solo con `--esegui`;
//   · prende un BACKUP con timestamp prima di riscrivere;
//   · non tocca MAI le righe `nofill` né altro: solo i duplicati esatti di `kind:'fill'`.
//
// Non è un meccanismo permanente: è una riparazione una-tantum di dati già scritti. Il difetto che li
// produceva è chiuso in `lib/safety/reconcile-fills.js`.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'safety-fills.jsonl');
const ESEGUI = process.argv.includes('--esegui');

function main() {
  if (!fs.existsSync(FILE)) { console.log('ledger assente:', FILE); process.exit(1); }
  const testo = fs.readFileSync(FILE, 'utf8');
  const righe = testo.split('\n');

  const visto = new Map();      // firma → prima riga che l'ha portata
  const tenute = [];
  const scartate = [];

  for (const riga of righe) {
    if (!riga.trim()) continue;
    let r;
    try { r = JSON.parse(riga); }
    catch { tenute.push(riga); continue; }      // una riga illeggibile si TIENE: non si butta ciò che non si capisce
    if (r.kind !== 'fill') { tenute.push(riga); continue; }

    const firma = [r.userId, r.venue, r.tokenId, r.side, r.filledSize, r.filledPrice].join('|');
    if (visto.has(firma)) { scartate.push(r); continue; }
    visto.set(firma, r);
    tenute.push(riga);
  }

  const perToken = new Map();
  for (const r of scartate) {
    const k = `${String(r.tokenId).slice(0, 18)}…|${r.side}`;
    const v = perToken.get(k) || { n: 0, share: 0 };
    v.n++; v.share += Number(r.filledSize) || 0;
    perToken.set(k, v);
  }

  console.log(`righe totali            : ${righe.filter((x) => x.trim()).length}`);
  console.log(`righe fill              : ${righe.filter((x) => x.includes('"kind":"fill"')).length}`);
  console.log(`DUPLICATE da scartare   : ${scartate.length}`);
  console.log(`righe che restano       : ${tenute.length}`);
  console.log();
  console.log('scartate per token+lato:');
  for (const [k, v] of [...perToken.entries()].sort((a, b) => b[1].share - a[1].share)) {
    console.log(`  ${k.padEnd(26)} ${String(v.n).padStart(4)} righe · ${v.share.toFixed(2)} share`);
  }

  if (!ESEGUI) {
    console.log();
    console.log('ANTEPRIMA — niente è stato scritto. Rilancia con --esegui per applicare.');
    return;
  }

  const backup = `${FILE}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(FILE, backup);
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, tenute.join('\n') + '\n');
  fs.renameSync(tmp, FILE);
  console.log();
  console.log('backup :', path.basename(backup));
  console.log('scritto:', FILE, `(${tenute.length} righe)`);
}

main();
