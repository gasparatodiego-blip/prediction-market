'use strict';
// lib/news-guard/shadow-log.js — append-only shadow decision log.
//
// Every decision the action layer takes (act / suppress / monitor / alert / off) is appended as one
// JSON line to data/news-guard-shadow.jsonl. This file is the dataset Diego uses to measure the
// false-positive rate BEFORE arming: what fired, the measured evidence, which orders it WOULD have
// cancelled, which fills it WOULD have closed, and the estimated reward forgone.
//
// SAFETY: a defensive scrub removes anything that looks like a credential before it is written, so
// even a future record shape can never leak key material into this file. The action-layer records
// carry no credentials today; this is belt-and-suspenders.

const fs = require('fs');
const path = require('path');
// La cartella `data/` si CHIEDE al risolutore condiviso, non si conta con i «..»: sotto `lib/` un
// modulo puo' essere importato da una rotta, e nel bundle di Next `__dirname` e' .next/server/… —
// dove i «..» portano in `.next/data/`, una cartella che non esiste. Vedi lib/safety/store.js.
const { DATA_DIR } = require('../safety/store');

const SHADOW_FILE = path.join(DATA_DIR, 'news-guard-shadow.jsonl');
// Reward-drift advisory records are a SEPARATE dataset from news-guard action
// decisions — kept in their own file so the action-decision false-positive analysis
// stays clean. Same scrub, same append semantics.
const DRIFT_SHADOW_FILE = path.join(DATA_DIR, 'rewards-drift-shadow.jsonl');
const SENSITIVE = /(secret|passphrase|apikey|api_key|token|privatekey|private_key|password|dekenc|dek_enc|mnemonic|seedphrase)/i;

// Recursively replace any credential-looking value with a marker. Never throws on cycles/depth —
// bounded depth, and it only reads the record the action layer built (plain JSON).
function scrub(v, depth = 0) {
  if (depth > 8 || v == null) return v;
  if (Array.isArray(v)) return v.map(x => scrub(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = SENSITIVE.test(k) ? '[redacted]' : scrub(val, depth + 1);
    }
    return out;
  }
  return v;
}

/**
 * Append one decision record. Synchronous, atomic-enough for an append-only audit line.
 * @returns {{written:boolean, error?:string}}
 */
function appendTo(file, record) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(scrub(record)) + '\n');
    return { written: true };
  } catch (e) {
    return { written: false, error: e.message };
  }
}

function appendShadowRecord(record) { return appendTo(SHADOW_FILE, record); }

/** Append a reward-drift advisory record to its own dataset (same scrub). */
function appendDriftShadowRecord(record) { return appendTo(DRIFT_SHADOW_FILE, record); }

module.exports = { appendShadowRecord, appendDriftShadowRecord, SHADOW_FILE, DRIFT_SHADOW_FILE, _scrub: scrub };
