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
// @scure/starknet: small, audited, from the @noble authors, built on @noble/curves
// (already in this tree). Added ONLY for Paradex's StarkNet-curve signing — hand-rolling
// the Stark curve + Poseidon/Pedersen on a credential path would be the worse choice.
// ESM-only package: must be `import` (Next/webpack rejects require() for it). tsc emits a
// CommonJS __importStar(require(...)) for the compiled fail-closed test, which node loads.
import * as starknet from '@scure/starknet'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { rlGet, rlPost } = require('../rateLimitedFetch')

/**
 * PARADEX (StarkNet L2 perp DEX) — the ONE of seven perp DEXs whose delegated
 * credential is genuinely trade-only, and the first non-HMAC venue in the fleet.
 *
 * THE CREDENTIAL: a "Subkey" — a randomly-generated StarkNet keypair the user registers
 * to their account. The user pastes the subkey's PRIVATE KEY (secret) plus their MAIN
 * account address (non-secret, plaintext). NOT their wallet key; NOT the main account key.
 *
 * WHY canWithdraw can be a real `false` here (the guarantee, quoted verbatim):
 *   docs.paradex.trade/api/general-information/api-authentication —
 *   "Subkeys are private keys for an account with scoped down permissions. Unlike your
 *    main private key, Subkeys do not have permissions to perform Withdrawals, Transfers,
 *    and manage sensitive account settings."
 *   and the "Subkeys Cannot" list: "Withdraw funds from the account",
 *   "Transfer funds to other accounts", "Modify account settings", "Manage Subkeys".
 *
 * The guarantee is STRUCTURAL, not a queryable per-key permission field: Paradex exposes
 * NO endpoint that reports a presented credential's scope. So the guard is MEMBERSHIP:
 * a pasted key is trade-only IFF it is an ACTIVE registered subkey. We therefore
 *   1. derive the subkey's Stark public key from the pasted private key (local),
 *   2. authenticate to Paradex with it (POST /auth, StarkNet-signed → short-lived JWT),
 *   3. GET /account/keys/subkeys and require our pubkey to be present with state active.
 * A master key, a foreign key, or a revoked one is NOT in the active-subkey list → REFUSE.
 * Any error, absence, or unparseable response → 'unknown' → REFUSE. Fail closed, always.
 *
 * SIGNING IS UNVERIFIED UNTIL D1. The StarkNet SNIP-12 auth message below is implemented
 * from the Paradex SDK shape; Paradex does not publish the exact typed-data verbatim, and
 * we have no live subkey to test it against this run. This is SAFE by construction: if the
 * signing is wrong, /auth fails → verifyKey returns 'unknown' → the key is REFUSED. A wrong
 * signature can only cause a false REFUSAL, never a false STORE. liveVerified stays false
 * (POST /api/keys 409s for paradex) until a human runs scripts/verify-venue-live.md and a
 * real subkey is accepted end to end. Only parseSubkeyMembership() below is proven now.
 */

// Reuse the public base already proven by agent10-binance.js:698 and
// agent15-funding-writer.js:488. Do not duplicate a new base URL.
const BASE = 'https://api.prod.paradex.trade/v1'
const TIMEOUT_MS = 12_000

/** Paradex is a live L2; there is no separate testnet path for this guard. */
export const MAINNET_ONLY = true

/** Auth signature validity window (seconds). Short-lived; the JWT it yields is too. */
const SIG_EXPIRY_S = 300

// @scure/starknet's exported types are polymorphic (TRet<PedersenArg>). Pin the exact
// runtime shapes we depend on, verified empirically: computeHashOnElements + getStarkKey
// return 0x-hex STRINGS; keccak returns a bigint; sign returns {r,s} bigints.
type PedersenArg = string | bigint | number
interface StarkFns {
  getStarkKey: (priv: string) => string
  sign: (msgHash: string, priv: string) => { r: bigint; s: bigint }
  keccak: (data: Uint8Array) => bigint
  computeHashOnElements: (data: PedersenArg[]) => string
}
const sn = starknet as unknown as StarkFns

