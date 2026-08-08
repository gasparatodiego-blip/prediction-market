#!/usr/bin/env node
'use strict';
// IL TICK REALE ENTRA NELLA SELEZIONE, E SOLO NELLA SELEZIONE.
//
// ═══ IL GUASTO ═══════════════════════════════════════════════════════════════════════════════════════
// Misurato l'8 agosto 2026. `offsetTicks` aveva già corretto DOVE il motore si mette (un tick dal
// concorrente, non un centesimo fisso), ma non quanto vale starci: il lordo dell'obiettivo del knapsack
// è il ceiling a S=1 — un ordine appoggiato sul mid — e non contiene nessun termine di offset. In
// selezione quindi tutti i mercati venivano pesati uguale, che è l'equivalente esatto di una distanza
// fissa uguale per tutti: la cosa che `offsetTicks` esisteva per togliere.
//
// Il venue paga S(v,s) = ((v−s)/v)². Su una banda da 4,5¢:
//     tick 0,01  → 1,0¢ dal mid → S = 0,3086
//     tick 0,001 → 0,1¢ dal mid → S = 0,9131        → 2,96 volte tanto
// Sull'universo reale di quel giorno: 48 mercati su 113 a tick 0,001.
//
// ═══ COSA SI PROVA QUI ═══════════════════════════════════════════════════════════════════════════════
//   1. l'aritmetica del peso, e che fallisce verso il neutro invece di inventare;
//   2. che il peso CAMBIA LA SCELTA: a parità di tutto il resto il mercato a tick fine vince;
//   3. che NON cambia il piazzamento — offset e prezzi restano quelli di prima;
//   4. che il ceiling e il netto misurato restano leggibili accanto al numero di selezione;
//   5. che spento (il difetto di `allocateBudget`, cioè ogni driver di backtest) tutto è byte per byte
//      quello di prima.

const assert = require('assert');
const { planAllocation } = require('./allocator');
const { allocateBudget, placementWeightForMarket } = require('../../scripts/rewards-replay/lib/allocate');
const { placementScore } = require('./realistic-estimate');

