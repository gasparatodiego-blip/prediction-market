import { createECDH } from 'crypto'
import {
  VenueAdapter,
  VenueCreds,
  VerifyResult,
  CredField,
  PlainField,
  Balance,
  Position,
} from './types'
import { toSafeError } from './safe-error'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { rlGet } = require('../rateLimitedFetch')

/**
 * dYdX v4 (dYdX Chain) — the only DEX whose trade-only credential is ON-CHAIN
 * VERIFIABLE, which is why it builds while Hyperliquid/Paradex/etc. do not.
 *
 * The user connects an "authenticator" (dYdX Chain `x/accountplus` permissioned key):
 *   - secret         = the authenticator's secp256k1 PRIVATE KEY (encrypted at rest)
 *   - accountAddress = the owner's bech32 'dydx1...' address (non-secret)
 *   - accountId      = the authenticatorId, the on-chain record id (non-secret)
 *   - subaccountNumber = trading subaccount, default 0 (non-secret)
 *
 * WHY canWithdraw can be a real `false` here and not merely 'unknown':
 * a properly-scoped authenticator is an AllOf(SignatureVerification, MessageFilter)
 * where the MessageFilter whitelists ONLY clob order messages. Withdrawals
 * (`/dydxprotocol.sending.MsgWithdrawFromSubaccount`), transfers
 * (`/dydxprotocol.sending.MsgCreateTransfer`) and bank sends
 * (`/cosmos.bank.v1beta1.MsgSend`) are simply not in the whitelist, so the chain
 * rejects them from this key. This is not a permission flag that can silently go
 * stale — it is the authenticator's on-chain config, which we read back and check.
 *
 * VERIFICATION (all plain HTTPS GET + node:crypto, no new dependency):
 *   1. GET {lcd}/dydxprotocol/accountplus/authenticators/{address}
 *      Response: { account_authenticators: [ { id, type, config(base64) } ] }.
 *   2. Find the record whose id === accountId.
 *   3. Require type 'AllOf'; base64-decode config -> JSON array of
 *      { Type, Config(base64) } sub-authenticators (field names lower-cased in JSON).
 *   4. SignatureVerification sub: base64-decode its config -> 33-byte compressed
 *      secp256k1 pubkey; must byte-equal the pubkey derived from the pasted private
 *      key. (Proves the pasted key IS this authenticator.)
 *   5. MessageFilter sub: base64-decode -> split on ',' -> EVERY entry must be an
 *      allowlisted clob order message and NONE may be a sending/bank/transfer
 *      message. (Proves trade-only.)
 * Any deviation at any step -> canWithdraw 'unknown' -> REFUSE. Fail closed.
 *
 * Refs (verified live): docs.dydx.xyz/interaction/permissioned-keys ; the proto
 * message string '/dydxprotocol.clob.MsgPlaceOrder' ; secp256k1 (NOT ethsecp256k1),
 * 33-byte compressed pubkey; indexer.dydx.trade/v4 public, no auth.
 */

// Public mainnet LCD (REST) nodes, documented at docs.dydx.xyz/interaction/endpoints.
// Multiple, because not every public node keeps the REST gateway enabled.
const LCD_BASES = [
  'https://dydx-dao-api.polkachu.com',
  'https://dydx-ops-rest.kingnodes.com',
  'https://dydx-dao-lcd.enigma-validator.com',
]
const INDEXER = 'https://indexer.dydx.trade/v4'
const TIMEOUT_MS = 12_000

/** dYdX is a live chain; there is no separate testnet path for this guard. */
export const MAINNET_ONLY = true

// Clob order messages an authenticator may whitelist and still be "trade only".
const ALLOWED_MSGS = new Set([
  '/dydxprotocol.clob.MsgPlaceOrder',
  '/dydxprotocol.clob.MsgCancelOrder',
  '/dydxprotocol.clob.MsgBatchCancel',
])

/** Compressed secp256k1 pubkey (33 bytes) for a raw private key. Throws on bad input. */
function pubkeyFromPrivate(privHex: string): Buffer {
  const clean = privHex.trim().replace(/^0x/, '')
  const priv = Buffer.from(clean, 'hex')
  if (priv.length !== 32) throw new Error('private key must be 32 bytes')
  const ecdh = createECDH('secp256k1')
  ecdh.setPrivateKey(priv)
  return ecdh.getPublicKey(null, 'compressed') as Buffer
}

