#!/usr/bin/env node
'use strict';
// scripts/quanti-mercati.js — QUANTI MERCATI REGGE $663,11, E QUANTI NE CONVIENE TENERE.
//
// SOLA LETTURA. Nessuna rete, nessuna superficie di piazzamento: legge il board normalizzato e usa la
// matematica del venue già nel repo (`lib/rewardScore.js`).
//
// ═══ IL MODELLO DI SIZE, E PERCHÉ NON USO `minSizeVerdict` ═════════════════════════════════════════
// Nel repo convivono DUE modelli di quante share compra un dato capitale, e non coincidono:
//
//   · `plan-to-orders` (QUELLO CHE PIAZZA DAVVERO):  Q = capitale / (p_yes + p_no)
//     Compra Q share su ENTRAMBI i lati; il costo totale è Q·(p_yes+p_no) = capitale. Corretto: su
//     un mercato binario le due gambe costano insieme ~$1 per coppia, qualunque sia il mid.
//
//   · `minSizeVerdict` (in `reward-operator-estimate`): perSide = (capitale/2) / mid
//     Assume che ENTRAMBI i lati costino `mid`. Vero solo a mid = 0,50.
//
// La divergenza è grande sui mid estremi. A mid 0,055 e minSize 20 il secondo dice che bastano $2,20
// (`2 · mid · minSize`), mentre per avere 20 share su entrambi i lati servono ~$20: **sottostima di
// nove volte il capitale necessario a qualificare**. A mid 0,744 e minSize 100 sovrastima di 1,5×.
// Qui uso il modello di `plan-to-orders`, perché è quello che decide gli ordini veri.
//
// Uso: node scripts/quanti-mercati.js [--capitale 663.11] [--riserva 0.10]

const fs = require('fs');
const path = require('path');
const RADICE = path.join(__dirname, '..');
const RS = require(path.join(RADICE, 'lib', 'rewardScore.js'));

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const CAPITALE = Number(arg('--capitale', '663.11'));
const RISERVA = Number(arg('--riserva', '0.10'));   // il 10% di respiro dell'obiettivo di utilizzo 90%
// Il costo di una coppia: il bot posa le due gambe dentro la banda, un tick dietro il tocco su
// ciascun lato, quindi la coppia costa 1 − 2·offset. Misurato sui piani veri: 0,98 (§5 punto 48).
const COSTO_COPPIA = 0.98;

const board = (() => {
  const j = JSON.parse(fs.readFileSync('/tmp/liquidity-rewards.json', 'utf8'));
  return (Array.isArray(j) ? j : (j.markets || [])).filter((r) => r.venue === 'polymarket' && r.rewardScore);
})();

// ── LA QUOTA CON LA FORMULA DEL VENUE ────────────────────────────────────────────────────────────
// `competitorQ` è il Q dei concorrenti già misurato da agent24 sul book vero. La nostra quota alla
// distanza tipica (un tick dietro il tocco ⇒ s = v/2, la stessa che il repo chiama «typical») è
//     share = Qu / (Qu + Qcomp),  Qu = qMin(S·Q, S·Q, mid)
function quotaA(r, capitaleMercato) {
  const rs = r.rewardScore;
  const mid = Number(rs.mid); const v = Number(rs.maxSpreadCents) / 2;
  const minSize = Number(rs.minSize); const pool = Number(rs.poolDay);
  const qc = typeof rs.competitorQ === 'object' && rs.competitorQ ? Number(rs.competitorQ.Qmin ?? rs.competitorQ.q) : Number(rs.competitorQ);
  if (![mid, v, minSize, pool].every(Number.isFinite) || !(v > 0) || !(pool > 0)) return null;
  const Q = capitaleMercato / COSTO_COPPIA;                 // share per lato
  if (!(Q >= minSize)) return { qualifica: false, share: 0, usdGiorno: 0, shareLato: Q, minSize };
  if (!Number.isFinite(qc) || qc < 0) return null;           // concorrenza non misurata ⇒ non si stima
  const s = RS.scoreOrder(v / 2, v);
  const QuLato = s * Q;
  const Qu = RS.qMin(QuLato, QuLato, mid);
  const share = Qu / (Qu + qc);
  return { qualifica: true, share, usdGiorno: pool * share, shareLato: Q, minSize };
}

// ── 1 · IL VINCOLO DURO ──────────────────────────────────────────────────────────────────────────
const perMin = new Map();
for (const r of board) {
  const m = Number(r.rewardScore.minSize);
  if (!Number.isFinite(m)) continue;
  if (!perMin.has(m)) perMin.set(m, []);
  perMin.get(m).push(r);
}
console.log(`\n═══ 1 · IL VINCOLO DURO — board: ${board.length} mercati polymarket\n`);
console.log('min premiante | mercati | capitale minimo per coppia | max mercati con $' + CAPITALE.toFixed(0));
const minsOrd = [...perMin.keys()].sort((a, b) => a - b);
for (const m of minsOrd) {
  const costo = m * COSTO_COPPIA;
  console.log(String(m).padStart(13), '|', String(perMin.get(m).length).padStart(7), '|', ('$' + costo.toFixed(2)).padStart(26), '|', String(Math.floor(CAPITALE / costo)).padStart(20));
}

