import { createHmac } from 'crypto'
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
 * EDGEX — READ-ONLY, disclosed as read-only. We store ONLY the venue-issued HMAC
 * credentials (apiKey/secret/passphrase). Reads use those headers alone; edgeX's docs
 * scope L2 signing to writes: order placement and transfer-out are signed by a SEPARATE
 * venue-provisioned L2 "Signer" key, and off-exchange withdrawal is signed by the wallet
 * key — quoted from the Asset API: "Sign the returned typed data with the wallet private
 * key." We do NOT ask for or store the Signer key or the wallet key, so the credential we
 * hold cannot place orders, transfer, or withdraw: it can only read. canWithdraw is FALSE
 * by construction (the fund-moving keys are simply not in our custody). Not a block we
 * apply — it is not the fund-moving key.
 *
 * HMAC-SHA256 via X-edgeX-* headers. Exact HMAC preimage is D1-verified against the live
 * venue (liveVerified stays false until then). No withdraw/transfer/send endpoint is called.
 */

const BASE = 'https://pro.edgex.exchange' // agent10-binance.js:96 (EDGEX_BASE public host)
const TIMEOUT_MS = 12_000

export const MAINNET_ONLY = true

function signedGet(path: string, query: string, creds: VenueCreds) {
  const url = query ? `${BASE}${path}?${query}` : `${BASE}${path}`
  return rlGet(url, {
    timeoutMs: TIMEOUT_MS,
    sign: (req: { timestamp: number; path: string; query: string }) => {
      const ts = String(req.timestamp)
      const requestPath = req.query ? `${req.path}?${req.query}` : req.path
      // HMAC-SHA256 over timestamp + method + requestPath (preimage confirmed at D1).
      const prehash = ts + 'GET' + requestPath
      const sign = createHmac('sha256', String(creds.secret)).update(prehash).digest('hex')
      return {
        headers: {
          'X-edgeX-Api-Key': String(creds.apiKey),
          'X-edgeX-Passphrase': String(creds.passphrase ?? ''),
          'X-edgeX-Timestamp': ts,
          'X-edgeX-Signature': sign,
        },
      }
    },
  })
}

/**
 * Pure parse of an edgeX private read. Exported for the fail-closed test. edgeX wraps
 * responses as { code: "SUCCESS", data: {...} }. Anything not that authentic shape →
 * 'unknown'. An authentic read → canWithdraw FALSE (read-only credentials, see header).
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
    return unknownResult('edgeX returned an unexpected response. Nothing was stored.')
  }
  const b = body as Record<string, unknown>
  if (b.code !== 'SUCCESS' || b.data === undefined) {
    return unknownResult('edgeX rejected these credentials, so nothing was stored.')
  }
  return { ok: true, permissions: ['read-only'], canWithdraw: false, canTrade: false }
}

export const edgex: VenueAdapter = {
  id: 'edgex',
  label: 'edgeX',

  requiredFields(): CredField[] {
    return ['apiKey', 'secret', 'passphrase']
  },
  requiredPlainFields(): PlainField[] {
    return ['accountId']
  },

  async verifyKey(creds: VenueCreds): Promise<VerifyResult> {
    if (creds.accountId == null || String(creds.accountId).trim() === '') {
      return { ok: false, permissions: [], canWithdraw: 'unknown', canTrade: 'unknown', error: 'An edgeX account id is required. Nothing was stored.' }
    }
    try {
      const r = await signedGet('/api/v2/private/account/getAccountAsset', `accountId=${encodeURIComponent(String(creds.accountId))}`, creds)
      return parseRead(r && r.data)
    } catch (e) {
      return { ok: false, permissions: [], canWithdraw: 'unknown', canTrade: 'unknown', error: toSafeError(e) }
    }
  },

  async getBalance(creds: VenueCreds) {
    try {
      const r = await signedGet('/api/v2/private/account/getAccountAsset', `accountId=${encodeURIComponent(String(creds.accountId))}`, creds)
      const data = r && r.data && (r.data as Record<string, unknown>).data
      const d = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
      const total = Number(d.totalEquity ?? d.equity ?? 0)
      const balances: Balance[] = total ? [{ asset: 'USD', free: Number(d.availableAmount ?? total), total }] : []
      return { balances }
    } catch (e) {
      return { balances: [], error: toSafeError(e) }
    }
  },

  async getPositions(creds: VenueCreds) {
    try {
      const r = await signedGet('/api/v2/private/account/getPositionTransactionPage', `accountId=${encodeURIComponent(String(creds.accountId))}`, creds)
      const data = r && r.data && (r.data as Record<string, unknown>).data
      const rows = data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).dataList)
        ? ((data as Record<string, unknown>).dataList as Record<string, unknown>[])
        : []
      const positions: Position[] = rows
        .map((x) => ({
          symbol: String(x.contractId ?? ''),
          side: Number(x.openSize ?? 0) >= 0 ? 'long' : 'short',
          size: Math.abs(Number(x.openSize ?? 0)),
          entryPrice: x.openValue != null && Number(x.openSize) ? Number(x.openValue) / Number(x.openSize) : null,
          unrealizedPnl: null,
        }))
        .filter((p) => p.size > 0)
      return { positions }
    } catch (e) {
      return { positions: [], error: toSafeError(e) }
    }
  },
}
