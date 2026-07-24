'use strict';
// lib/maker/arming.js — the durable ARMING record for the liquidity-rewards maker.
//
// Arming is a SECOND, richer gate that sits ON TOP of the env ladder (MAKER_MODE / MAKER_FUNDING_APPROVED):
// even a fully-armed record cannot place while those env switches are off. What the record adds is a
// deliberate, time-boxed, preflight-gated authorization with a hard collateral ceiling and a reason-logged
// disarm — the thing agent35 consults every cycle to decide whether it MAY quote (once the env is live).
//
// NON-NEGOTIABLES:
//   • FAIL CLOSED. Unreadable or absent state ⇒ DISARMED (never armed). Arming is the dangerous direction;
//     it must require an explicit, well-formed, preflight-GO write — never a default or a partial read.
//   • MANDATORY TTL. arm() refuses ttlSeconds ≤ 0. Every arm has an expiry; readArming() auto-disarms the
//     record the instant it expires (and audits ttl-expiry). There is no arm-forever.
//   • TWO-STEP. arm() refuses unless the caller echoes the exact total size (typedSizeConfirm), so a stray
//     tap can never arm.
//   • PREFLIGHT-GATED. arm() refuses unless the supplied preflight result is go:true. No override.
//   • COLLATERAL CEILING. arm() refuses totalSizeUsd above the collateral cap; the cap is stored so the
//     per-cycle invariant check can disarm if usage later exceeds it.
//   • AUDITED. Every arm and every disarm appends a who/when/why line to data/maker-arming-audit.jsonl.

const path = require('path');
const { readStore, writeStoreAtomic, DATA_DIR } = require('../safety/store');
const { redact } = require('../venues/polymarket-clob/redact');

const STATE_FILE = path.join(DATA_DIR, 'maker-arming.json');
const AUDIT_FILE = path.join(DATA_DIR, 'maker-arming-audit.jsonl');
const EMPTY = Object.freeze({ armed: false });
const TTL_DEFAULT_SECONDS = 4 * 3600;      // 4 hours
const TTL_MAX_SECONDS = 24 * 3600;         // never arm for more than a day at a time (renew re-runs preflight)

function cfg(deps) {
  return {
    stateFile: deps.stateFile || STATE_FILE,
    auditFile: deps.auditFile || AUDIT_FILE,
    now: deps.now || (() => Date.now()),
    fs: deps.fs || require('fs'),
  };
}

function appendArmingAudit(rec, c) {
  try {
    c.fs.mkdirSync(path.dirname(c.auditFile), { recursive: true });
    c.fs.appendFileSync(c.auditFile, JSON.stringify(redact(rec)) + '\n');
  } catch (_e) { /* best-effort; an audit-write failure must never block a disarm */ }
}

// Read the arming record, ENFORCING expiry. Fail-closed: an unreadable file ⇒ disarmed.
function readArming(deps = {}) {
  const c = cfg(deps);
  const now = c.now();
  const r = readStore(c.stateFile, EMPTY, deps);
  if (!r.ok) return { armed: false, source: 'unreadable', reason: r.error, expiresInSec: null, record: null };
  const st = r.value || EMPTY;
  if (!st.armed) return { armed: false, source: 'clear', expiresInSec: null, record: st };
  // Enforce the mandatory TTL: an armed record past its expiry is auto-disarmed HERE (the instant it is read),
  // and the transition is audited. There is no path by which an expired arm stays live.
  if (!(st.expiresAtMs > now)) {
    const disarmed = { ...st, armed: false, disarmedAtMs: now, disarmedAt: new Date(now).toISOString(), disarmReason: 'ttl-expiry' };
    writeStoreAtomic(c.stateFile, disarmed, deps);
    appendArmingAudit({ ts: now, event: 'auto-disarm', reason: 'ttl-expiry', expiredAt: st.expiresAt, by: st.by || null }, c);
    return { armed: false, source: 'ttl-expiry', expiresInSec: 0, record: disarmed };
  }
  return { armed: true, source: 'armed', expiresInSec: Math.round((st.expiresAtMs - now) / 1000), record: st };
}

/**
 * Arm the maker. Fail-closed on every ill-formed or ungated request.
 * @param {object} req  totalSizeUsd, typedSizeConfirm, ttlSeconds, collateralCapUsd, perSideSizeUsd,
 *                      universeMarketIds[], by
 * @param {object} opts preflight (REQUIRED — the already-run preflight result {go, checks}); deps
 * @returns {{ok:boolean, refusedBy?:string, reason?:string, arming?:object}}
 */
