import { promises as fs } from 'fs'
import path from 'path'
import { prisma } from '@/lib/prisma'
import { newDek, wrapDek, unwrapDek, encryptField, decryptField } from '@/lib/key-custody'
import { resolveAdminServiceUserId } from '@/lib/admin-service-account'
import { storePolymarketCreds } from '@/lib/venues/polymarket-clob/credentials'

/**
 * Prisma-backed store for the admin/maker venue-credential lane (polymarket + kalshi). This REPLACES the
 * old file-backed lib/venue-maker-keys.ts: it writes the SAME ExchangeKey rows the maker actually reads
 * (loadPolymarketCreds), through the SAME lib/key-custody envelope. One store, one crypto path.
 *
 * OWNERSHIP: every admin-lane row belongs to the dedicated service-account User (lib/admin-service-account).
 * All queries are scoped to that userId AND venue ∈ {polymarket, kalshi}, so this lane can NEVER read or
 * write the maker's signing-key row (venue='polymarket-maker') — the raw wallet key stays CLI-only.
 *
 * WHAT NEVER LEAVES THIS MODULE: apiKey, apiSecret, passphrase — never plaintext, never masked. The only
 * credential-derived value returned is last4, derived on read by decrypting, never persisted.
 */

export type VenueId = 'polymarket' | 'kalshi'
export type KeyStatus = 'NOT_CONNECTED' | 'VERIFIED_READ_ONLY' | 'VERIFIED_TRADING'
const ADMIN_VENUES: VenueId[] = ['polymarket', 'kalshi']

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

export interface DecryptedCreds {
  venue: VenueId
  walletAddress: string | null
  apiKey: string | null
  apiSecret: string
  passphrase: string | null
}

export interface SaveInput {
  venue: VenueId
  label: string
  walletAddress?: string | null
  apiKey?: string | null
  apiSecret: string
  passphrase?: string | null
}

// Row shape we read back from Prisma (only the columns we use).
type Row = {
  id: string
  venue: string
  label: string
  accountAddress: string | null
  apiKeyEnc: string | null
  apiSecretEnc: string
  passphraseEnc: string | null
  dekEnc: string
  kekVersion: number
  verifiedAt: Date | null
  tradingEnabledAt: Date | null
  revokedAt: Date | null
  lastError: string | null
  createdAt: Date
}

let _cachedUserId: string | null = null
async function serviceUserId(): Promise<string> {
  if (!_cachedUserId) _cachedUserId = await resolveAdminServiceUserId(prisma)
  return _cachedUserId
}

function last4(s: string): string {
  return s.length <= 4 ? s : s.slice(-4)
}

function deriveStatus(r: Row): KeyStatus {
  if (r.tradingEnabledAt) return 'VERIFIED_TRADING'
  if (r.verifiedAt) return 'VERIFIED_READ_ONLY'
  return 'NOT_CONNECTED'
}

/** last4 of the api key (or, if none, the public wallet address). Plaintext lives only inside here. */
function deriveLast4(r: Row): string | null {
  try {
    if (r.apiKeyEnc) {
      const dek = unwrapDek(r.dekEnc, r.kekVersion)
      try {
        return last4(decryptField(r.apiKeyEnc, dek))
      } finally {
        dek.fill(0)
      }
    }
    if (r.accountAddress) return last4(r.accountAddress)
    return null
  } catch {
    return null
  }
}

function toPublic(r: Row): PublicRow {
  return {
    id: r.id,
    venue: r.venue as VenueId,
    label: r.label,
    walletAddress: r.accountAddress ?? null,
    last4: deriveLast4(r),
    status: deriveStatus(r),
    savedAt: r.createdAt.toISOString(),
    verifiedAt: r.verifiedAt ? r.verifiedAt.toISOString() : null,
    tradingEnabledAt: r.tradingEnabledAt ? r.tradingEnabledAt.toISOString() : null,
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
    lastError: r.lastError ?? null,
  }
}

