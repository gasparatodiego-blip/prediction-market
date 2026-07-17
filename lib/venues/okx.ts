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
 * OKX — withdrawal permission source of truth
 * ------------------------------------------
 * Endpoint: GET /api/v5/account/config   ("Get account configuration")
 * Docs:     https://www.okx.com/docs-v5/en/#trading-account-rest-api-get-account-configuration
 * Limit:    10 requests per 2 seconds, per User ID.
 *
 * Response parameter, quoted VERBATIM from the docs' response-parameters table
 * (fetched from the full 5,140,514-byte docs page and isolated by anchor):
 *
 *   perm | String | The permission of the current requesting API key or Access token
 *          read_only : Read
 *          trade     : Trade
 *          withdraw  : Withdraw
 *
 * Official response example: "perm": "read_only,withdraw,trade"
 *
 * Withdrawal field: membership of "withdraw" in the comma-separated `perm` string.
 * Trading field:    membership of "trade".
 * IP field:         `ip` — "IP addresses that linked with current API key... It is an
 *                   empty string "" if there is no IP bonded."
 *
 * Two adjacent fields confirm this endpoint describes the CALLING key, not the
 * account at large: `label` is "API key note of current request API key", and `ip`
 * is "linked with current API key".
 *
 * TRAP, recorded so nobody re-walks it: OKX's Broker/sub-account key endpoints ALSO
 * return a `perm` field, but their enum is only read_only/trade — it omits `withdraw`
 * entirely. Those endpoints are both the wrong caller and structurally incapable of
 * answering a withdraw question. /api/v5/account/config is the only OKX v5 endpoint
 * exposing the calling key's own permissions.
 *
 * Base URL www.okx.com is already proven by the public-only agents
 * (agent15-funding-writer.js:267, agent19-basis.js:676).
 */

const BASE = 'https://www.okx.com'
const TIMEOUT_MS = 12_000

/**
 * MAINNET-ONLY for VERIFICATION PURPOSES.
 *
 * OKX does have demo trading (header `x-simulated-trading: 1`), and account/config is
 * not among the named demo exclusions ("some functions are not supported, such as
 * withdraw, deposit, purchase/redemption, etc."). BUT the docs list exclusions as an
 * open-ended "etc." rather than an allowlist, and — decisively — whether `perm` is
 * POPULATED in demo is NOT established by the docs.
 *
 * A demo `perm` that came back empty or defaulted would make a withdraw-enabled key
 * look clean. Verifying the guard against an environment whose behaviour we cannot
 * establish is exactly the unverifiable-claim failure this layer exists to prevent,
 * so the guard is verified on mainnet only. See scripts/verify-venue-live.md.
 */
export const MAINNET_ONLY = true

function signedGet(path: string, creds: VenueCreds) {
  const url = `${BASE}${path}`
  return rlGet(url, {
    timeoutMs: TIMEOUT_MS,
    // Signed at FIRE time: OKX rejects a request whose OK-ACCESS-TIMESTAMP is more
    // than 30 seconds old, so a timestamp minted before the queue would fail.
    sign: (req: { timestamp: number; path: string; query: string }) => {
      // OKX timestamp is ISO8601 with milliseconds, e.g. 2020-12-08T09:08:57.715Z
      const ts = new Date(req.timestamp).toISOString()
      const requestPath = req.query ? `${req.path}?${req.query}` : req.path
      // sign = base64(hmac_sha256(timestamp + method + requestPath + body))
      const prehash = ts + 'GET' + requestPath
      const sign = createHmac('sha256', creds.secret).update(prehash).digest('base64')
      return {
        headers: {
          'OK-ACCESS-KEY': creds.apiKey,
          'OK-ACCESS-SIGN': sign,
          'OK-ACCESS-TIMESTAMP': ts,
          'OK-ACCESS-PASSPHRASE': String(creds.passphrase ?? ''),
          'Content-Type': 'application/json',
        },
      }
    },
  })
}

/**
 * Pure parse of the account/config body. Exported so the fail-closed rule is testable
 * without a live key. Anything not the documented shape yields 'unknown'.
 */
