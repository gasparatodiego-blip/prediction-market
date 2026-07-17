/* eslint-disable no-console */
'use strict'

/**
 * THE POSITIVE CONTROL — proves the fail-closed test is not vacuous.
 *
 * An adapter whose parseVerify() always returned 'unknown' would pass all 20
 * fail-closed assertions while being completely useless. (gate.io's genuinely does
 * always return 'unknown' — that is the finding, not a bug.) So for the three venues
 * with a real permission endpoint we must prove the parser DISCRIMINATES:
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

const { decideStorage } = require(path.join(DIST, 'types.js'))
const binance = require(path.join(DIST, 'binance.js'))
const bybit = require(path.join(DIST, 'bybit.js'))
const okx = require(path.join(DIST, 'okx.js'))
const gateio = require(path.join(DIST, 'gateio.js'))

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

// gate.io: prove it refuses even a "successful-looking" body — permanently.
const g = gateio.parseVerify({ anything: 'at all' })
const dg = decideStorage(g)
check(
  'gateio: ALWAYS refuses (no permission endpoint exists)',
  g.canWithdraw === 'unknown' && dg.store === false,
  `canWithdraw=${JSON.stringify(g.canWithdraw)} store=${dg.store}`,
)

console.log('\n=== The refusal message a user sees for a WITHDRAWAL-ENABLED key ===')
for (const r of refusals) {
  console.log(`\n  [${r.venue}]\n  "${r.message}"`)
}
console.log(`\n  total: ${pass + fail}   PASS: ${pass}   FAIL: ${fail}\n`)
if (fail > 0) process.exit(1)
