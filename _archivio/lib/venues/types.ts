/**
 * One interface, four key-based CEX venues.
 *
 * Read-only by construction. There is no order-placement method on this interface
 * and no venue implements one. Adding one is a product decision, not an adapter
 * change.
 *
 * THE FAIL-CLOSED RULE
 * --------------------
 * canWithdraw is deliberately a TRI-STATE: true | false | 'unknown'. It is not a
 * boolean, because a boolean forces every parse failure into either `true` (refuse
 * everything, useless) or `false` (STORE A KEY WE NEVER CHECKED — the failure this
 * whole layer exists to prevent).
 *
 * 'unknown' is returned whenever the venue does not tell us plainly:
 *   - the call errored, timed out, or was rate-limited
 *   - the body did not parse, or was not the documented shape
 *   - the permission field was absent, null, or a type we did not expect
 *   - the venue has no endpoint exposing the permission at all (gate.io)
 *
 * Only an explicit, parsed, documented `false` is `false`. Everything else refuses.
 * See decideStorage() — the single choke point every caller must go through.
 */

export type TriState = true | false | 'unknown'

/** Which ENCRYPTED credential fields a venue needs. Drives the UI form. */
export type CredField = 'apiKey' | 'secret' | 'passphrase'

/**
 * NON-SECRET identifier fields a venue needs (a public address, an id). These are
 * NOT encrypted and NOT credentials — they are stored in plaintext columns and are
 * required to build a verification query (e.g. dYdX needs the owner address +
 * authenticatorId to read the on-chain authenticator). Kept separate from CredField
 * on purpose: a plaintext identifier must never be handled as if it were a secret,
 * and a secret must never leak into a plaintext column.
 */
export type PlainField = 'accountAddress' | 'accountId' | 'subaccountNumber'

export interface VenueCreds {
  /** Absent for venues with no api key (e.g. dYdX). */
  apiKey?: string
  /** The signing secret. For dYdX this is the authenticator private key. */
  secret: string
  /** OKX/Bitget only. Nullable in ExchangeKey.passphraseEnc for exactly this reason. */
  passphrase?: string | null
  // Non-secret identifiers (dYdX). Plaintext by design.
  accountAddress?: string | null
  accountId?: string | null
  subaccountNumber?: number | null
}

export interface VerifyResult {
  /** True only if the venue answered and we parsed a documented response. */
  ok: boolean
  /** Human-readable permissions found, for display. Never contains credentials. */
  permissions: string[]
  canWithdraw: TriState
  canTrade: TriState
  /**
   * Safe, user-facing reason. NEVER contains the secret, the passphrase, a
   * signature, or a raw exception with a signed URL in it.
   */
  error?: string
}

export interface Balance {
  asset: string
  free: number
  total: number
}

export interface Position {
  symbol: string
  side: string
  size: number
  entryPrice: number | null
  unrealizedPnl: number | null
}

export interface VenueAdapter {
  id: string
  label: string
  /** binance/bybit: apiKey+secret. okx/bitget: +passphrase. dYdX: just secret. */
  requiredFields(): CredField[]
  /** Non-secret plaintext identifiers this venue needs (default none). */
  requiredPlainFields?(): PlainField[]
  verifyKey(creds: VenueCreds): Promise<VerifyResult>
  getBalance(creds: VenueCreds): Promise<{ balances: Balance[]; error?: string }>
  getPositions(creds: VenueCreds): Promise<{ positions: Position[]; error?: string }>
}

/**
 * Coerce an unknown value to a TriState. Anything that is not a real boolean is
 * 'unknown' — a missing field, null, undefined, a string "false", a number 0. A
 * venue that changes `enableWithdrawals` from bool to string does not silently
 * become "cannot withdraw"; it becomes 'unknown', and we refuse.
 */
export function triFromBool(v: unknown): TriState {
  if (v === true) return true
  if (v === false) return false
  return 'unknown'
}

