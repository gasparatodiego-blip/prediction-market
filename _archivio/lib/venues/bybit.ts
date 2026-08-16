import { createHmac } from 'crypto'
import {
  VenueAdapter,
  VenueCreds,
  VerifyResult,
  CredField,
  Balance,
  Position,
  TriState,
  triFromList,
} from './types'
import { toSafeError } from './safe-error'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { rlGet } = require('../rateLimitedFetch')

/**
 * BYBIT — withdrawal permission source of truth
 * --------------------------------------------
 * Endpoint: GET /v5/user/query-api   ("Get API Key Information")
 * Docs:     https://bybit-exchange.github.io/docs/v5/user/apikey-info
 * Limit:    10 req/s. "Any permission can access this endpoint."
 *
 * Documented response parameters, quoted verbatim from the docs:
 *
 *   readOnly    integer  "0": Read and Write. "1": Read only
 *   permissions.Wallet   array
 *       "Permission of wallet 'AccountTransfer', 'SubMemberTransfer'(master account),
 *        'SubMemberTransferList'(sub account), 'Withdraw'(master account)"
 *   permissions.ContractTrade  array  "Permission of contract trade 'Order', 'Position'"
 *   permissions.Spot           array  "Permission of spot 'SpotTrade'"
 *   permissions.Derivatives    array  "'DerivativesTrade'"
 *   ips         array   IP bound
 *
 * Withdrawal field: membership of the string "Withdraw" in `result.permissions.Wallet`.
 *                   NOT a boolean — an array. An ABSENT array is 'unknown', never false:
 *                   a missing permissions object is not proof of absent permission.
 * Trading fields:   permissions.ContractTrade / .Spot / .Derivatives (non-empty arrays).
 * IP field:         `ips` (array), plus `readOnly` (0/1).
 *
 * NOTE (doc-stated): 'Withdraw' is annotated "(master account)". A sub-account key
 * appears structurally unable to hold it. That does not weaken the guard — we refuse
 * on PRESENCE — but it means an absent Withdraw on a sub-account key means something
 * different than on a master key. Not relied upon here.
 *
 * Base URL api.bybit.com is already proven by the public-only agents
 * (agent15-funding-writer.js:258, lib/source-verify.js:125).
 */

const BASE = 'https://api.bybit.com'
const TIMEOUT_MS = 12_000
const RECV_WINDOW = '5000'

/** See scripts/verify-venue-live.md — set from research, not assumed. */
export const MAINNET_ONLY = false

function signedGet(path: string, query: string, creds: VenueCreds) {
  const url = query ? `${BASE}${path}?${query}` : `${BASE}${path}`
  return rlGet(url, {
    timeoutMs: TIMEOUT_MS,
    // Signed at FIRE time: Bybit rejects a stale X-BAPI-TIMESTAMP against recvWindow.
    sign: (req: { timestamp: number; query: string }) => {
      const ts = String(req.timestamp)
      // Docs: "timestamp + API key + recv_window + queryString", HMAC_SHA256 -> lowercase HEX.
      const payload = ts + creds.apiKey + RECV_WINDOW + (req.query || '')
      const sign = createHmac('sha256', creds.secret).update(payload).digest('hex')
      return {
        headers: {
          'X-BAPI-API-KEY': creds.apiKey,
          'X-BAPI-TIMESTAMP': ts,
          'X-BAPI-RECV-WINDOW': RECV_WINDOW,
          'X-BAPI-SIGN': sign,
        },
      }
    },
  })
}

function nonEmpty(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0
}

/**
 * Pure parse of the query-api body. Exported so the fail-closed rule is testable
 * without a live key. Anything not the documented shape yields 'unknown'.
 */