// One-time opportunistic migration of the OLD file store into Prisma. Copies the encrypted envelope
// VERBATIM (same key-custody scheme) — never decrypts. Renames the file to .migrated (retained, not
// deleted) so it never runs twice. A no-op when the file is absent.
let _migrationChecked = false
async function migrateFileStoreIfPresent(): Promise<void> {
  if (_migrationChecked) return
  _migrationChecked = true
  const file = path.join(process.cwd(), 'data', 'venue-maker-keys.json')
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    return // absent → nothing to migrate
  }
  let parsed: { rows?: unknown[] }
  try {
    parsed = JSON.parse(raw)
  } catch {
    return
  }
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : []
  const userId = await serviceUserId()
  let migrated = 0
  for (const rr of rows as Record<string, unknown>[]) {
    if (!rr.apiSecretEnc || !rr.dekEnc || !rr.venue) continue
    if (!ADMIN_VENUES.includes(rr.venue as VenueId)) continue
    await prisma.exchangeKey.create({
      data: {
        userId,
        venue: rr.venue as string,
        label: (rr.label as string) ?? `${rr.venue} (migrated)`,
        apiKeyEnc: (rr.apiKeyEnc as string) ?? null,
        apiSecretEnc: rr.apiSecretEnc as string,
        passphraseEnc: (rr.passphraseEnc as string) ?? null,
        accountAddress: (rr.walletAddress as string) ?? null,
        dekEnc: rr.dekEnc as string,
        kekVersion: (rr.kekVersion as number) ?? 1,
        verifiedAt: rr.verifiedAt ? new Date(rr.verifiedAt as string) : null,
        tradingEnabledAt: rr.tradingEnabledAt ? new Date(rr.tradingEnabledAt as string) : null,
        lastError: (rr.lastError as string) ?? null,
        revokedAt: rr.revokedAt ? new Date(rr.revokedAt as string) : null,
        ...(rr.savedAt ? { createdAt: new Date(rr.savedAt as string) } : {}),
      },
    })
    migrated++
  }
  await fs.rename(file, `${file}.migrated`).catch(() => {})
  if (migrated) console.log(`[admin-venue-keys] migrated ${migrated} row(s) from the file store into Prisma`)
}

/** PUBLIC view of every ACTIVE admin-lane row. Never any *Enc field or plaintext secret. */
export async function listRows(): Promise<PublicRow[]> {
  await migrateFileStoreIfPresent()
  const userId = await serviceUserId()
  const rows = (await prisma.exchangeKey.findMany({
    where: { userId, venue: { in: ADMIN_VENUES }, revokedAt: null },
    orderBy: { createdAt: 'desc' },
  })) as unknown as Row[]
  return rows.map(toPublic)
}

/**
 * Encrypt + persist a new credential row. For polymarket we reuse storePolymarketCreds so the field
 * mapping is IDENTICAL to what loadPolymarketCreds reads back (apiKeyEnc=key, apiSecretEnc=secret,
 * passphraseEnc=passphrase, accountAddress=address). Status starts NOT_CONNECTED.
 */
export async function saveRow(input: SaveInput): Promise<PublicRow> {
  await migrateFileStoreIfPresent()
  const userId = await serviceUserId()

  if (input.venue === 'polymarket') {
    if (!input.walletAddress || !input.apiKey || !input.passphrase) {
      throw new Error('polymarket requires walletAddress, apiKey, apiSecret and passphrase')
    }
    const id = await storePolymarketCreds(prisma, {
      userId,
      label: input.label,
      creds: { key: input.apiKey, secret: input.apiSecret, passphrase: input.passphrase },
      address: input.walletAddress,
    })
    const row = (await prisma.exchangeKey.findUnique({ where: { id } })) as unknown as Row
    return toPublic(row)
  }

  // kalshi: generic envelope write (apiKey optional, apiSecret is the PEM; no wallet/passphrase).
  const dek = newDek()
  try {
    const row = (await prisma.exchangeKey.create({
      data: {
        userId,
        venue: input.venue,
        label: input.label,
        apiKeyEnc: input.apiKey ? encryptField(input.apiKey, dek) : null,
        apiSecretEnc: encryptField(input.apiSecret, dek),
        passphraseEnc: input.passphrase ? encryptField(input.passphrase, dek) : null,
        accountAddress: input.walletAddress ? input.walletAddress.toLowerCase() : null,
        dekEnc: wrapDek(dek, 1),
        kekVersion: 1,
      },
    })) as unknown as Row
    return toPublic(row)
  } finally {
    dek.fill(0)
  }
}

