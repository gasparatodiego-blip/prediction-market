'use strict';
/**
 * scripts/ricerca/tetto-6125.js — SOLA LETTURA.
 *
 * Cosa cambia sul board VIVO portando il tetto per mercato da $32,67 a $61,25.
 *
 * Non si assume niente: si rifà la catena con le FUNZIONI VERE del repo (orizzonte,
 * pavimento premiante, finestra di mid dal tetto per ordine, quotabilità con la
 * banda corretta) prima e dopo, e si confrontano i due esiti mercato per mercato.
 *
 * ⚠ La finestra di mid è il pezzo che sorprende: `MARGINE_ORDINE_USD` è fisso a $5,
 * quindi crescendo il tetto il margine pesa RELATIVAMENTE meno e la finestra si
 * STRINGE. È l'effetto già annotato in §5-bis p.117, qui misurato sul board di oggi.
 *
 * Nessuna scrittura fuori da data/ricerca/. Nessun ordine, nessuna credenziale.
 */

const fs = require('fs');
const path = require('path');
const conc = require('../../lib/rewards/concentration');
const { horizonVerdict } = require('../../lib/rewards/horizon');
const { verificaRiga } = require('../../lib/maker/coerenza-soglie');
const { planBehindBest } = require('../../lib/maker/top-of-book');
const { raggioBandaCents } = require('../../lib/banda-premiante');

const OUT = path.join(__dirname, '..', '..', 'data', 'ricerca', 'tetto-6125.json');
const BOARD = path.join(__dirname, '..', '..', 'data', 'liquidity-rewards.json');
const COMP = path.join(__dirname, '..', '..', 'data', 'ricerca', 'banda-competitivita.json');

const CAPITALE = 651.92;                 // letto on-chain il 13/08 sera
const COSTO_COPPIA = 0.98;
const MARGINE_ORDINE_USD = conc.MARGINE_ORDINE_USD;
const MAX_CREDIBLE_SHARE = 0.60;         // realistic-estimate.DEFAULTS
const REWARD_MISURATO_GIORNO = 4.40;     // §5-bis p.152 — eredita i 4 giorni su 30
const MAX_OPEN_NOTIONAL = 600;

const S = (s, v) => (!(v > 0) || s >= v) ? 0 : ((v - s) / v) ** 2;
const qMin = (qb, qa, mid) => (mid < 0.10 || mid > 0.90)
  ? Math.min(qb, qa) : Math.max(Math.min(qb, qa), Math.max(qb / 3, qa / 3));
const sp = (p) => +(1 - p).toFixed(10);

// La finestra di mid che UN DATO tetto concede, con la stessa algebra di
// concentration.finestraMid ma parametrica sul tetto (la funzione vera legge il
// tetto in vigore, e qui servono entrambi gli scenari).
function finestra(tetto) {
  const pMax = COSTO_COPPIA * (tetto / 2 + MARGINE_ORDINE_USD) / tetto;
  const hi = Math.min(0.99, +pMax.toFixed(3));
  return { lo: +(1 - hi).toFixed(3), hi, tettoOrdine: +(tetto / 2 + MARGINE_ORDINE_USD).toFixed(2) };
}

function quotabile(m) {
  const mid = m.mid, tick = m.tickSize;
  if (!(mid > 0 && mid < 1) || !(tick > 0)) return null;
  const r = raggioBandaCents(m.rewardsMaxSpread);
  if (r == null) return null;
  const a = planBehindBest({ bestOther: m.bestBid > 0 ? m.bestBid : null, tick, scoringMid: mid, bandRadiusCents: r });
  const v = planBehindBest({ bestOther: m.bestAsk > 0 ? sp(m.bestAsk) : null, tick, scoringMid: sp(mid), bandRadiusCents: r });
  if (a.quotabile === false || v.quotabile === false) return false;
  return a.ok === true && v.ok === true;
}

const board = JSON.parse(fs.readFileSync(BOARD, 'utf8'));
const comp = JSON.parse(fs.readFileSync(COMP, 'utf8'));
const qPerCid = new Map(comp.righe.map(r => [r.conditionId, r]));
const ora = Date.now();

const righe = [];
for (const m of board.markets || []) {
  if (!(m.rewardsMaxSpread > 0) || !(m.rewardsDailyRate > 0)) continue;
  const h = horizonVerdict({ endDate: m.endDate, nowMs: ora });
  righe.push({
    slug: (m.slug || '').slice(0, 46),
    conditionId: m.conditionId,
    minSize: m.rewardsMinSize,
    pavimento: conc.pavimentoPremiante(m.rewardsMinSize),
    mid: m.mid,
    pool: m.rewardsDailyRate,
    maxSpread: m.rewardsMaxSpread,
    orizzonteStato: h ? h.state : null,
    // `ignota` NON esclude (§4.4): si tolgono solo i NO detti — scaduto/troppo lontano.
    orizzonteOk: h ? (h.state !== 'resolved' && h.state !== 'too-far') : false,
    quotabile: quotabile(m),
    q: qPerCid.get(m.conditionId) || null,
  });
}

