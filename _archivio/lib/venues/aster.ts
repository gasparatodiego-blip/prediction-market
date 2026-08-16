import { createHmac } from 'crypto'
import {
  VenueAdapter,
  VenueCreds,
  VerifyResult,
  CredField,
  Balance,
  Position,
  TriState,
  triFromBool,
} from './types'
import { toSafeError } from './safe-error'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { rlGet } = require('../rateLimitedFetch')

/**
 * ASTER — accept-and-disclose. Aster is Binance-shaped: HMAC-SHA256, X-MBX-APIKEY,
 * signature carried in the query string. There is NO per-key apiRestrictions endpoint, but
 * GET /fapi/v4/account DOES report ACCOUNT-level `canTrade/canDeposit/canWithdraw`
 * ("canWithdraw": "if can transfer out asset") — so we read and disclose the account's
 * canWithdraw. That is account-level, not the key's own scope, so we never present it as
 * this key's withdrawal permission.
 *
 * A cited, load-bearing fact (decision: show the reassurance ONLY with the quote): the API
 * key ALONE cannot withdraw off-account. Aster's withdraw endpoints require a separate
 * EIP-712 `userSignature` produced by the owner's WALLET — quoted verbatim from
 * github.com/asterdex/api-docs/blob/master/demo/aster-deposit-withdrawal.md:
 *   "When you withdraw, you should supply an EIP712 signature. You can get the signature
 *    by signing the following message with your wallet."
 * and the withdraw request's required param row: "userSignature | string | true | EIP712
 * withdraw signature". The HMAC API key does not hold that wallet signature. We never call
 * a withdraw/transfer/send endpoint here; verify + reads use the account endpoint only.
 */

const BASE = 'https://fapi.asterdex.com' // agent10-binance.js:630
const TIMEOUT_MS = 12_000
const RECV_WINDOW = 5_000

export const MAINNET_ONLY = true

function signedGet(path: string, params: Record<string, string | number>, creds: VenueCreds) {
  return rlGet(`${BASE}${path}`, {
    timeoutMs: TIMEOUT_MS,
    sign: (req: { url: string; timestamp: number }) => {
      const all: Record<string, string | number> = { ...params, timestamp: req.timestamp, recvWindow: RECV_WINDOW }
      const qs = Object.keys(all)
        .map((k) => `${k}=${encodeURIComponent(String(all[k]))}`)
        .join('&')
      const signature = createHmac('sha256', String(creds.secret)).update(qs).digest('hex')
      return { url: `${req.url}?${qs}&signature=${signature}`, headers: { 'X-MBX-APIKEY': String(creds.apiKey) } }
    },
  })
}

/**
 * Pure parse of GET /fapi/v4/account. Exported for the fail-closed test. Anything that is
 * not the documented account shape → canWithdraw 'unknown'. An authentic body reports the
 * ACCOUNT-level canWithdraw (disclosed as such) and records that the key alone cannot
 * withdraw without the owner's wallet EIP-712 signature (cited above).
 */
export function parseAccount(body: unknown): VerifyResult {
  const unknownResult = (error: string): VerifyResult => ({
    ok: false,
    permissions: [],
    canWithdraw: 'unknown',
    canTrade: 'unknown',
    error,
  })

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return unknownResult('Aster returned an unexpected response. Nothing was stored.')
  }
  const b = body as Record<string, unknown>

  // Aster error bodies look like { code: -2015, msg: '...' } (Binance-style) and lack canWithdraw.
  if (typeof b.code === 'number' && typeof b.msg === 'string') {
    return unknownResult('Aster rejected this key. Check the key, its IP allowlist, and its permissions.')
  }
  if (b.canWithdraw === undefined) {
    return unknownResult('Aster did not return account permissions, so nothing was stored.')
  }

  const acctCanWithdraw: TriState = triFromBool(b.canWithdraw)
  const acctCanTrade: TriState = triFromBool(b.canTrade)
  const permissions: string[] = []
  if (b.canTrade === true) permissions.push('account:trade')
  if (b.canDeposit === true) permissions.push('account:deposit')
  // The ACCOUNT-level withdraw flag, labelled as account-level — not this key's own scope.
  permissions.push(b.canWithdraw === true ? 'account-canWithdraw:true' : 'account-canWithdraw:false')
  // Cited reassurance: the key alone cannot withdraw off-account without a wallet EIP-712 sig.
  permissions.push('key-alone-cannot-withdraw:needs-wallet-signature')

  return { ok: true, permissions, canWithdraw: acctCanWithdraw, canTrade: acctCanTrade }
}

export const aster: VenueAdapter = {
  id: 'aster',
  label: 'Aster',

  requiredFields(): CredField[] {
    return ['apiKey', 'secret']
  },

  async verifyKey(creds: VenueCreds): Promise<VerifyResult> {
    try {
      const r = await signedGet('/fapi/v4/account', {}, creds)
      return parseAccount(r && r.data)
    } catch (e) {
      return { ok: false, permissions: [], canWithdraw: 'unknown', canTrade: 'unknown', error: toSafeError(e) }
    }
  },

  async getBalance(creds: VenueCreds) {
    try {
      const r = await signedGet('/fapi/v4/balance', {}, creds)
      const rows = Array.isArray(r && r.data) ? (r.data as Record<string, unknown>[]) : []
      const balances: Balance[] = rows
        .map((x) => ({
          asset: String(x.asset ?? ''),
          free: Number(x.availableBalance ?? 0),
          total: Number(x.balance ?? 0),
        }))
        .filter((x) => x.asset && (x.total !== 0 || x.free !== 0))
      return { balances }
    } catch (e) {
      return { balances: [], error: toSafeError(e) }
    }
  },

  async getPositions(creds: VenueCreds) {
    try {
      const r = await signedGet('/fapi/v4/positionRisk', {}, creds)
      const rows = Array.isArray(r && r.data) ? (r.data as Record<string, unknown>[]) : []
      const positions: Position[] = rows
        .map((x) => ({
          symbol: String(x.symbol ?? ''),
          side: Number(x.positionAmt ?? 0) >= 0 ? 'long' : 'short',
          size: Math.abs(Number(x.positionAmt ?? 0)),
          entryPrice: x.entryPrice != null ? Number(x.entryPrice) : null,
          unrealizedPnl: x.unRealizedProfit != null ? Number(x.unRealizedProfit) : null,
        }))
        .filter((p) => p.size > 0)
      return { positions }
    } catch (e) {
      return { positions: [], error: toSafeError(e) }
    }
  },
}