async function findScoped(id: string, opts: { includeRevoked?: boolean } = {}): Promise<Row | null> {
  const userId = await serviceUserId()
  const row = await prisma.exchangeKey.findFirst({
    where: { id, userId, venue: { in: ADMIN_VENUES }, ...(opts.includeRevoked ? {} : { revokedAt: null }) },
  })
  return (row as unknown as Row) ?? null
}

/** Decrypt a row's credentials for an in-process verification call ONLY. Never returned/logged. */
export async function getDecryptedCreds(id: string): Promise<DecryptedCreds | null> {
  const r = await findScoped(id)
  if (!r) return null
  try {
    const dek = unwrapDek(r.dekEnc, r.kekVersion)
    try {
      return {
        venue: r.venue as VenueId,
        walletAddress: r.accountAddress ?? null,
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

/** PUBLIC view of one row (active or revoked), or null. */
export async function getPublicRow(id: string): Promise<PublicRow | null> {
  const r = await findScoped(id, { includeRevoked: true })
  return r ? toPublic(r) : null
}

export async function getStatus(id: string): Promise<KeyStatus | null> {
  const r = await findScoped(id, { includeRevoked: true })
  return r ? deriveStatus(r) : null
}

export async function getLast4(id: string): Promise<string | null> {
  const r = await findScoped(id, { includeRevoked: true })
  return r ? deriveLast4(r) : null
}

export interface SetStatusOpts {
  error?: string | null
  verifiedAt?: string | null
  tradingEnabledAt?: string | null
}

/** Update a row's two-stage state (and optional timestamps / lastError). Returns the PUBLIC row or null. */
export async function setStatus(id: string, status: KeyStatus, opts: SetStatusOpts = {}): Promise<PublicRow | null> {
  const existing = await findScoped(id, { includeRevoked: true })
  if (!existing) return null

  const data: {
    lastError?: string | null
    verifiedAt?: Date | null
    tradingEnabledAt?: Date | null
  } = {}
  if (opts.error !== undefined) data.lastError = opts.error
  if (opts.verifiedAt !== undefined) data.verifiedAt = opts.verifiedAt ? new Date(opts.verifiedAt) : null
  if (opts.tradingEnabledAt !== undefined) data.tradingEnabledAt = opts.tradingEnabledAt ? new Date(opts.tradingEnabledAt) : null

  // Honour the target status even if the caller passed no explicit timestamp — but NEVER overwrite an
  // existing timestamp (a re-verify or a failure must not reset when the stage was already reached).
  if (status === 'VERIFIED_READ_ONLY' && data.verifiedAt === undefined && !existing.verifiedAt) data.verifiedAt = new Date()
  if (status === 'VERIFIED_TRADING' && data.tradingEnabledAt === undefined && !existing.tradingEnabledAt) data.tradingEnabledAt = new Date()
  if (status === 'NOT_CONNECTED') {
    data.verifiedAt = null
    data.tradingEnabledAt = null
  }

  const row = (await prisma.exchangeKey.update({ where: { id }, data })) as unknown as Row
  return toPublic(row)
}

/** Revoke: set revokedAt (retain the row + ciphertext for audit) and clear the verified/trading stages. */
export async function revokeRow(id: string): Promise<boolean> {
  const userId = await serviceUserId()
  const existing = await prisma.exchangeKey.findFirst({
    where: { id, userId, venue: { in: ADMIN_VENUES }, revokedAt: null },
    select: { id: true },
  })
  if (!existing) return false
  await prisma.exchangeKey.update({
    where: { id },
    data: { revokedAt: new Date(), verifiedAt: null, tradingEnabledAt: null },
  })
  return true
}