interface SubAuth {
  type: string
  config: string // base64
}

/**
 * Pure verifier over the authenticator record + the derived pubkey. Exported so the
 * fail-closed rule is testable without a live chain call. Returns canWithdraw:
 *   false  -> AllOf(SignatureVerification matches our key, MessageFilter allow-only-clob)
 *   'unknown' (refuse) -> anything else
 */
export function parseAuthenticator(record: unknown, ourPubkey: Buffer): VerifyResult {
  const refuse = (error: string): VerifyResult => ({
    ok: false,
    permissions: [],
    canWithdraw: 'unknown',
    canTrade: 'unknown',
    error,
  })

  if (record === null || typeof record !== 'object') {
    return refuse('dYdX did not return this authenticator. Nothing was stored.')
  }
  const rec = record as Record<string, unknown>

  // Must be an AllOf composed authenticator — a bare SignatureVerification has NO
  // message filter and could sign anything, so it is not provably trade-only.
  if (rec.type !== 'AllOf') {
    return refuse(
      'This dYdX authenticator is not a trade-only permissioned key (no message restriction), so it was refused. Nothing was stored.',
    )
  }

  let subs: SubAuth[]
  try {
    const json = Buffer.from(String(rec.config), 'base64').toString('utf8')
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed)) throw new Error('not an array')
    // Field names are lower-cased in the grpc-gateway JSON mapping.
    subs = parsed.map((s: Record<string, unknown>) => ({
      type: String(s.type ?? ''),
      config: String(s.config ?? ''),
    }))
  } catch {
    return refuse('Could not read the dYdX authenticator configuration, so it was refused. Nothing was stored.')
  }

  const sigSub = subs.find((s) => s.type === 'SignatureVerification')
  const filterSubs = subs.filter((s) => s.type === 'MessageFilter')

  if (!sigSub || filterSubs.length === 0) {
    return refuse(
      'This dYdX authenticator lacks a signature+message-filter pair, so trade-only could not be confirmed. Nothing was stored.',
    )
  }

  // 4. The pasted key must BE this authenticator's key.
  let onChainPubkey: Buffer
  try {
    onChainPubkey = Buffer.from(sigSub.config, 'base64')
  } catch {
    return refuse('Could not read the dYdX authenticator key, so it was refused. Nothing was stored.')
  }
  if (onChainPubkey.length !== 33 || !timingEqual(onChainPubkey, ourPubkey)) {
    return refuse(
      'The pasted key does not match this dYdX authenticator, so it was refused. Nothing was stored.',
    )
  }

  // 5. Every whitelisted message must be a clob order message; none may move funds.
  const whitelisted: string[] = []
  for (const f of filterSubs) {
    let str: string
    try {
      str = Buffer.from(f.config, 'base64').toString('utf8')
    } catch {
      return refuse('Could not read the dYdX message filter, so it was refused. Nothing was stored.')
    }
    for (const m of str.split(',').map((x) => x.trim()).filter(Boolean)) {
      whitelisted.push(m)
    }
  }
  if (whitelisted.length === 0) {
    return refuse('This dYdX authenticator has an empty message filter, so it was refused. Nothing was stored.')
  }
  const disallowed = whitelisted.filter((m) => !ALLOWED_MSGS.has(m))
  if (disallowed.length > 0) {
    // Any non-clob message (a withdraw, transfer, or bank send) means the key can
    // move funds. Refuse — do not store a key that can do more than trade.
    return refuse(
      'This dYdX authenticator can sign more than trading (it permits a non-order message), so it was refused. Nothing was stored.',
    )
  }

  return {
    ok: true,
    permissions: ['trade (clob orders only)'],
    canWithdraw: false, // proven: withdraw/transfer/send are not in the whitelist
    canTrade: true,
  }
}

function timingEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

