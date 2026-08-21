'use strict';
// scripts/ricerca/frontiera-5-dollari.js — SOLA LETTURA.
// Domanda: esiste una configurazione che rende $5/giorno con il capitale disponibile?
//
// FORMULA USATA, DICHIARATA: la formula del venue ancorata al COSTO DELLA COPPIA.
//   · lib/banda-premiante.raggioBandaCents            v = maxSpread (NON maxSpread/2)
//   · lib/rewards/size-da-capitale.costoCoppiaAllaDistanza   1 - 2d   (la SSOT di ef6be4d)
//   · lib/rewardScore.recoverCompetitorQ              Qc, inversa esatta dei `levels` del board
//   · lib/rewardScore.quadraticUserShare              share = Qu/(Qu+Qc), Qu = S(v,s)*size
// NON si usa realistic-estimate: qui serve la sola algebra del venue, senza le correzioni di
// credibilita'. (Verificato comunque che realistic-estimate:269 E' corretto da 1a8e89a.)
const fs = require('fs');
const path = require('path');
const RS  = require('../../lib/rewardScore');
const SDC = require('../../lib/rewards/size-da-capitale');

const BOARD = path.join(__dirname, '..', '..', 'data', 'liquidity-rewards.json');
const OUT   = path.join(__dirname, '..', '..', 'data', 'ricerca');

const board = JSON.parse(fs.readFileSync(BOARD, 'utf8'));
const ORA   = Date.parse(board.meta.generatedAt);
const fin   = (x) => typeof x === 'number' && Number.isFinite(x);

// ── LE RIGHE SCORABILI ────────────────────────────────────────────────────────────────────────
// Si scarta chi non ha Qc misurabile: con Qc=0 la formula attribuirebbe il 100% del montepremi,
// che e' la formula usata fuori dal suo dominio (stessa regola di realistic-estimate `empty-book`).
const righe = [];
const scartate = { senzaQc: 0, qcZero: 0, senzaRate: 0, senzaBanda: 0, senzaScadenza: 0 };
for (const m of board.markets) {
  const v = m.rewardsMaxSpread, mid = m.mid, minSize = m.rewardsMinSize, rate = m.rewardsDailyRate;
  if (!fin(v) || v <= 0) { scartate.senzaBanda++; continue; }
  if (!fin(rate) || rate <= 0) { scartate.senzaRate++; continue; }
  const cQ = RS.recoverCompetitorQ(m.levels, mid, v, minSize);
  if (cQ == null) { scartate.senzaQc++; continue; }
  if (!(cQ > 0))  { scartate.qcZero++;  continue; }
  const end = m.endDate ? Date.parse(m.endDate) : NaN;
  if (!Number.isFinite(end)) { scartate.senzaScadenza++; continue; }
  righe.push({
    id: m.conditionId, q: (m.groupItemTitle ? m.groupItemTitle + ' — ' : '') + m.question,
    v, mid, minSize, rate, cQ,
    oreAScadenza: (end - ORA) / 3600000,
    categoria: m.category || null,
    depth: m.existing_depth_usd,
    tick: m.tickSize,
  });
}

