import { createHmac } from 'crypto'
import {
  VenueAdapter,
  VenueCreds,
  VerifyResult,
  CredField,
  Balance,
  Position,
  TriState,
} from './types'
import { toSafeError } from './safe-error'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { rlGet } = require('../rateLimitedFetch')

/**
 * BITGET — withdrawal permission source of truth
 * ---------------------------------------------
 * Endpoint: GET /api/v2/spot/account/info   ("Get Account Information")
 * Docs:     https://www.bitget.com/api-doc/spot/account/Get-Account-Info
 *
 * The response carries an `authorities` array of CRYPTIC permission codes (this is
 * the v2/classic shape — NOT the legacy-v1 human-readable ["trade","readonly"]).
 * Official decode table, quoted from that page:
 *
 *   Read only:        cpor futures-holdings, coor futures-orders, stor spot-trade,
 *                     smor margin-trade, ttor copy-trading, wtor wallet-transfer,
 *                     taxr taxation, chor subaccount, p2pr P2P-query
 *   Read and Write:   cpow, coow, stow, smow, ttow, wtow wallet-transfer,
 *                     wwow "wallet withdrawl", chow, p2p, pllw, pllr, taxw
 *
 * WITHDRAWAL FIELD: membership of "wwow" in `data.authorities`. Docs list it
 * literally as `wwow: wallet withdrawl` — the ONLY code that grants external
 * withdrawal, and there is no read-only variant (withdrawal is an action, not a
 * query), so it is a single unambiguous signal.
 *
 * DELIBERATE, load-bearing distinction: `wtor`/`wtow` = wallet TRANSFER (moving
 * funds between the user's OWN Bitget accounts, e.g. spot↔futures) is NOT external
 * withdrawal and must NOT be treated as `wwow`. Conflating them would refuse every
 * transfer-enabled trade key for no safety gain.
 *
 * TRADE FIELD: spot `stow`/`stor` or futures `coow`/`cpow`.
 *
 * Signing (like OKX): base64 HMAC-SHA256 over timestamp+method+requestPath, with a
 * PASSPHRASE header. Base URL api.bitget.com is already proven by the public-only
 * agents (agent15-funding-writer.js:277, lib/source-verify.js:148).
 */

const BASE = 'https://api.bitget.com'
const TIMEOUT_MS = 12_000

/** The withdraw code. Cited: docs list `wwow: wallet withdrawl`. */
const WITHDRAW_CODE = 'wwow'
/** Codes we positively recognise. An authorities array with anything outside this
 *  set is treated as unrecognised → 'unknown' → refuse (fail closed). */
const KNOWN_CODES = new Set([
  'cpor', 'coor', 'stor', 'smor', 'ttor', 'wtor', 'taxr', 'chor', 'p2pr',
  'cpow', 'coow', 'stow', 'smow', 'ttow', 'wtow', 'wwow', 'chow', 'p2p',
  'pllw', 'pllr', 'taxw',
])
const TRADE_CODES = new Set(['stow', 'stor', 'coow', 'cpow', 'smow', 'smor'])

export const MAINNET_ONLY = true

function signedGet(path: string, creds: VenueCreds) {
  const url = `${BASE}${path}`
  return rlGet(url, {
    timeoutMs: TIMEOUT_MS,
    // Signed at FIRE time — Bitget rejects a stale ACCESS-TIMESTAMP.
    sign: (req: { timestamp: number; path: string; query: string }) => {
      const ts = String(req.timestamp) // milliseconds
      const requestPath = req.query ? `${req.path}?${req.query}` : req.path
      // sign = base64(hmac_sha256(timestamp + method + requestPath + body))
      const prehash = ts + 'GET' + requestPath
      const sign = createHmac('sha256', creds.secret).update(prehash).digest('base64')
      return {
        headers: {
          'ACCESS-KEY': creds.apiKey,
          'ACCESS-SIGN': sign,
          'ACCESS-TIMESTAMP': ts,
          'ACCESS-PASSPHRASE': String(creds.passphrase ?? ''),
          'Content-Type': 'application/json',
          locale: 'en-US',
        },
      }
    },
  })
}

