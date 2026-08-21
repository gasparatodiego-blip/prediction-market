'use strict';
// scripts/ricerca/curva-capitale.js — SOLA LETTURA. La curva capitale → premio/giorno con
// allocazione ottima, sul modello ONESTO (prezzo da planBehindBest, quota contro il Q misurato).
//
// Il prezzo NON dipende dal capitale (planBehindBest guarda il libro, non la size), quindi per ogni
// mercato il premio e' in forma chiusa:  premio(C) = rate * min(0,60 ; f*C/(f*C+Qc)),  f = Qu per $.
// Concavo con un gradino al pavimento premiante ⇒ si risolve col moltiplicatore di Lagrange e si
// bisecca sul budget. Stessa struttura di `frontiera-5-dollari.alloca`, su righe migliori.
const fs = require('fs'); const path = require('path');
const F = require('./frontiera-onesta.js');
const OUT = path.join(__dirname, '..', '..', 'data', 'ricerca');
const CAP_SONDA = 61.25;

// ── LE RIGHE, con `f` estratto una volta ────────────────────────────────────────────────────────
function costruisci(filtro) {
  const out = [];
  for (const m of F.U.ammissibili) {
    if (!m.tokenIds || m.tokenIds.length < 2 || !(m.maxSpread > 0)) continue;
    if (filtro && !filtro(m)) continue;
    const r = F.valuta(m, CAP_SONDA);
    if (!r || r.stato !== 'ok') continue;
    // Qu(C) = Qu(CAP)/CAP * C  — lineare in C: S, pairCost e il ramo qMin non dipendono dalla size.
    const QuSonda = r.shareGrezza * r.cQ / (1 - r.shareGrezza);
    const f = QuSonda / CAP_SONDA;
    if (!(f > 0)) continue;
    out.push({ id: m.id, q: m.q, rate: m.rate, cQ: r.cQ, f, ore: m.ore, minSize: m.minSize,
      cMin: m.minSize * r.pairCost, visto: F.VISTI.has(m.id), spread: r.spread, dBid: r.dBid });
  }
  return out;
}
const premio = (r, C, cap) => {
  if (C < r.cMin) return 0;
  const q = r.f * Math.min(C, cap === undefined ? Infinity : cap);
  return r.rate * Math.min(F.TETTO_CREDIBILE, q / (q + r.cQ));
};

function alloca(righe, K, { capMercato = Infinity, maxMercati = Infinity } = {}) {
  const cand = righe.filter(r => r.cMin <= capMercato);
  const scelta = (r, lam) => {
    let best = { C: 0, u: 0 };
    const cStar = (Math.sqrt(r.rate * r.f * r.cQ / lam) - r.cQ) / r.f;
    const cTetto = (F.TETTO_CREDIBILE / (1 - F.TETTO_CREDIBILE)) * r.cQ / r.f;
    for (const C0 of [r.cMin, cStar, cTetto]) {
      const C = Math.min(Math.max(C0, r.cMin), capMercato);
      if (!(C >= r.cMin)) continue;
      const u = premio(r, C, capMercato) - lam * C;
      if (u > best.u) best = { C, u };
    }
    return best.C;
  };
  const insieme = (lam) => {
    let s = cand.map(r => ({ r, C: scelta(r, lam) })).filter(x => x.C > 0);
    s.sort((a, b) => premio(b.r, b.C, capMercato) - premio(a.r, a.C, capMercato));
    return s.length > maxMercati ? s.slice(0, maxMercati) : s;
  };
  let lo = 1e-14, hi = 1e5;
  for (let i = 0; i < 260; i++) {
    const mid = Math.sqrt(lo * hi);
    (insieme(mid).reduce((a, x) => a + x.C, 0) > K) ? lo = mid : hi = mid;
  }
  const sel = insieme(hi);
  let usato = sel.reduce((a, x) => a + x.C, 0), giri = 0;
  while (K - usato > 0.5 && giri++ < 600) {
    let best = null;
    for (const x of sel) {
      if (x.C >= capMercato) continue;
      const p = Math.min(1, capMercato - x.C, K - usato);
      const g = premio(x.r, x.C + p, capMercato) - premio(x.r, x.C, capMercato);
      if (!best || g > best.g) best = { x, g, p };
    }
    if (!best || best.g <= 0) break;
    best.x.C += best.p; usato += best.p;
  }
  return { premio: sel.reduce((a, x) => a + premio(x.r, x.C, capMercato), 0), usato, n: sel.length, sel };
}
module.exports = { costruisci, alloca, premio, CAP_SONDA };

if (require.main === module) {
  console.log('costruzione righe (prezzo vero, 1.556 ammissibili)…');
  const TUTTE = costruisci();
  const K = [268, 500, 1000, 1495, 3000, 6000, 12000, 30000, 100000, 1e6, 1e8];
  console.log('righe scorabili:', TUTTE.length);
  console.log('');
  const casi = [
    ['universo VERO, nessun cap',            TUTTE, {}],
    ['universo VERO, cap $61,25 + 5 mercati', TUTTE, { capMercato: 61.25, maxMercati: 5 }],
    ['universo VERO, cap $61,25, illimitati', TUTTE, { capMercato: 61.25 }],
    ['solo BOARD (i 22 visti), cap $61,25+5', TUTTE.filter(r => r.visto), { capMercato: 61.25, maxMercati: 5 }],
  ];
  console.log('scenario'.padEnd(40) + K.map(x => (x >= 1e6 ? (x / 1e6) + 'M' : '$' + x).padStart(10)).join(''));
  const salva = {};
  for (const [n, R, o] of casi) {
    const riga = K.map(k => alloca(R, k, o).premio);
    salva[n] = K.map((k, i) => ({ capitale: k, premio: +riga[i].toFixed(4) }));
    console.log(n.padEnd(40) + riga.map(x => ('$' + x.toFixed(2)).padStart(10)).join(''));
  }
  console.log('');
  // ── IL CAPITALE PER $5/GIORNO, per bisezione ──────────────────────────────────────────────────
  const perCinque = (R, o) => {
    if (alloca(R, 1e8, o).premio < 5) return null;
    let lo = 1, hi = 1e8;
    for (let i = 0; i < 90; i++) { const m = Math.sqrt(lo * hi); (alloca(R, m, o).premio < 5) ? lo = m : hi = m; }
    return hi;
  };
  console.log('CAPITALE PER $5/GIORNO:');
  for (const [n, R, o] of casi) {
    const c = perCinque(R, o);
    const asint = alloca(R, 1e8, o).premio;
    console.log('  ' + n.padEnd(40), c == null ? 'IRRAGGIUNGIBILE' : ('$' + c.toFixed(0)).padEnd(12),
      ' asintoto $' + asint.toFixed(2) + '/g');
  }
  fs.writeFileSync(path.join(OUT, 'curva-capitale.json'), JSON.stringify({
    lettoAl: new Date().toISOString(), righe: TUTTE.length, curve: salva,
    perCinque: Object.fromEntries(casi.map(([n, R, o]) => [n, { capitale: perCinque(R, o), asintoto: +alloca(R, 1e8, o).premio.toFixed(4) }])),
  }, null, 1));
  console.log('\nscritto data/ricerca/curva-capitale.json');
}
