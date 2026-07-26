// scripts/maker-store-proxy.ts — derive the Polymarket PROXY (funder) wallet for the stored SIGNER and
// persist it on the credential row, so preflight / the pUSD display / the settings badge all read ONE
// source of truth instead of falling back to the signer (which holds nothing).
//
// READ-ONLY on-chain (eth_call), then a SINGLE additive DB write of a PUBLIC 0x address. It never
// decrypts, prints, or touches the signing private key — it reads only the plaintext accountAddress.
//
//   npx tsx scripts/maker-store-proxy.ts            # resolve + persist for the active maker row
//   npx tsx scripts/maker-store-proxy.ts --dry-run  # resolve + print, write nothing
//
// THE PROOF: the derived proxy must equal what Polymarket itself reports for this signer. The script
// resolves on-chain (CTFExchangeV2.getProxyWalletAddress) AND cross-checks the profile API, and REFUSES
// to persist a value the two disagree on. It also refuses if a proxyAddress is already stored and differs
// from the freshly derived one (a silent identity change must never be written unnoticed).

import { JsonRpcProvider, isAddress } from 'ethers'
import { PrismaClient } from '@prisma/client'
import { POLY_MAKER_VENUE } from '../lib/venues/polymarket-clob-maker/credentials'
import { resolveProxyForSigner } from '../lib/venues/polymarket-clob-maker/proxy-wallet'
import { DEFAULT_RPC } from '../lib/poly-contracts'

const DRY = process.argv.includes('--dry-run')
const RPC = process.env.POLYGON_RPC_URL || DEFAULT_RPC

async function main() {
  const prisma = new PrismaClient()
  try {
    const row = await prisma.exchangeKey.findFirst({
      where: { venue: POLY_MAKER_VENUE, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, accountAddress: true, proxyAddress: true },
    })
    if (!row) throw new Error('no active polymarket-maker row — store a signing key first (scripts/polymarket-maker-store-key.ts)')
    const signer = row.accountAddress
    if (!signer || !isAddress(signer)) throw new Error('the maker row has no valid signer accountAddress')

    console.log('Polymarket maker — store proxy (READ-ONLY on-chain, one additive DB write)')
    console.log(`RPC:    ${RPC}`)
    console.log(`SIGNER: ${signer}   (signs only — holds no funds)`)
    console.log(`stored proxyAddress before: ${row.proxyAddress ?? '—'}`)

    const provider = new JsonRpcProvider(RPC)
    let res
    try {
      res = await resolveProxyForSigner(signer, { provider })
    } finally {
      try { provider.destroy() } catch { /* already closed */ }
    }

    console.log(`\non-chain getProxyWalletAddress(signer) = ${res.onChain ?? '—'}`)
    console.log(`profile API proxyWallet(signer)        = ${res.profile ?? '— (unreachable)'}`)
    console.log(`cross-check agree                      = ${res.agree === null ? 'profile unreachable (on-chain stands)' : res.agree}`)

    if (!res.proxyAddress) throw new Error('on-chain resolver returned no proxy for this signer (self-custody EOA, or exchange unreachable) — refusing to persist a fabricated address')
    if (res.agree === false) throw new Error(`profile API (${res.profile}) DISAGREES with on-chain (${res.onChain}) — refusing to persist a contested proxy identity`)
    if (row.proxyAddress && isAddress(row.proxyAddress) && row.proxyAddress.toLowerCase() !== res.proxyAddress.toLowerCase()) {
      throw new Error(`a different proxy is already stored (${row.proxyAddress}) — refusing to silently overwrite; revoke + re-store if the signer truly changed`)
    }

    console.log(`\nPROXY (funder): ${res.proxyAddress}   (holds pUSD + approvals — the order \`maker\`)`)

    if (DRY) {
      console.log('\n--dry-run: nothing written.')
      return
    }
    // Stamp the proxy on EVERY non-revoked row that shares this signer — the maker row AND the L2
    // `polymarket` row the settings admin displays — so the badge and the preflight read the same proxy.
    // Scoped to accountAddress == signer + null-or-matching proxy so no unrelated account is ever touched.
    const siblings = await prisma.exchangeKey.findMany({
      where: { venue: { in: ['polymarket', POLY_MAKER_VENUE] }, revokedAt: null, accountAddress: signer },
      select: { id: true, venue: true, proxyAddress: true },
    })
    let wrote = 0
    for (const s of siblings) {
      if (s.proxyAddress && s.proxyAddress.toLowerCase() === res.proxyAddress.toLowerCase()) continue
      if (s.proxyAddress && s.proxyAddress.toLowerCase() !== res.proxyAddress.toLowerCase()) {
        console.log(`  skip ${s.venue}: a different proxy is stored (${s.proxyAddress}) — not overwriting`)
        continue
      }
      await prisma.exchangeKey.update({ where: { id: s.id }, data: { proxyAddress: res.proxyAddress } })
      console.log(`  persisted proxy on venue='${s.venue}' row`)
      wrote++
    }
    console.log(wrote > 0 ? '\nConsumers now read one source of truth.' : '\nalready persisted and matches — no write needed.')
  } finally {
    await prisma.$disconnect()
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('store-proxy failed:', String(e && e.message ? e.message : e).slice(0, 240))
  process.exit(1)
})
