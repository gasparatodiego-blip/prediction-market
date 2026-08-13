'use strict';
/**
 * scripts/ricerca/fine-scala-1090.js — SOLA LETTURA.
 *
 * Quanto costa stringere `end-of-scale` da [0,03 · 0,97] a [0,10 · 0,90]?
 *
 * La ragione per stringere: il venue ROMPE `Q_min` fuori da [0,10 · 0,90] — dentro, una gamba sola
 * matura comunque un terzo; fuori, **matura ZERO** (§5.2 p.22). Noi restiamo nudi spesso, quindi in
 * quella fascia il capitale della gamba nuda non produce niente.
 *
 * Il costo da misurare prima di decidere: quanti mercati del board vivo perdiamo, quanto montepremi,
 * e — questo è il punto — quanti di quelli sono davvero FINANZIABILI e QUOTABILI oggi, perché un
 * mercato che già non entra nel piano non è un costo.
 *
 * ⚠ Si misura anche col NUOVO orizzonte (0,50 g), perché è lì che la fascia si popola: mercati più
 * vicini alla risoluzione hanno mid più estremi.
 */

const fs = require('fs');
const path = require('path');
const conc = require('../../lib/rewards/concentration');
const { horizonVerdict, MIN_HORIZON_DAYS } = require('../../lib/rewards/horizon');
const { planBehindBest } = require('../../lib/maker/top-of-book');
const { raggioBandaCents } = require('../../lib/banda-premiante');

const OUT = path.join(__dirname, '..', '..', 'data', 'ricerca', 'fine-scala-1090.json');
const BOARD = path.join(__dirname, '..', '..', 'data', 'liquidity-rewards.json');
const CAPITALE = 2149.88;
const sp = (p) => +(1 - p).toFixed(10);

function quotabile(m) {
  const mid = m.mid; const tick = m.tickSize;
  if (!(mid > 0 && mid < 1) || !(tick > 0)) return null;
  const r = raggioBandaCents(m.rewardsMaxSpread);
  if (r == null) return null;
  const a = planBehindBest({ bestOther: m.bestBid > 0 ? m.bestBid : null, tick, scoringMid: mid, bandRadiusCents: r });
  const v = planBehindBest({ bestOther: m.bestAsk > 0 ? sp(m.bestAsk) : null, tick, scoringMid: sp(mid), bandRadiusCents: r });
  if (a.quotabile === false || v.quotabile === false) return false;
  return a.ok === true && v.ok === true;
}

const board = JSON.parse(fs.readFileSync(BOARD, 'utf8'));
const tetto = conc.capPerMarketUsd(CAPITALE);
const ora = Date.now();

const righe = [];
for (const m of board.markets || []) {
  if (!(m.rewardsMaxSpread > 0) || !(m.rewardsDailyRate > 0) || !(m.mid > 0)) continue;
  const h = horizonVerdict({ endDate: m.endDate, nowMs: ora });
  const orizzonteOk = h ? (h.state !== 'resolved' && h.state !== 'too-far') : false;
  righe.push({
    slug: (m.slug || '').slice(0, 44), mid: m.mid, pool: m.rewardsDailyRate, minSize: m.rewardsMinSize,
    oreAllaScadenza: h && Number.isFinite(h.days) ? +(h.days * 24).toFixed(1) : null,
    orizzonteOk,
    finanziabile: conc.pavimentoPremiante(m.rewardsMinSize) <= tetto + 1e-9,
    quotabile: quotabile(m),
    dentroVecchia: m.mid >= 0.03 && m.mid <= 0.97,
    dentroNuova: m.mid >= 0.10 && m.mid <= 0.90,
  });
}

// La fascia contesa: ammessa dalla regola vecchia, vietata dalla nuova.
const contesi = righe.filter((r) => r.dentroVecchia && !r.dentroNuova);
const utili = (a) => a.filter((r) => r.orizzonteOk && r.finanziabile && r.quotabile === true);

const res = {
  generatoAl: new Date().toISOString(),
  minHorizonDays: MIN_HORIZON_DAYS, capitale: CAPITALE, tettoPerMercato: tetto,
  boardConMontepremi: righe.length,
  nellaFasciaContesa: contesi.length,
  fasciaContesaMontepremiTotale: +contesi.reduce((a, r) => a + r.pool, 0).toFixed(2),
  // Il costo VERO: quelli che oggi entrerebbero davvero nel piano.
  contesiUtiliOggi: utili(contesi).length,
  contesiUtiliMontepremi: +utili(contesi).reduce((a, r) => a + r.pool, 0).toFixed(2),
  utiliTotaliOggi: utili(righe).length,
  utiliTotaliMontepremi: +utili(righe).reduce((a, r) => a + r.pool, 0).toFixed(2),
  dettaglioContesiUtili: utili(contesi).map((r) => ({ slug: r.slug, mid: r.mid, pool: r.pool, minSize: r.minSize, ore: r.oreAllaScadenza })),
  // Quanto la fascia si popola avvicinandosi alla risoluzione: è la ragione per cui l'orizzonte
  // più corto la rende più rilevante.
  perFasciaOraria: [[0, 6], [6, 12], [12, 24], [24, 72], [72, 1e9]].map(([lo, hi]) => {
    const g = righe.filter((r) => r.oreAllaScadenza != null && r.oreAllaScadenza >= lo && r.oreAllaScadenza < hi);
    const est = g.filter((r) => !r.dentroNuova);
    return { daOre: lo, aOre: hi === 1e9 ? null : hi, mercati: g.length, estremi: est.length,
             quotaEstremiPct: g.length ? +(est.length / g.length * 100).toFixed(1) : null };
  }),
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(res, null, 1));

console.log(`board con montepremi: ${res.boardConMontepremi} · orizzonte minimo ${MIN_HORIZON_DAYS} g · tetto $${tetto}\n`);
console.log(`mercati nella fascia contesa (ammessi da [0,03·0,97], vietati da [0,10·0,90]): ${res.nellaFasciaContesa}`);
console.log(`  montepremi complessivo della fascia: $${res.fasciaContesaMontepremiTotale}/g`);
console.log(`\nIL COSTO VERO — quelli che oggi entrerebbero DAVVERO nel piano:`);
console.log(`  contesi e utili: ${res.contesiUtiliOggi} mercati, $${res.contesiUtiliMontepremi}/g di montepremi`);
console.log(`  su un totale di ${res.utiliTotaliOggi} utili per $${res.utiliTotaliMontepremi}/g`);
for (const d of res.dettaglioContesiUtili) console.log(`    ${d.slug.padEnd(46)} mid ${d.mid} · pool $${d.pool} · min ${d.minSize} · ${d.ore}h`);
console.log(`\nquanto la fascia estrema si popola avvicinandosi alla risoluzione:`);
console.log('  ore alla scadenza    mercati   fuori da [0,10·0,90]   quota');
for (const f of res.perFasciaOraria) {
  console.log(`  ${String(f.daOre).padStart(6)}-${String(f.aOre ?? '∞').padEnd(6)} ${String(f.mercati).padStart(10)} ${String(f.estremi).padStart(20)} ${String(f.quotaEstremiPct ?? '—').padStart(8)}%`);
}
console.log(`\nscritto in ${OUT}`);
