import { VenueAdapter, WithdrawalPolicy } from './types'
import { binance, MAINNET_ONLY as BINANCE_MAINNET_ONLY } from './binance'
import { bybit, MAINNET_ONLY as BYBIT_MAINNET_ONLY } from './bybit'
import { okx, MAINNET_ONLY as OKX_MAINNET_ONLY } from './okx'
import { bitget, MAINNET_ONLY as BITGET_MAINNET_ONLY } from './bitget'
import { dydx, MAINNET_ONLY as DYDX_MAINNET_ONLY } from './dydx'
import { paradex, MAINNET_ONLY as PARADEX_MAINNET_ONLY } from './paradex'
import { gateio, MAINNET_ONLY as GATEIO_MAINNET_ONLY } from './gateio'
import { kraken, MAINNET_ONLY as KRAKEN_MAINNET_ONLY } from './kraken'
import { aster, MAINNET_ONLY as ASTER_MAINNET_ONLY } from './aster'
import { lighter, MAINNET_ONLY as LIGHTER_MAINNET_ONLY } from './lighter'
import { extended, MAINNET_ONLY as EXTENDED_MAINNET_ONLY } from './extended'
import { edgex, MAINNET_ONLY as EDGEX_MAINNET_ONLY } from './edgex'
import { apex, MAINNET_ONLY as APEX_MAINNET_ONLY } from './apex'

/**
 * The venue registry.
 *
 * withdrawalPolicy — DECLARED per venue, never inferred at the call site:
 *   'refuse'              store ONLY on an explicit parsed canWithdraw === false. The
 *                         original guard, unchanged. The six live venues.
 *   'accept_and_disclose' the key can move funds, or we cannot check whether it can. Store
 *                         the authentic key anyway, record the TRUTH in permissionsAtVerify
 *                         (what the venue reported, or the explicit UNQUERYABLE marker),
 *                         and require the user to acknowledge the disclosure first.
 *   'read_only'           we deliberately hold ONLY read credentials; the venue's
 *                         fund-moving key is a separate secret we never collect. Store the
 *                         authentic read credential; the user acknowledges it is stored.
 *
 * liveVerified — HAS a real key been run against this adapter by a human? A fact about our
 * testing, changed ONLY by the procedure in scripts/verify-venue-live.md. EVERY venue is
 * liveVerified:false right now, so POST /api/keys 409s for all of them. There is no UI, no
 * route, no env var that flips it.
 *
 * NOTHING here blocks or prevents a withdrawal. A venue enforces its own key permissions;
 * we choose which endpoints to call (never a withdraw/transfer/send one) and we disclose
 * what a stored credential can do. The mitigations that DO block — the user's venue-side
 * withdrawal-address and IP whitelists — are the user's to set; we link the venue's own
 * how-to and, where the venue lets us read it (Gate.io only), we report the state.
 */
export interface VenueDisclosure {
  /** The headline the card renders. */
  state: 'withdrawal_unknown' | 'withdrawal_capable' | 'read_only'
  /** Plain-language disclosure. Never implies WE block withdrawals. */
  body: string
  /** The acknowledgement checkbox text. Required before storing a non-refuse credential. */
  ack: string
  /** Venue's own how-to for setting a withdrawal-address whitelist (the real mitigation). */
  addressWhitelistUrl?: string
  /** Venue's own how-to for restricting the key to our server IP 167.233.63.218. */
  ipWhitelistUrl?: string
  /** True ONLY where the venue lets a read MEASURE the whitelist state (Gate.io). Else the
   * card says "cannot verify" — never "enabled" for a state we did not read. */
  whitelistReadable: boolean
}

export interface VenueRegistration {
  adapter: VenueAdapter
  withdrawalPolicy: WithdrawalPolicy
  /** Has a REAL key been run against this adapter by a human? */
  liveVerified: boolean
  /** Can the guard/verify only be exercised on mainnet (no testnet/demo path)? */
  mainnetOnly: boolean
  /** Shown in the UI. Plain, honest, no hedging. */
  note: string
  /** Disclosure shown BEFORE the user pastes. Present for non-refuse policies only. */
  disclosure?: VenueDisclosure
}

