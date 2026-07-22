// scripts/polymarket-maker-store-key.ts — ONE-SHOT (human, once): store the maker's raw signing key
// ENCRYPTED in the existing key-custody envelope so the maker adapter can produce the L1 EIP-712 order
// signature when armed. This is the ONLY new custody plumbing the maker needs — it reuses the same
// ExchangeKey table + AES-256-GCM envelope, storing the private key in apiSecretEnc exactly as dYdX
// already stores its authenticator private key (schema comment, line 66). No new table/column.
//
//   Usage (key via env ONLY — never a CLI arg, so it can't land in shell history):
//     POLYMARKET_PRIVATE_KEY=0x... POLYMARKET_USER_ID=<userId> npx tsx scripts/polymarket-maker-store-key.ts
//
// SAFETY: prints NOTHING secret (row id + derived address only). The key is used once to derive the
// address (to record which wallet this is), encrypted, and the plaintext dropped. Placement is still
// gated: MAKER_MODE must be live-min/live AND the engine's live provider hook must be wired (a separate
// reviewed change) before this key is ever decrypted. Storing the key does NOT arm anything.

import { PrismaClient } from '@prisma/client'
import { Wallet } from 'ethers'
import { newDek, wrapDek, encryptField } from '../lib/key-custody'
import { POLY_MAKER_VENUE } from '../lib/venues/polymarket-clob-maker/credentials'

async function main() {
  const pk = process.env.POLYMARKET_PRIVATE_KEY || ''
  const userId = process.env.POLYMARKET_USER_ID || ''
  const label = process.env.POLYMARKET_MAKER_LABEL || 'polymarket-maker-signer'
  if (!/^0x[a-fA-F0-9]{64}$/.test(pk)) throw new Error('POLYMARKET_PRIVATE_KEY must be a 0x-prefixed 64-hex private key (env only)')
  if (!userId) throw new Error('POLYMARKET_USER_ID is required')

  const address = new Wallet(pk).address // derive the public address only
  const prisma = new PrismaClient()
  const dek = newDek()
  try {
    const row = await prisma.exchangeKey.create({
      data: {
        userId,
        venue: POLY_MAKER_VENUE,
        label,
        apiSecretEnc: encryptField(pk, dek),   // the raw signing key (dYdX pattern), encrypted under the row DEK
        accountAddress: address.toLowerCase(), // non-secret; which wallet this key controls
        dekEnc: wrapDek(dek, 1),
        kekVersion: 1,
      },
      select: { id: true },
    })
    console.log(`Stored Polymarket MAKER signing key (encrypted) as ExchangeKey ${row.id} for wallet ${address}.`)
    console.log('This does NOT arm anything. Placement still requires MAKER_MODE=live-min/live AND the wired live provider hook.')
    console.log('Before going live, ensure the wallet has: funded pUSD/USDC.e + ERC-20 allowance + ERC-1155 CTF approvals to the 3 exchange contracts (see the maker README).')
  } finally {
    dek.fill(0)
    await prisma.$disconnect()
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('store-key failed:', String(e && e.message ? e.message : e).slice(0, 200)); process.exit(1) })
