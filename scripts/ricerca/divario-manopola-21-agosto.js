'use strict';
// scripts/ricerca/divario-manopola-21-agosto.js — IL DIVARIO FRA DISTANZA CHIESTA E DISTANZA VERA.
// SOLA LETTURA. Chiama `prezzoInCoda`, la funzione di produzione, su una scansione di frazioni.
const fs = require('fs'); const path = require('path');
const RADICE = path.resolve(__dirname, '..', '..');
const { fileRuntime, NOMI } = require(path.join(RADICE, 'lib', 'percorsi-runtime'));
const { prezzoInCoda } = require(path.join(RADICE, 'lib', 'maker', 'prezzo-in-coda'));
const { parseOrders, adjustedMid } = require(path.join(RADICE, 'lib', 'rewardScore'));
const { punteggio: S } = require(path.join(RADICE, 'lib', 'banda-premiante'));

const ORD = JSON.parse(fs.readFileSync(path.join(RADICE, 'data', 'ricerca', 'ordini-vivi-21ago.json'), 'utf8'));
const LB = JSON.parse(fs.readFileSync(fileRuntime(NOMI.bookVivi), 'utf8'));
const BD = Object.fromEntries(JSON.parse(fs.readFileSync(fileRuntime(NOMI.boardNormalizzato), 'utf8')).markets.map((m) => [m.marketId, m]));
const ids = [...new Set(ORD.ordini.map((o) => o.market))];

const out = [];
for (const id of ids) {
  const b = BD[id]; const L = LB.markets[id];
  const v = Number(b.maxSpread), minSize = Number(b.minSize), tick = Number(b.tickSize);
  const midY = adjustedMid(parseOrders(L.yes.levels.bids, true), parseOrders(L.yes.levels.asks, false), minSize, L.yes.plainMid);
  const midN = adjustedMid(parseOrders(L.no.levels.bids, true), parseOrders(L.no.levels.asks, false), minSize, L.no.plainMid);
  const rules = { readable: true, tick, maxSpreadCents: v, books: { yes: { scoringMid: midY }, no: { scoringMid: midN } } };
  const depth = { yes: { bids: L.yes.levels.bids, asks: L.yes.levels.asks }, no: { bids: L.no.levels.bids, asks: L.no.levels.asks } };
  const punti = [];
  for (let d = 0.10; d <= v - 0.05; d += 0.05) {
    const dd = +d.toFixed(2);
    process.env.MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V = String(dd / v);
    const p = prezzoInCoda({ book: 'yes', side: 'BUY', rules, depth, ownOrders: [], ownSize: 56.5 });
    delete process.env.MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V;
    if (!p.ok) { punti.push({ chiestaC: dd, ok: false, motivo: p.reason }); continue; }
    const reale = +(Math.abs(p.price - midY) * 100).toFixed(3);
    punti.push({ chiestaC: dd, frazione: +(dd / v).toFixed(4), realeC: reale, divarioC: +(reale - dd).toFixed(3),
      prezzo: p.price, modo: p.mode, S: +S(reale, v).toFixed(4), Sideale: +S(dd, v).toFixed(4) });
  }
  out.push({ id, titolo: b.title, v, tick, midY: +midY.toFixed(4), bestOtherBid: L.yes.bestBid, punti });
}
fs.writeFileSync(path.join(RADICE, 'data', 'ricerca', 'divario-manopola-21-agosto.json'), JSON.stringify(out, null, 1));

for (const m of out) {
  console.log(`\n═══ ${m.titolo.slice(0, 55)}  (tick ${m.tick}, mid ${m.midY}, miglior bid ${m.bestOtherBid}) ═══`);
  const ok = m.punti.filter((p) => p.ok !== false);
  console.log(' chiesta →  reale  divario   S(reale)  S(ideale)  perdita%');
  for (const p of ok) {
    if (Math.round(p.chiestaC * 100) % 25 !== 0) continue;
    const perdita = p.Sideale > 0 ? ((1 - p.S / p.Sideale) * 100).toFixed(1) : '—';
    console.log(`  ${String(p.chiestaC).padStart(5)}¢ → ${String(p.realeC).padStart(5)}¢  ${String(p.divarioC).padStart(6)}¢   ${String(p.S).padStart(7)}  ${String(p.Sideale).padStart(8)}   ${String(perdita).padStart(6)}%`);
  }
  const div = ok.map((p) => p.divarioC);
  console.log(`  divario: min ${Math.min(...div).toFixed(2)}¢  max ${Math.max(...div).toFixed(2)}¢  mediano ${div.sort((a, b) => a - b)[Math.floor(div.length / 2)].toFixed(2)}¢`);
  const raggiungibili = [...new Set(ok.map((p) => p.realeC))].sort((a, b) => a - b);
  console.log(`  distanze RAGGIUNGIBILI su questa griglia: ${raggiungibili.join('¢ · ')}¢`);
}
