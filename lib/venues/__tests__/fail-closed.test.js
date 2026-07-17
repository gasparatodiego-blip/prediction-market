/* eslint-disable no-console */
'use strict'

/**
 * THE FAIL-CLOSED PROOF.
 *
 * 4 venues x 5 degenerate inputs = 20 assertions. Every one must REFUSE.
 *
 * The inputs are the ways reality actually breaks: an empty object, a null body, a
 * malformed body, the venue's real auth-error shape, and — the sharpest one — a body
 * that is otherwise perfectly valid but MISSING the permission field. That last case
 * is the one a boolean `canWithdraw` would silently turn into "cannot withdraw" and
 * store.
 *
 * Run: node lib/venues/__tests__/fail-closed.test.js  (compiled JS; see the report)
 *
 * The ACCEPT branch is deliberately NOT exercised here — it cannot be, without a live
 * key. REFUSE is the default for every unknown, which is the direction to be wrong in.
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
    name: 'empty object {}',
    body: {},
  },
  {
    name: 'null body',
    body: null,
  },
  {
    name: 'malformed body (a string, not the documented object)',
    body: 'not json at all',
  },
]

// Each venue's REAL documented auth-error shape, and a valid-looking body with the
// permission field surgically removed.
const VENUES = [
  {
    id: 'binance',
    parse: binance.parseVerify,
    authError: { code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' },
    // Real apiRestrictions body, verbatim from docs, MINUS enableWithdrawals.
    missingField: {
      ipRestrict: false,
      createTime: 1623840271000,
      enableReading: true,
      enableInternalTransfer: true,
      enableMargin: false,
      enableFutures: true,
      permitsUniversalTransfer: true,
      enableVanillaOptions: false,
      enableSpotAndMarginTrading: true,
      enablePortfolioMarginTrading: true,
    },
  },
  {
    id: 'bybit',
    parse: bybit.parseVerify,
    authError: { retCode: 10003, retMsg: 'API key is invalid.', result: {} },
    // Real query-api body MINUS permissions.Wallet.
    missingField: {
      retCode: 0,
      retMsg: 'OK',
      result: {
        id: '13770',
        readOnly: 0,
        permissions: {
          ContractTrade: ['Order', 'Position'],
          Spot: ['SpotTrade'],
          Derivatives: ['DerivativesTrade'],
        },
        ips: ['*'],
      },
    },
  },
  {
    id: 'okx',
    parse: okx.parseVerify,
    authError: { code: '50111', msg: 'Invalid OK-ACCESS-KEY', data: [] },
    // Real account/config body MINUS perm.
    missingField: {
      code: '0',
      msg: '',
      data: [
        {
          acctLv: '2',
          autoLoan: false,
          ctIsoMode: 'automatic',
          greeksType: 'PA',
          level: 'Lv1',
          mgnIsoMode: 'automatic',
          posMode: 'long_short_mode',
          uid: '44705892343619584',
          label: 'v5 test',
          ip: '',
        },
      ],
    },
  },
  {
    id: 'gateio',
    parse: gateio.parseVerify,
    // Gate has no permission endpoint at all; these are placeholders — every input
    // must refuse, including a body that "looks" successful.
    authError: { label: 'INVALID_KEY', message: 'invalid key provided' },
    missingField: { user_id: 1667201533, tier: 2, key: { mode: 1 }, ip_whitelist: [] },
  },
]

let pass = 0
let fail = 0

function assertRefuse(venueId, caseName, body, parse) {
  let verdict
  let detail = ''
  try {
    const result = parse(body)
    const decision = decideStorage(result)
    if (decision.store === false && result.canWithdraw !== false) {
      verdict = 'REFUSE'
    } else if (decision.store === false) {
      // Refused, but canWithdraw parsed as an explicit false — flag it: a degenerate
      // input must never produce a confident "cannot withdraw".
      verdict = 'REFUSE(but canWithdraw===false!)'
    } else {
      verdict = 'STORE'
    }
    detail = `canWithdraw=${JSON.stringify(result.canWithdraw)} store=${decision.store}`
  } catch (e) {
    // A throw is NOT an acceptable refusal — the UI would see a 500.
    verdict = 'THREW'
    detail = String(e && e.message).slice(0, 60)
  }

  const ok = verdict === 'REFUSE'
  if (ok) pass++
  else fail++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${venueId.padEnd(8)} ${caseName.padEnd(58)} -> ${verdict.padEnd(8)} ${detail}`,
  )
}

console.log('\n=== FAIL-CLOSED: 4 venues x 5 degenerate inputs = 20 assertions ===')
console.log('    every one must REFUSE, and none may throw\n')

for (const v of VENUES) {
  for (const c of CASES) {
    assertRefuse(v.id, c.name, c.body, v.parse)
  }
  assertRefuse(v.id, "venue's real auth-error body", v.authError, v.parse)
  assertRefuse(v.id, 'valid body MISSING the permission field', v.missingField, v.parse)
}

console.log(`\n  total: ${pass + fail}   PASS: ${pass}   FAIL: ${fail}`)
if (fail > 0) {
  console.log('  FAIL-CLOSED PROOF FAILED')
  process.exit(1)
}
console.log('  all 20 refused\n')
