// scripts/polymarket-derive-creds.ts — derive Polymarket L2 API creds and persist them ENCRYPTED as the
// venue='polymarket' ExchangeKey row the maker/cancel path reads (loadPolymarketCreds).
//
// KEY SOURCE (in order): the stored maker signing key from custody (default — no secret in env/history),
// or POLYMARKET_PRIVATE_KEY as an explicit override. Deriving L2 creds is an L1 op (needs the wallet's
// EIP-712 signature); the key is used once here and then dropped. Normal operation (cancel/list) uses
// ONLY the derived L2 creds, never the private key again.
//
//   # after storing the signing key with polymarket-maker-store-key:
//   npx tsx scripts/polymarket-derive-creds.ts
//   # or with an explicit key override:
//   POLYMARKET_PRIVATE_KEY=0x… npx tsx scripts/polymarket-derive-creds.ts
//
// POLYMARKET_USER_ID is optional (admin service account resolved automatically). Prints NOTHING secret —
// row id + wallet address + resolved userId only. Does NOT set verifiedAt (derivation ≠ proof); verify next.

import { PrismaClient } from '@prisma/client'
import { Wallet } from 'ethers'
import { ClobClient } from '@polymarket/clob-client'
import { storePolymarketCreds, POLY_VENUE } from '../lib/venues/polymarket-clob/credentials'
import { loadMakerSigningKey } from '../lib/venues/polymarket-clob-maker/credentials'
import { resolveAdminServiceUserId } from '../lib/admin-service-account'

const HOST = 'https://clob.polymarket.com'
const CHAIN_ID = 137 // Polygon mainnet

async function main() {
  const label = process.env.POLYMARKET_LABEL || 'polymarket-l2-derived'
  const sigType = process.env.POLYMARKET_SIGNATURE_TYPE ? Number(process.env.POLYMARKET_SIGNATURE_TYPE) : undefined
  const funder = process.env.POLYMARKET_FUNDER_ADDRESS || undefined

  const prisma = new PrismaClient()
  try {
    const userId = process.env.POLYMARKET_USER_ID || (await resolveAdminServiceUserId(prisma))

    // Key source: explicit env override, else decrypt the stored maker signing key from custody.
    let pk = process.env.POLYMARKET_PRIVATE_KEY || ''
    let address: string
    if (pk) {
      if (!/^0x[a-fA-F0-9]{64}$/.test(pk)) throw new Error('POLYMARKET_PRIVATE_KEY must be a 0x-prefixed 64-hex private key (env only)')
      address = new Wallet(pk).address
    } else {
      // Reads venue='polymarket-maker' from custody. Throws a clear message if none stored.
      const signing = await loadMakerSigningKey(prisma, userId)
      pk = signing.privateKey
      address = signing.address
    }

    // DUPLICATE GUARD: don't stack L2 rows and let "most recent wins" decide. Revoke first to re-derive.
    const existingL2 = await prisma.exchangeKey.findFirst({
      where: { venue: POLY_VENUE, revokedAt: null, userId },
      select: { id: true },
    })
    if (existingL2) {
      console.error(`Refusing: an ACTIVE polymarket L2 credential already exists — ExchangeKey ${existingL2.id}.`)
      console.error('Revoke it first (from /settings/keys, or set revokedAt) to re-derive.')
      process.exit(2)
    }

    const wallet = new Wallet(pk)
    // clob-client detects an ethers-v5-style signer via `_signTypedData`; shim ethers v6.
    const signer: any = {
      _signTypedData: (domain: any, types: any, value: any) => wallet.signTypedData(domain, types, value),
      getAddress: async () => address,
    }
    const client = new ClobClient(HOST, CHAIN_ID, signer, undefined, sigType as any, funder)
    const creds = await client.createOrDeriveApiKey() // L1 op: create if absent, else derive
    if (!creds || !creds.key || !creds.secret || !creds.passphrase) throw new Error('CLOB did not return complete API creds')

    const id = await storePolymarketCreds(prisma, { userId, label, creds, address })
    pk = '' // drop the plaintext key reference (best-effort; JS can't zero a string)
    console.log(`row: ${id}`)
    console.log(`wallet: ${address}`)
    console.log(`userId: ${userId}`)
    console.log('NOT yet verified. Next: run "Test read-only" in /settings/keys, or scripts/polymarket-verify-live.ts')
  } finally {
    await prisma.$disconnect()
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('derive failed:', String(e && e.message ? e.message : e).slice(0, 300))
    process.exit(1)
  })
