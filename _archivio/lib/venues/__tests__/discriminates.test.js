/* eslint-disable no-console */
'use strict'

/**
 * THE POSITIVE CONTROL — proves the fail-closed test is not vacuous.
 *
 * An adapter whose parseVerify() always returned 'unknown' would pass all fail-closed
 * assertions while being completely useless. (Gate.io was exactly that — always
 * 'unknown', because no endpoint exposes the permission — which is why its adapter was
 * deleted and it is now refused structurally at the registry, asserted at the end of
 * this file.) So for the venues with a real permission endpoint we must prove the
 * parser DISCRIMINATES:
 *
 *   trade-only body        -> canWithdraw === false -> STORE
 *   withdraw-enabled body  -> canWithdraw === true  -> REFUSE
 *
 * The bodies below are the venues' real documented response shapes, with only the
 * permission field varied. This is the synthetic stand-in for D2 (a real
 * withdrawal-enabled key refused). It proves the DECISION, not the live path —
 * D1/D2 remain DEFERRED and are not claimed by this test.
 */

const path = require('path')
const DIST = process.env.VENUES_DIST || path.join(__dirname, '..')

const { decideStorage, decideDisclosedStorage, PERMISSION_UNQUERYABLE } = require(path.join(DIST, 'types.js'))
const binance = require(path.join(DIST, 'binance.js'))
const bybit = require(path.join(DIST, 'bybit.js'))
const okx = require(path.join(DIST, 'okx.js'))
const bitget = require(path.join(DIST, 'bitget.js'))
const dydx = require(path.join(DIST, 'dydx.js'))
const paradex = require(path.join(DIST, 'paradex.js'))
const gateio = require(path.join(DIST, 'gateio.js'))
const kraken = require(path.join(DIST, 'kraken.js'))
const { getVenue } = require(path.join(DIST, 'registry.js'))
const { createECDH } = require('crypto')

const CASES = [
  {
    id: 'binance',
    parse: binance.parseVerify,
    tradeOnly: {
      ipRestrict: true,
      createTime: 1623840271000,
      enableReading: true,
      enableWithdrawals: false, // <-- trade-only
      enableInternalTransfer: false,
      enableMargin: false,
      enableFutures: true,
      permitsUniversalTransfer: false,
      enableVanillaOptions: false,
      enableSpotAndMarginTrading: true,
      enablePortfolioMarginTrading: false,
    },
    withdrawEnabled: {
      ipRestrict: false,
      createTime: 1623840271000,
      enableReading: true,
      enableWithdrawals: true, // <-- DANGEROUS
      enableInternalTransfer: true,
      enableMargin: false,
      enableFutures: true,
      permitsUniversalTransfer: true,
      enableVanillaOptions: false,
      enableSpotAndMarginTrading: true,
      enablePortfolioMarginTrading: false,
    },
  },
  {
    id: 'bybit',
    parse: bybit.parseVerify,
    tradeOnly: {
      retCode: 0,
      retMsg: 'OK',
      result: {
        readOnly: 0,
        permissions: {
          ContractTrade: ['Order', 'Position'],
          Spot: ['SpotTrade'],
          Wallet: ['AccountTransfer'], // <-- no "Withdraw"
        },
        ips: ['1.2.3.4'],
      },
    },
    withdrawEnabled: {
      retCode: 0,
      retMsg: 'OK',
      result: {
        readOnly: 0,
        permissions: {
          ContractTrade: ['Order', 'Position'],
          Spot: ['SpotTrade'],
          Wallet: ['AccountTransfer', 'Withdraw'], // <-- DANGEROUS
        },
        ips: [],
      },
    },
  },
  {
    id: 'okx',
    parse: okx.parseVerify,
    tradeOnly: {
      code: '0',
      msg: '',
      data: [{ acctLv: '2', uid: '447058', label: 'edgeradar', ip: '', perm: 'read_only,trade' }],
    },
    withdrawEnabled: {
      code: '0',
      msg: '',
      data: [
        { acctLv: '2', uid: '447058', label: 'edgeradar', ip: '', perm: 'read_only,withdraw,trade' },
      ],
    },
  },
  {
    id: 'bitget',
    parse: bitget.parseVerify,
    // stow/stor spot trade, coow/cpow futures, wtow = internal TRANSFER (not withdraw).
    tradeOnly: {
      code: '00000',
      msg: 'success',
      data: { userId: '1', authorities: ['stor', 'stow', 'coow', 'cpow', 'wtow'] },
    },
    // wwow = wallet withdrawl → the one code that means the key can withdraw.
    withdrawEnabled: {
      code: '00000',
      msg: 'success',
      data: { userId: '1', authorities: ['stor', 'stow', 'wwow'] },
    },
  },
]

let pass = 0
let fail = 0
const refusals = []

