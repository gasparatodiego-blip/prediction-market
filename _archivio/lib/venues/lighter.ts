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
 * LIGHTER — accept-and-disclose. The credential is a delegated on-chain-registered API
 * signer private key (Type A — its own keypair, NOT the L1 wallet key). It CAN withdraw,
 * but ONLY to the owner's own L1 address, by PROTOCOL. Quoted verbatim from
 * apidocs.lighter.xyz/docs/api-keys:
 *   "only secure withdrawals can be executed without also signing the account's Ethereum
 *    private key - as they can only be sent to the same L1 address that created the
 *    account. In contrast, Fast Withdrawals and Transfers can be sent to other L1
 *    addresses and will require signing with the wallet's private key."
 * So a leaked Lighter key can push funds ONLY back to the legitimate owner — a hard,
 * protocol-enforced address lock. We disclose "can withdraw (to your own address only)";
 * we never claim WE block it — the protocol does.
 *
 * No per-key permission field exists (the apikeys endpoint returns only
 * {account_index, api_key_index, nonce, public_key, transaction_time}). canWithdraw is
 * therefore reported as `true` (the key type can withdraw), disclosed as owner-locked.
 *
 * KEY-MATCH IS D1-DEFERRED: confirming the pasted private key IS the registered signer
 * requires Lighter's Schnorr pubkey derivation (a curve not in node crypto and not added
 * as a dependency). verifyKey confirms the account + key slot exist (public read) and that
 * the slot has a registered public key; the private-key match is proven live at D1. Reads
 * are public by account index. No withdraw/transfer/send endpoint is ever called.
 */

const BASE = 'https://mainnet.zklighter.elliot.ai' // agent10-binance.js:902
const TIMEOUT_MS = 12_000

export const MAINNET_ONLY = true

/**
 * Pure parse of GET /api/v1/apikeys. Exported for the fail-closed test. Requires an
 * `api_keys` array with an entry at the requested index carrying a public_key. Anything
 * else → 'unknown'. An authentic slot → canWithdraw TRUE (owner-address-locked, disclosed).
 */
export function parseApiKeys(body: unknown, apiKeyIndex: number): VerifyResult {
  const unknownResult = (error: string): VerifyResult => ({
    ok: false,
    permissions: [],
    canWithdraw: 'unknown',
    canTrade: 'unknown',
    error,
  })

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return unknownResult('Lighter returned an unexpected response. Nothing was stored.')
  }
  const b = body as Record<string, unknown>
  if (!Array.isArray(b.api_keys)) {
    return unknownResult('Lighter did not return this account’s API keys, so nothing was stored.')
  }
  const slot = (b.api_keys as Record<string, unknown>[]).find(
    (k) => k && typeof k === 'object' && Number(k.api_key_index) === Number(apiKeyIndex),
  )
  if (!slot || !slot.public_key || String(slot.public_key).trim() === '') {
    return unknownResult('No registered Lighter API key was found at that index, so nothing was stored.')
  }

  // The key type can withdraw — but ONLY to the owner's own L1 address (protocol lock).
  return {
    ok: true,
    permissions: ['withdraw:owner-address-locked', 'trade', 'key-match:D1-unverified'],
    canWithdraw: true,
    canTrade: true,
  }
}

async function fetchApiKeys(accountIndex: string, apiKeyIndex: string): Promise<unknown> {
  const r = await rlGet(
    `${BASE}/api/v1/apikeys?account_index=${encodeURIComponent(accountIndex)}&api_key_index=${encodeURIComponent(apiKeyIndex)}`,
    { timeoutMs: TIMEOUT_MS },
  )
  return r && r.data
}

export const lighter: VenueAdapter = {
  id: 'lighter',
  label: 'Lighter',

  /** Just the signer private key (secret). The indices are public identifiers. */
  requiredFields(): CredField[] {
    return ['secret']
  },
  requiredPlainFields(): PlainField[] {
    return ['accountId', 'subaccountNumber']
  },

  async verifyKey(creds: VenueCreds): Promise<VerifyResult> {
    if (creds.accountId == null || String(creds.accountId).trim() === '') {
      return { ok: false, permissions: [], canWithdraw: 'unknown', canTrade: 'unknown', error: 'A Lighter account index is required. Nothing was stored.' }
    }
    const apiKeyIndex = creds.subaccountNumber ?? 0
    try {
      const body = await fetchApiKeys(String(creds.accountId), String(apiKeyIndex))
      return parseApiKeys(body, Number(apiKeyIndex))
    } catch (e) {
      return { ok: false, permissions: [], canWithdraw: 'unknown', canTrade: 'unknown', error: toSafeError(e) }
    }
  },

  async getBalance(creds: VenueCreds) {
    try {
      const r = await rlGet(`${BASE}/api/v1/account?by=index&value=${encodeURIComponent(String(creds.accountId))}`, { timeoutMs: TIMEOUT_MS })
      const d = r && r.data && (r.data as Record<string, unknown>)
      const accounts = d && Array.isArray(d.accounts) ? (d.accounts as Record<string, unknown>[]) : []
      const a = accounts[0]
      const collateral = a && a.collateral != null ? Number(a.collateral) : 0
      const balances: Balance[] = collateral ? [{ asset: 'USDC', free: collateral, total: collateral }] : []
      return { balances }
    } catch (e) {
      return { balances: [], error: toSafeError(e) }
    }
  },

  async getPositions(creds: VenueCreds) {
    try {
      const r = await rlGet(`${BASE}/api/v1/account?by=index&value=${encodeURIComponent(String(creds.accountId))}`, { timeoutMs: TIMEOUT_MS })
      const d = r && r.data && (r.data as Record<string, unknown>)
      const accounts = d && Array.isArray(d.accounts) ? (d.accounts as Record<string, unknown>[]) : []
      const positionsRaw = accounts[0] && Array.isArray(accounts[0].positions) ? (accounts[0].positions as Record<string, unknown>[]) : []
      const positions: Position[] = positionsRaw
        .map((x) => ({
          symbol: String(x.symbol ?? x.market_id ?? ''),
          side: Number(x.position ?? x.sign ?? 0) >= 0 ? 'long' : 'short',
          size: Math.abs(Number(x.position ?? 0)),
          entryPrice: x.avg_entry_price != null ? Number(x.avg_entry_price) : null,
          unrealizedPnl: x.unrealized_pnl != null ? Number(x.unrealized_pnl) : null,
        }))
        .filter((p) => p.size > 0)
      return { positions }
    } catch (e) {
      return { positions: [], error: toSafeError(e) }
    }
  },
}
