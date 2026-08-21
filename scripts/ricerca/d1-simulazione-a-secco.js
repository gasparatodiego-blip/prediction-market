'use strict';
// scripts/ricerca/d1-simulazione-a-secco.js — D1 di rewardScore: COSA CAMBIA, PRIMA DI SCRIVERE.
// SOLA LETTURA. Le funzioni corrette vivono QUI, non in lib/: è la simulazione a secco.
//
// IL DENOMINATORE CORRETTO, derivato dalla formula del venue (NON per simmetria col piazzamento):
//   il venue scora SHARE (`S(v,s)·size_i`), mai capitale. Una posa BILATERALE SIMMETRICA a distanza
//   `s` — l'ipotesi che la funzione stessa dichiara nel proprio docstring — costa per share:
//       bid YES a (mid − s/100)  +  ask YES a (mid + s/100), finanziato comprando NO a 1−(mid+s/100)
//       ⇒ pairCost = (mid − s/100) + (1 − mid − s/100) = 1 − 2s/100      ← il mid si CANCELLA
//   quindi size = capital / (1 − 2s/100). `capital/mid` è la size di una posa UNILATERALE che spende
//   tutto sulla gamba YES: finanzia UN lato e ne scora DUE (`qMin(Qu,Qu,mid)`).
//
// ⚠ LA FONTE È `data/liquidity-rewards.json`, il board GREZZO di agent24 — quello che agent41 legge
// davvero (`agent41:1222 BOARD_REWARD`), non il normalizzato di /tmp.

const fs = require('fs'); const path = require('path');
const RADICE = path.resolve(__dirname, '..', '..');
const { scoreOrder, qMin, recoverCompetitorQ } = require(path.join(RADICE, 'lib', 'rewardScore'));
const { raggioBandaCents } = require(path.join(RADICE, 'lib', 'banda-premiante'));
const SEL = require(path.join(RADICE, 'lib', 'maker', 'selezione-mercati'));

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const CAPITAL_LEVELS = [500, 5000, 50000];
const REF = 1000;

function pairCost(s_cents, mid) {
  if (!fin(s_cents) || s_cents < 0 || !fin(mid)) return null;
  const d = s_cents / 100;
  if (!(mid - d > 0) || !(mid + d < 1)) return null;   // bid o ask fuori da (0,1): posa non esprimibile
  const pc = 1 - 2 * d;
  return pc > 0 ? pc : null;
}
const sizeVecchia = (c, mid) => c / Math.max(0.01, Math.min(0.99, mid));
const sizeNuova = (c, mid, s) => { const pc = pairCost(s, mid); return pc == null ? null : c / pc; };

function unLivello({ Q, mid, v_cents, minSize, pool, capital, nuovo }) {
  const v = raggioBandaCents(v_cents); if (v == null) return null;
  const s = v / 2;
  const size = nuovo ? sizeNuova(capital, mid, s) : sizeVecchia(capital, mid);
  if (size == null) return { share: 0, grossRewardDay: 0, aboveMin: false, size: null };
  const aboveMin = size >= minSize;
  const sc = scoreOrder(s, v);
  if (!aboveMin || sc === 0) return { share: 0, grossRewardDay: 0, aboveMin, size };
  const Qu = qMin(sc * size, sc * size, mid);
  const share = Qu / (Qu + Q);
  return { share, grossRewardDay: share * pool, aboveMin, size };
}
function unRefShare({ Q, mid, v_cents, minSize, nuovo }) {
  const v = raggioBandaCents(v_cents); if (v == null) return null;
  const s = v / 4;
  const size = nuovo ? sizeNuova(REF, mid, s) : sizeVecchia(REF, mid);
  if (size == null || size < (minSize || 0)) return 0;
  const sc = scoreOrder(s, v);
  const Qu = qMin(sc * size, sc * size, mid);
  return Qu / (Qu + Q);
}
/** `punteggio()` della selezione, rifatto su un insieme di livelli qualsiasi. Stessa regola: il primo
 *  livello di capitale (ordinato crescente) con `grossRewardDay > 0`. */
