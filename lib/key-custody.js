'use strict';
const {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} = require('crypto');

/**
 * Envelope encryption at rest for exchange API credentials.
 *
 *   plaintext --[ DEK, per row ]--> field ciphertext   (apiKeyEnc, apiSecretEnc, ...)
 *   DEK       --[ KEK, global  ]--> dekEnc             (+ kekVersion says which KEK)
 *
 * Each ROW gets its own random 32-byte DEK. The DEK encrypts the fields; the
 * master (KEK) encrypts only the DEK. Rotating the master therefore re-wraps a
 * single small dekEnc per row and NEVER touches the field ciphertext.
 *
 * There is deliberately no master-direct field encryption in this module. A helper
 * that encrypts a field straight under the KEK would produce rows with no DEK —
 * rows rotation would skip and that would silently break the first time an old KEK
 * was retired.
 *
 * KEK registry, so a rotation can read v1 while writing v2 in one process:
 *   KEY_CUSTODY_MASTER      -> version 1
 *   KEY_CUSTODY_MASTER_V<n> -> version n   (n >= 2)
 *
 * Version 1 is required and validated at import. If it is absent or not 32 bytes,
 * this module throws at import — loudly, at boot. No default, no fallback.
 *
 * Fails closed everywhere. A wrong key, a tampered auth tag, a truncated record, or
 * a kekVersion naming a KEK we do not hold all throw. Nothing returns a partial.
 *
 * CommonJS (not TS) ON PURPOSE: this is the ONE crypto path, and it must be
 * require()-able by BOTH the Next runtime (via allowJs) AND the plain-node agents
 * (agent37 watchdog + the cancel credsProvider). Types live in key-custody.d.ts so
 * every existing TS consumer keeps full type-checking with zero edits.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const DEK_BYTES = 32;

const PRIMARY_ENV = 'KEY_CUSTODY_MASTER';
const VERSIONED_ENV = /^KEY_CUSTODY_MASTER_V(\d+)$/;

function parseKekMaterial(raw, envName) {
  // Buffer.from(x, 'base64') silently drops invalid characters rather than
  // throwing, so the LENGTH check below is what actually holds.
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${envName} must decode to exactly ${KEY_BYTES} bytes, got ${key.length}. ` +
        'Expected 32 random bytes, base64-encoded.',
    );
  }
  return key;
}

/** version -> KEK material. Built once, at import. */
function loadKekRegistry() {
  const registry = new Map();

  const primary = process.env[PRIMARY_ENV];
  if (!primary || primary.trim() === '') {
    throw new Error(
      `${PRIMARY_ENV} is not set. Exchange key custody cannot start without it. ` +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))" ' +
        'and set it in .env. There is no fallback by design.',
    );
  }
  registry.set(1, parseKekMaterial(primary, PRIMARY_ENV));

  for (const [envName, raw] of Object.entries(process.env)) {
    const match = envName.match(VERSIONED_ENV);
    if (!match || !raw || raw.trim() === '') continue;

    const version = Number(match[1]);
    if (version === 1) {
      throw new Error(
        `${envName} is ambiguous: version 1 is always ${PRIMARY_ENV}. ` +
          'Remove it, or use version 2+ for a new master.',
      );
    }
    registry.set(version, parseKekMaterial(raw, envName));
  }

  return registry;
}

const KEK_REGISTRY = loadKekRegistry();

function kekFor(version) {
  const key = KEK_REGISTRY.get(version);
  if (!key) {
    const held = Array.from(KEK_REGISTRY.keys()).sort((a, b) => a - b).join(', ');
    throw new Error(
      `No KEK held for kekVersion ${version}. Versions available: [${held}]. ` +
        `Set ${version === 1 ? PRIMARY_ENV : `KEY_CUSTODY_MASTER_V${version}`} to read these rows. ` +
        'Refusing to guess.',
    );
  }
  return key;
}

/** KEK versions this process can currently unwrap with. */
function availableKekVersions() {
  return Array.from(KEK_REGISTRY.keys()).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// DEK lifecycle
// ---------------------------------------------------------------------------

/** A fresh random data key. One per row, never reused across rows. */
function newDek() {
  return randomBytes(DEK_BYTES);
}

/**
 * Wrap a DEK under a KEK for storage in ExchangeKey.dekEnc. kekVersion is bound in
 * as GCM additional authenticated data, so the stored version tag is tamper-evident.
 */
function wrapDek(dek, version = 1) {
  if (!Buffer.isBuffer(dek) || dek.length !== DEK_BYTES) {
    throw new TypeError(`wrapDek expects a ${DEK_BYTES}-byte Buffer`);
  }

  const kek = kekFor(version);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, kek, iv);
  cipher.setAAD(Buffer.from(String(version), 'utf8'));

  const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    wrapped.toString('base64'),
  ].join(':');
}

