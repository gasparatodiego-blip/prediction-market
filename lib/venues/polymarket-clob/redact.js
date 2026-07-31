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

// ── PUBLIC IDENTIFIERS THAT MUST SURVIVE THE 64-HEX BELT ────────────────────────────────────────────
// A Polymarket CLOB order id has exactly the shape of the inline-private-key belt below: `0x` + 64 hex.
// So that belt was rewriting every order id in the audit trail to the literal string
// '0x[redacted-64hex]', and the damage was not cosmetic — lib/maker/manual-order.attributeOrder matches
// the VENUE's order ids against the ids recorded in the trail to decide who placed an order. With every
// recorded id replaced by the same placeholder, no match was ever possible: the operator's own orders
// were reported as 'agent35', and agent40 (which only manages orders it can PROVE are the panel's) left
// them completely unmanaged — no band-exit re-price, no proactive renewal.
//
// An order id is a PUBLIC artefact of a public order. It is not a credential and there is nothing to
// protect. So values under these keys skip the 64-hex belt — and ONLY that belt: registered secret
// VALUES are still scrubbed from them, and every other key keeps the full treatment. A private key can
// never arrive under a key named `orderId` without something far more serious having gone wrong first.
const PUBLIC_ID_KEY = /^(orderid|order_id|orderids|order_ids|oldorderid|neworderid|idempotencykey)$/i;

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
// `keepPublicIds` skips ONLY the 64-hex belt (see PUBLIC_ID_KEY); the registered-secret scrub always runs.
function scrubString(s, keepPublicIds = false) {
  if (typeof s !== 'string' || s === '') return s;
  let out = s;
  for (const v of SECRET_VALUES) {
    if (v && out.includes(v)) out = out.split(v).join('[redacted]');
  }
  // Belt: a 0x-prefixed 64-hex private key inline (never store/log these, but scrub if one appears).
  if (!keepPublicIds) out = out.replace(/0x[a-fA-F0-9]{64}/g, '0x[redacted-64hex]');
  return out;
}

// Recursively scrub an arbitrary value (object/array/string). Bounded depth; never throws.
function redact(v, depth = 0, keepPublicIds = false) {
  if (depth > 8 || v == null) return v;
  if (typeof v === 'string') return scrubString(v, keepPublicIds);
  if (Array.isArray(v)) return v.map(x => redact(x, depth + 1, keepPublicIds));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      // SENSITIVE first — a key that looks secret is blanked whatever else it looks like. Then the
      // public-id exemption, which is NOT inherited by nested objects beyond the value it names.
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(val, depth + 1, PUBLIC_ID_KEY.test(k));
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

module.exports = { redact, scrubString, safeError, registerSecretValues, _SENSITIVE_KEY: SENSITIVE_KEY, _PUBLIC_ID_KEY: PUBLIC_ID_KEY };
