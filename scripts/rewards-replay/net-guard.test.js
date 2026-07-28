#!/usr/bin/env node
'use strict';
// Independent selfcheck for the two invariants of the net-from-unknown-cost fix:
//   (1) when the +5m cost cannot be computed (fills exist but none has a horizon sample), NET is null and
//       renders "—" — never a number derived from an unknown, never a defaulted 0; and
//   (2) NET can never exceed GROSS under ANY markout input, because favorable (positive) markout is
//       unrealised and is floored to 0 — a fill can only reduce net, never inflate it above the reward.
// Hand-computed synthetic rows; fires independently of the replay pipeline.
const assert = require('assert');
const { computeNet } = require('./lib/net');

let n = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };
const near = (a, b, t = 1e-6) => a != null && b != null && Math.abs(a - b) <= t;
const money = (x) => (x == null ? '—' : (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(2)); // same contract as the drivers

// one market, pot 100, depth 1000 sh, mid 0.50, size $1000/side → share 2000/3000 = 0.6667, grossPerDay 66.67.
// Two samples exactly 24h apart → observed span 1 day → grossWindow = grossPerDay = 66.67.
const row = (tsMs) => ({ ts: '', tsMs, marketId: 'M', adjMid: 0.5, bidDepthInBand: 1000, askDepthInBand: 1000, bandLow: 0, bandHigh: 1, tick: 0.01, src: 'ws' });
const mkMarket = () => new Map([['M', [row(0), row(86400000)]]]);
const pot = new Map([['M', 100]]);
const GROSS = 100 * (2000 / 3000); // 66.6667 = grossPerDay = grossWindow (span 1 day)
const mo = (usd) => [{ marketId: 'M', side: 'buy', horizons: { '1m': usd == null ? null : { usd }, '5m': usd == null ? null : { usd }, '30m': usd == null ? null : { usd } } }];

console.log('(1) UNKNOWN cost → net "—", never a number');
{
  const net = computeNet(mkMarket(), mo(null), pot, { sizeUsd: 1000, windowHours: 24, wsOnly: false });
  const r = net.rows[0];
  ok('fills present (1) but no +5m sample', r.fills === 1 && r.missing['5m'] === 1);
  ok('cost(+5m) is null', r.costWindow['5m'] === null);
  ok('net(+5m) is null (not a number)', r.netWindow['5m'] === null);
  ok('renders "—"', money(r.netWindow['5m']) === '—');
  ok('aggregate counts the unknown net, excludes it from totals', net.aggregate.unknownNet['5m'] === 1 && net.aggregate.netWindow['5m'] === 0);
}

console.log('(2) NET ≤ GROSS under ANY markout, favorable markout not booked');
{
  // favorable +5 markout must NOT push net above gross.
  const fav = computeNet(mkMarket(), mo(5), pot, { sizeUsd: 1000, windowHours: 24, wsOnly: false }).rows[0];
  ok('favorable +$5 markout → cost 0 (floored), net = gross (not gross+5)', near(fav.costWindow['5m'], 0) && near(fav.netWindow['5m'], GROSS));
  ok('net ≤ gross with favorable markout', fav.netWindow['5m'] <= fav.grossWindow + 1e-9);
  // adverse −4 markout → cost 4, net = gross − 4.
  const adv = computeNet(mkMarket(), mo(-4), pot, { sizeUsd: 1000, windowHours: 24, wsOnly: false }).rows[0];
  ok('adverse −$4 markout → cost $4, net = gross − 4', near(adv.costWindow['5m'], 4) && near(adv.netWindow['5m'], GROSS - 4));
  // sweep a range of markout values → net ≤ gross ALWAYS.
  let allLe = true;
  for (const usd of [-1000, -100, -1, 0, 1, 100, 1000, 1e6]) {
    const r = computeNet(mkMarket(), mo(usd), pot, { sizeUsd: 1000, windowHours: 24, wsOnly: false }).rows[0];
    if (!(r.netWindow['5m'] <= r.grossWindow + 1e-9)) allLe = false;
  }
  ok('net ≤ gross for every markout in {−1000…+1e6}', allLe);
}

console.log('(3) NO fills → cost 0 (KNOWN), net = gross');
{
  const r = computeNet(mkMarket(), [], pot, { sizeUsd: 1000, windowHours: 24, wsOnly: false }).rows[0];
  ok('zero fills → cost $0 (known, not "—")', r.costWindow['5m'] === 0 && r.netWindow['5m'] != null && near(r.netWindow['5m'], GROSS));
}

console.log(`\nnet-guard.test: ${n} assertions passed`);