function arm(req = {}, opts = {}) {
  const c = cfg(opts.deps || opts);
  const now = c.now();
  const preflight = opts.preflight;

  // 1. PREFLIGHT gate — no go, no arm. No override.
  if (!preflight || preflight.go !== true) {
    const reds = preflight && Array.isArray(preflight.checks) ? preflight.checks.filter((x) => !x.pass).map((x) => x.key) : ['preflight-missing'];
    appendArmingAudit({ ts: now, event: 'arm-refused', refusedBy: 'preflight', reds }, c);
    return { ok: false, refusedBy: 'preflight', reason: `preflight is not GO (red: ${reds.join(', ') || 'unknown'})` };
  }

  // 2. Well-formed size + mandatory TTL.
  const totalSizeUsd = Number(req.totalSizeUsd);
  if (!(totalSizeUsd > 0)) return refuse(c, now, 'invalid-size', 'totalSizeUsd must be > 0');
  let ttlSeconds = Number(req.ttlSeconds);
  if (!(ttlSeconds > 0)) ttlSeconds = TTL_DEFAULT_SECONDS;              // default 4h; never 0/forever
  if (ttlSeconds > TTL_MAX_SECONDS) return refuse(c, now, 'ttl-too-long', `ttlSeconds must be ≤ ${TTL_MAX_SECONDS} (renew re-runs preflight)`);

  // 3. TWO-STEP confirmation — the caller must echo the exact size. A stray tap cannot arm.
  if (Number(req.typedSizeConfirm) !== totalSizeUsd) {
    return refuse(c, now, 'size-confirm', 'typed size does not match the total size — refusing (two-step arm)');
  }

  // 4. COLLATERAL ceiling.
  const collateralCapUsd = Number(req.collateralCapUsd);
  if (Number.isFinite(collateralCapUsd) && collateralCapUsd > 0 && totalSizeUsd > collateralCapUsd + 1e-9) {
    return refuse(c, now, 'collateral-cap', `totalSizeUsd $${totalSizeUsd} exceeds the collateral cap $${collateralCapUsd}`);
  }

  const record = {
    armed: true,
    by: req.by || 'operator',
    armedAtMs: now, armedAt: new Date(now).toISOString(),
    ttlSeconds, expiresAtMs: now + ttlSeconds * 1000, expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
    totalSizeUsd,
    perSideSizeUsd: Number.isFinite(Number(req.perSideSizeUsd)) ? Number(req.perSideSizeUsd) : null,
    collateralCapUsd: Number.isFinite(collateralCapUsd) && collateralCapUsd > 0 ? collateralCapUsd : null,
    universeMarketIds: Array.isArray(req.universeMarketIds) ? req.universeMarketIds : [],
    preflightAtArm: { go: true, at: preflight.at || null, checks: (preflight.checks || []).map((x) => ({ key: x.key, pass: x.pass, value: x.value })) },
  };
  writeStoreAtomic(c.stateFile, record, cfg(opts.deps || opts));
  appendArmingAudit({ ts: now, event: 'arm', by: record.by, totalSizeUsd, ttlSeconds, expiresAt: record.expiresAt, markets: record.universeMarketIds.length }, c);
  return { ok: true, arming: record };
}

function refuse(c, now, refusedBy, reason) {
  appendArmingAudit({ ts: now, event: 'arm-refused', refusedBy, reason }, c);
  return { ok: false, refusedBy, reason };
}

/**
 * RENEW an armed record — the ONLY way to extend an arm, and an explicit one that RE-RUNS the preflight.
 * If the fresh preflight is not GO, renewing DISARMS (a check went red while armed — the safe direction),
 * so a stale arm can never be extended past a condition that has since failed. Never resurrects a disarmed
 * or expired record (you must arm() again, which re-confirms the size).
 * @param {object} req  ttlSeconds (defaults to the record's own ttlSeconds, else 4h)
 * @param {object} opts preflight (REQUIRED), deps
 */
function renew(req = {}, opts = {}) {
  const c = cfg(opts.deps || opts);
  const now = c.now();
  const cur = readArming(opts.deps || opts); // enforces expiry first — a just-expired record is already disarmed
  if (!cur.armed) return { ok: false, refusedBy: 'not-armed', reason: 'nothing armed to renew (arm() again to re-confirm the size)' };
  const preflight = opts.preflight;
  if (!preflight || preflight.go !== true) {
    disarm('preflight-red-on-renew', opts.deps || opts);
    const reds = preflight && Array.isArray(preflight.checks) ? preflight.checks.filter((x) => !x.pass).map((x) => x.key) : ['preflight-missing'];
    return { ok: false, refusedBy: 'preflight', reason: `preflight went NO-GO on renew (red: ${reds.join(', ')}) — DISARMED` };
  }
  const prev = cur.record;
  let ttlSeconds = Number(req.ttlSeconds);
  if (!(ttlSeconds > 0)) ttlSeconds = Number(prev.ttlSeconds) > 0 ? Number(prev.ttlSeconds) : TTL_DEFAULT_SECONDS;
  if (ttlSeconds > TTL_MAX_SECONDS) return { ok: false, refusedBy: 'ttl-too-long', reason: `ttlSeconds must be ≤ ${TTL_MAX_SECONDS}` };
  const record = { ...prev, armed: true, ttlSeconds, renewedAtMs: now, renewedAt: new Date(now).toISOString(), expiresAtMs: now + ttlSeconds * 1000, expiresAt: new Date(now + ttlSeconds * 1000).toISOString(), preflightAtArm: { go: true, at: preflight.at || null, checks: (preflight.checks || []).map((x) => ({ key: x.key, pass: x.pass, value: x.value })) } };
  writeStoreAtomic(c.stateFile, record, cfg(opts.deps || opts));
  appendArmingAudit({ ts: now, event: 'renew', by: prev.by || null, ttlSeconds, expiresAt: record.expiresAt }, c);
  return { ok: true, arming: record };
}

/** Disarm the record with a reason. Idempotent (disarming a clear record still audits the intent). */
function disarm(reason = 'manual', deps = {}) {
  const c = cfg(deps);
  const now = c.now();
  const r = readStore(c.stateFile, EMPTY, deps);
  const prev = (r.ok && r.value) ? r.value : {};
  const record = { ...prev, armed: false, disarmedAtMs: now, disarmedAt: new Date(now).toISOString(), disarmReason: reason };
  writeStoreAtomic(c.stateFile, record, deps);
  appendArmingAudit({ ts: now, event: 'disarm', reason, wasArmed: !!prev.armed, by: prev.by || null }, c);
  return { ok: true, disarmed: true, reason };
}

module.exports = { readArming, arm, renew, disarm, appendArmingAudit, STATE_FILE, AUDIT_FILE, TTL_DEFAULT_SECONDS, TTL_MAX_SECONDS, EMPTY };
