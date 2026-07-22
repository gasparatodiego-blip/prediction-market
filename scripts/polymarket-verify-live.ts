// scripts/polymarket-verify-live.ts — the ONLY way liveVerified becomes true. Not hand-settable.
//
//   Usage:
//     [POLYMARKET_USER_ID=<userId>] npx tsx scripts/polymarket-verify-live.ts
//
// Proves the stored L2 credentials actually authenticate, using the LEAST DANGEROUS operation there
// is: authenticate and LIST open orders (a pure read, no mutation). It runs that read through the
// cancel-only adapter's own healthCheck(), i.e. the exact address-only-signer + L2-HMAC path that a
// real cancel would use — so a green here means that path authenticates, not merely that a key exists.
//
// Only if the read succeeds does it set verifiedAt + record the wallet address (address only, never key
// material) + the honest permission evidence. There is deliberately no flag or arg that sets verified
// without the read.
//
// HONESTY NOTE on what this proves: there is NO fully-safe test of the CANCEL path without placement —
// the only way to prove a cancel end-to-end is to place a deep post-only order and cancel it, and this
// adapter has no placement by design. So verification proves AUTH + the READ path; the FIRST real
// cancel will be the first true exercise of the cancel path. We do not pretend otherwise: the recorded
// permission is 'l2-auth:ok, read:open-orders', not 'cancel:ok'.

import { createRequire } from 'module'
import { PrismaClient } from '@prisma/client'
import { loadPolymarketCreds, markPolymarketVerified } from '../lib/venues/polymarket-clob/credentials'

// adapter.js is CommonJS (it must be requireable by the plain-node agent); bridge it without a .d.ts.
const require_ = createRequire(import.meta.url)
const { createCancelOnlyAdapter } = require_('../lib/venues/polymarket-clob/adapter')

async function main() {
  const userId = process.env.POLYMARKET_USER_ID || undefined
  const prisma = new PrismaClient()
  try {
    const { id, creds, address } = await loadPolymarketCreds(prisma, userId)

    // Live (NOT dry-run) adapter, creds injected. healthCheck = authenticate + getOpenOrders (read).
    const adapter = createCancelOnlyAdapter({ dryRun: false, credsProvider: async () => ({ creds, address }) })
    const res = await adapter.healthCheck()

    if (!res.ok || !res.authenticated) {
      console.error('verify FAILED — credentials did not authenticate. Nothing was marked verified.')
      console.error('reason:', res.error || 'unknown')
      process.exit(2)
    }

    await markPolymarketVerified(prisma, id, address, ['l2-auth:ok', 'read:open-orders'])
    console.log(`VERIFIED: L2 auth + read succeeded against wallet ${address} (${res.openOrders} open order(s)).`)
    console.log('liveVerified is now true for the news-guard keyLiveVerified gate.')
    console.log('NOTE: this proved AUTH + the read path only. No safe cancel-path test exists without')
    console.log('placement (which this adapter lacks) — the first real cancel is the first true cancel test.')
  } finally {
    await prisma.$disconnect()
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('verify error:', String(e && e.message ? e.message : e).slice(0, 300))
    process.exit(1)
  })
