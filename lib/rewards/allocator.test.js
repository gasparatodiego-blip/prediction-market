#!/usr/bin/env node
'use strict';
// Selfcheck for the shared allocator's UI wrapper planAllocation(). The knapsack itself is proven by the
// backtest tests + the machine-precision equality proof; here we assert the NEW normalisation behaviours:
//   • a market with 0 observed fills funds on gross but its NET renders null ("—"), never gross-as-net;
//   • portfolio net stays null when any chosen market's net is unknown;
//   • per-side size in shares, snapped bid/ask at the offset+tick, and in-band depth are surfaced correctly.
// Deterministic synthetic journal (no tape → 0 fills).
const assert = require('assert');
const { planAllocation } = require('./allocator');

let n = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };
const near = (a, b, t = 1e-6) => a != null && b != null && Math.abs(a - b) <= t;

// One fundable market Z: two samples 24h apart (span 24h), mid 0.50, in-band depth 1000 sh, tick 0.01,
// pot $100/day, NO trades → 0 fills. grossPerDay = 100·share; net = gross (measured 0 cost) but DISPLAY "—".
const row = (tsMs) => ({ ts: new Date(tsMs).toISOString(), tsMs, marketId: 'Z', tokenIdYes: 'TKZ', adjMid: 0.50, plainMid: 0.50, bestBid: 0.49, bestAsk: 0.51, bidDepthInBand: 1000, askDepthInBand: 1000, bandLow: 0.45, bandHigh: 0.55, tick: 0.01, src: 'ws' });
const byMarket = new Map([['Z', [row(0), row(86400000)]]]);
const marketTokens = new Map([['Z', 'TKZ']]);
const tapeByToken = new Map(); // no trades
const potByCond = new Map([['Z', 100]]);

console.log('planAllocation — 0-fill market: funds on gross, net renders "—"');
{
  const plan = planAllocation({ byMarket, marketTokens, tapeByToken, potByCond, budgetUsd: 200, unitUsd: 100, offsetCents: 1, maxInventoryUsd: 5000, policy: 'hold' });
  ok('one market used', plan.marketsUsed === 1 && plan.rows.length === 1);
  const r = plan.rows[0];
  ok('0 fills → net is null (renders "—"), never a number', r.fills === 0 && r.netPerDay === null);
  ok('gross/day is a real positive number', typeof r.grossPerDay === 'number' && r.grossPerDay > 0);
  ok('portfolio net stays null when a chosen market net is unknown', plan.totalNetPerDay === null);
  ok('portfolio gross is summed (real)', near(plan.totalGrossPerDay, r.grossPerDay));
  // size in shares = sizeUsd / clampPrice(mid 0.50); capital = 2·sizeUsd.
  ok('per-side size in shares = sizeUsd / 0.50', near(r.sizePerSideShares, r.sizePerSideUsd / 0.50));
  ok('capital = 2 × per-side size $', near(r.capital, 2 * r.sizePerSideUsd));
  // snapped prices at offset 1¢, tick 0.01: bid 0.49, ask 0.51.
  ok('snapped bid 0.49 / ask 0.51 at offset 1¢, tick 0.01', near(r.snappedBid, 0.49) && near(r.snappedAsk, 0.51) && near(r.tick, 0.01));
  ok('in-band depth surfaced = 1000 shares', near(r.depthShares, 1000));
  ok('offset echoed on the row', r.offsetCents === 1);
  ok('frontier present (count → net)', Array.isArray(plan.frontier) && plan.frontier.length >= 1 && plan.frontier[0].count === 1);
}

console.log('planAllocation — unallocated remainder is explicit, never absorbed');
{
  // budget $250 at unit $100 → only $200 is allocatable in whole units; the $50 remainder is REPORTED,
  // never silently rolled into a market. unallocated is always exactly budget − totalCapital.
  const plan = planAllocation({ byMarket, marketTokens, tapeByToken, potByCond, budgetUsd: 250, unitUsd: 100, offsetCents: 1, maxInventoryUsd: 5000, policy: 'hold' });
  ok('unallocated = budget − totalCapital (exact), and here the $50 granularity remainder is > 0', near(plan.unallocated, plan.budgetUsd - plan.totalCapital) && near(plan.unallocated, 50));
}

// ── LA SIZE MINIMA DEL VENUE ARRIVA FINO ALLA RIGA DEL PANNELLO ────────────────────────────────────────
// Il mercato Z ha mid 0,50: $100 di capitale totale sono $50/lato = 100 share. Con un min_incentive_size di
// 500 share quel capitale NON e' scorato dal venue, quindi la riga deve valere $0/g — e deve dire quanto
// servirebbe, altrimenti l'operatore vede sparire un mercato senza sapere perche'.
console.log('planAllocation — sotto il minimo del venue la riga vale ZERO, e dice quanto serve');
{
  const minSizeByMarket = new Map([['Z', 500]]);
  const plan = planAllocation({ byMarket, marketTokens, tapeByToken, potByCond, budgetUsd: 100, unitUsd: 100, offsetCents: 1, maxInventoryUsd: 5000, policy: 'hold', minSizeByMarket });
  const funded = plan.rows.filter((r) => r.capital > 0 && (r.grossPerDay ?? 0) > 0);
  ok('nessuna riga finanziata produce un lordo positivo sotto il minimo', funded.length === 0);
  ok('il totale lordo del piano e 0, non un numero inventato', near(plan.totalGrossPerDay, 0));
  ok('il mercato escluso e ELENCATO, non silenziosamente assente',
    Array.isArray(plan.belowMinSize) && plan.belowMinSize.some((b) => b.marketId === 'Z'));
  const b = (plan.belowMinSize || []).find((x) => x.marketId === 'Z');
  ok('e porta il minimo del venue (500 share)', b && b.minSizeShares === 500);
  // 500 share/lato a 0,50 = $250/lato = $500 in tutto
  ok('e il capitale che lo sbloccherebbe ($500), calcolato dalla stessa regola', b && near(b.capitalToQualifyUsd, 500));

  // Con capitale SUFFICIENTE lo stesso mercato torna finanziabile e il numero e quello di sempre:
  // la correzione e' un gate sotto la soglia, non uno sconto sopra.
  const okPlan = planAllocation({ byMarket, marketTokens, tapeByToken, potByCond, budgetUsd: 600, unitUsd: 600, offsetCents: 1, maxInventoryUsd: 5000, policy: 'hold', minSizeByMarket });
  const noGate = planAllocation({ byMarket, marketTokens, tapeByToken, potByCond, budgetUsd: 600, unitUsd: 600, offsetCents: 1, maxInventoryUsd: 5000, policy: 'hold' });
  ok('sopra il minimo il mercato e finanziato di nuovo', okPlan.rows.length === 1 && okPlan.rows[0].grossPerDay > 0);
  ok('e il lordo sopra la soglia e IDENTICO a quello senza gate', near(okPlan.totalGrossPerDay, noGate.totalGrossPerDay));
  ok('la riga sopra la soglia non e marcata sotto-minimo', okPlan.rows[0].belowVenueMinSize === false);
  ok('e porta comunque il minimo del venue, per poterlo mostrare', okPlan.rows[0].minSizeShares === 500);
}

console.log(`\nallocator.test: ${n} assertions passed`);