const ACK_UNKNOWN = (v: string) =>
  `I understand this key may be able to withdraw funds, that Edgeradar cannot prevent that, and that securing it with ${v}'s withdrawal-address and IP whitelists is my responsibility.`

export const VENUES: VenueRegistration[] = [
  // ── refuse (unchanged, do not touch) ──────────────────────────────────────────────
  {
    adapter: binance,
    withdrawalPolicy: 'refuse',
    liveVerified: false,
    mainnetOnly: BINANCE_MAINNET_ONLY,
    note:
      'Withdrawal permission is reported by GET /sapi/v1/account/apiRestrictions ' +
      '(enableWithdrawals). Binance docs state /sapi is unavailable on the Spot Test ' +
      'Network, so this can only be verified with a real mainnet key.',
  },
  {
    adapter: bybit,
    withdrawalPolicy: 'refuse',
    liveVerified: false,
    mainnetOnly: BYBIT_MAINNET_ONLY,
    note:
      'Withdrawal permission is reported by GET /v5/user/query-api ' +
      '(permissions.Wallet contains "Withdraw"). Testnet is available at ' +
      'api-testnet.bybit.com.',
  },
  {
    adapter: okx,
    withdrawalPolicy: 'refuse',
    liveVerified: false,
    mainnetOnly: OKX_MAINNET_ONLY,
    note:
      'Withdrawal permission is reported by GET /api/v5/account/config (perm contains ' +
      '"withdraw"). Demo trading exists, but whether perm is populated in demo is not ' +
      'established by the docs, so the guard is verified on mainnet only.',
  },
  {
    adapter: bitget,
    withdrawalPolicy: 'refuse',
    liveVerified: false,
    mainnetOnly: BITGET_MAINNET_ONLY,
    note:
      'Withdrawal permission is reported by GET /api/v2/spot/account/info: the ' +
      '`authorities` array contains "wwow" (wallet withdrawl) iff the key can ' +
      'withdraw. Verified with a real mainnet key only.',
  },
  {
    adapter: dydx,
    withdrawalPolicy: 'refuse',
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
    withdrawalPolicy: 'refuse',
    liveVerified: false,
    mainnetOnly: PARADEX_MAINNET_ONLY,
    note:
      'Trade-only via a Paradex Subkey (a registered StarkNet keypair that, per Paradex ' +
      'docs, cannot withdraw or transfer). Trade-only is proven by MEMBERSHIP: the pasted ' +
      'key must be an active subkey on the account. Connect the SUBKEY private key and your ' +
      'main account address — never your wallet key or main account key.',
  },

  // ── accept_and_disclose (withdrawal-capable, or permission unqueryable) ─────────────
  {
    adapter: gateio,
    withdrawalPolicy: 'accept_and_disclose',
    liveVerified: false,
    mainnetOnly: GATEIO_MAINNET_ONLY,
    note:
      'Accept-and-disclose. Gate.io exposes NO endpoint reporting a key’s withdrawal ' +
      'permission, so permissionsAtVerify records it as UNQUERYABLE (never "no withdrawal"). ' +
      'GET /account/detail DOES expose the key’s ip_whitelist, so the card reports whether ' +
      'the key is IP-restricted to our server. Set an address + IP whitelist at Gate.io.',
    disclosure: {
      state: 'withdrawal_unknown',
      body:
        'We cannot check whether this Gate.io key can withdraw — Gate.io exposes no way to ' +
        'read a key’s permissions, so assume it CAN move funds. Edgeradar does not and cannot ' +
        'prevent a withdrawal; only Gate.io enforces key permissions. The real protection is ' +
        'yours to set at Gate.io: whitelist your own withdrawal addresses, and restrict the key ' +
        'to our server IP 167.233.63.218. Where Gate.io lets us read the IP whitelist, the card ' +
        'shows whether our server is in it.',
      ack: ACK_UNKNOWN('Gate.io'),
      addressWhitelistUrl: 'https://www.gate.io/help/guide/deposit_withdrawa/22597/how-to-whitelist-withdrawal-addresses-on-web',
      ipWhitelistUrl: 'https://www.gate.com/help/guide/faq/17521',
      whitelistReadable: true,
    },
  },
  {
    adapter: kraken,
    withdrawalPolicy: 'accept_and_disclose',
    liveVerified: false,
    mainnetOnly: KRAKEN_MAINNET_ONLY,
    note:
      'Accept-and-disclose. Kraken exposes NO REST endpoint reporting a key’s permissions, ' +
      'so permissionsAtVerify records it as UNQUERYABLE. Kraken supports withdrawal-address ' +
      'and IP whitelists, but neither is safely API-readable — the card says "cannot verify". ' +
      'Set both at Kraken.',
    disclosure: {
      state: 'withdrawal_unknown',
      body:
        'We cannot check whether this Kraken key can withdraw — Kraken exposes no way to read a ' +
        'key’s permissions, so assume it CAN move funds. Edgeradar does not and cannot prevent a ' +
        'withdrawal; only Kraken enforces key permissions. The real protection is yours to set at ' +
        'Kraken: whitelist your withdrawal addresses and lock the account so no new address can be ' +
        'added, and restrict the key to our server IP 167.233.63.218. We cannot read either ' +
        'setting back, so the card cannot confirm they are enabled — verify them at Kraken.',
      ack: ACK_UNKNOWN('Kraken'),
      addressWhitelistUrl: 'https://support.kraken.com/articles/360000672863-adding-and-confirming-a-new-cryptocurrency-withdrawal-address',
      ipWhitelistUrl: 'https://support.kraken.com/articles/how-to-create-an-api-key-on-kraken-pro',
      whitelistReadable: false,
    },
  },
  {
    adapter: lighter,
    withdrawalPolicy: 'accept_and_disclose',
    liveVerified: false,
    mainnetOnly: LIGHTER_MAINNET_ONLY,
    note:
      'Accept-and-disclose. A Lighter API-signer key CAN withdraw, but ONLY to your own ' +
      'account’s original L1 address (protocol lock); sending elsewhere needs your wallet key, ' +
      'which we never hold. permissionsAtVerify records withdraw:owner-address-locked. Key-match ' +
      'is D1-deferred (Lighter Schnorr derivation not in node crypto).',
    disclosure: {
      state: 'withdrawal_capable',
      body:
        'This Lighter key CAN withdraw — but by protocol it can only send funds to your own ' +
        'account’s original L1 address; moving funds to any other address needs your separate ' +
        'wallet key, which we never ask for or hold. Edgeradar does not prevent withdrawals; the ' +
        'address lock is enforced by Lighter, not by us. So a leaked key can only push your funds ' +
        'back to you.',
      ack:
        'I understand this Lighter key can withdraw to my own account’s L1 address, that Edgeradar ' +
        'cannot control that, and that sending anywhere else would need my wallet key which I am not providing.',
      whitelistReadable: false,
    },
  },
  {
    adapter: aster,
    withdrawalPolicy: 'accept_and_disclose',
    liveVerified: false,
    mainnetOnly: ASTER_MAINNET_ONLY,
    note:
      'Accept-and-disclose. Aster reports ACCOUNT-level canWithdraw via GET /fapi/v4/account ' +
      '(recorded as account-canWithdraw:true|false — not the key’s own scope, which is not ' +
      'queryable). The API key ALONE cannot withdraw off-account: Aster requires a separate ' +
      'EIP-712 wallet signature for withdrawals, which we never hold. IP whitelist is settable ' +
      'at key creation but not API-readable.',
    disclosure: {
      state: 'withdrawal_capable',
      body:
        'Aster reports your ACCOUNT’s withdrawal setting (shown on the card once connected). The ' +
        'API key alone cannot withdraw off the account — Aster requires a separate signature from ' +
        'your wallet for any withdrawal, which we never ask for or hold. Edgeradar does not prevent ' +
        'withdrawals; that wallet-signature requirement is Aster’s. Restrict the key to our server ' +
        'IP 167.233.63.218 at key creation; we cannot read that setting back, so the card cannot confirm it.',
      ack:
        'I understand Aster shows my account’s withdrawal setting, that this key alone cannot withdraw ' +
        'without my wallet signature, and that Edgeradar cannot control withdrawals.',
      ipWhitelistUrl: 'https://github.com/asterdex/api-docs/blob/master/V3(Recommended)/EN/aster-finance-futures-api-v3.md',
      whitelistReadable: false,
    },
  },

  // ── read_only (disclosed as read-only; the fund-moving key is never collected) ──────
  {
    adapter: extended,
    withdrawalPolicy: 'read_only',
    liveVerified: false,
    mainnetOnly: EXTENDED_MAINNET_ONLY,
    note:
      'Read-only. We store ONLY Extended’s API key, which the venue documents as read-only ' +
      '("The API key alone cannot be used to create orders, transfer funds, or withdraw assets"). ' +
      'The fund-moving Stark L2 key is a separate secret we never ask for. canWithdraw:false, cited.',
    disclosure: {
      state: 'read_only',
      body:
        'This is a READ-ONLY credential. Extended’s API key can see your balances and positions but ' +
        'cannot place orders, transfer, or withdraw — moving funds needs a separate Stark signing key ' +
        'that we never ask for and never store. Nothing we hold for Extended can move your funds.',
      ack: 'I understand Edgeradar stores a read-only credential for Extended that cannot move funds.',
      whitelistReadable: false,
    },
  },
  {
    adapter: edgex,
    withdrawalPolicy: 'read_only',
    liveVerified: false,
    mainnetOnly: EDGEX_MAINNET_ONLY,
    note:
      'Read-only. We store ONLY edgeX’s HMAC credentials (apiKey/secret/passphrase). Orders and ' +
      'transfers need a separate L2 Signer key, and withdrawals need the wallet key — neither of ' +
      'which we ask for or hold. canWithdraw:false by construction.',
    disclosure: {
      state: 'read_only',
      body:
        'This is a READ-ONLY credential. edgeX’s API key/secret/passphrase can read your account but ' +
        'cannot place orders, transfer, or withdraw — those need a separate L2 Signer key (and the ' +
        'wallet key for withdrawals) that we never ask for and never store. Nothing we hold for edgeX ' +
        'can move your funds.',
      ack: 'I understand Edgeradar stores a read-only credential for edgeX that cannot move funds.',
      whitelistReadable: false,
    },
  },
  {
    adapter: apex,
    withdrawalPolicy: 'read_only',
    liveVerified: false,
    mainnetOnly: APEX_MAINNET_ONLY,
    note:
      'Read-only. We store ONLY ApeX’s apiKey triple (key/secret/passphrase). Value-moving actions ' +
      'need a second signature from the zk seeds/l2Key ("For orders, transfers, and withdrawals, two ' +
      'signatures are required"), which we never ask for or hold. canWithdraw:false by construction.',
    disclosure: {
      state: 'read_only',
      body:
        'This is a READ-ONLY credential. ApeX’s apiKey/secret/passphrase can read your account but ' +
        'cannot place orders, transfer, or withdraw — those need a second zk signing key that we never ' +
        'ask for and never store. Nothing we hold for ApeX can move your funds.',
      ack: 'I understand Edgeradar stores a read-only credential for ApeX Omni that cannot move funds.',
      whitelistReadable: false,
    },
  },
]

export function getVenue(id: string): VenueRegistration | undefined {
  for (let i = 0; i < VENUES.length; i++) {
    if (VENUES[i].adapter.id === id) return VENUES[i]
  }
  return undefined
}

/**
 * A venue can accept keys only once a human has live-verified the adapter. The policy
 * decides HOW canWithdraw is handled (refuse / disclose / read-only), never WHETHER we
 * accept — every venue is liveVerified:false today, so this is false for all of them.
 */
export function canAcceptKeys(v: VenueRegistration): boolean {
  return v.liveVerified
}
