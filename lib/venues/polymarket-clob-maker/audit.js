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

// La cartella `data/` si CHIEDE al risolutore, non si conta con i `..`: questo modulo lo caricano sia
// gli agent (node semplice) sia la dashboard (bundle di Next, dove `__dirname` è .next/server/chunks).
// Con i `..` a mano l'audit della dashboard sarebbe finito in `.next/data/` — cioè in un file che la
// riconciliazione non legge, mentre `mkdirSync(recursive)` creava la cartella senza che niente lo
// segnalasse. Un registro che si sdoppia in silenzio è peggio di un registro assente.
const { DATA_DIR } = require('../../safety/store');

const AUDIT_FILE = path.join(DATA_DIR, 'polymarket-maker-audit.jsonl');

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
