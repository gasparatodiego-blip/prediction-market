// scripts/maker-wallet-preflight.ts — READ-ONLY on-chain wallet readiness check for the Polymarket maker.
// Makes NO transactions. Reads a public Polygon RPC + the public Data API and prints a PASS/MISSING table
// so the operator can confirm the funding + approvals actually took effect, without trusting that they did.
// Every unknown renders "—", never a fabricated zero.
//
//   npx tsx scripts/maker-wallet-preflight.ts                        # signer from custody, proxy resolved
//   MAKER_WALLET_ADDRESS=0x… npx tsx scripts/maker-wallet-preflight.ts   # dry-test funds against any address
//   POLYGON_RPC_URL=https://… npx tsx scripts/maker-wallet-preflight.ts  # override the RPC
//
// THE WALLET MODEL — the whole point of this rewrite. A Polymarket email/Magic account is TWO addresses:
//   SIGNER (accountAddress in custody) — signs orders, holds NOTHING. Reading its balance/approvals shows
//                                        an empty account and looks broken. It is only a key.
//   PROXY  (proxyAddress in custody)   — the on-chain wallet that actually holds the pUSD collateral and
//                                        the CTF outcome-token approvals, and is the order `maker`.
// Collateral, allowances and ERC-1155 approvals are therefore checked against the PROXY. Gas is shown for
// both addresses but is informational: Polymarket's relayer/operator submits the settlement tx, so the
// maker never needs MATIC of its own. Both addresses are printed at the top, clearly labelled, so the
// operator can never again mistake one for the other.
//
// CONTRACT ADDRESSES — PRIMARY SOURCE: @polymarket/clob-client-v2 getContractConfig(137) via
// lib/poly-contracts (the SAME source the maker README and the event terminal cite).

import { JsonRpcProvider, Contract, formatUnits, formatEther, isAddress, MaxUint256 } from 'ethers'
import { PrismaClient } from '@prisma/client'
import { POLY_MAKER_VENUE } from '../lib/venues/polymarket-clob-maker/credentials'
import { resolveProxyForSigner } from '../lib/venues/polymarket-clob-maker/proxy-wallet'
import { PUSD, USDCE, CTF, EXCHANGES, DEFAULT_RPC } from '../lib/poly-contracts'

const RPC = process.env.POLYGON_RPC_URL || DEFAULT_RPC
const DATA_API = 'https://data-api.polymarket.com'

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]
const ERC1155_ABI = ['function isApprovedForAll(address,address) view returns (bool)']

const DASH = '—'
type Cell = { value: string; status: string }
const cell = (value: string, status: string): Cell => ({ value, status })

interface Wallets {
  signer: string | null
  proxy: string | null
  proxySource: 'custody' | 'derived-onchain' | 'env-override' | null
  envFunder: string | null
  funderMismatch: boolean
}

// Resolve the SIGNER (custody accountAddress) and the PROXY (custody proxyAddress; else derived on-chain).
// MAKER_WALLET_ADDRESS overrides the PROXY only (the address whose funds/approvals we read) for dry tests.
async function resolveWallets(provider: JsonRpcProvider): Promise<Wallets> {
  const envFunderRaw = process.env.MAKER_FUNDER_ADDRESS
  const envFunder = envFunderRaw && isAddress(envFunderRaw) ? envFunderRaw : null

  const prisma = new PrismaClient()
  let signer: string | null = null
  let proxy: string | null = null
  let proxySource: Wallets['proxySource'] = null
  try {
    const row =
      (await prisma.exchangeKey.findFirst({ where: { venue: POLY_MAKER_VENUE, revokedAt: null }, orderBy: { createdAt: 'desc' }, select: { accountAddress: true, proxyAddress: true } })) ||
      (await prisma.exchangeKey.findFirst({ where: { venue: 'polymarket', revokedAt: null }, orderBy: { createdAt: 'desc' }, select: { accountAddress: true, proxyAddress: true } }))
    signer = row?.accountAddress && isAddress(row.accountAddress) ? row.accountAddress : null
    if (row?.proxyAddress && isAddress(row.proxyAddress)) { proxy = row.proxyAddress; proxySource = 'custody' }
  } finally {
    await prisma.$disconnect()
  }

  const override = process.env.MAKER_WALLET_ADDRESS
  if (override && isAddress(override)) { proxy = override; proxySource = 'env-override' }
  else if (!proxy && signer) {
    // No stored proxy — derive it from primary source (on-chain) so the preflight still works pre-backfill.
    try {
      const res = await resolveProxyForSigner(signer, { provider })
      if (res.proxyAddress) { proxy = res.proxyAddress; proxySource = 'derived-onchain' }
    } catch { /* leave proxy null → funds rows read against nothing and render "—" honestly */ }
  }

  const funderMismatch = !!(envFunder && proxy && envFunder.toLowerCase() !== proxy.toLowerCase())
  return { signer, proxy, proxySource, envFunder, funderMismatch }
}