function punteggioDaLivelli(livelli) {
  for (const k of Object.keys(livelli).map(Number).sort((a, b) => a - b)) {
    const g = livelli[String(k)] && livelli[String(k)].grossRewardDay;
    if (fin(g) && g > 0) return g;
  }
  return 0;
}

const BOARD = JSON.parse(fs.readFileSync(path.join(RADICE, 'data', 'liquidity-rewards.json'), 'utf8'));
const MERCATI = Array.isArray(BOARD) ? BOARD : (BOARD.markets || []);
const ORD = JSON.parse(fs.readFileSync(path.join(RADICE, 'data', 'ricerca', 'ordini-vivi-21ago.json'), 'utf8'));
const A_LIBRO = new Set([...new Set(ORD.ordini.map((o) => String(o.market).toLowerCase()))]);
const ora = Date.now();

const righe = []; let nonEsprimibili = 0, QnonRecuperabile = 0;
for (const m of MERCATI) {
  const v = Number(m.rewardsMaxSpread), minSize = Number(m.rewardsMinSize) || 0;
  const mid = Number(m.mid), pool = Number(m.rewardsDailyRate);
  if (!(v > 0) || !fin(mid) || !fin(pool) || !m.levels) continue;
  const Q = recoverCompetitorQ(m.levels, mid, v, minSize);   // esatto: l'errore si cancella nel giro
  if (Q == null) { QnonRecuperabile++; continue; }
  const lv = {}, ln = {};
  for (const C of CAPITAL_LEVELS) {
    lv[String(C)] = unLivello({ Q, mid, v_cents: v, minSize, pool, capital: C, nuovo: false });
    ln[String(C)] = unLivello({ Q, mid, v_cents: v, minSize, pool, capital: C, nuovo: true });
  }
  if (ln['500'].size == null) nonEsprimibili++;
  const amm = SEL.valutaAmmissibilita(m, { ora });
  righe.push({
    id: String(m.conditionId).toLowerCase(), titolo: String(m.question || '').slice(0, 42),
    mid, v, minSize, pool, Q: +Q.toFixed(1),
    aLibro: A_LIBRO.has(String(m.conditionId).toLowerCase()),
    ammissibile: !!amm.ammissibile, motivo: amm.motivo || null,
    // il punteggio COME LO LEGGE la selezione, dai livelli SALVATI e dai livelli CORRETTI
    pSalvato: punteggioDaLivelli(m.levels),
    pVecchio: punteggioDaLivelli(lv), pNuovo: punteggioDaLivelli(ln),
    sizeVecchia: Math.round(lv['500'].size), sizeNuova: ln['500'].size ? Math.round(ln['500'].size) : null,
    aboveMinVecchio: lv['500'].aboveMin, aboveMinNuovo: ln['500'].aboveMin,
    refVecchio: +unRefShare({ Q, mid, v_cents: v, minSize, nuovo: false }).toFixed(6),
    refNuovo: +unRefShare({ Q, mid, v_cents: v, minSize, nuovo: true }).toFixed(6),
  });
}
for (const r of righe) r.fattore = r.pNuovo > 0 ? +(r.pVecchio / r.pNuovo).toFixed(2) : null;

const amm = righe.filter((r) => r.ammissibile);
const ord = (k) => [...amm].sort((a, b) => (b[k] || 0) - (a[k] || 0) || (a.id < b.id ? -1 : 1));
const perV = ord('pVecchio'), perN = ord('pNuovo');

console.log(`board grezzo: ${MERCATI.length} righe · ${righe.length} scorabili · Q non recuperabile su ${QnonRecuperabile}`);
console.log(`AMMISSIBILI (funzione vera valutaAmmissibilita): ${amm.length}`);
console.log(`pose non esprimibili col nuovo denominatore: ${nonEsprimibili}`);
console.log(`controllo: |pSalvato − pVecchio| max = ${Math.max(...righe.map((r) => Math.abs(r.pSalvato - r.pVecchio))).toExponential(2)}  (0 ⇒ la mia copia del VECCHIO riproduce la produzione)\n`);