/** Recover a DEK from dekEnc. Throws if the KEK is wrong, absent, or the record is bad. */
function unwrapDek(dekEnc, version) {
  const { iv, authTag, payload } = splitRecord(dekEnc, 'unwrapDek');
  const kek = kekFor(version);

  const decipher = createDecipheriv(ALGORITHM, kek, iv);
  decipher.setAAD(Buffer.from(String(version), 'utf8'));
  decipher.setAuthTag(authTag);

  let dek;
  try {
    dek = Buffer.concat([decipher.update(payload), decipher.final()]);
  } catch {
    throw new Error(
      `unwrapDek: authentication failed for kekVersion ${version} — wrong master key, ` +
        'tampered record, or corrupted dekEnc',
    );
  }

  if (dek.length !== DEK_BYTES) {
    throw new Error(`unwrapDek: recovered key is ${dek.length} bytes, expected ${DEK_BYTES}`);
  }
  return dek;
}

// ---------------------------------------------------------------------------
// Field encryption, under a row's DEK
// ---------------------------------------------------------------------------

/** Encrypt one credential field under this row's DEK. Fresh IV per field, per call. */
function encryptField(plaintext, dek) {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encryptField expects a string');
  }
  if (!Buffer.isBuffer(dek) || dek.length !== DEK_BYTES) {
    throw new TypeError(`encryptField expects a ${DEK_BYTES}-byte DEK`);
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, dek, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/** Decrypt one credential field. Throws on a wrong DEK, a tampered tag, or a truncated record. */
function decryptField(ciphertext, dek) {
  if (!Buffer.isBuffer(dek) || dek.length !== DEK_BYTES) {
    throw new TypeError(`decryptField expects a ${DEK_BYTES}-byte DEK`);
  }

  const { iv, authTag, payload } = splitRecord(ciphertext, 'decryptField');
  const decipher = createDecipheriv(ALGORITHM, dek, iv);
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8');
  } catch {
    // Deliberately identical for every failure mode, so a caller cannot distinguish
    // "wrong key" from "tampered" and use this as an oracle.
    throw new Error(
      'decryptField: authentication failed — wrong data key, tampered record, or corrupted ciphertext',
    );
  }
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

/**
 * Re-wrap a row's DEK from one KEK to another. Takes VERSIONS, not key material.
 * Does NOT decrypt any credential field — the field ciphertext stays byte-identical.
 */
function rotateRow(row, oldKekVersion, newKekVersion) {
  if (oldKekVersion === newKekVersion) {
    throw new Error(
      `rotateRow: old and new kekVersion are both ${newKekVersion} — that is a no-op, not a rotation.`,
    );
  }

  // Two versions pointing at identical material would "rotate" green while changing nothing.
  if (kekFor(oldKekVersion).equals(kekFor(newKekVersion))) {
    throw new Error(
      `rotateRow: kekVersion ${oldKekVersion} and ${newKekVersion} hold IDENTICAL key material. ` +
        'Rotating between them would report success while changing nothing.',
    );
  }

  if (row.kekVersion !== oldKekVersion) {
    throw new Error(
      `rotateRow: row is at kekVersion ${row.kekVersion}, expected ${oldKekVersion}. Refusing to guess.`,
    );
  }

  const dek = unwrapDek(row.dekEnc, oldKekVersion);
  try {
    return { dekEnc: wrapDek(dek, newKekVersion), kekVersion: newKekVersion };
  } finally {
    // Best-effort: don't leave the plaintext DEK lying in a heap buffer.
    dek.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function splitRecord(record, fn) {
  if (typeof record !== 'string' || record === '') {
    throw new Error(`${fn}: record must be a non-empty string`);
  }

  const parts = record.split(':');
  if (parts.length !== 3) {
    throw new Error(
      `${fn}: malformed record, expected 3 colon-separated parts, got ${parts.length}`,
    );
  }

  const iv = Buffer.from(parts[0], 'base64');
  const authTag = Buffer.from(parts[1], 'base64');
  const payload = Buffer.from(parts[2], 'base64');

  if (iv.length !== IV_BYTES) {
    throw new Error(`${fn}: bad IV length ${iv.length}, expected ${IV_BYTES}`);
  }
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new Error(`${fn}: bad auth tag length ${authTag.length}, expected ${AUTH_TAG_BYTES}`);
  }
  return { iv, authTag, payload };
}

/** Constant-time equality for two decrypted secrets. */
function secretsEqual(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

module.exports = {
  availableKekVersions,
  newDek,
  wrapDek,
  unwrapDek,
  encryptField,
  decryptField,
  rotateRow,
  secretsEqual,
};
