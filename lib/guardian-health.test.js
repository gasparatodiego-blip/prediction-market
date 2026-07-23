'use strict';
// Smoke tests for lib/guardian-health.js — the robustness/uptime report (rules 51–74).
// Read-only over real /tmp state; we exercise the `now`-injectable freshness logic and
// the report shape/roll-up. Plain-node (mirrors guardian-suppress.test.js).

const assert = require('assert');
const H = require('./guardian-health');
let passed = 0;
function ok(name) { passed++; console.log('  ok -', name); }

// ── shape + roll-up invariants ──
{
  const r = H.getGuardianHealth();
  for (const k of ['ok', 'degraded', 'banner', 'pipeline', 'feeds', 'watchdog', 'build', 'guardian', 'checkedAt']) {
    assert.ok(k in r, `report has ${k}`);
  }
  assert.strictEqual(r.guardian.readOnly, true, 'rule 70: guardian is read-only on source');
  assert.strictEqual(r.guardian.everyActionLogged, true, 'rule 72: every action logged');
  assert.strictEqual(typeof r.build.buildIdPresent, 'boolean', 'rule 59: build-id presence is observed');
  ok('report shape + guardian self-check invariants (rules 70/72/59)');
}

// ── rule 48/62: a far-future `now` makes every feed stale ⇒ global banner + degraded ──
{
  const far = Date.now() + 10 * 24 * 3600_000; // +10 days
  const r = H.getGuardianHealth(far);
  assert.strictEqual(r.pipeline.stale, true, 'pipeline stale at +10d');
  assert.strictEqual(r.banner, 'Data may be stale', 'rule 48/62: stale pipeline raises the global banner');
  assert.strictEqual(r.degraded, true, 'stale pipeline ⇒ calm-degraded');
  ok('rule 48/62: stale pipeline → "Data may be stale" banner + degraded');
}

// ── banner is null OR a string; never undefined/NaN (calm degradation, no raw null) ──
{
  const r = H.getGuardianHealth();
  assert.ok(r.banner === null || typeof r.banner === 'string', 'banner is null or a clean string');
  ok('rule 54: banner never renders a raw null/NaN');
}

console.log(`\nguardian-health: ${passed} assertions passed`);
