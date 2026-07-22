'use strict';
// lib/venues/polymarket-clob/redact.js — the ONE redaction helper every log/audit/error path in the
// Polymarket cancel adapter must go through. Nothing in this adapter writes a string or object to a
// log, an audit line, an error message, or a thrown Error without first passing it through here.
//
// WHY A DEDICATED HELPER: the shadow-log scrub keys on FIELD NAMES. That is not enough here, because
// a Polymarket API secret / passphrase / private key can also appear INLINE inside a free-text string
// — an axios error message, a signed URL, a stack trace. So this scrubs BOTH: object keys by name AND
// known secret VALUES wherever they appear in a string. Secret values are registered at construction
// (registerSecretValues) so the redactor can blank them out of any text it later sees.

// Field-name patterns → redact the whole value. Superset of shadow-log's set, incl. Polymarket names.
const SENSITIVE_KEY = /(secret|passphrase|apikey|api_key|api-key|privatekey|private_key|pk|mnemonic|seed|seedphrase|poly_api_key|poly_passphrase|poly_signature|authorization|cookie|password|token|dek|dekenc)/i;

// A registry of literal secret VALUES to blank out of any string (the derived key/secret/passphrase,
// a private key). Populated at adapter construction; module-global so a redactor built anywhere scrubs
// the same values. Only reasonably-long values are registered (≥8 chars) so we never blank out "0x" or
// a short token that would over-redact useful text.
const SECRET_VALUES = new Set();

function registerSecretValues(values) {
  for (const v of values) {
    if (typeof v === 'string' && v.length >= 8) SECRET_VALUES.add(v);
  }
}

// Blank every registered secret value out of a string, plus obvious inline private-key / hmac shapes.
function scrubString(s) {
  if (typeof s !== 'string' || s === '') return s;
  let out = s;
  for (const v of SECRET_VALUES) {
    if (v && out.includes(v)) out = out.split(v).join('[redacted]');
  }
  // Belt: a 0x-prefixed 64-hex private key inline (never store/log these, but scrub if one appears).
  out = out.replace(/0x[a-fA-F0-9]{64}/g, '0x[redacted-64hex]');
  return out;
}

// Recursively scrub an arbitrary value (object/array/string). Bounded depth; never throws.
function redact(v, depth = 0) {
  if (depth > 8 || v == null) return v;
  if (typeof v === 'string') return scrubString(v);
  if (Array.isArray(v)) return v.map(x => redact(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(val, depth + 1);
    }
    return out;
  }
  return v;
}

// Turn any caught error into a safe, redacted, credential-free message (never the raw stack/URL).
function safeError(e) {
  const msg = e && e.message ? String(e.message) : String(e);
  return scrubString(msg).slice(0, 400);
}

module.exports = { redact, scrubString, safeError, registerSecretValues, _SENSITIVE_KEY: SENSITIVE_KEY };