let n = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { console.log('  ✓ ' + name + (extra ? ' — ' + extra : '')); n++; }
  else { console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); fail++; }
};
const near = (a, b, t = 1e-9) => a != null && b != null && Math.abs(a - b) <= t;

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n══ 1 · IL PESO DELLA POSIZIONE REALE');
{
  const grosso = placementWeightForMarket([{ tick: 0.01 }], { offsetCents: 1, offsetTicks: 1, maxSpreadCents: 4.5 });
  const fine = placementWeightForMarket([{ tick: 0.001 }], { offsetCents: 1, offsetTicks: 1, maxSpreadCents: 4.5 });
  ok('tick 0,01 → un tick è 1¢ dal mid', near(grosso.offsetCents, 1));
  ok('  e vale il quadratico del venue a 1¢', near(grosso.S, placementScore(1, 4.5)), grosso.S.toFixed(4));
  ok('tick 0,001 → lo stesso tick è 0,1¢', near(fine.offsetCents, 0.1));
  ok('  e vale il quadratico a 0,1¢', near(fine.S, placementScore(0.1, 4.5)), fine.S.toFixed(4));
  ok('il rapporto fra i due è ~2,96: è tutta qui la sottovalutazione', Math.abs(fine.S / grosso.S - 2.958) < 0.01, (fine.S / grosso.S).toFixed(3));

  // Il peso NON è la stessa cosa a banda diversa: una banda stretta punisce di più lo stesso tick.
  const stretta = placementWeightForMarket([{ tick: 0.01 }], { offsetCents: 1, offsetTicks: 1, maxSpreadCents: 3.5 });
  ok('a banda 3,5¢ lo stesso tick vale meno che a 4,5¢', stretta.S < grosso.S, `${stretta.S.toFixed(3)} < ${grosso.S.toFixed(3)}`);

  ok('banda illeggibile ⇒ null: nessun peso inventato', placementWeightForMarket([{ tick: 0.01 }], { offsetCents: 1, offsetTicks: 1, maxSpreadCents: null }) === null);
  ok('banda zero o negativa ⇒ null', placementWeightForMarket([{ tick: 0.01 }], { offsetCents: 1, offsetTicks: 1, maxSpreadCents: 0 }) === null);
  const senzaTick = placementWeightForMarket([{}], { offsetCents: 1, offsetTicks: 1, maxSpreadCents: 4.5 });
  ok('tick illeggibile ⇒ si ricade sui centesimi, MAI su un tick inventato', senzaTick.tick === null && near(senzaTick.offsetCents, 1));
  const oltreBanda = placementWeightForMarket([{ tick: 0.05 }], { offsetCents: 1, offsetTicks: 1, maxSpreadCents: 4.5 });
  ok('un tick che porta fuori banda vale ZERO, non un numero negativo', oltreBanda.S === 0, `5¢ su banda 4,5¢ → S=${oltreBanda.S}`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// DUE MERCATI GEMELLI, UNA SOLA DIFFERENZA: IL TICK.
// Stesso mid, stessa profondità altrui, stessa banda, stesso montepremi, nessun fill (nessun nastro).
// Al ceiling S=1 sono indistinguibili e il knapsack ne sceglie uno qualsiasi; col punteggio reale il
// mercato a tick fine rende 2,96 volte l'altro e deve prendersi il capitale.
const riga = (marketId, tokenId, tick) => (tsMs) => ({
  ts: new Date(tsMs).toISOString(), tsMs, marketId, tokenIdYes: tokenId,
  adjMid: 0.50, plainMid: 0.50, bestBid: 0.49, bestAsk: 0.51,
  bidDepthInBand: 1000, askDepthInBand: 1000, bandLow: 0.4775, bandHigh: 0.5225, tick, src: 'ws',
});
const G = riga('GROSSO', 'TKG', 0.01);
const F = riga('FINE', 'TKF', 0.001);
const byMarket = new Map([['GROSSO', [G(0), G(86_400_000)]], ['FINE', [F(0), F(86_400_000)]]]);
const marketTokens = new Map([['GROSSO', 'TKG'], ['FINE', 'TKF']]);
const tapeByToken = new Map();                       // nessun nastro ⇒ 0 fill ⇒ costo misurato 0
const potByCond = new Map([['GROSSO', 100], ['FINE', 100]]);
const maxSpreadByMarket = new Map([['GROSSO', 4.5], ['FINE', 4.5]]);
const base = { byMarket, marketTokens, tapeByToken, potByCond, budgetUsd: 100, unitUsd: 100, offsetCents: 1, maxInventoryUsd: 5000, policy: 'hold', maxSpreadByMarket };

console.log('\n══ 2 · IL PESO CAMBIA LA SCELTA');
{
  // Budget per UN solo mercato: la scelta è forzata a essere esclusiva, quindi visibile.
  const senza = planAllocation({ ...base, usePlacementScore: false });
  const con = planAllocation({ ...base, usePlacementScore: true });
  ok('senza peso il piano prende un mercato solo (il budget basta per uno)', senza.rows.length === 1);
  ok('con il peso ne prende comunque uno solo: il capitale non cambia', con.rows.length === 1);
  ok('CON IL PESO vince il mercato a tick fine', con.rows[0].marketId === 'FINE', `scelto ${con.rows[0].marketId}`);

  const candFine = con.candidates.find((c) => c.marketId === 'FINE');
  const candGrosso = con.candidates.find((c) => c.marketId === 'GROSSO');
  ok('il peso viaggia sul candidato, non resta nel codice', near(candFine.punteggioPosizione, placementScore(0.1, 4.5)) && near(candGrosso.punteggioPosizione, placementScore(1, 4.5)));
  ok('  con la distanza reale in centesimi', near(candFine.punteggioOffsetCents, 0.1) && near(candGrosso.punteggioOffsetCents, 1));
  ok('  e col tick da cui viene', near(candFine.punteggioTick, 0.001) && near(candGrosso.punteggioTick, 0.01));
  // Il numero con cui il knapsack ha davvero deciso sta sul LIVELLO della curva. (Sulle card
  // `bestNetPerDay` resta un trattino finché nessun fill è stato osservato — regola di net-per-day.js,
  // che questa correzione non tocca: un netto senza fill non è misurato, pesato o no.)
  const curva = allocateBudget(byMarket, marketTokens, tapeByToken, potByCond, {
    offsetCents: 1, offsetTicks: 1, maxInventoryUsd: 5000, budgetUsd: 200, unitUsd: 100,
    maxPerMarketUsd: 200, policy: 'hold', usePlacementScore: true, maxSpreadByMarket,
  });
  const liv = (id) => curva.curves.find((c) => c.marketId === id).levels.find((l) => l.units > 0);
  ok('l\'obiettivo del tick fine è ~2,96× quello del tick grosso',
    Math.abs(liv('FINE').net5m / liv('GROSSO').net5m - 2.958) < 0.02,
    `${liv('FINE').net5m.toFixed(3)} contro ${liv('GROSSO').net5m.toFixed(3)}`);
  ok('mentre il netto MISURATO resta identico fra i due: è il numero che non distingueva',
    near(liv('FINE').netPerDay5m, liv('GROSSO').netPerDay5m, 1e-6),
    `${liv('FINE').netPerDay5m} = ${liv('GROSSO').netPerDay5m}`);
  ok('e sulle card il ceiling resta leggibile accanto al numero di selezione',
    'bestNetCeilingPerDay' in candFine && 'bestNetCeilingPerDay' in candGrosso);
  ok('nessun mercato è rimasto senza peso: la banda c\'era per entrambi', con.pesoNonApplicato.length === 0);
  ok('e il piano dichiara di aver pesato', con.usePlacementScore === true);
}

console.log('\n══ 3 · IL PIAZZAMENTO NON CAMBIA DI UN TICK');
{
  // Budget per DUE mercati: così entrambe le righe esistono in tutti e due i piani e si possono
  // confrontare riga per riga. È il controllo che questa correzione tocchi la selezione e basta.
  const b2 = { ...base, budgetUsd: 200, unitUsd: 100, maxPerMarketUsd: 100 };
  const senza = planAllocation({ ...b2, usePlacementScore: false });
  const con = planAllocation({ ...b2, usePlacementScore: true });
  ok('entrambi i piani prendono i due mercati', senza.rows.length === 2 && con.rows.length === 2);
  const perId = (p) => new Map(p.rows.map((r) => [r.marketId, r]));
  const A = perId(senza), B = perId(con);
  for (const id of ['GROSSO', 'FINE']) {
    ok(`${id}: l'offset con cui si piazza è lo stesso`, A.get(id).computedDefaultOffsetTicks === B.get(id).computedDefaultOffsetTicks,
      `${A.get(id).computedDefaultOffsetTicks} tick`);
    ok(`  ${id}: bid e ask snappati identici`, near(A.get(id).snappedBid, B.get(id).snappedBid) && near(A.get(id).snappedAsk, B.get(id).snappedAsk));
    ok(`  ${id}: il LORDO dichiarato resta il ceiling, non il pesato`, near(A.get(id).grossPerDay, B.get(id).grossPerDay));
    ok(`  ${id}: e il capitale della riga non cambia`, near(A.get(id).capital, B.get(id).capital));
  }
  ok('il lordo PESATO è un campo in più, accanto al ceiling — mai al posto suo',
    near(B.get('FINE').grossScoredPerDay, B.get('FINE').grossPerDay * placementScore(0.1, 4.5)));
  ok('  e il totale lordo del piano resta quello di sempre', near(senza.totalGrossPerDay, con.totalGrossPerDay));
}

console.log('\n══ 4 · SPENTO, È BYTE PER BYTE QUELLO DI PRIMA');
{
  // Il difetto di `allocateBudget` è SPENTO: è il percorso di ogni driver di backtest, e non deve
  // essersi mosso di un centesimo.
  const args = [byMarket, marketTokens, tapeByToken, potByCond];
  const vecchio = allocateBudget(...args, { offsetCents: 1, offsetTicks: 1, maxInventoryUsd: 5000, budgetUsd: 200, unitUsd: 100, maxPerMarketUsd: 200, policy: 'hold' });
  const esplicito = allocateBudget(...args, { offsetCents: 1, offsetTicks: 1, maxInventoryUsd: 5000, budgetUsd: 200, unitUsd: 100, maxPerMarketUsd: 200, policy: 'hold', usePlacementScore: false, maxSpreadByMarket });
  ok('il difetto è «non pesare»', vecchio.usePlacementScore === false);
  ok('  e passare la banda senza accendere non cambia niente', near(vecchio.totalNet5m, esplicito.totalNet5m) && vecchio.marketsHeld === esplicito.marketsHeld);
  for (const c of vecchio.curves) {
    const l = c.levels.find((x) => x.units > 0);
    ok(`  ${c.marketId}: senza peso l'obiettivo È il netto misurato`, near(l.net5m, l.netPerDay5m));
  }

  // Acceso ma SENZA banda: nessun peso applicabile, e i mercati finiscono nell'elenco dichiarato invece
  // di essere pesati a caso o silenziosamente favoriti.
  const senzaBanda = allocateBudget(...args, { offsetCents: 1, offsetTicks: 1, maxInventoryUsd: 5000, budgetUsd: 200, unitUsd: 100, maxPerMarketUsd: 200, policy: 'hold', usePlacementScore: true });
  ok('acceso senza banda ⇒ i mercati sono ELENCATI come non pesati', senzaBanda.pesoNonApplicato.length === 2);
  ok('  e il risultato torna a essere quello di prima, non uno a caso', near(senzaBanda.totalNet5m, vecchio.totalNet5m));
}

console.log(`\npunteggio in selezione: ${n} passati, ${fail} falliti`);
assert.strictEqual(fail, 0, `${fail} asserzioni fallite`);