// Il reward modellato di un mercato alla distanza mediana reale (1,0¢), con il
// tetto di credibilità in vigore. Serve a ORDINARE e a dare un rapporto, non un
// livello: il livello si ancora al consuntivo misurato.
function rewardModellato(r, capMercato) {
  if (!r.q) return 0;
  const sc = S(1.0, r.maxSpread);
  if (sc <= 0) return 0;
  const share = capMercato / COSTO_COPPIA;
  const Qu = qMin(sc * share, sc * share, r.q.mid);
  const Qc = qMin(r.q.larga.qBids, r.q.larga.qAsks, r.q.mid);
  return Math.min(Qu / (Qu + Qc), MAX_CREDIBLE_SHARE) * r.pool;
}

function scenario(nome, tetto) {
  const f = finestra(tetto);
  const passa = righe.filter(r => r.orizzonteOk)
    .map(r => {
      const finanziabile = r.pavimento != null && r.pavimento <= tetto + 1e-9;
      // LA FUNZIONE VERA: la finestra di mid non ESCLUDE, RIDUCE. La riga muore solo se il
      // massimo compatibile col tetto per ordine scende sotto il pavimento della RIGA
      // (minSize × costoCoppia — senza il margine del 25%, che vive in mercatoAmmissibile).
      const v = verificaRiga(
        { marketId: r.conditionId, capital: tetto, pairCostUsd: COSTO_COPPIA, mid: r.mid, minSizeShares: r.minSize },
        { capPerMercatoUsd: tetto, tettoOrdineUsd: f.tettoOrdine, pavimentoRigaUsd: +(r.minSize * COSTO_COPPIA).toFixed(2) },
      );
      return { ...r, finanziabile, capitaleEffettivo: v.ok ? v.capitale : null,
               ridotta: v.ok ? v.adattata : null, scartataDaCoerenza: !v.ok,
               fMin: v.ok && v.capitale > 0 ? +(r.minSize * COSTO_COPPIA / v.capitale).toFixed(3) : null };
    });
  const utilizzabili = passa.filter(r => r.finanziabile && !r.scartataDaCoerenza && r.quotabile === true);
  const perCapitale = Math.floor(CAPITALE / tetto);
  // Si riempie fino a esaurire il capitale VERO, riga per riga al suo capitale effettivo.
  const ordinati = utilizzabili
    .map(r => ({ r, usd: rewardModellato(r, r.capitaleEffettivo) }))
    .sort((a, b) => b.usd - a.usd);
  const scelti = []; let resta = CAPITALE;
  for (const x of ordinati) {
    if (scelti.length >= conc.MAX_MERCATI) break;
    if (x.r.capitaleEffettivo > resta) continue;
    scelti.push(x); resta -= x.r.capitaleEffettivo;
  }
  const lordo = scelti.reduce((a, x) => a + x.usd, 0);
  const perMinSize = {};
  for (const x of scelti) perMinSize[x.r.minSize] = (perMinSize[x.r.minSize] || 0) + 1;
  const fMinPesato = scelti.length
    ? scelti.reduce((a, x) => a + (x.r.minSize * COSTO_COPPIA / x.r.capitaleEffettivo), 0) / scelti.length : null;
  return {
    nome, tetto, finestraMid: f,
    orizzonteOk: passa.length,
    finanziabili: passa.filter(r => r.finanziabile).length,
    finanziabiliNonScartateDaCoerenza: passa.filter(r => r.finanziabile && !r.scartataDaCoerenza).length,
    ridottePerFinestraMid: passa.filter(r => r.finanziabile && r.ridotta === true).length,
    utilizzabili: utilizzabili.length,
    mercatiPerCapitale: perCapitale,
    mercatiCoperti: scelti.length,
    capitaleImpiegato: +(CAPITALE - resta).toFixed(2),
    capitaleInCassa: +resta.toFixed(2),
    lordoModellatoGiorno: +lordo.toFixed(2),
    mixMinSize: perMinSize,
    fMinMedio: fMinPesato != null ? +fMinPesato.toFixed(3) : null,
    fMinPerScaglione: { 20: +(20 * COSTO_COPPIA / tetto).toFixed(3), 50: +(50 * COSTO_COPPIA / tetto).toFixed(3) },
    // Il tetto di esposizione conta i fill RICONCILIATI, non gli ordini a riposo:
    // morde solo se le gambe si riempiono davvero.
    mercatiPrimaDelTettoEsposizione: Math.floor(MAX_OPEN_NOTIONAL / tetto),
    capitaleMedioPerMercato: scelti.length ? +((CAPITALE - resta) / scelti.length).toFixed(2) : null,
    scelti: scelti.map(x => ({ slug: x.r.slug, minSize: x.r.minSize, mid: x.r.mid, pool: x.r.pool,
                               capitale: x.r.capitaleEffettivo, usd: +x.usd.toFixed(3) })),
  };
}