// ── StarkNet SNIP-12 helpers (rev-0 StarkNetDomain, Pedersen via computeHashOnElements) ──

/** Short-string → felt (BigInt of the ASCII bytes, big-endian). Max 31 chars. */
function encodeShortString(str: string): bigint {
  if (str.length > 31) throw new Error('short string too long')
  let hex = ''
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c > 0xff) throw new Error('non-ascii in short string')
    hex += c.toString(16).padStart(2, '0')
  }
  return hex ? BigInt('0x' + hex) : BigInt(0)
}

/** felt from a 0x-hex or decimal string (BigInt handles both). Throws on garbage. */
function toFelt(v: string): bigint {
  return BigInt(v.trim())
}

/** starknet_keccak type hash (bigint) of a SNIP-12 encodeType string. */
function typeHash(encodeType: string): bigint {
  return sn.keccak(new TextEncoder().encode(encodeType))
}

/** SNIP-12 struct hash. Returns a 0x-hex string (computeHashOnElements' shape). */
function structHash(encodeType: string, values: PedersenArg[]): string {
  return sn.computeHashOnElements([typeHash(encodeType), ...values])
}

/**
 * SNIP-12 (rev 0) message hash (0x-hex) for the Paradex /auth request, signed by the
 * subkey. Shape from the Paradex SDK; UNVERIFIED against the live venue until D1.
 */
function authMessageHash(accountAddress: string, chainId: string, ts: number, exp: number): string {
  const domainHash = structHash('StarkNetDomain(name:felt,chainId:felt,version:felt)', [
    encodeShortString('Paradex'),
    encodeShortString(chainId),
    encodeShortString('1'),
  ])
  const requestHash = structHash(
    'Request(method:felt,path:felt,body:felt,timestamp:felt,expiration:felt)',
    [
      encodeShortString('POST'),
      encodeShortString('/v1/auth'),
      encodeShortString(''),
      BigInt(ts),
      BigInt(exp),
    ],
  )
  return sn.computeHashOnElements([
    encodeShortString('StarkNet Message'),
    domainHash,
    toFelt(accountAddress),
    requestHash,
  ])
}

/** Sign the auth hash with the subkey private key. Returns the ["r","s"] header value. */
function signAuth(accountAddress: string, privKeyHex: string, chainId: string, ts: number, exp: number): string {
  const hashHex = authMessageHash(accountAddress, chainId, ts, exp).replace(/^0x/, '')
  const sig = sn.sign(hashHex, privKeyHex.replace(/^0x/, ''))
  // r, s are bigint. Paradex wants a JSON array of decimal strings.
  return JSON.stringify([sig.r.toString(), sig.s.toString()])
}

// One chain-id fetch per process, cached. Public endpoint, no auth.
let chainIdCache: string | null = null
async function getChainId(): Promise<string> {
  if (chainIdCache) return chainIdCache
  const r = await rlGet(`${BASE}/system/config`, { timeoutMs: TIMEOUT_MS })
  const id = r && r.data && r.data.starknet_chain_id
  if (typeof id !== 'string' || !id) throw new Error('paradex system config missing chain id')
  chainIdCache = id
  return id
}

/**
 * Authenticate and return a short-lived JWT. The JWT is a DERIVED SECRET: it is returned
 * to the caller to use IN MEMORY for the immediately-following request and is never
 * persisted, logged, or stored. The signature is computed INSIDE the sign hook so its
 * timestamp is generated at FIRE time (not queue time) — a stale ts is rejected by Paradex.
 */
