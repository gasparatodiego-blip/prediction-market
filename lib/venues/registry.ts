import { VenueAdapter } from './types'
import { binance, MAINNET_ONLY as BINANCE_MAINNET_ONLY } from './binance'
import { bybit, MAINNET_ONLY as BYBIT_MAINNET_ONLY } from './bybit'
import { okx, MAINNET_ONLY as OKX_MAINNET_ONLY } from './okx'
import { bitget, MAINNET_ONLY as BITGET_MAINNET_ONLY } from './bitget'
import { dydx, MAINNET_ONLY as DYDX_MAINNET_ONLY } from './dydx'
import { paradex, MAINNET_ONLY as PARADEX_MAINNET_ONLY } from './paradex'

/**
 * GATE.IO — PERMANENTLY UNSUPPORTED, and its adapter file is deliberately GONE.
 *
 * lib/venues/gateio.ts was DELETED on 2026-07-17. It was dead code on the credential
 * path: a verifyKey() that could only ever return canWithdraw:'unknown' (→ refuse),
 * plus getBalance/getPositions that no stored key could ever reach — because NO Gate.io
 * API endpoint reports whether the calling key can withdraw. A guard we cannot verify is
 * not a guard, it is a claim; carrying signing code for it on the credential path was
 * the worst place to keep it.
 *
 * The registration below is KEPT ON PURPOSE (not silently dropped): the absence of a
 * venue is not self-documenting, its REFUSAL is. POST /api/keys short-circuits on
 * guardVerifiable:false and returns `note` with code VENUE_UNSUPPORTED — the adapter's
 * methods are NEVER reached, which is why the stub below throws instead of implementing
 * anything: a throw makes any future violation of that invariant loud. Do NOT re-add an
 * adapter file. This will not change until Gate.io ships a key-permissions endpoint.
 * Same permanent-refusal reason as Kraken (see the comment at the end of VENUES).
 */
const gateioUnsupported: VenueAdapter = {
  id: 'gateio',
  label: 'Gate.io',
  // No key slot is offered; a permanently-unsupported venue collects no fields.
  requiredFields: () => [],
  verifyKey: () => {
    throw new Error('gateio is permanently unsupported (guardVerifiable:false); verifyKey must never be called')
  },
  getBalance: () => {
    throw new Error('gateio is permanently unsupported (guardVerifiable:false); getBalance must never be called')
  },
  getPositions: () => {
    throw new Error('gateio is permanently unsupported (guardVerifiable:false); getPositions must never be called')
  },
}

/**
 * The venue registry.
 *
 * TWO SEPARATE FLAGS, deliberately not collapsed into one:
 *
 *   guardVerifiable — CAN the withdrawal guard ever be verified at this venue?
 *                     A permanent fact about the venue's API surface.
 *                     false for gate.io: no endpoint returns the calling key's
 *                     permissions, so no amount of work makes this true.
 *
 *   liveVerified    — HAS this adapter been run against the real venue with a real
 *                     key? A fact about our testing, changed by a human after the
 *                     procedure in scripts/verify-venue-live.md.
 *
 * Collapsing these into one boolean would make gate.io indistinguishable from a venue
 * merely awaiting a key — implying a pending state that will never resolve. The UI
 * renders them differently for that reason.
 *
 * EVERY venue is liveVerified:false right now. No live key has ever been run against
 * any of these adapters. Flipping a flag here is a claim that a human ran the
 * procedure and saw it pass — do not flip one because the code "looks right".
 * There is deliberately no UI, no API route, and no env var that can flip it.
 */
export interface VenueRegistration {
  adapter: VenueAdapter
  /** Permanent: can the withdrawal guard ever be verified here? */
  guardVerifiable: boolean
  /** Has a REAL key been run against this adapter by a human? */
  liveVerified: boolean
  /** Can the guard only be exercised on mainnet (no testnet/demo path)? */
  mainnetOnly: boolean
  /** Shown in the UI. Plain, honest, no hedging. */
  note: string
}