/**
 * Coerce list-membership to a TriState. `list` must be a real array, or the answer
 * is 'unknown' — an absent permissions array is not proof of absent permission.
 */
export function triFromList(list: unknown, needle: string): TriState {
  if (!Array.isArray(list)) return 'unknown'
  return list.indexOf(needle) !== -1
}

export interface StorageDecision {
  store: boolean
  reason: string
}

/**
 * THE choke point. Every caller decides here, not inline.
 *
 * Storing requires an explicit, parsed `canWithdraw === false`. true refuses,
 * 'unknown' refuses. There is no third path and no override flag.
 */
export function decideStorage(v: VerifyResult): StorageDecision {
  if (!v.ok) {
    return {
      store: false,
      reason:
        v.error ||
        'Could not verify this key against the venue. Nothing was stored. Please try again.',
    }
  }
  if (v.canWithdraw === true) {
    return {
      store: false,
      reason:
        'This key has WITHDRAWALS ENABLED, so it was refused and nothing was stored. ' +
        'Create a new key with withdrawals disabled (trade-only) and connect that instead.',
    }
  }
  if (v.canWithdraw === 'unknown') {
    return {
      store: false,
      reason:
        'Could not confirm from the venue that this key cannot withdraw, so it was refused ' +
        'and nothing was stored. We only store a key when the venue tells us plainly that ' +
        'withdrawals are disabled.',
    }
  }
  return { store: true, reason: 'Verified: the venue reports withdrawals are disabled.' }
}

/**
 * Per-venue withdrawal policy, DECLARED in the registry — never inferred at the call
 * site. It changes only what we do with the tri-state, never the tri-state itself.
 *
 *   'refuse'              — store ONLY on an explicit parsed canWithdraw === false.
 *                           The original guard. Unchanged. The six live venues.
 *   'accept_and_disclose' — the venue's key can move funds, or we cannot check whether
 *                           it can. Store the AUTHENTIC key anyway, and record the TRUTH
 *                           in permissionsAtVerify (what the venue reported, or the
 *                           explicit UNQUERYABLE marker). The user must acknowledge first.
 *   'read_only'           — we deliberately hold ONLY credentials that can READ the
 *                           account; the venue's fund-moving key is a separate secret we
 *                           never collect. Store the authentic read credential; the user
 *                           acknowledges it is stored. Never claimed to be a withdrawal
 *                           block — it is simply not the fund-moving key.
 */
export type WithdrawalPolicy = 'refuse' | 'accept_and_disclose' | 'read_only'

/**
 * The explicit marker written into permissionsAtVerify when a venue exposes NO endpoint
 * to read the calling key's withdrawal permission (Gate.io, Kraken). It is the honest
 * alternative to writing 'false' for a permission we never read. Rendered by the UI as
 * "withdrawal permission UNKNOWN — this venue does not let us check", never as "no
 * withdrawal".
 */
export const PERMISSION_UNQUERYABLE = 'withdrawal-permission:UNQUERYABLE'

/**
 * Policy-aware storage choke point. 'refuse' defers to decideStorage() UNCHANGED — the
 * six existing venues cannot be weakened by this path. For the disclosed policies, we
 * still require an AUTHENTIC key (v.ok) — an invalid/garbage credential is never stored —
 * but canWithdraw does NOT gate storage: the disclosure and the user's acknowledgement do.
 * The acknowledgement itself is enforced by the API route, not here.
 */
export function decideDisclosedStorage(v: VerifyResult, policy: WithdrawalPolicy): StorageDecision {
  if (policy === 'refuse') return decideStorage(v)
  if (!v.ok) {
    return {
      store: false,
      reason:
        v.error ||
        'Could not verify this credential against the venue. Nothing was stored. Please try again.',
    }
  }
  return {
    store: true,
    reason:
      policy === 'read_only'
        ? 'Verified: a read-only credential for this venue.'
        : 'Verified: the credential is authentic. Its withdrawal capability is disclosed, not blocked.',
  }
}