// ── IL RENDIMENTO DI UN MERCATO A CAPITALE C E DISTANZA d ─────────────────────────────────────
// share = a*C/(a*C+Qc) con a = S(v,d)/(1-2d)   [derivato: Qu = S*size, size = C/(1-2d),
// e qMin(Q,Q,mid) = Q per una posa simmetrica, su entrambi i rami]. Verificato contro
// quadraticUserShare in `verifica()` piu' sotto: e' la stessa funzione, non una copia.
function coeff(r, dCents) {
  const pc = SDC.costoCoppiaAllaDistanza(dCents);
  if (pc == null || pc <= 0) return null;
  if (!(r.mid - dCents / 100 > 0) || !(r.mid + dCents / 100 < 1)) return null;   // posa esprimibile
  const S = ((r.v - dCents) / r.v) ** 2;
  if (!(S > 0)) return null;
  return { a: S / pc, pc, S, cMin: r.minSize * pc };   // cMin = capitale minimo premiante VENUE
}
// ── LE DUE CORREZIONI CHE RENDONO IL NUMERO LEGGIBILE, ENTRAMBE DICHIARATE ───────────────────
// (1) TETTO DI CREDIBILITA' — la stessa regola di realistic-estimate (`maxCredibleShare = 0,60`):
//     `share -> 1` quando Qc -> 0 non e' un'opportunita', e' il mercato che spiega perche' nessuno
//     quota li'. Si taglia la quota a 0,60. MISURATO: senza, il board attribuisce quote > 90% su
//     libri con Qc = 0,2.
// (2) PRO-RATA SULLA VITA RESIDUA — un mercato che risolve fra H ore non puo' pagare un giorno
//     intero: al piu' `rate * min(1, H/24)`, e domani zero. ⚠ QUESTO E' INFERITO, non misurato:
//     il venue paga un bonifico AGGREGATO (§4.12) e nessun file attribuisce il premio al mercato.
const TETTO_CREDIBILE = 0.60;
function premio(r, C, dCents, opt = {}) {
  const k = coeff(r, dCents);
  if (!k || C < k.cMin) return 0;
  let share = (k.a * C) / (k.a * C + r.cQ);
  if (opt.tettoCredibile !== false) share = Math.min(share, TETTO_CREDIBILE);
  let rate = r.rate;
  if (opt.proRata) rate = rate * Math.max(0, Math.min(1, r.oreAScadenza / 24));
  return rate * share;
}
// prova che `premio` e la funzione di produzione coincidano
function verifica(dCents) {
  let peggio = 0;
  for (const r of righe.slice(0, 40)) {
    for (const C of [60, 200, 1000]) {
      const mio = premio(r, C, dCents, { tettoCredibile: false });
      const suo = RS.quadraticUserShare(r.cQ, r.mid, r.v, r.minSize, C, dCents) * r.rate;
      if (fin(suo)) peggio = Math.max(peggio, Math.abs(mio - suo));
    }
  }
  return peggio;
}

