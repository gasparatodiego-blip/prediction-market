import { createHmac, createHash } from 'crypto'
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
 * GATE.IO — NO WITHDRAWAL-PERMISSION ENDPOINT EXISTS. THIS VENUE CANNOT BE ENABLED.
 * ================================================================================
 *
 * verifyKey() ALWAYS returns canWithdraw: 'unknown', so decideStorage() ALWAYS
 * refuses. This is not a bug, a stub, or a temporary state pending a live key: it is
 * the finding. No Gate.io v4 endpoint returns the CALLING key's permissions, so the
 * withdrawal guard cannot be built for Gate at all. A guard we cannot verify is not a
 * guard — it is a claim.
 *
 * HOW THAT NEGATIVE WAS ESTABLISHED (a failed search is not evidence; this is):
 *
 *  1. Gate's full account surface is /account/detail, /account/rate_limit,
 *     /account/stp_groups, /account/debit_fee. None return permissions.
 *
 *  2. /account/detail's response model, from Gate's OWN OpenAPI-generated SDK
 *     (gateio/gateapi-python, docs/AccountDetail.md), is exactly:
 *         ip_whitelist   list[str]  "IP Whitelist"
 *         currency_pairs list[str]  "Trading pair whitelist"
 *         user_id        int
 *         tier           int        "User VIP level"
 *         key            AccountDetailKey
 *         copy_trading_role int
 *     The promising `key` object (AccountDetailKey) has ONE property:
 *         mode  int  "Mode: 1 - Classic mode, 2 - Legacy unified mode"
 *     That is ACCOUNT MODE, not permissions.
 *
 *  3. Scanning EVERY model in the official SDK, only three relate to keys/perms:
 *     account_detail_key.py (mode only), sub_account_key.py, sub_account_key_perms.py.
 *
 *  4. The only permission data anywhere is SubAccountKeyPerms (`name`, `read_only`),
 *     reachable via GET /sub_accounts/{user_id}/keys — a MAIN-account key inspecting a
 *     SUB-account's key. That answers "what can that OTHER key do", never "what can
 *     THIS key do", and needs a MORE privileged credential to ask. Wrong direction.
 *
 * AMBIGUITY, recorded not resolved: Gate's docs say withdrawal "is separated from
 * wallet API into a standalone permission group", yet `withdraw` does not appear in
 * the documented SubAccountKeyPerms.name enum (wallet, spot, futures, delivery, earn,
 * custody, options, account, loan, margin, unified, copy). Those two statements do not
 * reconcile from the docs alone. It changes nothing — even resolved, it is the wrong
 * endpoint for the wrong key.
 *
 * IP field: `ip_whitelist` via /account/detail — Gate DOES expose that. It is not a
 * substitute for a withdrawal check and is not treated as one.
 *
 * Testnet: futures-only (fx-api-testnet.gateio.ws/api/v4). Irrelevant here — there is
 * no permission endpoint to test on either environment.
 *
 * getBalance/getPositions below are implemented to satisfy the interface and are
 * CURRENTLY UNREACHABLE: no Gate key can be stored, so nothing can ever call them
 * with real creds. They are not a promise that Gate is coming.
 *
 * SIGNING DEVIATION (venue fact, not a choice): Gate signs with HMAC-SHA512, not
 * SHA256 like the other three. Docs: "HexEncode(HMAC_SHA512(secret, signature_string))".
 */

const BASE = 'https://api.gateio.ws' // agent15-funding-writer.js:287, lib/leverage-caps.js:127
const TIMEOUT_MS = 12_000

/**
 * Not "mainnet-only" — there is no environment, mainnet or testnet, where Gate
 * exposes the calling key's withdrawal permission. Permanently unverifiable.
 */
export const MAINNET_ONLY = true

/** No endpoint to hit. Kept for symmetry with the other adapters' exported parsers. */
export function parseVerify(_body: unknown): VerifyResult {
  return {
    ok: false,
    permissions: [],
    canWithdraw: 'unknown',
    canTrade: 'unknown',
    error:
      'Gate.io does not expose whether an API key can withdraw, so we cannot verify that ' +
      'a key is trade-only. We do not store keys we cannot check. Gate.io is not supported.',
  }
}

function signedGet(path: string, query: string, creds: VenueCreds) {
  const url = query ? `${BASE}${path}?${query}` : `${BASE}${path}`
  return rlGet(url, {
    timeoutMs: TIMEOUT_MS,
    sign: (req: { timestamp: number; path: string; query: string }) => {
      const ts = String(Math.floor(req.timestamp / 1000)) // Gate uses SECONDS
      // Docs: METHOD \n PATH \n QueryString \n HexEncode(SHA512(payload)) \n Timestamp
      const bodyHash = createHash('sha512').update('').digest('hex')
      const prehash = `GET\n${req.path}\n${req.query || ''}\n${bodyHash}\n${ts}`
      const sign = createHmac('sha512', creds.secret).update(prehash).digest('hex')
      return { headers: { KEY: creds.apiKey, SIGN: sign, Timestamp: ts } }
    },
  })
}

export const gateio: VenueAdapter = {
  id: 'gateio',
  label: 'Gate.io',

  requiredFields(): CredField[] {
    return ['apiKey', 'secret']
  },

  /**
   * ALWAYS refuses. No network call is made — there is no endpoint to call. Returning
   * 'unknown' without hitting the network is the honest answer, not a shortcut: the
   * information does not exist at the venue.
   */
  async verifyKey(_creds: VenueCreds): Promise<VerifyResult> {
    return parseVerify(null)
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
