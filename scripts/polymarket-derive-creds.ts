// scripts/polymarket-derive-creds.ts — ONE-SHOT: derive Polymarket L2 API creds from a wallet private
// key and persist them encrypted, then discard the key. Run by a human, once, per wallet.
//
//   Usage (private key is passed via env and NEVER a CLI arg, so it can't land in shell history):
//     POLYMARKET_PRIVATE_KEY=0x... POLYMARKET_USER_ID=<userId> \
//     [POLYMARKET_SIGNATURE_TYPE=0] [POLYMARKET_FUNDER_ADDRESS=0x...] \
//     npx tsx scripts/polymarket-derive-creds.ts
//
// AUTH MODEL (verified from the client source): deriving L2 creds is an L1 operation — it needs the
// wallet's EIP-712 signature, i.e. the private key. This is the ONLY step that touches the private
// key. The derived {key, secret, passphrase} + the public wallet address are what get stored; normal
// operation (cancel / list) uses ONLY those (L2 HMAC), never the private key again.
//
// This script prints NOTHING secret — only the new row id and the wallet address. It does not set
// verifiedAt: derivation is not proof the creds authenticate. Run polymarket-verify-live.ts next.

import { PrismaClient } from '@prisma/client'
import { Wallet } from 'ethers'
import { ClobClient } from '@polymarket/clob-client'
import { storePolymarketCreds } from '../lib/venues/polymarket-clob/credentials'

const HOST = 'https://clob.polymarket.com'
const CHAIN_ID = 137 // Polygon mainnet

async function main() {
  const pk = process.env.POLYMARKET_PRIVATE_KEY || ''
  const userId = process.env.POLYMARKET_USER_ID || ''
  const label = process.env.POLYMARKET_LABEL || 'polymarket-cancel-only'
  const sigType = process.env.POLYMARKET_SIGNATURE_TYPE ? Number(process.env.POLYMARKET_SIGNATURE_TYPE) : undefined
  const funder = process.env.POLYMARKET_FUNDER_ADDRESS || undefined

  if (!/^0x[a-fA-F0-9]{64}$/.test(pk)) throw new Error('POLYMARKET_PRIVATE_KEY must be a 0x-prefixed 64-hex private key (env only)')
  if (!userId) throw new Error('POLYMARKET_USER_ID is required (the local user this connection belongs to)')

  const wallet = new Wallet(pk)
  const address = wallet.address
  // clob-client detects an ethers-v5-style signer via `_signTypedData`; ethers v6 exposes
  // `signTypedData`. Shim it so the client uses this wallet for the L1 signature + address.
  const signer: any = {
    _signTypedData: (domain: any, types: any, value: any) => wallet.signTypedData(domain, types, value),
    getAddress: async () => address,
  }

  const client = new ClobClient(HOST, CHAIN_ID, signer, undefined, sigType as any, funder)
  // L1 op: create the key if absent, else derive the existing one. Deterministic for a given wallet.
  const creds = await client.createOrDeriveApiKey()
  if (!creds || !creds.key || !creds.secret || !creds.passphrase) throw new Error('CLOB did not return complete API creds')

  const prisma = new PrismaClient()
  try {
    const id = await storePolymarketCreds(prisma, { userId, label, creds, address })
    // NOTHING secret is printed. Row id + address only.
    console.log(`Stored Polymarket L2 creds (encrypted) as ExchangeKey ${id} for wallet ${address}.`)
    console.log('NOT yet verified. Next: POLYMARKET_USER_ID=%s npx tsx scripts/polymarket-verify-live.ts', userId)
  } finally {
    await prisma.$disconnect()
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    // Never print the raw error (could echo a signed payload). Message only, truncated.
    console.error('derive failed:', String(e && e.message ? e.message : e).slice(0, 300))
    process.exit(1)
  })
