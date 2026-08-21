'use strict';
// scripts/ricerca/d2-ordine-minciclo.js — L'UNICA DECISIONE CHE :269 SPOSTA DAVVERO.
// SOLA LETTURA.
//
// `trigger-capitale-fermo.scegliMercato:317` ordina le righe del piano per `realisticBestPerDay`, che
// esce da `realisticEstimate` — quindi dalla riga :269. E' il mini-ciclo a capitale fermo (120 s):
// decide QUALE mercato riceve la prossima tranche. Non cancella niente e non cambia il perimetro:
// sceglie fra righe che la selezione ha gia' ammesso. Ma e' una decisione, non un numero da mostrare,
// e va misurata.
const fs = require('fs'); const path = require('path');
const R = path.resolve(__dirname, '..', '..');
const RE = require(path.join(R, 'lib', 'rewards', 'realistic-estimate'));
const SDC = require(path.join(R, 'lib', 'rewards', 'size-da-capitale'));
const TCF = require(path.join(R, 'lib', 'maker', 'trigger-capitale-fermo'));

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const clampPrice = (m) => Math.max(0.01, Math.min(0.99, m));
const CAP = 61.25, D = 2.05, V = 4.5;
const pc = SDC.costoCoppiaAllaDistanza(D);

const BOARD = JSON.parse(fs.readFileSync(path.join(R, 'data', 'liquidity-rewards.json'), 'utf8'));
const MER = Array.isArray(BOARD) ? BOARD : BOARD.markets;
const ORD = JSON.parse(fs.readFileSync(path.join(R, 'data', 'ricerca', 'ordini-vivi-21ago.json'), 'utf8'));
const LIBRO = new Set(ORD.ordini.map((o) => String(o.market).toLowerCase()));
const SEL = require(path.join(R, 'lib', 'maker', 'selezione-mercati'));
const ora = Date.now();

/** `realisticEstimate` con la size VECCHIA, riprodotta qui: la produzione ormai porta quella nuova. */
function stimaVecchia(inp) {
  const S = RE.placementScore(inp.offsetCents, inp.maxSpreadCents);
  const price = fin(inp.mid) ? clampPrice(inp.mid) : null;
  const size = (fin(inp.capitalUsd) && price) ? (inp.capitalUsd / 2) / price : null;
  const nuova = RE.realisticEstimate(inp);
  if (!fin(nuova.realisticPerDay) || size == null || !fin(inp.competitorQ)) return nuova.realisticPerDay;
  // Si sostituisce SOLO il fattore che dipende dalla size, lasciando intatti gli altri quattro.
  const sizeNuova = SDC.sharePerLato({ capitaleUsd: inp.capitalUsd, pairCostUsd: pc }).shares;
  const fN = RE.placementShareFactor(sizeNuova, inp.competitorQ, S);
  const fV = RE.placementShareFactor(size, inp.competitorQ, S);
  const cN = RE.credibleShareFactor(sizeNuova, inp.competitorQ);
  const cV = RE.credibleShareFactor(size, inp.competitorQ);
  if (!fin(fN) || !fin(fV) || fN === 0 || !cN || !cV) return nuova.realisticPerDay;
  return nuova.realisticPerDay * (fV / fN) * (cV.factor / cN.factor);
}

const righe = [];
for (const m of MER) {
  const v = Number(m.rewardsMaxSpread), mid = Number(m.mid), pool = Number(m.rewardsDailyRate);
  const depth = Number(m.existing_depth_usd);
  if (!(v > 0) || !fin(mid) || !fin(pool) || !fin(depth)) continue;
  if (!SEL.valutaAmmissibilita(m, { ora }).ammissibile) continue;
  const qShares = depth / clampPrice(mid);
  const inp = { grossPerDay: pool * 0.02, pot: pool, competitorQ: qShares, mid, capitalUsd: CAP,
    offsetCents: D, maxSpreadCents: v, measuredCostPerDay: 0, observedFills: 2,
    poolTrend: null, midRows: null, refreshesPerDay: 0 };
  const nuova = RE.realisticEstimate(inp).realisticPerDay;
  const vecchia = stimaVecchia(inp);
  righe.push({ marketId: String(m.conditionId).toLowerCase(), titolo: String(m.question || '').slice(0, 40),
    mid, capital: CAP, netPerDay: null, grossPerDay: inp.grossPerDay,
    realisticBestPerDay: nuova, _vecchia: vecchia, aLibro: LIBRO.has(String(m.conditionId).toLowerCase()) });
}

const ordina = (campo) => [...righe].sort((a, b) => (b[campo] ?? -Infinity) - (a[campo] ?? -Infinity));
const dopo = ordina('realisticBestPerDay'), prima = ordina('_vecchia');

console.log(`righe ammissibili valutate: ${righe.length} · capitale di riga $${CAP} · offset ${D}¢ · coppia ${pc}\n`);
console.log('  #  PRIMA (size (C/2)/mid)                        $/g   |  DOPO (size C/coppia)                          $/g');
for (let i = 0; i < Math.min(12, righe.length); i++) {
  const a = prima[i], b = dopo[i];
  const f = (r, k) => `${r.aLibro ? '◆' : ' '}${r.titolo.padEnd(41)} ${(r[k] ?? 0).toFixed(4).padStart(8)}`;
  console.log(` ${String(i + 1).padStart(2)}  ${f(a, '_vecchia')}  |  ${f(b, 'realisticBestPerDay')}`);
}
console.log(`\nla PRIMA riga (quella che scegliMercato finanzierebbe per prima):`);
console.log(`   PRIMA: ${prima[0].titolo}  (mid ${prima[0].mid})`);
console.log(`   DOPO : ${dopo[0].titolo}  (mid ${dopo[0].mid})`);
console.log(`   ⇒ la scelta ${prima[0].marketId === dopo[0].marketId ? 'NON cambia' : 'CAMBIA'}`);

// La funzione VERA, con lo stesso insieme di righe, per vedere cosa sceglie davvero.
const scelta = (campo) => {
  const rr = righe.map((r) => ({ ...r, realisticBestPerDay: r[campo] }));
  const s = TCF.scegliMercato({ righe: rr, disponibileUsd: 200, notionalePerMercato: {}, capPerMercatoUsd: CAP });
  return s && s.scelto ? s.scelto : (s && s.marketId ? s : null);
};
const sv = scelta('_vecchia'), sn = scelta('realisticBestPerDay');
const nome = (x) => { if (!x) return 'nessuna'; const id = String(x.marketId || x.id || '').toLowerCase(); const r = righe.find((y) => y.marketId === id); return r ? r.titolo : id.slice(0, 14); };
console.log("\nscegliMercato (funzione VERA):  PRIMA -> " + nome(sv) + "   DOPO -> " + nome(sn));
fs.writeFileSync(path.join(R, 'data', 'ricerca', 'd2-ordine-minciclo.json'),
  JSON.stringify({ generatoIl: new Date().toISOString(), capital: CAP, offsetC: D, coppia: pc, righe,
    ordinePrima: prima.map((r) => r.titolo), ordineDopo: dopo.map((r) => r.titolo) }, null, 1));
