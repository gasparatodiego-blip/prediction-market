'use strict';
// lib/safety/execution-audit.js — the APPEND-ONLY audit trail for every order placed on a user's behalf.
// Venue-agnostic. Its purpose is answering "what did the bot do with my money on Tuesday" — so it is
// queryable per user and per time range, and it is reconstructable AFTER the fact.
//
// APPEND-ONLY. Never update-in-place, never delete. A correction is a NEW row referencing the original.
//
// INTENT-BEFORE-SEND + IDEMPOTENCY (the money-safety core):
//   • recordIntent writes the INTENT row (with a caller-stable idempotency key) BEFORE the venue call.
//     If the intent cannot be durably recorded, the caller MUST refuse to place — no evidence, no order.
//   • A crash between send and response therefore ALWAYS leaves an intent row: the classic way to lose
//     money silently is to log only successes.
//   • recordIntent is the idempotency guard: if an intent already exists for this key it returns
//     { recorded:false, duplicate:true } and the caller must NOT place — the same key never places twice,
//     even on a retry after an ambiguous timeout.
//   • recordOutcome writes the OUTCOME row after the venue responds (or throws), referencing the key.
//
// REDACTION: every row passes through the shared redact() (the maker adapter's redactor) — API keys,
// private keys, signatures, and any inline secret value are blanked. Only counts / ids / prices survive.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { redact } = require('../venues/polymarket-clob/redact');
const { DATA_DIR } = require('./store');

const AUDIT_FILE = path.join(DATA_DIR, 'execution-audit.jsonl');

function cfg(deps) {
  return { auditFile: deps.auditFile || AUDIT_FILE, now: deps.now || (() => Date.now()), fs: deps.fs || fs };
}

// Deterministic idempotency key from the order identity, when the caller does not supply one. A retry of
// the SAME intended order produces the SAME key (so it dedups); a re-quote at a new price is a new order
// and a new key. Callers that need cross-price dedup must pass an explicit idempotencyKey.
function deriveIdempotencyKey({ userId, venue, tokenId, side, price, size }) {
  const h = crypto.createHash('sha256')
    .update([userId, venue, tokenId, side, price, size].map(String).join('|'))
    .digest('hex').slice(0, 24);
  return `idem_${h}`;
}

// Scan the append-only trail for an existing INTENT row with this key. The file is the single source of
// truth (not an in-memory index that a restart would lose). O(n) scan — fine at this scale; documented.
function hasIntent(idempotencyKey, deps = {}) {
  const c = cfg(deps);
  let raw;
  try { raw = c.fs.readFileSync(c.auditFile, 'utf8'); }
  catch (e) { if (e && e.code === 'ENOENT') return false; throw e; } // unreadable (non-ENOENT) → throw → caller fails closed
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.indexOf(idempotencyKey) === -1) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row && row.kind === 'intent' && row.idempotencyKey === idempotencyKey) return true;
  }
  return false;
}

function append(row, deps = {}) {
  const c = cfg(deps);
  c.fs.mkdirSync(path.dirname(c.auditFile), { recursive: true });
  // Synchronous append — the intent must be on disk before the venue call returns. Throws on failure so
  // the caller can refuse to place (no durable intent ⇒ no order).
  c.fs.appendFileSync(c.auditFile, JSON.stringify(redact(row)) + '\n');
}

/**
 * Record an INTENT row iff no intent exists for this key. THROWS if it cannot durably write (caller must
 * treat a throw as "do not place"). Returns { recorded, duplicate, idempotencyKey, row }.
 *
 * intent fields: { idempotencyKey?, userId, venue, market, side, price, size, notionalUsd, decision,
 *                  gates, mode }  — decision = what the engine believed (signal/strategy); gates = the
 *                  gate results that were evaluated.
 */
function recordIntent(intent, deps = {}) {
  const c = cfg(deps);
  const key = intent.idempotencyKey || deriveIdempotencyKey(intent);
  if (hasIntent(key, deps)) return { recorded: false, duplicate: true, idempotencyKey: key };
  const row = {
    kind: 'intent',
    ts: c.now(),
    idempotencyKey: key,
    userId: intent.userId || null,
    venue: intent.venue || null,
    market: intent.market || null,
    side: intent.side || null,
    price: intent.price != null ? intent.price : null,
    size: intent.size != null ? intent.size : null,
    notionalUsd: intent.notionalUsd != null ? intent.notionalUsd : null,
    decision: intent.decision != null ? intent.decision : null, // engine belief: signal/strategy/what it thought
    gates: intent.gates != null ? intent.gates : null,          // which gates were evaluated + their results
    mode: intent.mode || null,
  };
  append(row, deps);
  return { recorded: true, duplicate: false, idempotencyKey: key, row };
}

/**
 * Record the OUTCOME row after the venue responds or throws. References the intent's idempotency key.
 * outcome: { idempotencyKey, userId, venue, market, ok, orderId, response, error }
 */
function recordOutcome(outcome, deps = {}) {
  const c = cfg(deps);
  const row = {
    kind: 'outcome',
    ts: c.now(),
    idempotencyKey: outcome.idempotencyKey || null,
    userId: outcome.userId || null,
    venue: outcome.venue || null,
    market: outcome.market || null,
    ok: outcome.ok === true,
    orderId: outcome.orderId != null ? outcome.orderId : null,
    response: outcome.response != null ? outcome.response : null,
    error: outcome.error != null ? outcome.error : null,
  };
  try { append(row, deps); return { recorded: true }; }
  catch (_e) { return { recorded: false }; } // an outcome-write failure must not mask the (already sent) order
}

/**
 * Query the trail per user and time range — this is what makes the trail auditable after the fact.
 * @returns rows (intent + outcome) for userId within [fromTs, toTs].
 */
function queryByUser({ userId, fromTs = 0, toTs = Infinity }, deps = {}) {
  const c = cfg(deps);
  let raw;
  try { raw = c.fs.readFileSync(c.auditFile, 'utf8'); }
  catch (e) { if (e && e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (userId && row.userId !== userId) continue;
    if (row.ts < fromTs || row.ts > toTs) continue;
    out.push(row);
  }
  return out;
}

module.exports = { recordIntent, recordOutcome, hasIntent, queryByUser, deriveIdempotencyKey, AUDIT_FILE };
