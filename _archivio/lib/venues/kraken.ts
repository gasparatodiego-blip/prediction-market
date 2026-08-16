import { createHmac, createHash } from 'crypto'
import {
  VenueAdapter,
  VenueCreds,
  VerifyResult,
  CredField,
  Balance,
  Position,
  PERMISSION_UNQUERYABLE,
} from './types'
import { toSafeError } from './safe-error'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { rlPost } = require('../rateLimitedFetch')

/**
 * KRAKEN — accept-and-disclose. Kraken exposes NO REST endpoint that reports the calling
 * key's permissions (query/trade/withdraw are visible only in the web UI). So we cannot
 * read whether this key can withdraw: permissionsAtVerify records the explicit UNQUERYABLE
 * marker, never a fabricated 'false'. Kraken keys are Type A (issued public/private pair);
 * the secret is a base64-encoded private key.
 *
 * Kraken DOES support a withdrawal-address whitelist and IP restriction, but neither is
 * safely API-readable (reading the saved addresses needs a Withdraw-permission key, and
 * exercising that is itself a withdraw-scoped call we will never make). So the card shows
 * "cannot verify" for both, with the venue's own how-to links next to the field. We never
 * call a withdraw/transfer/send endpoint; verify + reads use private query endpoints only.
 */

const BASE = 'https://api.kraken.com'
const TIMEOUT_MS = 12_000

export const MAINNET_ONLY = true

/**
 * Kraken signs POST bodies: API-Sign = HMAC-SHA512(b64secret, path + SHA256(nonce+body)).
 * The nonce lives in the body and is signed, so it is fixed at CALL time and passed to
 * rlPost as the exact body the seam signs and sends. Unlike Binance's recvWindow, Kraken's
 * nonce is only required to strictly INCREASE per key (not fall in a time window), so a
 * call-time nonce behind the limiter is correct — a later call simply gets a larger one.
 */
function signedPost(path: string, creds: VenueCreds) {
  const nonce = String(Date.now())
  const body = `nonce=${nonce}`
  return rlPost(`${BASE}${path}`, body, {
    timeoutMs: TIMEOUT_MS,
    sign: () => {
      const sha = createHash('sha256').update(nonce + body).digest()
      const secretBuf = Buffer.from(String(creds.secret), 'base64')
      const sign = createHmac('sha512', secretBuf)
        .update(Buffer.concat([Buffer.from(path, 'utf8'), sha]))
        .digest('base64')
      return {
        headers: {
          'API-Key': String(creds.apiKey),
          'API-Sign': sign,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    },
  })
}

/**
 * Pure parse of a Kraken private response. Exported for the fail-closed test. Kraken wraps
 * every response as { error: string[], result: {...} }. A non-empty `error` (or any shape
 * that is not that envelope) → canWithdraw 'unknown'. An authentic result records the
 * UNQUERYABLE withdrawal marker — Kraken never reports the permission.
 */
export function parsePrivate(body: unknown): VerifyResult {
  const unknownResult = (error: string): VerifyResult => ({
    ok: false,
    permissions: [],
    canWithdraw: 'unknown',
    canTrade: 'unknown',
    error,
  })

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return unknownResult('Kraken returned an unexpected response. Nothing was stored.')
  }
  const b = body as Record<string, unknown>

  if (Array.isArray(b.error) && b.error.length > 0) {
    return unknownResult('Kraken rejected this key. Check the key, its IP restriction, and its permissions.')
  }
  if (b.result === undefined || b.result === null || typeof b.result !== 'object') {
    return unknownResult('Kraken did not return account data, so nothing was stored.')
  }

  // Authentic key. Withdrawal permission is UNQUERYABLE at Kraken — record that, not 'false'.
  return { ok: true, permissions: [PERMISSION_UNQUERYABLE], canWithdraw: 'unknown', canTrade: 'unknown' }
}

export const kraken: VenueAdapter = {
  id: 'kraken',
  label: 'Kraken',

  requiredFields(): CredField[] {
    return ['apiKey', 'secret']
  },

  async verifyKey(creds: VenueCreds): Promise<VerifyResult> {
    try {
      const r = await signedPost('/0/private/Balance', creds)
      return parsePrivate(r && r.data)
    } catch (e) {
      return { ok: false, permissions: [], canWithdraw: 'unknown', canTrade: 'unknown', error: toSafeError(e) }
    }
  },

  async getBalance(creds: VenueCreds) {
    try {
      const r = await signedPost('/0/private/Balance', creds)
      const result = r && r.data && (r.data as Record<string, unknown>).result
      const rows = result && typeof result === 'object' ? (result as Record<string, unknown>) : {}
      const balances: Balance[] = Object.keys(rows)
        .map((asset) => ({ asset, free: Number(rows[asset] ?? 0), total: Number(rows[asset] ?? 0) }))
        .filter((x) => x.total !== 0)
      return { balances }
    } catch (e) {
      return { balances: [], error: toSafeError(e) }
    }
  },

  async getPositions(creds: VenueCreds) {
    try {
      const r = await signedPost('/0/private/OpenPositions', creds)
      const result = r && r.data && (r.data as Record<string, unknown>).result
      const rows = result && typeof result === 'object' ? (result as Record<string, Record<string, unknown>>) : {}
      const positions: Position[] = Object.keys(rows)
        .map((k) => {
          const x = rows[k]
          return {
            symbol: String(x.pair ?? ''),
            side: String(x.type ?? ''),
            size: Math.abs(Number(x.vol ?? 0)),
            entryPrice: x.cost != null && Number(x.vol) ? Number(x.cost) / Number(x.vol) : null,
            unrealizedPnl: x.net != null ? Number(x.net) : null,
          }
        })
        .filter((p) => p.size > 0)
      return { positions }
    } catch (e) {
      return { positions: [], error: toSafeError(e) }
    }
  },
}
