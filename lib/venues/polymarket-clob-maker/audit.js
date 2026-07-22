'use strict';
// lib/venues/polymarket-clob-maker/audit.js — append-only, credential-scrubbed audit for EVERY call the
// MAKER adapter makes (post / cancel / list / positions / health), in every mode (off/paper/live-min/
// live/dry-run). One JSON line per call: intent, venue response shape, latency, outcome, resulting
// state, and the execution mode. This is the twin of the cancel adapter's audit, in its own file, so a
// human can see exactly what the maker did or WOULD have done — including every paper-mode intent.
//
// It reuses the cancel adapter's redact() (the same field-name + inline-secret-value + private-key-hex
// scrubber), so no credential or key can reach this log — by construction, not by discipline.

const fs = require('fs');
const path = require('path');
const { redact } = require('../polymarket-clob/redact');

const AUDIT_FILE = path.join(__dirname, '..', '..', '..', 'data', 'polymarket-maker-audit.jsonl');

/**
 * Append one maker audit record. Synchronous, append-only. Never throws into the caller — an audit
 * write failure must not become a live-call failure (or mask one). Every record is redacted first.
 */
function appendMakerAudit(record) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(redact(record)) + '\n');
    return { written: true };
  } catch (e) {
    return { written: false };
  }
}

module.exports = { appendMakerAudit, AUDIT_FILE };