async function fetchAuthenticators(address: string): Promise<unknown[] | null> {
  const path = `/dydxprotocol/accountplus/authenticators/${encodeURIComponent(address)}`
  for (const base of LCD_BASES) {
    try {
      const r = await rlGet(`${base}${path}`, { timeoutMs: TIMEOUT_MS })
      if (r && r.status === 200 && r.data && Array.isArray(r.data.account_authenticators)) {
        return r.data.account_authenticators as unknown[]
      }
      // 501/404-on-route = gateway disabled on this node; try the next.
    } catch {
      // network/timeout on this node; try the next.
    }
  }
  return null
}

export const dydx: VenueAdapter = {
  id: 'dydx',
  label: 'dYdX v4',

  /** No api key, no passphrase — just the authenticator private key. */
  requiredFields(): CredField[] {
    return ['secret']
  },
  requiredPlainFields(): PlainField[] {
    return ['accountAddress', 'accountId', 'subaccountNumber']
  },

  async verifyKey(creds: VenueCreds): Promise<VerifyResult> {
    if (!creds.accountAddress || !/^dydx1[0-9a-z]{20,}$/.test(creds.accountAddress)) {
      return refuseCreds('A valid dYdX address (dydx1...) is required. Nothing was stored.')
    }
    if (creds.accountId == null || String(creds.accountId).trim() === '') {
      return refuseCreds('A dYdX authenticator id is required. Nothing was stored.')
    }

    let ourPubkey: Buffer
    try {
      ourPubkey = pubkeyFromPrivate(creds.secret)
    } catch {
      return refuseCreds('That does not look like a valid dYdX authenticator private key. Nothing was stored.')
    }

    try {
      const records = await fetchAuthenticators(creds.accountAddress)
      if (records === null) {
        return refuseCreds('Could not reach dYdX to verify this key right now. Nothing was stored. Please try again.')
      }
      const wanted = String(creds.accountId).trim()
      const record = records.find(
        (r) => r && typeof r === 'object' && String((r as Record<string, unknown>).id) === wanted,
      )
      if (!record) {
        return refuseCreds('No dYdX authenticator with that id was found for this address. Nothing was stored.')
      }
      return parseAuthenticator(record, ourPubkey)
    } catch (e) {
      return refuseCreds(toSafeError(e))
    }
  },

  async getBalance(creds: VenueCreds) {
    try {
      const n = creds.subaccountNumber ?? 0
      const r = await rlGet(
        `${INDEXER}/addresses/${encodeURIComponent(String(creds.accountAddress))}/subaccountNumber/${n}`,
        { timeoutMs: TIMEOUT_MS },
      )
      const sub = r && r.data && r.data.subaccount
      const equity = sub && sub.equity != null ? Number(sub.equity) : 0
      const free = sub && sub.freeCollateral != null ? Number(sub.freeCollateral) : 0
      const balances: Balance[] = equity || free ? [{ asset: 'USDC', free, total: equity }] : []
      return { balances }
    } catch (e) {
      return { balances: [], error: toSafeError(e) }
    }
  },

  async getPositions(creds: VenueCreds) {
    try {
      const n = creds.subaccountNumber ?? 0
      const r = await rlGet(
        `${INDEXER}/perpetualPositions?address=${encodeURIComponent(String(creds.accountAddress))}&subaccountNumber=${n}&status=OPEN`,
        { timeoutMs: TIMEOUT_MS },
      )
      const rows = r && r.data && Array.isArray(r.data.positions) ? r.data.positions : []
      const positions: Position[] = rows
        .map((x: Record<string, unknown>) => ({
          symbol: String(x.market ?? ''),
          side: String(x.side ?? ''),
          size: Math.abs(Number(x.size ?? 0)),
          entryPrice: x.entryPrice != null ? Number(x.entryPrice) : null,
          unrealizedPnl: x.unrealizedPnl != null ? Number(x.unrealizedPnl) : null,
        }))
        .filter((p: Position) => p.size > 0)
      return { positions }
    } catch (e) {
      return { positions: [], error: toSafeError(e) }
    }
  },
}

function refuseCreds(error: string): VerifyResult {
  return { ok: false, permissions: [], canWithdraw: 'unknown', canTrade: 'unknown', error }
}