export const VENUES: VenueRegistration[] = [
  {
    adapter: binance,
    guardVerifiable: true,
    liveVerified: false,
    mainnetOnly: BINANCE_MAINNET_ONLY,
    note:
      'Withdrawal permission is reported by GET /sapi/v1/account/apiRestrictions ' +
      '(enableWithdrawals). Binance docs state /sapi is unavailable on the Spot Test ' +
      'Network, so this can only be verified with a real mainnet key.',
  },
  {
    adapter: bybit,
    guardVerifiable: true,
    liveVerified: false,
    mainnetOnly: BYBIT_MAINNET_ONLY,
    note:
      'Withdrawal permission is reported by GET /v5/user/query-api ' +
      '(permissions.Wallet contains "Withdraw"). Testnet is available at ' +
      'api-testnet.bybit.com.',
  },
  {
    adapter: okx,
    guardVerifiable: true,
    liveVerified: false,
    mainnetOnly: OKX_MAINNET_ONLY,
    note:
      'Withdrawal permission is reported by GET /api/v5/account/config (perm contains ' +
      '"withdraw"). Demo trading exists, but whether perm is populated in demo is not ' +
      'established by the docs, so the guard is verified on mainnet only.',
  },
  {
    adapter: bitget,
    guardVerifiable: true,
    liveVerified: false,
    mainnetOnly: BITGET_MAINNET_ONLY,
    note:
      'Withdrawal permission is reported by GET /api/v2/spot/account/info: the ' +
      '`authorities` array contains "wwow" (wallet withdrawl) iff the key can ' +
      'withdraw. Verified with a real mainnet key only.',
  },
  {
    adapter: dydx,
    guardVerifiable: true,
    liveVerified: false,
    mainnetOnly: DYDX_MAINNET_ONLY,
    note:
      'Trade-only via a dYdX Chain authenticator (permissioned key). Withdrawal ' +
      'exclusion is verified ON-CHAIN: the authenticator’s MessageFilter must ' +
      'whitelist only clob order messages. Connect the authenticator private key, ' +
      'your dydx1 address, and the authenticator id.',
  },
  {
    adapter: paradex,
    guardVerifiable: true,
    liveVerified: false,
    mainnetOnly: PARADEX_MAINNET_ONLY,
    note:
      'Trade-only via a Paradex Subkey (a registered StarkNet keypair that, per Paradex ' +
      'docs, cannot withdraw or transfer). Trade-only is proven by MEMBERSHIP: the pasted ' +
      'key must be an active subkey on the account. Connect the SUBKEY private key and your ' +
      'main account address — never your wallet key or main account key.',
  },
  {
    // Adapter file deleted; this is the documented refusal, not a live adapter. See the
    // gateioUnsupported comment above. guardVerifiable:false is THE finding, not a TODO.
    adapter: gateioUnsupported,
    guardVerifiable: false,
    liveVerified: false,
    mainnetOnly: true,
    note:
      'Not supported. No Gate.io API endpoint reports whether the calling key can ' +
      'withdraw, so we cannot verify a key is trade-only. We do not store keys we ' +
      'cannot check. This will not change until Gate.io ships such an endpoint.',
  },
  // KRAKEN is deliberately ABSENT — no registry entry, no key slot. Kraken exposes
  // NO API endpoint that returns a key's permissions (permissions are visible only in
  // the web UI), so the withdrawal guard cannot exist. Fail-closed rule: cannot
  // determine → refuse. Same reason as Gate.io; Kraken simply never gets an adapter.
]

export function getVenue(id: string): VenueRegistration | undefined {
  for (let i = 0; i < VENUES.length; i++) {
    if (VENUES[i].adapter.id === id) return VENUES[i]
  }
  return undefined
}

/** A venue can accept keys only if the guard is verifiable AND a human verified it live. */
export function canAcceptKeys(v: VenueRegistration): boolean {
  return v.guardVerifiable && v.liveVerified
}
