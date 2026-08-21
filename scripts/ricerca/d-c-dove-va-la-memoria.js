'use strict';
// scripts/ricerca/d-c-dove-va-la-memoria.js — SOLA LETTURA, e volutamente PRUDENTE.
// ⚠ NON esegue il piano intero: su questa macchina il figlio vero arriva a 924 MB e ne restano ~430
// disponibili, quindi misurarlo per intero mette a rischio agent40/agent41, cioe' i processi che
// tengono gli ordini veri. Si misurano i COMPONENTI su un CAMPIONE, con l'heap capato, e si dichiara
// cosa e' misurato e cosa e' estrapolato.
const fs = require('fs'); const path = require('path');
const DATA = path.join(__dirname, '..', '..', 'data');
const N = Number(process.argv[2] || 20000);   // righe di campione

const files = fs.readdirSync(DATA).filter(f => /^mid-history-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
console.log('file di mid-history sul disco:', files.length);
let totale = 0;
for (const f of files) { const b = fs.statSync(path.join(DATA, f)).size; totale += b;
  console.log('  ' + f, (b / 1048576).toFixed(1) + ' MB'); }
console.log('  TOTALE ' + (totale / 1048576).toFixed(1) + ' MB — `loadJournal` li legge TUTTI, uno per uno, interi');

// ── un campione di righe dal file piu' recente ────────────────────────────────────────────────
const ultimo = path.join(DATA, files[files.length - 1]);
const fd = fs.openSync(ultimo, 'r');
const buf = Buffer.alloc(64 * 1024 * 1024);
const letti = fs.readSync(fd, buf, 0, buf.length, 0);
fs.closeSync(fd);
const righe = buf.slice(0, letti).toString('utf8').split('\n').filter(x => x.trim()).slice(0, N);
console.log('');
console.log('campione:', righe.length, 'righe da', files[files.length - 1]);

// peso dei campi, sul testo grezzo
let bytesTot = 0, bytesNo = 0, bytesRichiesti = 0;
const RICHIESTI = ['ts', 'marketId', 'tokenIdYes', 'adjMid', 'plainMid', 'bestBid', 'bestAsk',
  'bidDepthInBand', 'askDepthInBand', 'bandLow', 'bandHigh', 'tick', 'src'];
let conNo = 0;
for (const l of righe) {
  bytesTot += l.length;
  let r; try { r = JSON.parse(l); } catch { continue; }
  if (r.no !== undefined) { conNo++; bytesNo += JSON.stringify(r.no).length; }
  const solo = {}; for (const k of RICHIESTI) if (k in r) solo[k] = r[k];
  bytesRichiesti += JSON.stringify(solo).length;
}
console.log('');
console.log('PESO DEI CAMPI, sul testo grezzo del campione:');
console.log('  riga intera        ', (bytesTot / righe.length).toFixed(0), 'byte in media');
console.log('  campo `no`         ', (bytesNo / righe.length).toFixed(0), 'byte  ('
  + (100 * bytesNo / bytesTot).toFixed(1) + '% della riga · presente su ' + conNo + '/' + righe.length + ')');
console.log('  SOLI campi richiesti', (bytesRichiesti / righe.length).toFixed(0), 'byte  ('
  + (100 * bytesRichiesti / bytesTot).toFixed(1) + '% della riga)');
console.log('  ⇒ scartabile        ', (100 - 100 * bytesRichiesti / bytesTot).toFixed(1) + '% del testo');

// ── il costo in HEAP delle tre strutture, misurato ────────────────────────────────────────────
const mb = (x) => (x / 1048576).toFixed(1);
global.gc && global.gc();
const h0 = process.memoryUsage().heapUsed;
const parsate = righe.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const h1 = process.memoryUsage().heapUsed;
const sparse = parsate.map(r => ({ ...r, tsMs: Date.parse(r.ts) }));       // cio' che fa loadJournal:52
const h2 = process.memoryUsage().heapUsed;
const magre = parsate.map(r => { const o = { tsMs: Date.parse(r.ts) }; for (const k of RICHIESTI) if (k in r) o[k] = r[k]; return o; });
const h3 = process.memoryUsage().heapUsed;
console.log('');
console.log('COSTO IN HEAP, misurato su', parsate.length, 'righe:');
console.log('  ① oggetti parsati            ', mb(h1 - h0), 'MB  ⇒', ((h1 - h0) / parsate.length).toFixed(0), 'byte/riga');
console.log('  ② copia `{...r, tsMs}` (:52) ', mb(h2 - h1), 'MB  ⇒', ((h2 - h1) / parsate.length).toFixed(0), 'byte/riga  ← la copia RITENUTA');
console.log('  ③ copia coi SOLI richiesti   ', mb(h3 - h2), 'MB  ⇒', ((h3 - h2) / parsate.length).toFixed(0), 'byte/riga');
console.log('  ⇒ la copia magra costa il', (100 * (h3 - h2) / (h2 - h1)).toFixed(0) + '% di quella grassa');

// ── estrapolazione dichiarata ────────────────────────────────────────────────────────────────
const bytePerRiga = bytesTot / righe.length;
const righeTotali = totale / bytePerRiga;
const righe24h = fs.statSync(ultimo).size / bytePerRiga;
console.log('');
console.log('ESTRAPOLAZIONE (dichiarata come tale, non misurata):');
console.log('  righe stimate su tutti i file :', Math.round(righeTotali).toLocaleString('it-IT'));
console.log('  heap per la sola `byMarket`   :', mb(righeTotali * ((h2 - h1) / parsate.length)), 'MB   ← oggi');
console.log('  heap con la copia magra       :', mb(righeTotali * ((h3 - h2) / parsate.length)), 'MB');
console.log('  + la stringa del file piu\' grande:', mb(Math.max(...files.map(f => fs.statSync(path.join(DATA, f)).size))), 'MB (readFileSync) x2 con split');
fs.writeFileSync(path.join(DATA, 'ricerca', 'd-c-dove-va-la-memoria.json'), JSON.stringify({
  lettoAl: new Date().toISOString(), file: files.length, totaleMb: +(totale / 1048576).toFixed(1),
  campione: righe.length, bytePerRiga: +bytePerRiga.toFixed(0),
  fraseNo: +(100 * bytesNo / bytesTot).toFixed(1), frazioneRichiesti: +(100 * bytesRichiesti / bytesTot).toFixed(1),
  heapParsato: h1 - h0, heapCopiaGrassa: h2 - h1, heapCopiaMagra: h3 - h2, righeCampione: parsate.length,
}, null, 1));
console.log('\nscritto data/ricerca/d-c-dove-va-la-memoria.json');