export function parseVerify(body: unknown): VerifyResult {
  const unknownResult = (error: string): VerifyResult => ({
    ok: false,
    permissions: [],
    canWithdraw: 'unknown',
    canTrade: 'unknown',
    error,
  })

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return unknownResult('OKX returned an unexpected response. Nothing was stored.')
  }

  const b = body as Record<string, unknown>

  // OKX signals success with code "0" (a STRING, not a number).
  if (b.code !== undefined && b.code !== '0') {
    return unknownResult(
      'OKX rejected this key. Check the API key, the passphrase, the IP allowlist, and the key’s permissions.',
    )
  }

  const data = b.data
  if (!Array.isArray(data) || data.length === 0) {
    return unknownResult(
      'OKX did not report this key’s permissions, so it was refused. Nothing was stored.',
    )
  }

  const row = data[0]
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    return unknownResult(
      'OKX did not report this key’s permissions, so it was refused. Nothing was stored.',
    )
  }

  const perm = (row as Record<string, unknown>).perm

  // An absent or non-string perm is 'unknown' — never "no withdraw permission".
  if (typeof perm !== 'string' || perm.trim() === '') {
    return unknownResult(
      'OKX did not report whether this key can withdraw, so it was refused. Nothing was stored.',
    )
  }

  const parts = perm.split(',').map((s) => s.trim().toLowerCase())
  const canWithdraw = parts.indexOf('withdraw') !== -1
  const canTrade = parts.indexOf('trade') !== -1

  const permissions: string[] = []
  if (parts.indexOf('read_only') !== -1) permissions.push('read')
  if (canTrade) permissions.push('trade')
  if (canWithdraw) permissions.push('WITHDRAW')
  const ip = (row as Record<string, unknown>).ip
  if (typeof ip === 'string' && ip !== '') permissions.push('ip-bound')

  return { ok: true, permissions, canWithdraw, canTrade }
}

export const okx: VenueAdapter = {
  id: 'okx',
  label: 'OKX',

  /** OKX is the reason ExchangeKey.passphraseEnc is nullable. Do not flatten this. */
  requiredFields(): CredField[] {
    return ['apiKey', 'secret', 'passphrase']
  },

  async verifyKey(creds: VenueCreds): Promise<VerifyResult> {
    if (!creds.passphrase) {
      return {
        ok: false,
        permissions: [],
        canWithdraw: 'unknown',
        canTrade: 'unknown',
        error: 'OKX requires a passphrase. Nothing was stored.',
      }
    }
    try {
      const r = await signedGet('/api/v5/account/config', creds)
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
      const r = await signedGet('/api/v5/account/balance', creds)
      const d = r && r.data
      const rows = d && Array.isArray(d.data) ? d.data : []
      const details = rows.length && Array.isArray(rows[0].details) ? rows[0].details : []
      const balances: Balance[] = details
        .map((x: Record<string, unknown>) => ({
          asset: String(x.ccy ?? ''),
          free: Number(x.availBal ?? 0),
          total: Number(x.eq ?? 0),
        }))
        .filter((x: Balance) => x.asset && x.total !== 0)
      return { balances }
    } catch (e) {
      return { balances: [], error: toSafeError(e) }
    }
  },

  async getPositions(creds: VenueCreds) {
    try {
      const r = await signedGet('/api/v5/account/positions', creds)
      const d = r && r.data
      const rows = d && Array.isArray(d.data) ? d.data : []
      const positions: Position[] = rows
        .map((x: Record<string, unknown>) => ({
          symbol: String(x.instId ?? ''),
          side: String(x.posSide ?? 'net'),
          size: Math.abs(Number(x.pos ?? 0)),
          entryPrice: x.avgPx != null && x.avgPx !== '' ? Number(x.avgPx) : null,
          unrealizedPnl: x.upl != null && x.upl !== '' ? Number(x.upl) : null,
        }))
        .filter((p: Position) => p.size > 0)
      return { positions }
    } catch (e) {
      return { positions: [], error: toSafeError(e) }
    }
  },
}
