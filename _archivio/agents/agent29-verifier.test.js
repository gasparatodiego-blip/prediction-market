'use strict';
// Unit tests for agent29-verifier's pure logic (no network). Run: node agents/agent29-verifier.test.js
// The live venue adapters + comparators are covered by lib/source-verify.test.js and
// the agent29 smoke cycle; here we pin the alert-dedup and rotating-selection logic.
const A = require('./agent29-verifier.js');
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.error('  ✗', name); } };

// ── alert dedup: one message per (row, finding) per 6h ──────────────────────
const state = { alerts: {} };
const mm = [{ id: 'funding-OP-binance-hyperliquid', section: 'funding', source: { legs: [{ leg: 'binance', delta8h: 9.98 }] } }];
const t0 = 1_000_000_000_000;
ok('first mismatch alerts once',          A.selectFreshAlerts(mm, state, t0).length === 1);
ok('same finding within 6h suppressed',   A.selectFreshAlerts(mm, state, t0 + 60_000).length === 0);
ok('same finding at 5h59m still suppressed', A.selectFreshAlerts(mm, state, t0 + (6 * 3600_000 - 60_000)).length === 0);
ok('after 6h cooldown it may alert again',   A.selectFreshAlerts(mm, state, t0 + 7 * 3600_000).length === 1);

// a CHANGED finding (different source fingerprint) on the same row is NOT deduped
const mm2 = [{ id: 'funding-OP-binance-hyperliquid', section: 'funding', source: { legs: [{ leg: 'binance', delta8h: 42 }] } }];
ok('changed finding on same row alerts', A.selectFreshAlerts(mm2, state, t0 + 7 * 3600_000 + 1000).length === 1);

// ── rotating selection: above-fold always included, tail rotates ────────────
const all = Array.from({ length: 10 }, (_, i) => ({ i }));
const s1 = A.selectRotating({ rotation: {} }, 'x', all, 3, 2);
ok('above-fold head always included', s1.set.slice(0, 3).every((r, i) => r.i === i));
ok('rotate window size respected',    s1.set.length === 5);
const s2 = A.selectRotating({ rotation: { x: s1.nextOffset } }, 'x', all, 3, 2);
ok('rotation advances over the tail',  s2.set[3].i !== s1.set[3].i);
ok('no tail ⇒ just head',             A.selectRotating({ rotation: {} }, 'y', all.slice(0, 3), 3, 2).set.length === 3);

console.log(`agent29-verifier.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
