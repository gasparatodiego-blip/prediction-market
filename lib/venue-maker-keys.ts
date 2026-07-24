import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'
import path from 'path'
import { newDek, wrapDek, unwrapDek, encryptField, decryptField } from '@/lib/key-custody'

/**
 * File-backed, envelope-encrypted store for the admin/maker venue-credential lane
 * (polymarket + kalshi only). SEPARATE from the per-user Prisma ExchangeKey model:
 * that one requires a next-auth userId, and this admin flow has none.
 *
 * WHAT NEVER LEAVES THIS MODULE: apiKey, apiSecret, passphrase — not plaintext,
 * not masked, not "just the public part". The only credential-derived value ever
 * returned is `last4` (four characters), and it is derived on READ by decrypting,
 * never persisted alongside the ciphertext (mirrors app/api/keys). The wallet
 * address IS public and is stored/returned in the clear by design.
 *
 * Encryption reuses lib/key-custody envelope scheme — do NOT add a second crypto
 * path. Per row: newDek() → encryptField(field, dek) for each secret → wrapDek(dek,1)
 * stored as dekEnc + kekVersion.
 *
 * Writes are atomic (tmp + rename), like lib/rewards-normalize.js.
 *
 * Audit entries are emitted by the CALLING route (save/delete/verify), which holds
 * the operation's outcome context — this module never double-logs them.
 */

export type VenueId = 'polymarket' | 'kalshi'
export type KeyStatus = 'NOT_CONNECTED' | 'VERIFIED_READ_ONLY' | 'VERIFIED_TRADING'

export interface StoredRow {
  id: string
  venue: VenueId
  label: string
  walletAddress: string | null // PUBLIC, displayable — stored plaintext by design
  apiKeyEnc: string | null
  apiSecretEnc: string
  passphraseEnc: string | null
  dekEnc: string
  kekVersion: number
  status: KeyStatus
  savedAt: string
  verifiedAt: string | null
  tradingEnabledAt: string | null
  revokedAt: string | null
  lastError: string | null
}

/** The ONLY shape that leaves the server. Never any *Enc field, never plaintext secrets. */
export interface PublicRow {
  id: string
  venue: VenueId
  label: string
  walletAddress: string | null
  last4: string | null
  status: KeyStatus
  savedAt: string
  verifiedAt: string | null
  tradingEnabledAt: string | null
  revokedAt: string | null
  lastError: string | null
}

/** Decrypted credentials — used ONLY in-process by the verify route, never returned. */
export interface DecryptedCreds {
  venue: VenueId
  walletAddress: string | null
  apiKey: string | null
  apiSecret: string
  passphrase: string | null
}

const STORE_FILE = path.join(process.cwd(), 'data', 'venue-maker-keys.json')

interface StoreShape {
  rows: StoredRow[]
}

async function readStore(): Promise<StoreShape> {
  try {
    const raw = await fs.readFile(STORE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.rows)) return { rows: parsed.rows }
    return { rows: [] }
  } catch {
    // Missing file or unparseable → an empty store. Never throw to the client.
    return { rows: [] }
  }
}

async function writeStore(store: StoreShape): Promise<void> {
  await fs.mkdir(path.dirname(STORE_FILE), { recursive: true })
  const tmp = `${STORE_FILE}.tmp.${process.pid}`
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 })
  await fs.rename(tmp, STORE_FILE)
}

function last4(s: string): string {
  return s.length <= 4 ? s : s.slice(-4)
}

/**
 * Derive the row's last4 by decrypting the api key (or, if the venue has no api key,
 * the public wallet address). The plaintext exists only inside this function and is
 * never returned, logged, or persisted. On any decrypt failure return null — an
 * undecryptable row is a real condition, not a blank, and we never throw to the client.
 */
function deriveLast4(r: StoredRow): string | null {
  try {
    if (r.apiKeyEnc) {
      const dek = unwrapDek(r.dekEnc, r.kekVersion)
      try {
        return last4(decryptField(r.apiKeyEnc, dek))
      } finally {
        dek.fill(0)
      }
    }
    if (r.walletAddress) return last4(r.walletAddress)
    return null
  } catch {
    return null
  }
}

function toPublic(r: StoredRow): PublicRow {
  return {
    id: r.id,
    venue: r.venue,
    label: r.label,
    walletAddress: r.walletAddress,
    last4: deriveLast4(r),
    status: r.status,
    savedAt: r.savedAt,
    verifiedAt: r.verifiedAt,
    tradingEnabledAt: r.tradingEnabledAt,
    revokedAt: r.revokedAt,
    lastError: r.lastError,
  }
}

/** PUBLIC view of every stored row. NEVER any *Enc field or plaintext secret. */
export async function listRows(): Promise<PublicRow[]> {
  const store = await readStore()
  return store.rows.map(toPublic)
}

