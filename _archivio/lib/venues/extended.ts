import {
  VenueAdapter,
  VenueCreds,
  VerifyResult,
  CredField,
  Balance,
  Position,
} from './types'
import { toSafeError } from './safe-error'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { rlGet } = require('../rateLimitedFetch')

/**
 * EXTENDED (x10) — READ-ONLY, disclosed as read-only. We deliberately store ONLY the
 * venue-issued API key, which is read-only by the venue's own design. Quoted verbatim from
 * api.docs.extended.exchange (Authentication):
 *   "The API key provides read-only access to your account data and public market
 *    information."
 *   "The API key alone cannot be used to create orders, transfer funds, or withdraw
 *    assets."
 * Writes (orders/transfers/withdrawals) need a separate private Stark L2 key, which we do
 * NOT ask for and do NOT store — a dashboard needs only reads. So the credential we hold
 * cannot move funds: canWithdraw is a real, DOC-CITED `false`. This is not a block we
 * apply; it is simply not the fund-moving key.
 *
 * The API key is sent as the `X-Api-Key` header (no HMAC). No withdraw/transfer/send
 * endpoint is ever called.
 */

const BASE = 'https://api.starknet.extended.exchange' // agent10-binance.js:954
const TIMEOUT_MS = 12_000

export const MAINNET_ONLY = true

function readGet(path: string, creds: VenueCreds) {
  return rlGet(`${BASE}${path}`, { timeoutMs: TIMEOUT_MS, headers: { 'X-Api-Key': String(creds.secret) } })
}

/**
 * Pure parse of a private Extended read. Exported for the fail-closed test. Extended wraps
 * responses as { status: "OK", data: {...} }. Anything not that authentic shape → 'unknown'.
 * An authentic read → canWithdraw FALSE (the API key is read-only, doc-cited above).
 */
export function parseRead(body: unknown): VerifyResult {
  const unknownResult = (error: string): VerifyResult => ({
    ok: false,
    permissions: [],
    canWithdraw: 'unknown',
    canTrade: 'unknown',
    error,
  })

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return unknownResult('Extended returned an unexpected response. Nothing was stored.')
  }
  const b = body as Record<string, unknown>
  if (b.status !== 'OK' || b.data === undefined) {
    return unknownResult('Extended rejected this API key, so nothing was stored.')
  }
  // Authentic, read-only API key. It cannot trade or withdraw (venue design, doc-cited).
  return { ok: true, permissions: ['read-only'], canWithdraw: false, canTrade: false }
}

export const extended: VenueAdapter = {
  id: 'extended',
  label: 'Extended',

  /** Just the venue-issued (read-only) API key, stored in the encrypted secret slot. */
  requiredFields(): CredField[] {
    return ['secret']
  },

  async verifyKey(creds: VenueCreds): Promise<VerifyResult> {
    try {
      const r = await readGet('/api/v1/user/balance', creds)
      return parseRead(r && r.data)
    } catch (e) {
      return { ok: false, permissions: [], canWithdraw: 'unknown', canTrade: 'unknown', error: toSafeError(e) }
    }
  },

  async getBalance(creds: VenueCreds) {
    try {
      const r = await readGet('/api/v1/user/balance', creds)
      const data = r && r.data && (r.data as Record<string, unknown>).data
      const d = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
      const bal = Number(d.balance ?? d.equity ?? 0)
      const balances: Balance[] = bal ? [{ asset: 'USD', free: Number(d.availableForTrade ?? d.balance ?? 0), total: bal }] : []
      return { balances }
    } catch (e) {
      return { balances: [], error: toSafeError(e) }
    }
  },

  async getPositions(creds: VenueCreds) {
    try {
      const r = await readGet('/api/v1/user/positions', creds)
      const data = r && r.data && (r.data as Record<string, unknown>).data
      const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : []
      const positions: Position[] = rows
        .map((x) => ({
          symbol: String(x.market ?? ''),
          side: String(x.side ?? ''),
          size: Math.abs(Number(x.size ?? 0)),
          entryPrice: x.averagePrice != null ? Number(x.averagePrice) : null,
          unrealizedPnl: x.unrealisedPnl != null ? Number(x.unrealisedPnl) : null,
        }))
        .filter((p) => p.size > 0)
      return { positions }
    } catch (e) {
      return { positions: [], error: toSafeError(e) }
    }
  },
}