async function authenticate(accountAddress: string, privKeyHex: string, pubkeyHex: string, chainId: string): Promise<string | null> {
  const r = await rlPost(`${BASE}/auth/${pubkeyHex}`, null, {
    timeoutMs: TIMEOUT_MS,
    sign: (req: { timestamp: number }) => {
      const ts = Math.floor(req.timestamp / 1000)
      const exp = ts + SIG_EXPIRY_S
      return {
        headers: {
          'PARADEX-STARKNET-ACCOUNT': accountAddress,
          'PARADEX-STARKNET-SIGNATURE': signAuth(accountAddress, privKeyHex, chainId, ts, exp),
          'PARADEX-TIMESTAMP': String(ts),
          'PARADEX-SIGNATURE-EXPIRATION': String(exp),
        },
      }
    },
  })
  const jwt = r && r.data && r.data.jwt_token
  return typeof jwt === 'string' && jwt ? jwt : null
}

/** Normalise a felt-ish value (0x-hex or decimal string, or number) to a BigInt, or null. */
function feltOrNull(v: unknown): bigint | null {
  try {
    if (typeof v === 'bigint') return v
    if (typeof v === 'number' && Number.isFinite(v)) return BigInt(v)
    if (typeof v === 'string' && v.trim() !== '') return BigInt(v.trim())
    return null
  } catch {
    return null
  }
}

/**
 * THE GUARD — pure, exported so the fail-closed rule is testable without a live key.
 *
 * canWithdraw:false is returned ONLY when our pubkey is an ACTIVE, non-revoked member of
 * the account's subkey list — because a subkey provably "Cannot Withdraw funds from the
 * account" (quoted above). Anything else — not the documented shape, our pubkey absent
 * (a master/foreign key), or present-but-inactive/revoked — is 'unknown' → REFUSE.
 */
export function parseSubkeyMembership(body: unknown, ourPubkeyHex: string): VerifyResult {
  const refuse = (error: string): VerifyResult => ({
    ok: false,
    permissions: [],
    canWithdraw: 'unknown',
    canTrade: 'unknown',
    error,
  })

  const ours = feltOrNull(ourPubkeyHex)
  if (ours === null) {
    return refuse('Could not read this Paradex key, so it was refused. Nothing was stored.')
  }

  // Accept either a bare array or the documented { results: [...] } envelope. Anything
  // else (an error object, null, a string) is not the documented shape → refuse.
  let list: unknown[]
  if (Array.isArray(body)) list = body
  else if (body !== null && typeof body === 'object' && Array.isArray((body as Record<string, unknown>).results)) {
    list = (body as Record<string, unknown>).results as unknown[]
  } else {
    return refuse('Paradex did not return the subkey list, so this key was refused. Nothing was stored.')
  }

  const entry = list.find((e) => {
    if (e === null || typeof e !== 'object') return false
    const pk = feltOrNull((e as Record<string, unknown>).public_key)
    return pk !== null && pk === ours
  }) as Record<string, unknown> | undefined

  if (!entry) {
    // Not a registered subkey — could be the MAIN account key (which CAN withdraw) or a
    // foreign key. We only ever store a proven-restricted subkey. Refuse.
    return refuse(
      'This Paradex key is not an active subkey on that account, so it was refused. Connect a Subkey (which cannot withdraw), not your main account key. Nothing was stored.',
    )
  }

  const state = String(entry.state ?? '').toLowerCase()
  const revoked = entry.revoked_at != null && entry.revoked_at !== 0 && entry.revoked_at !== ''
  if (state !== 'active' || revoked) {
    return refuse('This Paradex subkey is not active (revoked or pending), so it was refused. Nothing was stored.')
  }

  return {
    ok: true,
    // Subkeys "Cannot Withdraw funds from the account" / "Transfer funds to other accounts"
    // (docs.paradex.trade/api/general-information/api-authentication). THAT doc line — not a
    // queryable field — is what justifies canWithdraw:false on the next line.
    permissions: ['trade (subkey — cannot withdraw or transfer)'],
    canWithdraw: false,
    canTrade: true,
  }
}

function refuseCreds(error: string): VerifyResult {
  return { ok: false, permissions: [], canWithdraw: 'unknown', canTrade: 'unknown', error }
}