// ── LA FRONTIERA: ALLOCAZIONE OTTIMA A BUDGET K ───────────────────────────────────────────────
// reward(C) e' concavo in C (share = aC/(aC+Qc)), con un GRADINO al pavimento premiante. Si risolve
// col moltiplicatore di Lagrange: a valore marginale lambda, C*(lambda) = (sqrt(rate*a*Qc/lambda)-Qc)/a,
// poi si sceglie fra {0, cMin, C*} quello che massimizza reward - lambda*C. Si bisecca lambda sul
// budget. E' esatto per concavo+gradino, non un greedy approssimato.
function alloca(K, dCents, opts = {}) {
  const capMercato = opts.capMercato || Infinity;
  const maxMercati = opts.maxMercati || Infinity;
  const filtro     = opts.filtro || (() => true);
  const opt        = { tettoCredibile: opts.tettoCredibile, proRata: opts.proRata };
  const pavPianif  = opts.pavimentoPianificatore || false;   // minSize*0.98*1.25 invece del venue

  const cand = [];
  for (const r of righe) {
    if (!filtro(r)) continue;
    const k = coeff(r, dCents);
    if (!k) continue;
    const cMin = pavPianif ? +(r.minSize * 0.98 * 1.25).toFixed(2) : k.cMin;
    if (cMin > capMercato) continue;              // il tetto per mercato non arriva al pavimento
    cand.push({ r, k, cMin });
  }
  const scelta = (c, lambda) => {
    const { r, k, cMin } = c;
    let best = { C: 0, u: 0 };
    const cStar = (Math.sqrt(r.rate * k.a * r.cQ / lambda) - r.cQ) / k.a;
    // il tetto di credibilita' introduce un secondo punto di rottura: la C dove share = 0,60
    const cTetto = (TETTO_CREDIBILE / (1 - TETTO_CREDIBILE)) * r.cQ / k.a;
    for (const C of [cMin, Math.min(Math.max(cStar, cMin), capMercato), Math.min(Math.max(cTetto, cMin), capMercato)]) {
      if (!(C >= cMin) || C > capMercato) continue;
      const u = premio(r, C, dCents, opt) - lambda * C;
      if (u > best.u) best = { C, u };
    }
    return best.C;
  };
  const totale = (lambda) => {
    let out = cand.map(c => ({ c, C: scelta(c, lambda) })).filter(x => x.C > 0);
    out.sort((a, b) => premio(b.c.r, b.C, dCents, opt) - premio(a.c.r, a.C, dCents, opt));
    if (out.length > maxMercati) out = out.slice(0, maxMercati);
    return out;
  };
  // bisezione su lambda: lambda grande ⇒ poco capitale usato
  let lo = 1e-12, hi = 1e4;
  for (let i = 0; i < 300; i++) {
    const mid = Math.sqrt(lo * hi);
    const s = totale(mid).reduce((a, x) => a + x.C, 0);
    if (s > K) lo = mid; else hi = mid;
  }
  let sel = totale(hi);
  // il residuo di budget si versa sul mercato col miglior marginale (concavo ⇒ e' il completamento)
  let usato = sel.reduce((a, x) => a + x.C, 0);
  let giri = 0;
  while (K - usato > 0.5 && giri++ < 400) {
    let best = null;
    for (const x of sel) {
      if (x.C >= capMercato) continue;
      const passo = Math.min(1, capMercato - x.C, K - usato);
      const g = premio(x.c.r, x.C + passo, dCents, opt) - premio(x.c.r, x.C, dCents, opt);
      if (!best || g > best.g) best = { x, g, passo };
    }
    if (!best || best.g <= 0) break;
    best.x.C += best.passo; usato += best.passo;
  }
  const tot = sel.reduce((a, x) => a + premio(x.c.r, x.C, dCents, opt), 0);
  return { premioUsd: tot, capitaleUsato: usato, n: sel.length,
    righe: sel.map(x => ({ id: x.c.r.id, q: x.c.r.q, C: +x.C.toFixed(2),
      premio: +premio(x.c.r, x.C, dCents, opt).toFixed(4), rate: x.c.r.rate, cQ: +x.c.r.cQ.toFixed(1),
      minSize: x.c.r.minSize, v: x.c.r.v, ore: +x.c.r.oreAScadenza.toFixed(1) })) };
}

module.exports = { board, righe, scartate, coeff, premio, alloca, verifica, ORA, fin, TETTO_CREDIBILE };

if (require.main === module) {
  const D = Number(process.argv[2] || 2.5);
  console.log('board generato', board.meta.generatedAt, '· mercati', board.markets.length,
    '· soppressi per profondita', board.meta.suppressedThinDepth);
  console.log('righe scorabili', righe.length, '· scartate', JSON.stringify(scartate));
  console.log('divario max fra `premio` e quadraticUserShare:', verifica(D).toExponential(2), '(deve essere ~0)');
  console.log('');
  console.log('FRONTIERA a distanza', D, 'cent — nessun cap, nessun tetto, nessun limite di mercati');
  console.log('capitale   premio/g   mercati   $/1000$/g');
  for (const K of [214, 268, 500, 1000, 1495, 3000, 6000, 12000, 25000, 100000]) {
    const a = alloca(K, D);
    console.log(String('$' + K).padEnd(10), ('$' + a.premioUsd.toFixed(3)).padEnd(10),
      String(a.n).padEnd(9), (1000 * a.premioUsd / K).toFixed(3));
  }
  fs.writeFileSync(path.join(OUT, 'frontiera-riepilogo.json'), JSON.stringify({
    generatedAt: board.meta.generatedAt, distanzaCents: D, righeScorabili: righe.length, scartate,
  }, null, 1));
}
