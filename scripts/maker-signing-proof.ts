// scripts/maker-signing-proof.ts — prove the maker can sign a VALID order for the funder, offline.
//
//   npx tsx scripts/maker-signing-proof.ts
//
// SUBMITS NOTHING. Three read-only steps, no transaction, no order, no funds moved:
//   1. build the adapter exactly as agent35 does, and read back the (signatureType, funder) pair it
//      resolved from the environment;
//   2. build + SIGN one real order for a live market at a price far from mid, minimum size, using the
//      same ClobClient construction the adapter's liveClient() performs. `createOrder` signs locally;
//      posting is a different call (`createAndPostOrder`) and is never made here;
//   3. validate that signature the way the venue will — locally by ecrecover, and then on-chain via
//      CTFExchangeV2.validateOrder(), a `view` function that reverts on any invalid order. An eth_call
//      changes no state.
//
// WHY THIS EXISTS. A Polymarket account is two addresses: the EOA that signs (the key in custody) and
// the wallet that holds the money (the funder/proxy). Sign as the wrong one and the exchange rejects
// the order — but you only discover that by placing real money into a live book. This script moves that
// discovery to a laptop. Run it after ANY change to the signing path, and before arming.
//
// The private key is decrypted in-process, handed straight to the signing signer, never printed, never
// logged, and scrubbed at the end.

import fs from 'fs'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import { JsonRpcProvider, Contract, verifyTypedData, getAddress } from 'ethers'

// .env is loaded by hand: this script is run directly by an operator, not under the Next.js runtime that
// would otherwise populate process.env.
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const HOST = 'https://clob.polymarket.com'
const CHAIN_ID = 137
// The EIP-712 Order struct the v2 exchange hashes (@polymarket/clob-client-v2, ctfExchangeV2TypedData).
const ORDER_TYPES = {
  Order: [
    { name: 'salt', type: 'uint256' }, { name: 'maker', type: 'address' }, { name: 'signer', type: 'address' },
    { name: 'tokenId', type: 'uint256' }, { name: 'makerAmount', type: 'uint256' }, { name: 'takerAmount', type: 'uint256' },
    { name: 'side', type: 'uint8' }, { name: 'signatureType', type: 'uint8' }, { name: 'timestamp', type: 'uint256' },
    { name: 'metadata', type: 'bytes32' }, { name: 'builder', type: 'bytes32' },
  ],
}
const VALIDATE_ABI = ['function validateOrder((uint256,address,address,uint256,uint256,uint256,uint8,uint8,uint256,bytes32,bytes32,bytes)) view']

let failures = 0
function check(label: string, pass: boolean, detail = '') {
  if (!pass) failures++
  console.log(`  ${pass ? 'MATCH   ' : 'MISMATCH'}  ${label}${detail ? `  ${detail}` : ''}`)
}

/** A live market that is currently accepting orders, with its tick size and neg-risk flag. */
async function liveMarket(): Promise<{ tokenId: string; tickSize: string; negRisk: boolean; price: number }> {
  const r = await fetch(`${HOST}/sampling-simplified-markets`).then((x) => x.json())
  const m = (r.data || []).find((x: any) => x.active && !x.closed && x.accepting_orders && Array.isArray(x.tokens) && x.tokens[0]?.token_id)
  if (!m) throw new Error('no live market is accepting orders right now — cannot build a real order')
  const tokenId = m.tokens[0].token_id
  const tick = await fetch(`${HOST}/tick-size?token_id=${tokenId}`).then((x) => x.json())
  const neg = await fetch(`${HOST}/neg-risk?token_id=${tokenId}`).then((x) => x.json())
  return { tokenId, tickSize: String(tick.minimum_tick_size), negRisk: neg.neg_risk === true, price: Number(m.tokens[0].price) }
}