// ── 2 · IL MASSIMO TEORICO, coi minimi VERI mercato per mercato ─────────────────────────────────
// Si ordinano i mercati per costo minimo crescente e si riempie finché il capitale basta: è il numero
// massimo di mercati, non il migliore.
function massimo(cap) {
  const ord = board.map((r) => ({ r, costo: Number(r.rewardScore.minSize) * COSTO_COPPIA }))
    .filter((x) => Number.isFinite(x.costo) && x.costo > 0)
    .sort((a, b) => a.costo - b.costo);
  let speso = 0; let n = 0; const usati = [];
  for (const x of ord) { if (speso + x.costo > cap) continue; speso += x.costo; n += 1; usati.push(x); }
  return { n, speso: +speso.toFixed(2), residuo: +(cap - speso).toFixed(2), usati };
}
const pieno = massimo(CAPITALE);
const conRiserva = massimo(CAPITALE * (1 - RISERVA));
console.log(`\n═══ 2 · IL MASSIMO TEORICO\n`);
console.log(`  capitale interamente impiegato : ${pieno.n} mercati · spesi $${pieno.speso} · residuo $${pieno.residuo}`);
console.log(`  con riserva del ${(RISERVA * 100).toFixed(0)}%          : ${conRiserva.n} mercati · spesi $${conRiserva.speso} su $${(CAPITALE * (1 - RISERVA)).toFixed(2)}`);
const dist = {};
for (const x of pieno.usati) { const m = x.r.rewardScore.minSize; dist[m] = (dist[m] || 0) + 1; }
console.log(`  composizione del massimo: ${Object.entries(dist).map(([k, v]) => `${v}× min ${k}`).join(', ')}`);

// ── 3 · L'OTTIMO ─────────────────────────────────────────────────────────────────────────────────
// Per ogni N: capitale per mercato = C/N; si valutano TUTTI i mercati a quella size, si tengono i
// migliori N per $/giorno, si somma. I mercati che a quella size non qualificano rendono zero e
// vengono naturalmente scartati.
function rendimentoA(n, cap) {
  const perMercato = cap / n;
  const val = [];
  for (const r of board) {
    const q = quotaA(r, perMercato);
    if (!q || !q.qualifica) continue;
    val.push({ id: r.marketId, usd: q.usdGiorno, share: q.share, pool: Number(r.rewardScore.poolDay) });
  }
  val.sort((a, b) => b.usd - a.usd);
  const scelti = val.slice(0, n);
  return {
    n, perMercato: +perMercato.toFixed(2),
    qualificati: val.length,
    effettivi: scelti.length,
    usdGiorno: +scelti.reduce((s, x) => s + x.usd, 0).toFixed(2),
    quotaMediana: scelti.length ? +(scelti[Math.floor(scelti.length / 2)].share * 100).toFixed(2) : null,
    capitaleUsato: +(scelti.length * perMercato).toFixed(2),
  };
}
console.log(`\n═══ 3 · L'OTTIMO — rendimento atteso al variare del numero di mercati\n`);
console.log('  N | $/mercato | qualificati | effettivi | $/giorno | resa/g | quota mediana');
const curva = [];
for (const n of [5, 10, 11, 15, 20, 25, 30, 34, 40, 50, 60, 80, 100, 120]) {
  if (n > board.length) break;
  const x = rendimentoA(n, CAPITALE);
  curva.push(x);
  console.log(String(x.n).padStart(4), '|', ('$' + x.perMercato).padStart(9), '|', String(x.qualificati).padStart(11), '|',
    String(x.effettivi).padStart(9), '|', ('$' + x.usdGiorno).padStart(8), '|',
    ((100 * x.usdGiorno / CAPITALE).toFixed(1) + '%').padStart(6), '|', String(x.quotaMediana ?? '—').padStart(13));
}
const migliore = curva.reduce((a, b) => (b.usdGiorno > a.usdGiorno ? b : a), curva[0]);
console.log(`\n  MASSIMO della curva: N=${migliore.n} · $${migliore.usdGiorno}/g · $${migliore.perMercato} per mercato`);
const entro5 = curva.filter((x) => x.usdGiorno >= migliore.usdGiorno * 0.95).map((x) => x.n);
const entro10 = curva.filter((x) => x.usdGiorno >= migliore.usdGiorno * 0.90).map((x) => x.n);
console.log(`  entro il 5% del massimo:  N = ${entro5.join(', ')}`);
console.log(`  entro il 10% del massimo: N = ${entro10.join(', ')}`);

fs.writeFileSync(path.join(RADICE, 'docs', 'quanti-mercati-dati.json'), JSON.stringify({
  generatoIso: new Date().toISOString(), capitale: CAPITALE, costoCoppia: COSTO_COPPIA,
  boardMercati: board.length,
  distribuzioneMinimi: minsOrd.map((m) => ({ minSize: m, mercati: perMin.get(m).length, costoCoppiaUsd: +(m * COSTO_COPPIA).toFixed(2) })),
  massimoPieno: { n: pieno.n, speso: pieno.speso, residuo: pieno.residuo, composizione: dist },
  massimoConRiserva: { n: conRiserva.n, speso: conRiserva.speso },
  curva, migliore, entro5, entro10,
}, null, 1));
console.log('\ndati in docs/quanti-mercati-dati.json\n');