async function erc20(provider: JsonRpcProvider, token: string, wallet: string): Promise<{ balance: Cell; allowances: Cell[] }> {
  try {
    const c = new Contract(token, ERC20_ABI, provider)
    let dec = 6
    try { dec = Number(await c.decimals()) } catch { /* default 6 */ }
    const bal = await c.balanceOf(wallet)
    const balance = cell(formatUnits(bal, dec), bal > BigInt(0) ? 'PASS' : 'MISSING')
    // An unlimited approval is set to (near) MaxUint256; printing all 78 digits is noise, so it is named.
    const UNLIMITED_THRESHOLD = MaxUint256 / BigInt(2)
    const allowances: Cell[] = []
    for (const ex of EXCHANGES) {
      try {
        const a = await c.allowance(wallet, ex.addr)
        const label = a === BigInt(0) ? '0' : a >= UNLIMITED_THRESHOLD ? 'unlimited approved' : `${formatUnits(a, dec)} approved`
        allowances.push(cell(label, a > BigInt(0) ? 'PASS' : 'MISSING'))
      } catch {
        allowances.push(cell(DASH, DASH))
      }
    }
    return { balance, allowances }
  } catch {
    return { balance: cell(DASH, DASH), allowances: EXCHANGES.map(() => cell(DASH, DASH)) }
  }
}

async function erc1155Approvals(provider: JsonRpcProvider, wallet: string): Promise<Cell[]> {
  const c = new Contract(CTF, ERC1155_ABI, provider)
  const out: Cell[] = []
  for (const ex of EXCHANGES) {
    try {
      const ok = await c.isApprovedForAll(wallet, ex.addr)
      out.push(cell(ok ? 'approved' : 'not approved', ok ? 'PASS' : 'MISSING'))
    } catch {
      out.push(cell(DASH, DASH))
    }
  }
  return out
}

async function nativeBalance(provider: JsonRpcProvider, wallet: string): Promise<Cell> {
  try {
    const bal = await provider.getBalance(wallet)
    // Informational: gas is paid by Polymarket's relayer/operator, so 0 here is NOT a blocker.
    return cell(`${formatEther(bal)} MATIC`, bal > BigInt(0) ? 'PASS' : 'info')
  } catch {
    return cell(DASH, DASH)
  }
}

async function tradeHistory(wallet: string): Promise<Cell> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 8000)
    const r = await fetch(`${DATA_API}/trades?user=${wallet}&limit=1`, { signal: ctrl.signal }).finally(() => clearTimeout(t))
    if (!r.ok) return cell(DASH, DASH)
    const data = await r.json()
    const n = Array.isArray(data) ? data.length : Array.isArray((data as any)?.data) ? (data as any).data.length : 0
    return cell(n > 0 ? 'has trade history' : 'no trades found', n > 0 ? 'PASS' : 'none')
  } catch {
    return cell(DASH, DASH)
  }
}

function printRow(label: string, c: Cell) {
  console.log(`  ${label.padEnd(42)} ${c.value.padEnd(26)} ${c.status}`)
}

async function main() {
  console.log('Polymarket maker — wallet readiness preflight (READ-ONLY, no transactions)')
  console.log(`RPC: ${RPC}`)
  console.log('Contracts: @polymarket/clob-client-v2 getContractConfig(137) via lib/poly-contracts')

  const provider = new JsonRpcProvider(RPC)
  const w = await resolveWallets(provider)

  console.log('\nWALLET MODEL — a Polymarket account is two addresses:')
  console.log(`  SIGNER (signs, holds nothing) : ${w.signer ?? '— (no signing key stored)'}`)
  console.log(`  PROXY  (holds funds, is maker): ${w.proxy ?? '— (unresolved)'}${w.proxySource ? `   [${w.proxySource}]` : ''}`)
  if (w.envFunder) {
    console.log(`  env MAKER_FUNDER_ADDRESS      : ${w.envFunder}${w.funderMismatch ? '   ⚠ MISMATCH vs proxy — signing path funder differs from stored proxy!' : '   (matches proxy)'}`)
  }
  if (!w.proxy) {
    console.log('\nNo proxy address to read. Store a signing key + run scripts/maker-store-proxy.ts, or set MAKER_WALLET_ADDRESS to dry-test.')
    process.exit(1)
  }
  console.log('\nFunds, allowances and outcome-token approvals below are read against the PROXY (the funder).')
  console.log('Gas (MATIC) is shown for both addresses but is informational — the venue operator pays settlement gas.\n')

  const maticSigner = w.signer ? await nativeBalance(provider, w.signer) : cell(DASH, DASH)
  const maticProxy = await nativeBalance(provider, w.proxy)
  const pusd = await erc20(provider, PUSD, w.proxy)
  const usdce = await erc20(provider, USDCE, w.proxy)
  const approvals1155 = await erc1155Approvals(provider, w.proxy)
  const trades = await tradeHistory(w.proxy)

  console.log(`  ${'REQUIREMENT'.padEnd(42)} ${'ACTUAL'.padEnd(26)} STATUS`)
  console.log('  ' + '-'.repeat(76))
  printRow('MATIC on SIGNER (info — not required)', maticSigner)
  printRow('MATIC on PROXY  (info — not required)', maticProxy)
  printRow('pUSD balance on PROXY (v2 collateral)', pusd.balance)
  printRow('USDC.e balance on PROXY (legacy)', usdce.balance)
  EXCHANGES.forEach((ex, i) => printRow(`ERC-20 pUSD allowance (PROXY) → ${ex.name}`, pusd.allowances[i]))
  EXCHANGES.forEach((ex, i) => printRow(`ERC-1155 CTF approval (PROXY) → ${ex.name}`, approvals1155[i]))
  printRow('Trade history — PROXY (public Data API)', trades)
  console.log('\nPASS = ready · MISSING = action needed · info = not a blocker · — = could not read (never assumed zero).')
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('preflight failed:', String(e && e.message ? e.message : e).slice(0, 200))
    process.exit(1)
  })