async function main() {
  const { createMakerAdapter, resolveFunder } = require('../lib/venues/polymarket-clob-maker/adapter')
  const { signingSignerFromKey } = require('../lib/venues/polymarket-clob-maker/signer')
  const { loadMakerSigningKey } = await import('../lib/venues/polymarket-clob-maker/credentials')
  const { ClobClient, getContractConfig } = await import('@polymarket/clob-client-v2')

  console.log('Polymarket maker — offline signing proof (READ-ONLY: no order, no transaction, no funds)\n')

  // ── 1. what the shipped adapter resolved from the environment ──
  const adapter = createMakerAdapter({ mode: 'paper' })
  const funder = resolveFunder(process.env)
  console.log(`signatureType  ${adapter.signatureType}  (0=EOA 1=POLY_PROXY 2=POLY_GNOSIS_SAFE 3=POLY_1271)`)
  console.log(`funder         ${adapter.funderAddress ?? '— none configured (self-custody EOA)'}`)

  // ── 2. sign one real order ──
  const market = await liveMarket()
  // Far from mid and small, so that even a catastrophic misuse of this script could only ever rest
  // harmlessly — though nothing here reaches the venue at all.
  const price = Math.max(Number(market.tickSize), Math.round((market.price / 4) / Number(market.tickSize)) * Number(market.tickSize))
  console.log(`market         token ${market.tokenId.slice(0, 12)}…  tick=${market.tickSize}  negRisk=${market.negRisk}  mid≈${market.price}  → signing at ${price.toFixed(4)}\n`)

  const prisma = new PrismaClient()
  let privateKey: string
  let custodyAddress: string
  try {
    const loaded = await loadMakerSigningKey(prisma)
    privateKey = loaded.privateKey
    custodyAddress = loaded.address
  } finally {
    await prisma.$disconnect()
  }
  const handle = signingSignerFromKey(privateKey)

  const cfg = getContractConfig(CHAIN_ID) as any
  const exchange = getAddress(market.negRisk ? cfg.negRiskExchangeV2 : cfg.exchangeV2)
  // The SAME construction the adapter's liveClient() performs. The creds are placeholders: an L2 HMAC is
  // needed to POST an order, never to build or sign one, and we do not post.
  const client = new ClobClient({
    host: HOST, chain: CHAIN_ID, signer: handle.signer,
    creds: { key: 'not-used-when-only-signing', secret: 'not-used-when-only-signing', passphrase: 'not-used-when-only-signing' },
    signatureType: funder.signatureType, funderAddress: funder.funderAddress,
  } as any)
  const order: any = await client.createOrder({ tokenID: market.tokenId, price, size: 20, side: 'BUY' } as any, { tickSize: market.tickSize as any, negRisk: market.negRisk })

  // ── 3. validate it the way the venue will ──
  console.log('order identity')
  check('signer address == the address recorded in custody', handle.address.toLowerCase() === custodyAddress.toLowerCase(), handle.address)
  check("order.maker == the configured funder (the wallet that holds the money)", order.maker.toLowerCase() === (funder.funderAddress ?? handle.address).toLowerCase(), order.maker)
  const signerShouldBe = funder.signatureType === 3 ? (funder.funderAddress as string) : handle.address
  check('order.signer == the address this signature type requires', order.signer.toLowerCase() === signerShouldBe.toLowerCase(), order.signer)
  check('order.signatureType == the configured type', Number(order.signatureType) === funder.signatureType, String(order.signatureType))

  console.log('\nsignature')
  if (order.signature.length === 132) {
    const value = {
      salt: order.salt, maker: order.maker, signer: order.signer, tokenId: order.tokenId,
      makerAmount: order.makerAmount, takerAmount: order.takerAmount, side: order.side === 'BUY' ? 0 : 1,
      signatureType: order.signatureType, timestamp: order.timestamp, metadata: order.metadata, builder: order.builder,
    }
    const recovered = verifyTypedData({ name: 'Polymarket CTF Exchange', version: '2', chainId: CHAIN_ID, verifyingContract: exchange }, ORDER_TYPES, value, order.signature)
    check('ecrecover(signature) == the custody EOA', recovered.toLowerCase() === handle.address.toLowerCase(), recovered)
  } else {
    // ERC-1271 / ERC-7739 wrapped: not an ECDSA signature, so there is nothing to ecrecover locally.
    // The on-chain check below is the real verdict — it calls the wallet's isValidSignature.
    console.log(`  n/a       ERC-7739 wrapped signature (${(order.signature.length - 2) / 2} bytes) — verified on-chain below, not by ecrecover`)
  }

  const provider = new JsonRpcProvider(process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com')
  const ex = new Contract(exchange, VALIDATE_ABI, provider)
  const tuple = [order.salt, order.maker, order.signer, order.tokenId, order.makerAmount, order.takerAmount,
    order.side === 'BUY' ? 0 : 1, order.signatureType, order.timestamp, order.metadata, order.builder, order.signature]
  let onChainOk = false
  let revert = ''
  try { await ex.validateOrder(tuple as any); onChainOk = true } catch (e: any) { revert = String(e?.shortMessage || e?.reason || e?.message || e).slice(0, 160) }
  check(`${market.negRisk ? 'NegRiskCtfExchangeV2' : 'CTFExchangeV2'}.validateOrder() accepts it (eth_call, no state change)`, onChainOk, onChainOk ? exchange : revert)

  handle.scrub()
  adapter.close()
  console.log(`\n${failures === 0 ? 'MATCH — this key can sign orders the venue accepts for that funder.' : `MISMATCH — ${failures} check(s) failed. Do NOT arm.`}`)
  console.log('Nothing was submitted: createOrder() signs locally and validateOrder() is an eth_call.')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  // Never echo the underlying error object — a signing failure can carry key material in some libraries.
  console.error('signing proof failed:', String(e && e.message ? e.message : e).slice(0, 200))
  process.exit(1)
})