/**
 * Pure parse of the account/info body. Exported so the fail-closed rule is testable
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
    return unknownResult('Bitget returned an unexpected response. Nothing was stored.')
  }

  const b = body as Record<string, unknown>

  // Bitget signals success with code "00000" (a STRING).
  if (b.code !== undefined && b.code !== '00000') {
    return unknownResult(
      'Bitget rejected this key. Check the API key, the passphrase, the IP allowlist, and the key’s permissions.',
    )
  }

  const data = b.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return unknownResult(
      'Bitget did not report this key’s permissions, so it was refused. Nothing was stored.',
    )
  }

  const authorities = (data as Record<string, unknown>).authorities
  if (!Array.isArray(authorities)) {
    return unknownResult(
      'Bitget did not report whether this key can withdraw, so it was refused. Nothing was stored.',
    )
  }

  const codes = authorities.map((x) => String(x))

  // HARDENING: if we get the legacy/UTA human-readable shape instead of v2 codes,
  // do NOT silently mis-read it. Any literal "withdraw" string counts as withdraw,
  // and any value we don't recognise makes the whole verdict 'unknown' → refuse.
  const humanWithdraw = codes.some((c) => /^withdraw$/i.test(c))
  const unrecognised = codes.filter((c) => !KNOWN_CODES.has(c) && !/^(withdraw|transfer|trade|readonly)$/i.test(c))
  if (unrecognised.length > 0) {
    return unknownResult(
      'Bitget returned a permissions format we do not recognise, so the key was refused. Nothing was stored.',
    )
  }

  const canWithdraw: TriState = codes.indexOf(WITHDRAW_CODE) !== -1 || humanWithdraw
  const canTrade: TriState =
    codes.some((c) => TRADE_CODES.has(c)) || codes.some((c) => /^trade$/i.test(c))

  const permissions: string[] = []
  if (codes.some((c) => /or$/.test(c) || /^readonly$/i.test(c))) permissions.push('read')
  if (canTrade) permissions.push('trade')
  if (codes.indexOf('wtow') !== -1 || codes.some((c) => /^transfer$/i.test(c))) {
    permissions.push('internal-transfer')
  }
  if (canWithdraw) permissions.push('WITHDRAW')

  return { ok: true, permissions, canWithdraw, canTrade }
}

export const bitget: VenueAdapter = {
  id: 'bitget',
  label: 'Bitget',

  /** Bitget needs a passphrase, like OKX. */
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
        error: 'Bitget requires a passphrase. Nothing was stored.',
      }
    }
    try {
      const r = await signedGet('/api/v2/spot/account/info', creds)
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
      const r = await signedGet('/api/v2/spot/account/assets', creds)
      const d = r && r.data
      const rows = d && Array.isArray(d.data) ? (d.data as Record<string, unknown>[]) : []
      const balances: Balance[] = rows
        .map((x) => ({
          asset: String(x.coin ?? ''),
          free: Number(x.available ?? 0),
          total: Number(x.available ?? 0) + Number(x.frozen ?? 0) + Number(x.locked ?? 0),
        }))
        .filter((x) => x.asset && x.total !== 0)
      return { balances }
    } catch (e) {
      return { balances: [], error: toSafeError(e) }
    }
  },

  async getPositions(creds: VenueCreds) {
    try {
      // USDT-M futures positions.
      const r = await signedGet('/api/v2/mix/position/all-position?productType=USDT-FUTURES', creds)
      const d = r && r.data
      const rows = d && Array.isArray(d.data) ? (d.data as Record<string, unknown>[]) : []
      const positions: Position[] = rows
        .map((x) => ({
          symbol: String(x.symbol ?? ''),
          side: String(x.holdSide ?? ''),
          size: Math.abs(Number(x.total ?? 0)),
          entryPrice: x.openPriceAvg != null ? Number(x.openPriceAvg) : null,
          unrealizedPnl: x.unrealizedPL != null ? Number(x.unrealizedPL) : null,
        }))
        .filter((p) => p.size > 0)
      return { positions }
    } catch (e) {
      return { positions: [], error: toSafeError(e) }
    }
  },
}
