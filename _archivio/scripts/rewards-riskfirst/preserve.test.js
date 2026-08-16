#!/usr/bin/env node
'use strict';
// Unit tests for the capital-preservation constraint: the total structural bound and the accept/reject
// tolerance check (including the boundary). Hand-computed.
const assert = require('assert');
const { structuralTotal, withinTolerance } = require('./lib/preserve');

let n = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };
const near = (a, b, t = 1e-9) => a != null && b != null && Math.abs(a - b) <= t;

console.log('structuralTotal — Σ per-side $size');
{
  ok('[$1000,$250,$50] → $1300 total bound', near(structuralTotal([{ sizeUsd: 1000 }, { sizeUsd: 250 }, { sizeUsd: 50 }]), 1300));
  ok('empty → $0', structuralTotal([]) === 0);
}
console.log('withinTolerance — accept iff bound ≤ tolerance × budget');
{
  ok('bound 1300 vs 10% of 5000 ($500) → REJECT', withinTolerance(1300, 0.10, 5000).ok === false);
  ok('bound 1300 vs 50% ($2500) → ACCEPT', withinTolerance(1300, 0.50, 5000).ok === true);
  ok('boundary: bound 2500 vs 50% ($2500) → ACCEPT (≤, inclusive)', withinTolerance(2500, 0.50, 5000).ok === true);
  ok('bound 2501 vs 50% ($2500) → REJECT (just over)', withinTolerance(2501, 0.50, 5000).ok === false);
  ok('limit is reported = tolerance × budget', near(withinTolerance(0, 0.25, 5000).limit, 1250));
}
console.log(`\npreserve.test: ${n} assertions passed`);
