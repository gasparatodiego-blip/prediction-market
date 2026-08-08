#!/usr/bin/env node
'use strict';
// scripts/vedi-audit.js — LA CODA DELL'AUDIT, LEGGIBILE A COLPO D'OCCHIO.
//
// Sola lettura di `data/audit-coda.json`. Non lancia scansioni, non scrive niente.
//
//   node scripts/vedi-audit.js              i reperti APERTI, dal più grave
//   node scripts/vedi-audit.js --tutti      anche i risolti
//   node scripts/vedi-audit.js --storia     l'andamento delle ultime scansioni
//   node scripts/vedi-audit.js --json       la coda grezza
//
// In alternativa: `cat data/audit-coda.md`, che è la stessa cosa già scritta in markdown.

const fs = require('fs');
const path = require('path');

const FILE = path.resolve(__dirname, '..', 'data', 'audit-coda.json');
const arg = (n) => process.argv.includes('--' + n);
const SIM = { alta: '🔴', media: '🟠', bassa: '🟡' };
const ORD = { alta: 0, media: 1, bassa: 2 };

let d;
try { d = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
catch (e) {
  console.log(e.code === 'ENOENT'
    ? `Nessuna coda ancora: ${FILE} non esiste.\nLa prima scansione la crea. Per farne una adesso:\n  node agents/agent44-audit-scoperta.js`
    : `Coda illeggibile: ${e.message}`);
  process.exit(0);
}
if (arg('json')) { console.log(JSON.stringify(d, null, 2)); process.exit(0); }

const ultima = d.scansioni[d.scansioni.length - 1] || {};
const aperti = d.reperti.filter((r) => r.stato === 'aperto');
const risolti = d.reperti.filter((r) => r.stato === 'risolto');
const conta = (s) => aperti.filter((r) => r.severita === s).length;

console.log('');
console.log('═'.repeat(96));
console.log('  CODA DELL\'AUDIT DI SCOPERTA — agent44');
console.log('═'.repeat(96));
console.log(`  ultima scansione: ${ultima.at || '—'}  ·  durata ${ultima.durataSec ?? '—'}s  ·  RAM max ${ultima.rssMaxMb ?? '—'} MB`
  + `  ·  ${ultima.completa === false ? 'PARZIALE' : 'completa'}`);
console.log(`  APERTI: ${aperti.length}   🔴 ${conta('alta')} alta · 🟠 ${conta('media')} media · 🟡 ${conta('bassa')} bassa`
  + `   ·  risolti nel tempo: ${risolti.length}  ·  scansioni: ${d.scansioni.length}`);
if ((ultima.nuovi || []).length) console.log(`  NUOVI nell'ultima scansione: ${ultima.nuovi.length}`);
if ((ultima.riaperti || []).length) console.log(`  RIAPERTI (il fix non teneva): ${ultima.riaperti.length}`);
console.log('');

if (arg('storia')) {
  console.log('  quando                    durata   RAM   aperti  nuovi  risolti  esito');
  for (const s of d.scansioni.slice(-20)) {
    console.log(`  ${String(s.at).padEnd(26)}${String(s.durataSec + 's').padStart(6)}${String(s.rssMaxMb + 'M').padStart(6)}`
      + `${String(s.aperti).padStart(8)}${String((s.nuovi || []).length).padStart(7)}${String((s.risolti || []).length).padStart(9)}  ${s.completa === false ? 'parziale' : 'completa'}`);
  }
  console.log('');
  process.exit(0);
}

const mostra = (r, i) => {
  const nuovo = (ultima.nuovi || []).includes(r.id) ? '  [NUOVO]' : '';
  const riap = (ultima.riaperti || []).includes(r.id) ? '  [RIAPERTO]' : '';
  const g = Math.floor((Date.parse(ultima.at || Date.now()) - Date.parse(r.primaVisto)) / 86_400_000);
  console.log(`${String(i + 1).padStart(3)}. ${SIM[r.severita] || '·'} ${r.titolo}${nuovo}${riap}`);
  console.log(`     dove: ${r.dove}`);
  console.log(`     ${r.dettaglio}`);
  console.log(`     regola ${r.regola} · id ${r.id} · visto ${r.scansioniViste}× · aperto da ${g >= 1 ? g + 'g' : 'oggi'}`);
  console.log('');
};

if (!aperti.length) {
  console.log('  Nessun reperto aperto.');
  console.log('  (Che non è «non c\'è niente da trovare»: è «le regole di oggi non hanno trovato niente».');
  console.log('   L\'elenco delle regole è in lib/audit/rilevatori.js.)');
  console.log('');
} else {
  aperti.sort((a, b) => (ORD[a.severita] - ORD[b.severita]) || String(a.primaVisto).localeCompare(String(b.primaVisto)));
  aperti.forEach(mostra);
}

if (arg('tutti') && risolti.length) {
  console.log('─'.repeat(96));
  console.log(`  RISOLTI (${risolti.length}) — tenuti perché «sparito» e «risolto» non sono la stessa cosa`);
  console.log('');
  for (const r of risolti.slice(-25)) console.log(`   ✓ ${r.titolo}\n     risolto il ${r.risoltoIl} · visto la prima volta il ${r.primaVisto} · id ${r.id}\n`);
}
if (!arg('tutti') && risolti.length) console.log(`  (${risolti.length} reperti risolti nascosti — \`node scripts/vedi-audit.js --tutti\` per vederli)\n`);
