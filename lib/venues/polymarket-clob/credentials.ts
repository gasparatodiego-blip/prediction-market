// lib/venues/polymarket-clob/credentials.ts — persistence for Polymarket CLOB L2 API credentials.
//
// Reuses the EXISTING envelope encryption (lib/key-custody) and the EXISTING ExchangeKey row — no new
// table, no new column. A Polymarket connection is one ExchangeKey with venue='polymarket':
//   apiKeyEnc      = derived API key       (encrypted under the row DEK)
//   apiSecretEnc   = derived API secret    (encrypted under the row DEK)   ← the HMAC secret
//   passphraseEnc  = derived API passphrase(encrypted under the row DEK)
//   accountAddress = the wallet address    (PLAINTEXT, non-secret — the POLY_ADDRESS header value)
//   verifiedAt     = set ONLY by the verify command after a successful read (never by hand)
//   revokedAt      = set by revoke → flips liveVerified back to false
//
// The raw wallet PRIVATE KEY is NEVER stored. It is used once, in the derive script, to obtain the L2
// creds via the CLOB (L1 EIP-712), and then discarded. Everything persisted here is L2-only: it can
// cancel and read, and — because Polymarket order PLACEMENT needs an EIP-712-signed order and this
// adapter never signs one — it cannot open exposure.

import { PrismaClient } from '@prisma/client'
import { newDek, wrapDek, encryptField, decryptField, unwrapDek } from '../../key-custody'

export const POLY_VENUE = 'polymarket'

export interface PolyApiCreds {
  key: string
  secret: string
  passphrase: string
}

/** Encrypt + persist a freshly derived L2 credential as an ExchangeKey row. Returns the row id. */
export async function storePolymarketCreds(
  prisma: PrismaClient,
  args: { userId: string; label: string; creds: PolyApiCreds; address: string },
): Promise<string> {
  const { userId, label, creds, address } = args
  if (!creds.key || !creds.secret || !creds.passphrase) throw new Error('storePolymarketCreds: incomplete creds')
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error('storePolymarketCreds: address must be a 0x40-hex wallet address')

  const dek = newDek()
  try {
    const row = await prisma.exchangeKey.create({
      data: {
        userId,
        venue: POLY_VENUE,
        label,
        apiKeyEnc: encryptField(creds.key, dek),
        apiSecretEnc: encryptField(creds.secret, dek),
        passphraseEnc: encryptField(creds.passphrase, dek),
        accountAddress: address.toLowerCase(),
        dekEnc: wrapDek(dek, 1),
        kekVersion: 1,
        // NOT verified yet: derivation ≠ proof the creds authenticate. The verify command sets this.
      },
      select: { id: true },
    })
    return row.id
  } finally {
    dek.fill(0) // don't leave the plaintext DEK in a heap buffer
  }
}

/** The stored, active (non-revoked) Polymarket row, or null. Picks the most recently created. */
async function activeRow(prisma: PrismaClient, userId?: string) {
  return prisma.exchangeKey.findFirst({
    where: { venue: POLY_VENUE, revokedAt: null, ...(userId ? { userId } : {}) },
    orderBy: { createdAt: 'desc' },
  })
}

/** Decrypt the stored L2 creds + address for a live/verify call. Throws if none or if custody fails. */
export async function loadPolymarketCreds(
  prisma: PrismaClient,
  userId?: string,
): Promise<{ id: string; creds: PolyApiCreds; address: string }> {
  const row = await activeRow(prisma, userId)
  if (!row) throw new Error('loadPolymarketCreds: no active Polymarket credential stored')
  if (!row.apiKeyEnc || !row.passphraseEnc || !row.accountAddress) throw new Error('loadPolymarketCreds: row is missing fields')

  const dek = unwrapDek(row.dekEnc, row.kekVersion)
  try {
    return {
      id: row.id,
      address: row.accountAddress,
      creds: {
        key: decryptField(row.apiKeyEnc, dek),
        secret: decryptField(row.apiSecretEnc, dek),
        passphrase: decryptField(row.passphraseEnc, dek),
      },
    }
  } finally {
    dek.fill(0)
  }
}

/**
 * Mark a row verified. Called ONLY by the verify command after a successful authenticated READ.
 * Records the wallet address it authenticated against (address only — never key material) and the
 * timestamp. There is deliberately no "set verified = true" API that takes a boolean.
 */
export async function markPolymarketVerified(
  prisma: PrismaClient,
  rowId: string,
  address: string,
  permissions: string[],
): Promise<void> {
  await prisma.exchangeKey.update({
    where: { id: rowId },
    data: { verifiedAt: new Date(), permissionsAtVerify: permissions, accountAddress: address.toLowerCase() },
  })
}

/** Revoke: retire the row (audit-retained) and clear verifiedAt so liveVerified flips back to false. */
export async function revokePolymarketCreds(prisma: PrismaClient, userId?: string): Promise<number> {
  const rows = await prisma.exchangeKey.findMany({
    where: { venue: POLY_VENUE, revokedAt: null, ...(userId ? { userId } : {}) },
    select: { id: true },
  })
  let n = 0
  for (const r of rows) {
    await prisma.exchangeKey.update({ where: { id: r.id }, data: { revokedAt: new Date(), verifiedAt: null } })
    n++
  }
  return n
}

/**
 * The honest liveVerified fact for the news-guard gate: an active Polymarket row that a human verified
 * (verifiedAt set) and has not revoked. This is the ONLY thing that should feed keyState.liveVerified.
 */
export async function getPolymarketLiveVerified(prisma: PrismaClient, userId?: string): Promise<boolean> {
  const row = await prisma.exchangeKey.findFirst({
    where: { venue: POLY_VENUE, revokedAt: null, verifiedAt: { not: null }, ...(userId ? { userId } : {}) },
    select: { id: true },
  })
  return row != null
}