console.log('═══ I MERCATI A LIBRO — fattore d\'errore ═══');
console.log('mercato                                       mid     $/g VECCHIO   $/g NUOVO  fattore   size 500$: vecchia→nuova');
for (const r of righe.filter((x) => x.aLibro)) {
  console.log(`${r.titolo.padEnd(43)} ${r.mid.toFixed(4).padStart(6)}  ${r.pVecchio.toFixed(4).padStart(11)}  ${r.pNuovo.toFixed(4).padStart(10)}  ${String(r.fattore).padStart(6)}×  ${String(r.sizeVecchia).padStart(6)} → ${r.sizeNuova}`);
}

console.log('\n═══ CLASSIFICA DEGLI AMMISSIBILI — PRIMA vs DOPO (ordinamento LORDO, il ripiego di `punteggio()`) ═══');
console.log('  #  PRIMA (produzione di adesso)                        $/g  |  DOPO (corretto)                                    $/g');
for (let i = 0; i < amm.length; i++) {
  const a = perV[i], b = perN[i];
  const f = (r, k) => `${r.aLibro ? '◆' : ' '}${r.titolo.padEnd(43)} ${r[k].toFixed(4).padStart(8)}`;
  console.log(` ${String(i + 1).padStart(2)}  ${f(a, 'pVecchio')}  |  ${f(b, 'pNuovo')}`);
}
const N = 5;
const topV = perV.slice(0, N).map((r) => r.id), topN = perN.slice(0, N).map((r) => r.id);
const usciti = topV.filter((x) => !topN.includes(x)), entrati = topN.filter((x) => !topV.includes(x));
const nome = (i) => righe.find((r) => r.id === i).titolo;
console.log(`\nprimi ${N} identici? ${usciti.length || entrati.length ? 'NO' : 'SI'}`);
if (usciti.length) console.log('  uscirebbero:', usciti.map(nome).join(' · '));
if (entrati.length) console.log('  entrerebbero:', entrati.map(nome).join(' · '));
const libro = righe.filter((r) => r.aLibro);
console.log(`\nmercati A LIBRO: ${libro.length} · ammissibili ora: ${libro.filter((r) => r.ammissibile).length}`);
for (const r of libro) console.log(`   ${r.aLibro ? '◆' : ' '}${r.titolo.padEnd(43)} ammissibile=${r.ammissibile}${r.motivo ? ' (' + r.motivo + ')' : ''} · rango VECCHIO ${perV.findIndex((x) => x.id === r.id) + 1 || '—'} · rango NUOVO ${perN.findIndex((x) => x.id === r.id) + 1 || '—'}`);
const cambiaMin = righe.filter((r) => r.aboveMinVecchio !== r.aboveMinNuovo);
console.log('\nmercati in cui cambia aboveMin (il gate del livello): ' + cambiaMin.length);
for (const r of cambiaMin.slice(0, 12)) console.log(`   ${r.titolo.padEnd(43)} mid=${r.mid.toFixed(3)} minSize=${r.minSize} ${r.aboveMinVecchio}→${r.aboveMinNuovo} (size ${r.sizeVecchia}→${r.sizeNuova}) ammissibile=${r.ammissibile}`);

fs.writeFileSync(path.join(RADICE, 'data', 'ricerca', 'd1-simulazione-a-secco.json'),
  JSON.stringify({ generatoIl: new Date().toISOString(), nonEsprimibili, righe,
    classificaPrima: perV.map((r) => ({ id: r.id, t: r.titolo, v: r.pVecchio })),
    classificaDopo: perN.map((r) => ({ id: r.id, t: r.titolo, v: r.pNuovo })) }, null, 1));
