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
const { rlGet } = require('../rateLimitedFetch')

/**
 * GATE.IO — accept-and-disclose. No Gate.io endpoint reports the calling key's
 * withdrawal permission (AccountApi has no permission field; AccountDetailKey carries
 * only `mode`). So we CANNOT read whether this key can withdraw: permissionsAtVerify
 * records the explicit UNQUERYABLE marker, never a fabricated 'false'. Gate signs with
 * HMAC-SHA512 (its scheme; not SHA256).
 *
 * Gate.io UNIQUELY lets a read MEASURE the real, venue-enforced mitigation: GET
 * /account/detail returns an `ip_whitelist` array, so we report whether this key is
 * IP-restricted and whether OUR server IP is in it. That is a fact we read, not a block
 * we apply — the venue enforces the whitelist, we only surface its state. We never call a
 * withdraw/transfer/send endpoint here; getBalance/getPositions read futures state only.
 */

const BASE = 'https://api.gateio.ws' // agent15-funding-writer.js:287, lib/leverage-caps.js:127
const TIMEOUT_MS = 12_000

/** Our EU server IP. Used ONLY to report whether Gate's ip_whitelist includes it. */
export const SERVER_IP = '167.233.63.218'

export const MAINNET_ONLY = true

function signedGet(path: string, query: string, creds: VenueCreds) {
  const url = query ? `${BASE}${path}?${query}` : `${BASE}${path}`
  return rlGet(url, {
    timeoutMs: TIMEOUT_MS,
    sign: (req: { timestamp: number; path: string; query: string }) => {
      const ts = String(Math.floor(req.timestamp / 1000)) // Gate uses SECONDS
      // Docs: METHOD \n PATH \n QueryString \n HexEncode(SHA512(body)) \n Timestamp
      const bodyHash = createHash('sha512').update('').digest('hex')
      const prehash = `GET\n${req.path}\n${req.query || ''}\n${bodyHash}\n${ts}`
      const sign = createHmac('sha512', creds.secret).update(prehash).digest('hex')
      return { headers: { KEY: creds.apiKey, SIGN: sign, Timestamp: ts } }
    },
  })
}

/**
 * Pure parse of GET /account/detail. Exported so the fail-closed rule is testable without
 * a live key. Anything that is not the documented account shape → canWithdraw 'unknown'.
 * An AUTHENTIC body records the UNQUERYABLE withdrawal marker + the measured ip_whitelist
 * state — never 'false' for the permission itself (Gate does not report it).
 */
export function parseAccountDetail(body: unknown): VerifyResult {
  const unknownResult = (error: string): VerifyResult => ({
    ok: false,
    permissions: [],
    canWithdraw: 'unknown',
    canTrade: 'unknown',
    error,
  })

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return unknownResult('Gate.io returned an unexpected response. Nothing was stored.')
  }
  const b = body as Record<string, unknown>

  // Gate error bodies look like { label: 'INVALID_KEY', message: '...' } and carry no user_id.
  if (b.user_id === undefined) {
    return unknownResult(
      b.label !== undefined || b.message !== undefined
        ? 'Gate.io rejected this key. Check the key, its IP allowlist, and its permissions.'
        : 'Gate.io did not return account details, so nothing was stored.',
    )
  }

  // Authentic key. Withdrawal permission is UNQUERYABLE at Gate — record that, not 'false'.
  const permissions: string[] = [PERMISSION_UNQUERYABLE]
  const ipwl = Array.isArray(b.ip_whitelist) ? (b.ip_whitelist as unknown[]).map(String) : null
  if (ipwl && ipwl.length > 0) {
    permissions.push('ip-whitelist:set')
    permissions.push(ipwl.indexOf(SERVER_IP) !== -1 ? 'ip-whitelist:includes-server' : 'ip-whitelist:excludes-server')
  } else if (ipwl) {
    permissions.push('ip-whitelist:none')
  }
  // canWithdraw stays 'unknown' — the honest tri-state. accept_and_disclose stores anyway.
  return { ok: true, permissions, canWithdraw: 'unknown', canTrade: 'unknown' }
}

export const gateio: VenueAdapter = {
  id: 'gateio',
  label: 'Gate.io',

  requiredFields(): CredField[] {
    return ['apiKey', 'secret']
  },

  async verifyKey(creds: VenueCreds): Promise<VerifyResult> {
    try {
      const r = await signedGet('/api/v4/account/detail', '', creds)
      return parseAccountDetail(r && r.data)
    } catch (e) {
      return { ok: false, permissions: [], canWithdraw: 'unknown', canTrade: 'unknown', error: toSafeError(e) }
    }
  },

  async getBalance(creds: VenueCreds) {
    try {
      const r = await signedGet('/api/v4/futures/usdt/accounts', '', creds)
      const d = (r && r.data) as Record<string, unknown>
      if (!d || typeof d !== 'object') return { balances: [] }
      const total = Number(d.total ?? 0)
      const available = Number(d.available ?? 0)
      const balances: Balance[] = total || available ? [{ asset: 'USDT', free: available, total }] : []
      return { balances }
    } catch (e) {
      return { balances: [], error: toSafeError(e) }
    }
  },

  async getPositions(creds: VenueCreds) {
    try {
      const r = await signedGet('/api/v4/futures/usdt/positions', '', creds)
      const rows = Array.isArray(r && r.data) ? (r.data as Record<string, unknown>[]) : []
      const positions: Position[] = rows
        .map((x) => ({
          symbol: String(x.contract ?? ''),
          side: Number(x.size ?? 0) >= 0 ? 'long' : 'short',
          size: Math.abs(Number(x.size ?? 0)),
          entryPrice: x.entry_price != null ? Number(x.entry_price) : null,
          unrealizedPnl: x.unrealised_pnl != null ? Number(x.unrealised_pnl) : null,
        }))
        .filter((p) => p.size > 0)
      return { positions }
    } catch (e) {
      return { positions: [], error: toSafeError(e) }
    }
  },
}
