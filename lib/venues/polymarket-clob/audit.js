'use strict';
// lib/venues/polymarket-clob/audit.js — append-only, credential-scrubbed audit log for EVERY call the
// Polymarket cancel adapter makes (list / cancel / health), armed or shadow or dry-run. One JSON line
// per call: what was requested, the venue's response shape, latency, outcome, and the execution mode.
//
// This is the record a human reviews to see exactly what the adapter did (or would have done). It is
// the twin of the news-guard shadow log, but scoped to the adapter's own venue interaction. Every
// record is passed through redact() before it is written, so no credential (key/secret/passphrase/
// private key) can ever reach this file — by construction, not by discipline.

const fs = require('fs');
const path = require('path');
const { redact } = require('./redact');

// Stessa ragione dell'audit maker: `data/` si chiede al risolutore, perché questo modulo vive sia in
// node semplice sia dentro il bundle di Next, dove i `..` a mano portano in `.next/data/`.
const { DATA_DIR } = require('../../safety/store');

const AUDIT_FILE = path.join(DATA_DIR, 'polymarket-clob-audit.jsonl');

/**
 * Append one audit record. Synchronous, append-only. Returns {written} and never throws into the
 * caller's path — an audit failure must not turn into a live-call failure (or vice-versa).
 * @param {object} record  { ts, op, mode, marketId?, orderId?, requested, response, latencyMs, outcome, ... }
 */
function appendAudit(record) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(redact(record)) + '\n');
    return { written: true };
  } catch (e) {
    return { written: false };
  }
}

module.exports = { appendAudit, AUDIT_FILE };
