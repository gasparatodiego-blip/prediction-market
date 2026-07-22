// scripts/polymarket-revoke-creds.ts — invalidate stored Polymarket creds and flip liveVerified false.
//
//   Usage:
//     [POLYMARKET_USER_ID=<userId>] npx tsx scripts/polymarket-revoke-creds.ts
//
// Sets revokedAt (the row is retained for audit) and clears verifiedAt on every active Polymarket row.
// After this, getPolymarketLiveVerified() → false, so the news-guard's keyLiveVerified gate is closed
// again and the live adapter can never be selected until a fresh derive + verify.
//
// This is the "rotate" path too: revoke here, then re-run polymarket-derive-creds.ts with a new/rotated
// key and verify it. We do NOT reach the venue to delete the server-side API key by default (that is an
// L1 op needing the private key we deliberately do not hold at runtime); revocation is local-first and
// immediate. Delete the key at the venue from the Polymarket UI if you want it gone server-side too.

import { PrismaClient } from '@prisma/client'
import { revokePolymarketCreds } from '../lib/venues/polymarket-clob/credentials'

async function main() {
  const userId = process.env.POLYMARKET_USER_ID || undefined
  const prisma = new PrismaClient()
  try {
    const n = await revokePolymarketCreds(prisma, userId)
    console.log(`Revoked ${n} Polymarket credential row(s). liveVerified is now false${userId ? ` for user ${userId}` : ''}.`)
    console.log('To reconnect: re-run polymarket-derive-creds.ts then polymarket-verify-live.ts.')
  } finally {
    await prisma.$disconnect()
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('revoke failed:', String(e && e.message ? e.message : e).slice(0, 300))
    process.exit(1)
  })
