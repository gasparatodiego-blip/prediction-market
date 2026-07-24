// scripts/polymarket-maker-revoke-key.ts — revoke the ACTIVE maker signing key (venue='polymarket-maker').
// Sets revokedAt (row + ciphertext retained for audit); never deletes. After this, store-key can store a
// new signer. Prints only the affected row id + wallet — nothing secret.
//
//   npx tsx scripts/polymarket-maker-revoke-key.ts            # admin service account (default)
//   POLYMARKET_USER_ID=<id> npx tsx scripts/polymarket-maker-revoke-key.ts

import { PrismaClient } from '@prisma/client'
import { POLY_MAKER_VENUE } from '../lib/venues/polymarket-clob-maker/credentials'
import { resolveAdminServiceUserId } from '../lib/admin-service-account'

async function main() {
  const prisma = new PrismaClient()
  try {
    const userId = process.env.POLYMARKET_USER_ID || (await resolveAdminServiceUserId(prisma))
    const rows = await prisma.exchangeKey.findMany({
      where: { venue: POLY_MAKER_VENUE, revokedAt: null, userId },
      select: { id: true, accountAddress: true },
    })
    if (rows.length === 0) {
      console.log('No active maker signing key to revoke.')
      return
    }
    for (const r of rows) {
      await prisma.exchangeKey.update({ where: { id: r.id }, data: { revokedAt: new Date() } })
      console.log(`revoked: ${r.id} (wallet ${r.accountAddress})`)
    }
  } finally {
    await prisma.$disconnect()
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('revoke-key failed:', String(e && e.message ? e.message : e).slice(0, 200))
    process.exit(1)
  })
