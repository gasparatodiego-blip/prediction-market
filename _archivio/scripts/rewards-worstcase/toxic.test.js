#!/usr/bin/env node
'use strict';
// Unit tests for the toxic-market damage arithmetic: the fraction of a good day a negative net erases, with
// the honest-engine "—" contract (a positive net erases nothing; an undefined good day → "—", never a guess).
const assert = require('assert');
const { fractionErased } = require('./lib/toxic');

let n = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };
const near = (a, b, t = 1e-9) => a != null && b != null && Math.abs(a - b) <= t;

console.log('fractionErased — |negative net| / good net');
{
  ok('−$56.86 vs $100.98 good → 56.31%', near(fractionErased(-56.86, 100.98), 56.86 / 100.98));
  ok('−$153.11 vs $100.98 → 151.6% (more than a full day → day goes negative)', near(fractionErased(-153.11, 100.98), 153.11 / 100.98) && fractionErased(-153.11, 100.98) > 1);
  ok('a POSITIVE net erases nothing (0%)', fractionErased(5, 100) === 0);
  ok('good day = 0 → "—" (null, never a divide-by-zero guess)', fractionErased(-10, 0) === null);
  ok('good day negative → "—" (undefined base)', fractionErased(-10, -5) === null);
  ok('non-finite inputs → "—"', fractionErased(null, 100) === null && fractionErased(-10, null) === null);
}
console.log(`\ntoxic.test: ${n} assertions passed`);