export function parseVerify(body: unknown): VerifyResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      permissions: [],
      canWithdraw: 'unknown',
      canTrade: 'unknown',
      error: 'Bybit returned an unexpected response. Nothing was stored.',
    }
  }

  const b = body as Record<string, unknown>

  // Bybit signals errors with a non-zero retCode.
  if (b.retCode !== undefined && b.retCode !== 0) {
    return {
      ok: false,
      permissions: [],
      canWithdraw: 'unknown',
      canTrade: 'unknown',
      error: 'Bybit rejected this key. Check the key, its IP allowlist, and its permissions.',
    }
  }

  const result = b.result
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return {
      ok: false,
      permissions: [],
      canWithdraw: 'unknown',
      canTrade: 'unknown',
      error:
        'Bybit did not report this key’s permissions, so it was refused. Nothing was stored.',
    }
  }

  const r = result as Record<string, unknown>
  const perms = r.permissions

  if (perms === null || typeof perms !== 'object' || Array.isArray(perms)) {
    return {
      ok: false,
      permissions: [],
      canWithdraw: 'unknown',
      canTrade: 'unknown',
      error:
        'Bybit did not report whether this key can withdraw, so it was refused. Nothing was stored.',
    }
  }

  const p = perms as Record<string, unknown>
  const canWithdraw = triFromList(p.Wallet, 'Withdraw')

  if (canWithdraw === 'unknown') {
    return {
      ok: false,
      permissions: [],
      canWithdraw: 'unknown',
      canTrade: 'unknown',
      error:
        'Bybit did not report whether this key can withdraw, so it was refused. Nothing was stored.',
    }
  }

  const canTrade: TriState =
    nonEmpty(p.ContractTrade) || nonEmpty(p.Spot) || nonEmpty(p.Derivatives)

  const permissions: string[] = []
  if (r.readOnly === 1) permissions.push('read-only')
  if (nonEmpty(p.ContractTrade)) permissions.push('contract trade')
  if (nonEmpty(p.Spot)) permissions.push('spot trade')
  if (nonEmpty(p.Derivatives)) permissions.push('derivatives trade')
  if (canWithdraw === true) permissions.push('WITHDRAW')
  if (nonEmpty(r.ips)) permissions.push('ip-bound')

  return { ok: true, permissions, canWithdraw, canTrade }
}

export const bybit: VenueAdapter = {
  id: 'bybit',
  label: 'Bybit',

  requiredFields(): CredField[] {
    return ['apiKey', 'secret']
  },

  async verifyKey(creds: VenueCreds): Promise<VerifyResult> {
    try {
      const r = await signedGet('/v5/user/query-api', '', creds)
      return parseVerify(r && r.data)
    } catch (e) {
      return {
        ok: false,
        permissions: [],
        canWithdraw: 'unknown',
        canTrade: 'unknown',
        error: toSafeError(e),
      }
    }
  },

  async getBalance(creds: VenueCreds) {
    try {
      const q = 'accountType=UNIFIED'
      const r = await signedGet('/v5/account/wallet-balance', q, creds)
      const d = r && r.data
      const list = d && d.result && Array.isArray(d.result.list) ? d.result.list : []
      const coins = list.length && Array.isArray(list[0].coin) ? list[0].coin : []
      const balances: Balance[] = coins
        .map((c: Record<string, unknown>) => ({
          asset: String(c.coin ?? ''),
          free: Number(c.availableToWithdraw ?? c.walletBalance ?? 0),
          total: Number(c.walletBalance ?? 0),
        }))
        .filter((x: Balance) => x.asset && x.total !== 0)
      return { balances }
    } catch (e) {
      return { balances: [], error: toSafeError(e) }
    }
  },

  async getPositions(creds: VenueCreds) {
    try {
      const q = 'category=linear&settleCoin=USDT'
      const r = await signedGet('/v5/position/list', q, creds)
      const d = r && r.data
      const list = d && d.result && Array.isArray(d.result.list) ? d.result.list : []
      const positions: Position[] = list
        .map((x: Record<string, unknown>) => ({
          symbol: String(x.symbol ?? ''),
          side: String(x.side ?? '').toLowerCase() === 'sell' ? 'short' : 'long',
          size: Math.abs(Number(x.size ?? 0)),
          entryPrice: x.avgPrice != null ? Number(x.avgPrice) : null,
          unrealizedPnl: x.unrealisedPnl != null ? Number(x.unrealisedPnl) : null,
        }))
        .filter((p: Position) => p.size > 0)
      return { positions }
    } catch (e) {
      return { positions: [], error: toSafeError(e) }
    }
  },
}
