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
 * BINANCE — withdrawal permission source of truth
 * ----------------------------------------------
 * Endpoint: GET /sapi/v1/account/apiRestrictions   ("Get API Key Permission")
 * Docs:     https://developers.binance.com/docs/wallet/account/api-key-permission
 * Weight:   1 (IP). Params: timestamp (required), recvWindow (optional, max 60000).
 *
 * Documented response, quoted verbatim from the docs:
 *
 *   {
 *     "ipRestrict": false,
 *     "createTime": 1623840271000,
 *     "enableReading": true,
 *     "enableWithdrawals": false,   // <-- THE FIELD. bool.
 *     "enableInternalTransfer": true,
 *     "enableMargin": false,
 *     "enableFutures": false,
 *     "permitsUniversalTransfer": true,
 *     "enableVanillaOptions": false,
 *     "enableSpotAndMarginTrading": false,
 *     "enablePortfolioMarginTrading": true
 *   }
 *
 * Withdrawal field: `enableWithdrawals` (boolean).
 * Trading fields:   `enableSpotAndMarginTrading`, `enableFutures` (booleans).
 * IP field:         `ipRestrict` (boolean).
 *
 * BASE URL NOTE: this endpoint lives on the SPOT base (api.binance.com/sapi/...),
 * while USDT-M futures trade on fapi.binance.com. Same key, different host — we
 * verify on SAPI and read futures balance/positions on FAPI. Both bases are already
 * proven by the public-only agents (agent19-basis.js, agent15-funding-writer.js).
 *
 * MAINNET-ONLY: see MAINNET_ONLY below.
 */

const SPOT_BASE = 'https://api.binance.com' // agent19-basis.js:309 uses this host
const FAPI_BASE = 'https://fapi.binance.com' // agent15-funding-writer.js:250, agent28-perp-spot.js:125

const TIMEOUT_MS = 12_000
const RECV_WINDOW = 5_000

/**
 * MAINNET-ONLY — established by an explicit doc Q&A, not inferred.
 *
 * https://developers.binance.com/docs/binance-spot-api-docs/testnet/general-info
 *   Q: "Can I use the /sapi endpoints on the Spot Test Network?"
 *   A: "No, only the /api endpoints are available on the Spot Test Network"
 *
 * So /sapi/v1/account/apiRestrictions has NO testnet equivalent: the withdrawal
 * guard cannot be exercised anywhere but mainnet, with a real key.
 *
 * (Inference, labelled: the USDⓈ-M futures testnet docs never mention /sapi at all,
 * covering only /fapi. That is argument-from-silence, so it is not relied on. The
 * quotable fact above is sufficient.)
 *
 * See scripts/verify-venue-live.md.
 */
export const MAINNET_ONLY = true

function signedGet(
  base: string,
  path: string,
  params: Record<string, string | number>,
  creds: VenueCreds,
) {
  const url = `${base}${path}`
  return rlGet(url, {
    timeoutMs: TIMEOUT_MS,
    // Signed at FIRE time by the seam, not here — a timestamp minted at call time
    // would be stale behind the limiter and Binance would reject it on recvWindow.
    sign: (req: { url: string; timestamp: number }) => {
      const all: Record<string, string | number> = {
        ...params,
        timestamp: req.timestamp,
        recvWindow: RECV_WINDOW,
      }
      const qs = Object.keys(all)
        .map((k) => `${k}=${encodeURIComponent(String(all[k]))}`)
        .join('&')
      const signature = createHmac('sha256', creds.secret).update(qs).digest('hex')
      // Binance carries the signature as a QUERY PARAM, hence the url rewrite.
      return {
        url: `${req.url}?${qs}&signature=${signature}`,
        headers: { 'X-MBX-APIKEY': creds.apiKey },
      }
    },
  })
}

/**
 * Pure parse of the apiRestrictions body. Exported so the fail-closed rule is
 * testable without a live key or a network call.
 *
 * Anything that is not the documented shape yields canWithdraw: 'unknown'.
 */
export function parseVerify(body: unknown): VerifyResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      permissions: [],
      canWithdraw: 'unknown',
      canTrade: 'unknown',
      error: 'Binance returned an unexpected response. Nothing was stored.',
    }
  }

  const b = body as Record<string, unknown>

  // Binance error bodies look like { "code": -2015, "msg": "Invalid API-key, ..." }.
  // A successful apiRestrictions body has no `code`.
  if (typeof b.code === 'number' && typeof b.msg === 'string') {
    return {
      ok: false,
      permissions: [],
      canWithdraw: 'unknown',
      canTrade: 'unknown',
      error: 'Binance rejected this key. Check the key, its IP allowlist, and its permissions.',
    }
  }

  const canWithdraw = triFromBool(b.enableWithdrawals)

  const futures = triFromBool(b.enableFutures)
  const spot = triFromBool(b.enableSpotAndMarginTrading)
  const canTrade: TriState =
    futures === 'unknown' && spot === 'unknown' ? 'unknown' : futures === true || spot === true

  if (canWithdraw === 'unknown') {
    return {
      ok: false,
      permissions: [],
      canWithdraw: 'unknown',
      canTrade,
      error:
        'Binance did not report whether this key can withdraw, so it was refused. Nothing was stored.',
    }
  }

  const permissions: string[] = []
  if (b.enableReading === true) permissions.push('read')
  if (spot === true) permissions.push('spot+margin trade')
  if (futures === true) permissions.push('futures trade')
  if (b.enableWithdrawals === true) permissions.push('WITHDRAW')
  if (b.ipRestrict === true) permissions.push('ip-restricted')

  return { ok: true, permissions, canWithdraw, canTrade }
}

export const binance: VenueAdapter = {
  id: 'binance',
  label: 'Binance',

  requiredFields(): CredField[] {
    return ['apiKey', 'secret']
  },

  async verifyKey(creds: VenueCreds): Promise<VerifyResult> {
    try {
      const r = await signedGet(SPOT_BASE, '/sapi/v1/account/apiRestrictions', {}, creds)
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
      const r = await signedGet(FAPI_BASE, '/fapi/v2/balance', {}, creds)
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
      const r = await signedGet(FAPI_BASE, '/fapi/v2/positionRisk', {}, creds)
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
