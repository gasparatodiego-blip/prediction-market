// scripts/maker-wallet-preflight.ts — READ-ONLY on-chain wallet readiness check for the Polymarket maker.
// Makes NO transactions. Reads a public Polygon RPC + the public Data API and prints a PASS/MISSING table
// so the operator can confirm the manual browser-side funding + approval steps actually took effect,
// without trusting that they did. Every unknown renders "—", never a fabricated zero.
//
//   npx tsx scripts/maker-wallet-preflight.ts                       # wallet from custody (stored address)
//   MAKER_WALLET_ADDRESS=0x… npx tsx scripts/maker-wallet-preflight.ts   # dry test against any address
//   POLYGON_RPC_URL=https://… npx tsx scripts/maker-wallet-preflight.ts  # override the RPC
//
// CONTRACT ADDRESSES — PRIMARY SOURCE: @polymarket/clob-client-v2 getContractConfig(137) (dist/config.js,
// the Polygon-mainnet block: canonical CTF 0x4D97DCd9…, v1 exchange 0x4bFb41…), the same source the maker
// README cites. Settlement collateral is pUSD per that config; USDC.e is the legacy collateral (shown too).

import { JsonRpcProvider, Contract, formatUnits, formatEther, isAddress } from 'ethers'
import { PrismaClient } from '@prisma/client'
import { POLY_MAKER_VENUE } from '../lib/venues/polymarket-clob-maker/credentials'

const RPC = process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com'
const DATA_API = 'https://data-api.polymarket.com'

// getContractConfig(137) — Polygon mainnet
const PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB' // v2 settlement collateral (config.collateral)
const USDCE = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' // legacy collateral (USDC.e)
const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' // ConditionalTokens (ERC-1155) config.conditionalTokens
const EXCHANGES = [
  { name: 'CTF Exchange (v2)', addr: '0xE111180000d2663C0091e4f400237545B87B996B' },
  { name: 'Neg-Risk CTF Exchange (v2)', addr: '0xe2222d279d744050d28e00520010520000310F59' },
  { name: 'Neg Risk Adapter', addr: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296' },
]

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]
const ERC1155_ABI = ['function isApprovedForAll(address,address) view returns (bool)']

const DASH = '—'
type Cell = { value: string; status: string }
const cell = (value: string, status: string): Cell => ({ value, status })

async function resolveWallet(): Promise<string | null> {
  const override = process.env.MAKER_WALLET_ADDRESS
  if (override) {
    if (!isAddress(override)) throw new Error('MAKER_WALLET_ADDRESS is not a valid address')
    return override
  }
  const prisma = new PrismaClient()
  try {
    // The signing wallet (or, failing that, any stored polymarket row) — accountAddress is plaintext.
    const row =
      (await prisma.exchangeKey.findFirst({ where: { venue: POLY_MAKER_VENUE, revokedAt: null }, orderBy: { createdAt: 'desc' }, select: { accountAddress: true } })) ||
      (await prisma.exchangeKey.findFirst({ where: { venue: 'polymarket', revokedAt: null }, orderBy: { createdAt: 'desc' }, select: { accountAddress: true } }))
    return row?.accountAddress ?? null
  } finally {
    await prisma.$disconnect()
  }
}

async function erc20(provider: JsonRpcProvider, token: string, wallet: string): Promise<{ balance: Cell; allowances: Cell[] }> {
  try {
    const c = new Contract(token, ERC20_ABI, provider)
    let dec = 6
    try { dec = Number(await c.decimals()) } catch { /* default 6 */ }
    const bal = await c.balanceOf(wallet)
    const balance = cell(formatUnits(bal, dec), bal > BigInt(0) ? 'PASS' : 'MISSING')
    const allowances: Cell[] = []
    for (const ex of EXCHANGES) {
      try {
        const a = await c.allowance(wallet, ex.addr)
        allowances.push(cell(a > BigInt(0) ? `${formatUnits(a, dec)} approved` : '0', a > BigInt(0) ? 'PASS' : 'MISSING'))
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
  const wallet = await resolveWallet()
  console.log('Polymarket maker — wallet readiness preflight (READ-ONLY, no transactions)')
  console.log(`RPC: ${RPC}`)
  console.log('Contracts: @polymarket/clob-client-v2 getContractConfig(137) (dist/config.js) — same source as the maker README')
  if (!wallet) {
    console.log('\nNo wallet address found in custody. Store a signing key first, or set MAKER_WALLET_ADDRESS to dry-test.')
    process.exit(1)
  }
  console.log(`Wallet: ${wallet}\n`)

  const provider = new JsonRpcProvider(RPC)
  // Native MATIC (gas for approvals)
  let matic: Cell
  try {
    const bal = await provider.getBalance(wallet)
    matic = cell(`${formatEther(bal)} MATIC`, bal > BigInt(0) ? 'PASS' : 'MISSING')
  } catch {
    matic = cell(DASH, DASH)
  }
  const pusd = await erc20(provider, PUSD, wallet)
  const usdce = await erc20(provider, USDCE, wallet)
  const approvals1155 = await erc1155Approvals(provider, wallet)
  const trades = await tradeHistory(wallet)

  console.log(`  ${'REQUIREMENT'.padEnd(42)} ${'ACTUAL'.padEnd(26)} STATUS`)
  console.log('  ' + '-'.repeat(76))
  printRow('Native MATIC (gas for approvals)', matic)
  printRow('pUSD balance (v2 settlement collateral)', pusd.balance)
  printRow('USDC.e balance (legacy — onramp to pUSD)', usdce.balance)
  EXCHANGES.forEach((ex, i) => printRow(`ERC-20 pUSD allowance → ${ex.name}`, pusd.allowances[i]))
  EXCHANGES.forEach((ex, i) => printRow(`ERC-1155 CTF approval → ${ex.name}`, approvals1155[i]))
  printRow('Trade history (public Data API)', trades)
  console.log('\nPASS = ready · MISSING = action needed · — = could not read (never assumed zero).')
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('preflight failed:', String(e && e.message ? e.message : e).slice(0, 200))
    process.exit(1)
  })