const A = scenario('tetto attuale $32,67', 32.67);
const B = scenario('tetto proposto $61,25', 61.25);
// La curva completa, per rispondere a «61,25 o un valore piu' prudente?».
const SWEEP = [32.67, 40, 45, 50, 55, 61.25, 65, 70, 80].map(t => scenario('t' + t, t));

const res = { generatoAl: new Date().toISOString(), capitale: CAPITALE, board: righe.length, scenari: [A, B], sweep: SWEEP };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(res, null, 1));

console.log(`board con montepremi: ${righe.length} mercati · capitale $${CAPITALE}\n`);
const riga = (etichetta, a, b) => console.log(`  ${etichetta.padEnd(42)} ${String(a).padStart(12)} ${String(b).padStart(12)}`);
console.log(`  ${''.padEnd(42)} ${'$32,67'.padStart(12)} ${'$61,25'.padStart(12)}`);
riga('finestra di mid ammessa', `${A.finestraMid.lo}–${A.finestraMid.hi}`, `${B.finestraMid.lo}–${B.finestraMid.hi}`);
riga('tetto per ORDINE derivato', `$${A.finestraMid.tettoOrdine}`, `$${B.finestraMid.tettoOrdine}`);
riga('passano l\'orizzonte', A.orizzonteOk, B.orizzonteOk);
riga('  + finanziabili (pavimento ≤ tetto)', A.finanziabili, B.finanziabili);
riga('  + non scartati da coerenza-soglie', A.finanziabiliNonScartateDaCoerenza, B.finanziabiliNonScartateDaCoerenza);
riga('    (di cui RIDOTTI dalla finestra di mid)', A.ridottePerFinestraMid, B.ridottePerFinestraMid);
riga('  + quotabili (banda corretta)', A.utilizzabili, B.utilizzabili);
riga('mercati che il capitale finanzia', A.mercatiPerCapitale, B.mercatiPerCapitale);
riga('MERCATI COPERTI DAVVERO', A.mercatiCoperti, B.mercatiCoperti);
riga('capitale impiegato', `$${A.capitaleImpiegato}`, `$${B.capitaleImpiegato}`);
riga('capitale che resta in cassa', `$${A.capitaleInCassa}`, `$${B.capitaleInCassa}`);
riga('lordo modellato $/giorno', A.lordoModellatoGiorno, B.lordoModellatoGiorno);
riga('f_min medio dei mercati scelti', A.fMinMedio, B.fMinMedio);
riga('  f_min su un mercato minSize 20', A.fMinPerScaglione[20], B.fMinPerScaglione[20]);
riga('  f_min su un mercato minSize 50', A.fMinPerScaglione[50], B.fMinPerScaglione[50]);
riga('capitale medio per mercato', `$${A.capitaleMedioPerMercato}`, `$${B.capitaleMedioPerMercato}`);
riga('mix per minSize', JSON.stringify(A.mixMinSize), JSON.stringify(B.mixMinSize));
riga('mercati prima del tetto esposizione $600', A.mercatiPrimaDelTettoEsposizione, B.mercatiPrimaDelTettoEsposizione);

const rap = A.lordoModellatoGiorno > 0 ? B.lordoModellatoGiorno / A.lordoModellatoGiorno : null;
console.log(`\nrapporto del lordo modellato: ${rap != null ? rap.toFixed(3) + '×' : 'n/d'}`);
console.log(`ancorato al consuntivo misurato $${REWARD_MISURATO_GIORNO}/g ⇒ $${rap != null ? (REWARD_MISURATO_GIORNO * rap).toFixed(2) : '—'}/g`);
console.log('⚠ il livello eredita i 4 giorni di presenza su 30; il rapporto no.');
console.log('\n══ LA CURVA: quale tetto conviene davvero ══');
console.log('  tetto  ordine  finestra mid   coperti  capitale   lordo/g   f_min medio   peggior f_min');
for (const x of SWEEP) {
  const peggio = x.scelti.length ? Math.max(...x.scelti.map(y => y.minSize * COSTO_COPPIA / y.capitale)) : null;
  console.log('  ' + ('$' + x.tetto).padStart(6) + ('$' + x.finestraMid.tettoOrdine).padStart(8)
    + (x.finestraMid.lo + '-' + x.finestraMid.hi).padStart(14) + String(x.mercatiCoperti).padStart(9)
    + ('$' + x.capitaleImpiegato).padStart(10) + String(x.lordoModellatoGiorno).padStart(10)
    + String(x.fMinMedio).padStart(14) + (peggio != null ? peggio.toFixed(3) : '—').padStart(15));
}
console.log(`\nscritto in ${OUT}`);