function check(label, cond, detail) {
  if (cond) pass++
  else fail++
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label.padEnd(62)} ${detail}`)
}

console.log('\n=== POSITIVE CONTROL: the parsers actually DISCRIMINATE ===')
console.log('    (without this, an always-"unknown" parser would pass all 20 fail-closed tests)\n')

for (const c of CASES) {
  const a = c.parse(c.tradeOnly)
  const da = decideStorage(a)
  check(
    `${c.id}: trade-only body -> canWithdraw===false -> STORE`,
    a.canWithdraw === false && da.store === true,
    `canWithdraw=${JSON.stringify(a.canWithdraw)} store=${da.store} perms=[${a.permissions.join(',')}]`,
  )

  const b = c.parse(c.withdrawEnabled)
  const db = decideStorage(b)
  check(
    `${c.id}: withdraw-ENABLED body -> canWithdraw===true -> REFUSE`,
    b.canWithdraw === true && db.store === false,
    `canWithdraw=${JSON.stringify(b.canWithdraw)} store=${db.store} perms=[${b.permissions.join(',')}]`,
  )
  refusals.push({ venue: c.id, message: db.reason })
}

// ── Withdrawal POLICY split — declared per venue, never inferred. The six existing
//    venues MUST stay 'refuse' (the policy change must not leak into them). ──────────────
const REFUSE = ['binance', 'bybit', 'okx', 'bitget', 'dydx', 'paradex']
const DISCLOSE = ['gateio', 'kraken', 'lighter', 'aster']
const READONLY = ['extended', 'edgex', 'apex']
for (const id of REFUSE) {
  const v = getVenue(id)
  check(`${id}: policy is 'refuse' (unchanged)`, !!v && v.withdrawalPolicy === 'refuse', `policy=${v && v.withdrawalPolicy}`)
}
for (const id of DISCLOSE) {
  const v = getVenue(id)
  check(`${id}: policy is 'accept_and_disclose' + has disclosure`, !!v && v.withdrawalPolicy === 'accept_and_disclose' && !!v.disclosure, `policy=${v && v.withdrawalPolicy}`)
}
for (const id of READONLY) {
  const v = getVenue(id)
  check(`${id}: policy is 'read_only' + has disclosure`, !!v && v.withdrawalPolicy === 'read_only' && !!v.disclosure, `policy=${v && v.withdrawalPolicy}`)
}

// ── CHECK 4 — permissionsAtVerify NEVER fabricates a 'false'. Gate.io and Kraken, on an
//    AUTHENTIC key, must record the explicit UNQUERYABLE marker (not "no withdrawal"). ────
const gateAuthentic = gateio.parseAccountDetail({ user_id: 1667201533, tier: 2, key: { mode: 1 }, ip_whitelist: ['167.233.63.218'] })
check(
  'gateio: authentic key → permissionsAtVerify carries UNQUERYABLE, never false',
  gateAuthentic.ok === true && gateAuthentic.permissions.includes(PERMISSION_UNQUERYABLE) && gateAuthentic.canWithdraw === 'unknown' && !gateAuthentic.permissions.includes('false'),
  `perms=[${gateAuthentic.permissions.join(',')}] canWithdraw=${JSON.stringify(gateAuthentic.canWithdraw)}`,
)
const krakenAuthentic = kraken.parsePrivate({ error: [], result: { ZUSD: '100.0' } })
check(
  'kraken: authentic key → permissionsAtVerify carries UNQUERYABLE, never false',
  krakenAuthentic.ok === true && krakenAuthentic.permissions.includes(PERMISSION_UNQUERYABLE) && krakenAuthentic.canWithdraw === 'unknown' && !krakenAuthentic.permissions.includes('false'),
  `perms=[${krakenAuthentic.permissions.join(',')}] canWithdraw=${JSON.stringify(krakenAuthentic.canWithdraw)}`,
)

// ── The POLICY actually differs: an authentic 'unknown' key is REFUSED under 'refuse' but
//    STORED under 'accept_and_disclose'. Same verdict, opposite storage decision. ─────────
check(
  "gateio: 'unknown' authentic key → 'refuse' would REFUSE, 'accept_and_disclose' STORES",
  decideStorage(gateAuthentic).store === false && decideDisclosedStorage(gateAuthentic, 'accept_and_disclose').store === true,
  `refuse=${decideStorage(gateAuthentic).store} disclose=${decideDisclosedStorage(gateAuthentic, 'accept_and_disclose').store}`,
)
// And a garbage/unverified key is NEVER stored, even under the disclosed policies.
const gateBad = gateio.parseAccountDetail({ label: 'INVALID_KEY' })
check(
  'gateio: unverified key → NOT stored even under accept_and_disclose',
  decideDisclosedStorage(gateBad, 'accept_and_disclose').store === false,
  `store=${decideDisclosedStorage(gateBad, 'accept_and_disclose').store}`,
)
// Gate.io measured ip_whitelist: our server present vs absent must be distinguished.
const gateNoServer = gateio.parseAccountDetail({ user_id: 1, ip_whitelist: ['1.2.3.4'] })
check(
  'gateio: ip_whitelist measured — includes-server vs excludes-server distinguished',
  gateAuthentic.permissions.includes('ip-whitelist:includes-server') && gateNoServer.permissions.includes('ip-whitelist:excludes-server'),
  `withServer=[${gateAuthentic.permissions.join(',')}] withoutServer=[${gateNoServer.permissions.join(',')}]`,
)

// dYdX: build a REAL keypair so the on-chain pubkey match succeeds, then prove the
// verifier distinguishes a trade-only authenticator from a fund-moving one.
{
  const ecdh = createECDH('secp256k1')
  ecdh.generateKeys()
  const priv = ecdh.getPrivateKey()
  const e2 = createECDH('secp256k1')
  e2.setPrivateKey(priv)
  const pub = e2.getPublicKey(null, 'compressed') // 33-byte compressed, matches on-chain

  const allOf = (msgs) => ({
    id: '3',
    type: 'AllOf',
    config: Buffer.from(
      JSON.stringify([
        { type: 'SignatureVerification', config: pub.toString('base64') },
        { type: 'MessageFilter', config: Buffer.from(msgs.join(',')).toString('base64') },
      ]),
    ).toString('base64'),
  })

  // trade-only: filter permits only clob order messages.
  const tradeOnly = dydx.parseAuthenticator(
    allOf(['/dydxprotocol.clob.MsgPlaceOrder', '/dydxprotocol.clob.MsgCancelOrder']),
    pub,
  )
  const dtoA = decideStorage(tradeOnly)
  check(
    'dydx: trade-only authenticator (clob msgs only) -> canWithdraw===false -> STORE',
    tradeOnly.canWithdraw === false && dtoA.store === true,
    `canWithdraw=${JSON.stringify(tradeOnly.canWithdraw)} store=${dtoA.store}`,
  )

  // fund-moving: filter also permits a withdraw message → must REFUSE ('unknown').
  const withWithdraw = dydx.parseAuthenticator(
    allOf(['/dydxprotocol.clob.MsgPlaceOrder', '/dydxprotocol.sending.MsgWithdrawFromSubaccount']),
    pub,
  )
  const dww = decideStorage(withWithdraw)
  check(
    'dydx: authenticator that ALSO permits withdraw -> REFUSE (not stored)',
    withWithdraw.canWithdraw !== false && dww.store === false,
    `canWithdraw=${JSON.stringify(withWithdraw.canWithdraw)} store=${dww.store}`,
  )

  // wrong key: same trade-only filter but a DIFFERENT pubkey → must REFUSE.
  const wrongKey = dydx.parseAuthenticator(
    allOf(['/dydxprotocol.clob.MsgPlaceOrder']),
    Buffer.alloc(33), // not our pubkey
  )
  check(
    'dydx: trade-only filter but WRONG key -> REFUSE (pubkey mismatch)',
    wrongKey.canWithdraw !== false && decideStorage(wrongKey).store === false,
    `canWithdraw=${JSON.stringify(wrongKey.canWithdraw)}`,
  )
}

// Paradex: the MEMBERSHIP guard, which is the real one here — a subkey is provably
// unable to withdraw, so no "withdrawal-capable subkey" body can exist. The guard must
// therefore fire on MEMBERSHIP: our pubkey present+active -> STORE; absent (master/
// foreign key) -> REFUSE; present-but-revoked/inactive -> REFUSE.
{
  const OUR = '0x123abc'
  const active = paradex.parseSubkeyMembership(
    { results: [{ public_key: OUR, state: 'active', revoked_at: null }] },
    OUR,
  )
  const da = decideStorage(active)
  check(
    'paradex: our pubkey is an ACTIVE subkey -> canWithdraw===false -> STORE',
    active.canWithdraw === false && da.store === true,
    `canWithdraw=${JSON.stringify(active.canWithdraw)} store=${da.store} perms=[${active.permissions.join(',')}]`,
  )

  // NOT in the list (a master account key, or a foreign key) -> REFUSE. THIS is check 2.
  const absent = paradex.parseSubkeyMembership(
    { results: [{ public_key: '0x999', state: 'active', revoked_at: null }] },
    OUR,
  )
  const dAbsent = decideStorage(absent)
  check(
    'paradex: pubkey NOT an active subkey (master/foreign) -> REFUSE',
    absent.canWithdraw !== false && dAbsent.store === false,
    `canWithdraw=${JSON.stringify(absent.canWithdraw)} store=${dAbsent.store}`,
  )

  // Present but revoked/inactive -> REFUSE.
  const revoked = paradex.parseSubkeyMembership(
    { results: [{ public_key: OUR, state: 'revoked', revoked_at: 1_700_000_000 }] },
    OUR,
  )
  const dRev = decideStorage(revoked)
  check(
    'paradex: subkey present but REVOKED/inactive -> REFUSE',
    revoked.canWithdraw !== false && dRev.store === false,
    `canWithdraw=${JSON.stringify(revoked.canWithdraw)} store=${dRev.store}`,
  )
}

console.log('\n=== The refusal message a user sees for a WITHDRAWAL-ENABLED key ===')
for (const r of refusals) {
  console.log(`\n  [${r.venue}]\n  "${r.message}"`)
}
console.log(`\n  total: ${pass + fail}   PASS: ${pass}   FAIL: ${fail}\n`)
if (fail > 0) process.exit(1)
