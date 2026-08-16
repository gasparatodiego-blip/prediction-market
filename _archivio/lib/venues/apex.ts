import { createHmac } from 'crypto'
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
 * APEX OMNI — READ-ONLY, disclosed as read-only. We store ONLY the venue-issued apiKey
 * triple (key/secret/passphrase). Per the docs, all private reads authenticate with that
 * triple, while value-moving actions ADDITIONALLY require a second signature from the zk
 * seeds/l2Key: "For orders, transfers, and withdrawals, two signatures are required"
 * (api-docs.pro.apex.exchange). We do NOT ask for or store the zk seeds/l2Key, so the
 * credential we hold cannot place orders, transfer, or withdraw — it can only read.
 * canWithdraw is FALSE by construction (the fund-moving key is not in our custody). And
 * even the zk-key holder is protocol-limited: "Withdrawals are limited to user-registered
 * addresses." We never claim WE block anything — we simply don't hold the fund-moving key.
 *
 * HMAC-SHA256 (base64) via APEX-* headers with a passphrase. Exact preimage is D1-verified
 * (liveVerified stays false). No withdraw/transfer/send endpoint is ever called.
 */

const BASE = 'https://omni.apex.exchange' // agent10-binance.js:1051
const TIMEOUT_MS = 12_000

export const MAINNET_ONLY = true

function signedGet(path: string, query: string, creds: VenueCreds) {
  const url = query ? `${BASE}${path}?${query}` : `${BASE}${path}`
  return rlGet(url, {
    timeoutMs: TIMEOUT_MS,
    sign: (req: { timestamp: number; path: string; query: string }) => {
      const ts = String(req.timestamp)
      const requestPath = req.query ? `${req.path}?${req.query}` : req.path
      // base64(HMAC-SHA256(secret, timestamp + method + requestPath)) — preimage per docs, D1-confirmed.
      const prehash = ts + 'GET' + requestPath
      const sign = createHmac('sha256', String(creds.secret)).update(prehash).digest('base64')
      return {
        headers: {
          'APEX-API-KEY': String(creds.apiKey),
          'APEX-PASSPHRASE': String(creds.passphrase ?? ''),
          'APEX-TIMESTAMP': ts,
          'APEX-SIGNATURE': sign,
        },
      }
    },
  })
}

/**
 * Pure parse of an ApeX private read. Exported for the fail-closed test. ApeX success
 * bodies carry a `data` object; errors carry a non-zero `code`. Anything else → 'unknown'.
 * An authentic read → canWithdraw FALSE (read-only apiKey triple, see header).
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
    return unknownResult('ApeX returned an unexpected response. Nothing was stored.')
  }
  const b = body as Record<string, unknown>
  // Error bodies: { code: <non-zero>, msg: '...' } or { code: 'PERMISSION_DENIED' }.
  if (b.code !== undefined && b.code !== 0 && b.code !== '0') {
    return unknownResult('ApeX rejected these credentials, so nothing was stored.')
  }
  if (b.data === undefined) {
    return unknownResult('ApeX did not return account data, so nothing was stored.')
  }
  return { ok: true, permissions: ['read-only'], canWithdraw: false, canTrade: false }
}

export const apex: VenueAdapter = {
  id: 'apex',
  label: 'ApeX Omni',

  requiredFields(): CredField[] {
    return ['apiKey', 'secret', 'passphrase']
  },

  async verifyKey(creds: VenueCreds): Promise<VerifyResult> {
    try {
      const r = await signedGet('/api/v3/account', '', creds)
      return parseRead(r && r.data)
    } catch (e) {
      return { ok: false, permissions: [], canWithdraw: 'unknown', canTrade: 'unknown', error: toSafeError(e) }
    }
  },

  async getBalance(creds: VenueCreds) {
    try {
      const r = await signedGet('/api/v3/account-balance', '', creds)
      const data = r && r.data && (r.data as Record<string, unknown>).data
      const d = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
      const total = Number(d.totalEquityValue ?? d.equity ?? 0)
      const balances: Balance[] = total ? [{ asset: 'USDT', free: Number(d.availableBalance ?? total), total }] : []
      return { balances }
    } catch (e) {
      return { balances: [], error: toSafeError(e) }
    }
  },

  async getPositions(creds: VenueCreds) {
    try {
      const r = await signedGet('/api/v3/account', '', creds)
      const data = r && r.data && (r.data as Record<string, unknown>).data
      const rows = data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).positions)
        ? ((data as Record<string, unknown>).positions as Record<string, unknown>[])
        : []
      const positions: Position[] = rows
        .map((x) => ({
          symbol: String(x.symbol ?? ''),
          side: String(x.side ?? ''),
          size: Math.abs(Number(x.size ?? 0)),
          entryPrice: x.entryPrice != null ? Number(x.entryPrice) : null,
          unrealizedPnl: x.unrealizedPnl != null ? Number(x.unrealizedPnl) : null,
        }))
        .filter((p) => p.size > 0)
      return { positions }
    } catch (e) {
      return { positions: [], error: toSafeError(e) }
    }
  },
}