export interface SaveInput {
  venue: VenueId
  label: string
  walletAddress?: string | null
  apiKey?: string | null
  apiSecret: string
  passphrase?: string | null
}

/**
 * Encrypt and persist a new credential row. Status starts NOT_CONNECTED — a key is
 * VERIFIED only after a genuine venue 200 (see lib/venue-read-verify). Returns the
 * PUBLIC row only.
 */
export async function saveRow(input: SaveInput): Promise<PublicRow> {
  const dek = newDek()
  try {
    const now = new Date().toISOString()
    const row: StoredRow = {
      id: randomUUID(),
      venue: input.venue,
      label: input.label,
      walletAddress: input.walletAddress ? input.walletAddress : null,
      apiKeyEnc: input.apiKey ? encryptField(input.apiKey, dek) : null,
      apiSecretEnc: encryptField(input.apiSecret, dek),
      passphraseEnc: input.passphrase ? encryptField(input.passphrase, dek) : null,
      dekEnc: wrapDek(dek, 1),
      kekVersion: 1,
      status: 'NOT_CONNECTED',
      savedAt: now,
      verifiedAt: null,
      tradingEnabledAt: null,
      revokedAt: null,
      lastError: null,
    }
    const store = await readStore()
    store.rows.push(row)
    await writeStore(store)
    return toPublic(row)
  } finally {
    dek.fill(0)
  }
}

/**
 * Decrypt a row's credentials for an in-process verification call ONLY. The result
 * must never be returned to a client, logged, or placed in an error. Null if the row
 * is missing or cannot be decrypted.
 */
export async function getDecryptedCreds(id: string): Promise<DecryptedCreds | null> {
  const store = await readStore()
  const r = store.rows.find((x) => x.id === id)
  if (!r) return null
  try {
    const dek = unwrapDek(r.dekEnc, r.kekVersion)
    try {
      return {
        venue: r.venue,
        walletAddress: r.walletAddress,
        apiKey: r.apiKeyEnc ? decryptField(r.apiKeyEnc, dek) : null,
        apiSecret: decryptField(r.apiSecretEnc, dek),
        passphrase: r.passphraseEnc ? decryptField(r.passphraseEnc, dek) : null,
      }
    } finally {
      dek.fill(0)
    }
  } catch {
    return null
  }
}

/** Read the PUBLIC view of one row, or null. Never any secret. */
export async function getPublicRow(id: string): Promise<PublicRow | null> {
  const store = await readStore()
  const r = store.rows.find((x) => x.id === id)
  return r ? toPublic(r) : null
}

/** Read the current stored status of a row (server-internal; used to gate transitions). */
export async function getStatus(id: string): Promise<KeyStatus | null> {
  const store = await readStore()
  const r = store.rows.find((x) => x.id === id)
  return r ? r.status : null
}

/** The last4 of a row, derived by decrypt — for audit entries. Never a full key. */
export async function getLast4(id: string): Promise<string | null> {
  const store = await readStore()
  const r = store.rows.find((x) => x.id === id)
  return r ? deriveLast4(r) : null
}

export interface SetStatusOpts {
  error?: string | null
  verifiedAt?: string | null
  tradingEnabledAt?: string | null
}

/** Update a row's status (and optional timestamps / lastError). Returns the PUBLIC row or null. */
export async function setStatus(
  id: string,
  status: KeyStatus,
  opts: SetStatusOpts = {},
): Promise<PublicRow | null> {
  const store = await readStore()
  const r = store.rows.find((x) => x.id === id)
  if (!r) return null
  r.status = status
  if (opts.error !== undefined) r.lastError = opts.error
  if (opts.verifiedAt !== undefined) r.verifiedAt = opts.verifiedAt
  if (opts.tradingEnabledAt !== undefined) r.tradingEnabledAt = opts.tradingEnabledAt
  await writeStore(store)
  return toPublic(r)
}

/**
 * Revoke = delete the row entirely AND zero its wrapped DEK. Removing the row from
 * the file already drops the ciphertext from disk; we additionally overwrite dekEnc
 * in memory before the write so the wrapped key is not recoverable from any lingering
 * reference. Returns true if a row was removed.
 */
export async function revokeRow(id: string): Promise<boolean> {
  const store = await readStore()
  const idx = store.rows.findIndex((x) => x.id === id)
  if (idx === -1) return false
  const [removed] = store.rows.splice(idx, 1)
  // Zero the DEK material — "Revoke deletes the row and zeroes the DEK".
  removed.dekEnc = ''
  removed.apiKeyEnc = null
  removed.apiSecretEnc = ''
  removed.passphraseEnc = null
  await writeStore(store)
  return true
}