/** Authenticate then GET a private endpoint with the in-memory JWT. Never stores the JWT. */
async function privateGet(path: string, creds: VenueCreds): Promise<unknown> {
  const priv = String(creds.secret).replace(/^0x/, '')
  const pubkey = '0x' + BigInt(sn.getStarkKey('0x' + priv)).toString(16)
  const chainId = await getChainId()
  const jwt = await authenticate(String(creds.accountAddress), priv, pubkey, chainId)
  if (!jwt) throw new Error('paradex auth failed')
  const r = await rlGet(`${BASE}${path}`, {
    timeoutMs: TIMEOUT_MS,
    headers: { Authorization: `Bearer ${jwt}` },
  })
  return r && r.data
}

export const paradex: VenueAdapter = {
  id: 'paradex',
  label: 'Paradex',

  /** No api key, no passphrase — just the subkey private key (a secret). */
  requiredFields(): CredField[] {
    return ['secret']
  },
  /** The MAIN account address is a public identifier, stored plaintext like dYdX's. */
  requiredPlainFields(): PlainField[] {
    return ['accountAddress']
  },

  async verifyKey(creds: VenueCreds): Promise<VerifyResult> {
    if (!creds.accountAddress || !/^0x[0-9a-fA-F]{1,64}$/.test(String(creds.accountAddress))) {
      return refuseCreds('A valid Paradex account address (0x…) is required. Nothing was stored.')
    }

    // Derive the subkey's Stark public key locally. Bad key material → refuse (never throw).
    let pubkey: string
    try {
      const priv = String(creds.secret).replace(/^0x/, '')
      pubkey = '0x' + BigInt(sn.getStarkKey('0x' + priv)).toString(16)
    } catch {
      return refuseCreds('That does not look like a valid Paradex subkey private key. Nothing was stored.')
    }

    try {
      const chainId = await getChainId()
      const priv = String(creds.secret).replace(/^0x/, '')
      const jwt = await authenticate(String(creds.accountAddress), priv, pubkey, chainId)
      if (!jwt) {
        return refuseCreds('Could not authenticate this Paradex key against the venue. Nothing was stored. Please try again.')
      }
      const list = await rlGet(`${BASE}/account/keys/subkeys`, {
        timeoutMs: TIMEOUT_MS,
        headers: { Authorization: `Bearer ${jwt}` },
      })
      return parseSubkeyMembership(list && list.data, pubkey)
    } catch (e) {
      return refuseCreds(toSafeError(e))
    }
  },

  async getBalance(creds: VenueCreds) {
    try {
      const data = (await privateGet('/balance', creds)) as Record<string, unknown> | null
      const rows = data && Array.isArray(data.results) ? (data.results as Record<string, unknown>[]) : []
      const balances: Balance[] = rows
        .map((x) => ({
          asset: String(x.token ?? ''),
          free: Number(x.size ?? 0),
          total: Number(x.size ?? 0),
        }))
        .filter((b) => b.asset && b.total !== 0)
      return { balances }
    } catch (e) {
      return { balances: [], error: toSafeError(e) }
    }
  },

  async getPositions(creds: VenueCreds) {
    try {
      const data = (await privateGet('/positions', creds)) as Record<string, unknown> | null
      const rows = data && Array.isArray(data.results) ? (data.results as Record<string, unknown>[]) : []
      const positions: Position[] = rows
        .filter((x) => String(x.status ?? 'OPEN').toUpperCase() !== 'CLOSED')
        .map((x) => ({
          symbol: String(x.market ?? ''),
          side: String(x.side ?? ''),
          size: Math.abs(Number(x.size ?? 0)),
          entryPrice: x.average_entry_price != null ? Number(x.average_entry_price) : null,
          unrealizedPnl: x.unrealized_pnl != null ? Number(x.unrealized_pnl) : null,
        }))
        .filter((p) => p.size > 0)
      return { positions }
    } catch (e) {
      return { positions: [], error: toSafeError(e) }
    }
  },
}
