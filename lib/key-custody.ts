import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'crypto'

/**
 * Encryption at rest for exchange API credentials.
 *
 * AES-256-GCM. Fresh random 12-byte IV per record, so encrypting the same
 * plaintext twice never yields the same ciphertext. The GCM auth tag makes
 * decrypt fail closed: a wrong master key, a flipped byte, or a truncated
 * record throws rather than returning a partial or a guess.
 *
 * The master key is read ONCE at module import from KEY_CUSTODY_MASTER and must
 * be exactly 32 bytes, base64. If it is absent or the wrong length this module
 * throws at import — loudly, at boot, before anything can call it.
 *
 * There is deliberately NO fallback: no default key, no key derived from another
 * secret, no plaintext passthrough. A silent fallback would mean credentials
 * sitting readable in the database while every log line still says "encrypted",
 * which is the exact failure this module exists to prevent. Failing to boot is
 * the correct outcome.
 */

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const AUTH_TAG_BYTES = 16

function loadMasterKey(): Buffer {
  const raw = process.env.KEY_CUSTODY_MASTER

  if (!raw || raw.trim() === '') {
    throw new Error(
      'KEY_CUSTODY_MASTER is not set. Exchange key custody cannot start without it. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))" ' +
        'and set it in .env. There is no fallback by design.',
    )
  }

  let key: Buffer
  try {
    key = Buffer.from(raw.trim(), 'base64')
  } catch {
    throw new Error('KEY_CUSTODY_MASTER is not valid base64.')
  }

  // Buffer.from with base64 silently drops invalid characters rather than
  // throwing, so length is the check that actually holds.
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `KEY_CUSTODY_MASTER must decode to exactly ${KEY_BYTES} bytes, got ${key.length}. ` +
        'Expected 32 random bytes, base64-encoded.',
    )
  }

  return key
}

const MASTER_KEY = loadMasterKey()

/**
 * Encrypt a credential for storage. Returns `iv:authTag:ciphertext`, each part
 * base64. Safe to write straight into a single String column.
 */
export function encrypt(plaintext: string): string {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encrypt expects a string')
  }

  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, MASTER_KEY, iv)
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()

  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':')
}

/**
 * Decrypt a stored credential. Throws on anything it cannot fully authenticate:
 * malformed record, wrong master key, tampered ciphertext or auth tag. Never
 * returns a partial result.
 */
export function decrypt(record: string): string {
  if (typeof record !== 'string' || record === '') {
    throw new Error('decrypt: record must be a non-empty string')
  }

  const parts = record.split(':')
  if (parts.length !== 3) {
    throw new Error(
      `decrypt: malformed record, expected 3 colon-separated parts, got ${parts.length}`,
    )
  }

  const [ivB64, authTagB64, ciphertextB64] = parts
  const iv = Buffer.from(ivB64, 'base64')
  const authTag = Buffer.from(authTagB64, 'base64')
  const ciphertext = Buffer.from(ciphertextB64, 'base64')

  if (iv.length !== IV_BYTES) {
    throw new Error(`decrypt: bad IV length ${iv.length}, expected ${IV_BYTES}`)
  }
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new Error(
      `decrypt: bad auth tag length ${authTag.length}, expected ${AUTH_TAG_BYTES}`,
    )
  }

  const decipher = createDecipheriv(ALGORITHM, MASTER_KEY, iv)
  decipher.setAuthTag(authTag)

  try {
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    // decipher.final() throws when the auth tag does not verify. Rewritten to a
    // stable message so callers cannot distinguish "wrong key" from "tampered".
    throw new Error(
      'decrypt: authentication failed — wrong master key, tampered record, or corrupted ciphertext',
    )
  }
}

/**
 * Constant-time equality for two decrypted secrets. Exposed so future callers
 * comparing credentials do not reach for `===` and leak timing.
 */
export function secretsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
