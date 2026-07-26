// lib/venues/polymarket-clob-maker/credentials.ts — load the maker's SIGNING KEY from custody.
//
// The maker needs two things to place an order:
//   • the L2 API creds (key/secret/passphrase) — reused verbatim from the cancel adapter's
//     loadPolymarketCreds (venue='polymarket'); these authenticate post/cancel/list (L2 HMAC).
//   • the raw wallet PRIVATE KEY — to produce the L1 EIP-712 order signature (createOrder). This is
//     NOT stored by the cancel-only flow (that flow discards the key after deriving L2 creds). The
//     maker stores it in the EXISTING key-custody envelope as its OWN ExchangeKey row
//     (venue='polymarket-maker', apiSecretEnc = encrypted private key) — the SAME pattern dYdX already
//     uses ("For dYdX this is the authenticator PRIVATE KEY", schema comment). No new table, no new
//     column, no change to the cancel adapter or its custody.
//
// The key is decrypted ONLY here, ONLY when the engine is armed (live-min/live), handed straight to the
// signing signer, and never persisted in plaintext, logged, or returned in an error.

import { PrismaClient } from '@prisma/client'
import { decryptField, unwrapDek } from '../../key-custody'
import { loadPolymarketCreds } from '../polymarket-clob/credentials'

export const POLY_MAKER_VENUE = 'polymarket-maker'

/** The active (non-revoked) maker signing-key row, or null. Most recently created wins. */
async function activeMakerRow(prisma: PrismaClient, userId?: string) {
  return prisma.exchangeKey.findFirst({
    where: { venue: POLY_MAKER_VENUE, revokedAt: null, ...(userId ? { userId } : {}) },
    orderBy: { createdAt: 'desc' },
  })
}

/**
 * Decrypt the raw signing private key + its wallet address. Throws if none stored or custody fails.
 * NEVER logs, NEVER echoes the key in an error. Callers must scrub the returned key ASAP (hand it to
 * the signing signer and drop the reference).
 */
export async function loadMakerSigningKey(
  prisma: PrismaClient,
  userId?: string,
): Promise<{ id: string; privateKey: string; address: string }> {
  const row = await activeMakerRow(prisma, userId)
  if (!row) throw new Error('loadMakerSigningKey: no active polymarket-maker signing key stored (run scripts/polymarket-maker-store-key.ts)')
  if (!row.apiSecretEnc || !row.accountAddress) throw new Error('loadMakerSigningKey: row is missing fields')
  const dek = unwrapDek(row.dekEnc, row.kekVersion)
  try {
    return { id: row.id, privateKey: decryptField(row.apiSecretEnc, dek), address: row.accountAddress }
  } finally {
    dek.fill(0)
  }
}

/**
 * The stored PROXY (funder) wallet for the active maker account, or null when none is stored yet.
 * This is a PUBLIC 0x address (not a secret) — it holds the pUSD collateral and is the order `maker`.
 * Persisted by scripts/maker-store-proxy.ts (derived on-chain from the signer). Read-only consumers
 * (preflight, the pUSD display, the settings badge) read THIS so they never fall back to the signer.
 * Returns the checksummed address, or null if the row has no proxyAddress (never fabricated).
 */
export async function loadMakerProxyAddress(
  prisma: PrismaClient,
  userId?: string,
): Promise<string | null> {
  const row = await activeMakerRow(prisma, userId)
  const addr = row?.proxyAddress ?? null
  if (!addr) return null
  try {
    return require('ethers').getAddress(addr)
  } catch {
    return null
  }
}

/**
 * The provider pair the maker adapter needs when armed. Returns two async thunks:
 *   credsProvider  → L2 creds + address (reused from the cancel flow)
 *   signerProvider → raw private key + address (from the maker row)
 * Constructed ONLY on the armed path; in off/paper the adapter never calls them.
 */
export function makerProviders(prisma: PrismaClient, userId?: string) {
  return {
    credsProvider: async () => {
      const { creds, address } = await loadPolymarketCreds(prisma, userId)
      return { creds, address }
    },
    signerProvider: async () => {
      const { privateKey, address } = await loadMakerSigningKey(prisma, userId)
      return { privateKey, address }
    },
  }
}
