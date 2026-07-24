// scripts/polymarket-maker-store-key.ts — ONE-SHOT (human, once): store the maker's raw signing key
// ENCRYPTED in the existing key-custody envelope so the maker adapter can produce the L1 EIP-712 order
// signature when armed. Reuses the ExchangeKey table + AES-256-GCM envelope, storing the private key in
// apiSecretEnc exactly as dYdX stores its authenticator key. No new table/column.
//
//   Usage (key via env ONLY — never a CLI arg, so it can't land in shell history):
//     read -rs POLYMARKET_PRIVATE_KEY   # paste the 0x… key, press enter (nothing echoes)
//     POLYMARKET_PRIVATE_KEY=$POLYMARKET_PRIVATE_KEY npx tsx scripts/polymarket-maker-store-key.ts
//
// POLYMARKET_USER_ID is OPTIONAL now: if unset, the admin-lane service account is resolved automatically
// (lib/admin-service-account) — the operator has no way to know a next-auth userId, so they shouldn't need to.
//
// SAFETY: prints NOTHING secret (row id + derived address + resolved userId only). The key is used once to
// derive the address, encrypted, and the plaintext dropped. Storing the key ARMS NOTHING — placement still
// requires MAKER_MODE=live-min/live AND the wired live provider hook.

import { PrismaClient } from '@prisma/client'
import { Wallet } from 'ethers'
import { newDek, wrapDek, encryptField } from '../lib/key-custody'
import { POLY_MAKER_VENUE } from '../lib/venues/polymarket-clob-maker/credentials'
import { resolveAdminServiceUserId } from '../lib/admin-service-account'

async function main() {
  const pk = process.env.POLYMARKET_PRIVATE_KEY || ''
  const label = process.env.POLYMARKET_MAKER_LABEL || 'polymarket-maker-signer'
  if (!/^0x[a-fA-F0-9]{64}$/.test(pk)) {
    throw new Error('POLYMARKET_PRIVATE_KEY must be a 0x-prefixed 64-hex private key (env only)')
  }

  const prisma = new PrismaClient()
  try {
    // Auto-resolve the owner: explicit env override, else the admin-lane service account.
    const userId = process.env.POLYMARKET_USER_ID || (await resolveAdminServiceUserId(prisma))

    // DUPLICATE GUARD: refuse to create a SECOND active signer rather than let "most recently created
    // wins" silently decide which key signs. Instruct how to revoke the existing one first.
    const existing = await prisma.exchangeKey.findFirst({
      where: { venue: POLY_MAKER_VENUE, revokedAt: null, userId },
      select: { id: true, accountAddress: true },
    })
    if (existing) {
      console.error(`Refusing: an ACTIVE maker signing key already exists — ExchangeKey ${existing.id} (wallet ${existing.accountAddress}).`)
      console.error('Revoke it before storing a new one:')
      console.error(`  npx tsx scripts/polymarket-maker-revoke-key.ts   # or set revokedAt on ${existing.id}`)
      process.exit(2)
    }

    const address = new Wallet(pk).address // derive the public address only
    const dek = newDek()
    try {
      const row = await prisma.exchangeKey.create({
        data: {
          userId,
          venue: POLY_MAKER_VENUE,
          label,
          apiSecretEnc: encryptField(pk, dek), // the raw signing key (dYdX pattern), encrypted under the row DEK
          accountAddress: address.toLowerCase(),
          dekEnc: wrapDek(dek, 1),
          kekVersion: 1,
        },
        select: { id: true },
      })
      // Row id + address + resolved userId only. Nothing secret.
      console.log(`row: ${row.id}`)
      console.log(`wallet: ${address}`)
      console.log(`userId: ${userId}`)
    } finally {
      dek.fill(0)
    }
  } finally {
    await prisma.$disconnect()
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('store-key failed:', String(e && e.message ? e.message : e).slice(0, 200))
    process.exit(1)
  })
