/* eslint-disable no-console */
'use strict'

/**
 * rankLegs — the whole value lives HERE, because there is no live path to check against.
 * We prove: (1) thin ranks harder than deep, (2) over-book size is IMPOSSIBLE not "hard",
 * (3) missing/null/malformed/zero-size/empty depth → UNKNOWN → unusable, per leg and for
 * the whole result, (4) identical legs tie (no invented order), (5) the WALK ARITHMETIC
 * against a hand-computed book whose average is derived independently in the comment, and
 * (6) a REAL Kalshi book snapshot from disk run through the real depth-ladder extractor.
 *
 * Run: node lib/leg-order.test.js   (requires the compiled lib/leg-order.js)
 */

const path = require('path')
const fs = require('fs')
const DIST = process.env.LEG_DIST || path.join(__dirname)
const { rankLegs } = require(path.join(DIST, 'leg-order.js'))
const depth = require(path.join(__dirname, 'depth.js')) // real Kalshi/Poly ladder extractor

let pass = 0
let fail = 0
function check(label, cond, detail) {
  if (cond) pass++
  else fail++
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol

console.log('\n=== rankLegs ===\n')

// ── 1. Thin vs deep, same size → thin ranks harder. Show both slippages. ────────────────
{
  // deep: 5@100 then 5@100.1 for size 10 → cost 500+500.5=1000.5, avg 100.05, slip (0.05/100)=5.0 bps
  const deep = { id: 'deep', side: 'buy', ladder: [{ price: 100, qty: 5 }, { price: 100.1, qty: 1000 }] }
  // thin: 5@100 then 5@102 for size 10 → cost 500+510=1010, avg 101, slip (1/100)=100.0 bps
  const thin = { id: 'thin', side: 'buy', ladder: [{ price: 100, qty: 5 }, { price: 102, qty: 1000 }] }
  const r = rankLegs([deep, thin], 10)
  const thinD = r.legs.find((l) => l.id === 'thin')
  const deepD = r.legs.find((l) => l.id === 'deep')
  check('1. usable, both ranked', r.usable === true && r.executableAtSize === true)
  check('1. deep slippage = 5.0 bps (avg 100.05)', near(deepD.slippageBps, 5.0) && near(deepD.avgPrice, 100.05), `deep=${deepD.slippageBps}bps avg=${deepD.avgPrice}`)
  check('1. thin slippage = 100.0 bps (avg 101)', near(thinD.slippageBps, 100.0) && near(thinD.avgPrice, 101), `thin=${thinD.slippageBps}bps avg=${thinD.avgPrice}`)
  check('1. thin ranks HARDER (first)', r.order[0].id === 'thin' && r.order[1].id === 'deep', `order=[${r.order.map((l) => l.id).join(',')}]`)
}

// ── 2. Size larger than the whole book → IMPOSSIBLE, distinct from "hard". ───────────────
{
  const leg = { id: 'shallow', side: 'buy', ladder: [{ price: 100, qty: 3 }] }
  const r = rankLegs([leg], 10)
  const d = r.legs[0]
  check('2. over-book size → outcome IMPOSSIBLE (not ranked)', d.outcome === 'impossible', `outcome=${d.outcome}`)
  check('2. IMPOSSIBLE has no slippage score, reports partial fill', d.slippageBps === null && d.filledQty === 3, `slip=${d.slippageBps} filled=${d.filledQty}`)
  check('2. usable (measured) but executableAtSize=false', r.usable === true && r.executableAtSize === false, `usable=${r.usable} exec=${r.executableAtSize}`)
}

// ── 3. Five degenerate depth shapes → UNKNOWN → unusable. Per leg AND whole result. ─────
{
  const cases = [
    { name: 'empty book []', leg: { id: 'x', side: 'buy', ladder: [] } },
    { name: 'missing ladder (undefined)', leg: { id: 'x', side: 'buy', ladder: undefined } },
    { name: 'null ladder', leg: { id: 'x', side: 'buy', ladder: null } },
    { name: 'malformed level (non-finite price)', leg: { id: 'x', side: 'buy', ladder: [{ price: 'oops', qty: 5 }] } },
    { name: 'zero-size level', leg: { id: 'x', side: 'buy', ladder: [{ price: 100, qty: 0 }] } },
  ]
  for (const c of cases) {
    const r = rankLegs([c.leg], 10)
    check(`3. ${c.name} → UNKNOWN + unusable + order null`, r.legs[0].outcome === 'unknown' && r.usable === false && r.order === null, `outcome=${r.legs[0].outcome} usable=${r.usable} order=${r.order}`)
  }
  // Non-positive size is also UNKNOWN.
  const rZero = rankLegs([{ id: 'x', side: 'buy', ladder: [{ price: 100, qty: 5 }] }], 0)
  check('3. zero requested size → UNKNOWN + unusable', rZero.legs[0].outcome === 'unknown' && rZero.usable === false, `outcome=${rZero.legs[0].outcome}`)
  // WHOLE-RESULT: one good leg + one UNKNOWN leg → NO partial ranking. Half a ranking is worthless.
  const good = { id: 'good', side: 'buy', ladder: [{ price: 100, qty: 100 }] }
  const bad = { id: 'bad', side: 'buy', ladder: [] }
  const r2 = rankLegs([good, bad], 10)
  check('3. one UNKNOWN leg → whole ranking unusable, order null, evidence still present', r2.usable === false && r2.order === null && r2.legs.length === 2 && r2.legs.find((l) => l.id === 'good').outcome === 'ranked', `usable=${r2.usable} order=${r2.order}`)
}

// ── 4. Two identical legs → reported as a TIE, not arbitrarily ordered. ──────────────────
{
  const a = { id: 'legA', side: 'buy', ladder: [{ price: 100, qty: 5 }, { price: 102, qty: 100 }] }
  const b = { id: 'legB', side: 'buy', ladder: [{ price: 100, qty: 5 }, { price: 102, qty: 100 }] }
  const r = rankLegs([a, b], 10)
  check('4. identical legs → equal slippage', near(r.legs[0].slippageBps, r.legs[1].slippageBps))
  check('4. reported as a tie group', r.ties.length === 1 && r.ties[0].length === 2 && r.ties[0].includes('legA') && r.ties[0].includes('legB'), `ties=${JSON.stringify(r.ties)}`)
}

// ── 5. THE WALK ARITHMETIC — hand-derived, stated independently. ────────────────────────
{
  // BUY: cross asks. ladder [100 x2, 101 x3], size 4.
  //   fill 2 @ 100 = 200 ; then 2 @ 101 = 202 ; total cost 402 over qty 4 → avg = 402/4 = 100.5
  //   top = 100 ; slippage = (100.5 - 100)/100 = 0.005 = 50.000 bps
  const buy = { id: 'buy', side: 'buy', ladder: [{ price: 100, qty: 2 }, { price: 101, qty: 3 }] }
  const rb = rankLegs([buy], 4).legs[0]
  check('5. BUY avg == 100.5 EXACT (hand-derived)', near(rb.avgPrice, 100.5), `avg=${rb.avgPrice}`)
  check('5. BUY slippage == 50.000 bps EXACT', near(rb.slippageBps, 50), `slip=${rb.slippageBps}`)
  check('5. BUY levelsWalked == 2, filledQty == 4', rb.levelsWalked === 2 && near(rb.filledQty, 4), `walked=${rb.levelsWalked} filled=${rb.filledQty}`)

  // SELL: cross bids. ladder [100 x2, 99 x3], size 4.
  //   fill 2 @ 100 = 200 ; then 2 @ 99 = 198 ; total 398 over 4 → avg = 398/4 = 99.5
  //   top = 100 ; slippage = (100 - 99.5)/100 = 0.005 = 50.000 bps
  const sell = { id: 'sell', side: 'sell', ladder: [{ price: 100, qty: 2 }, { price: 99, qty: 3 }] }
  const rs = rankLegs([sell], 4).legs[0]
  check('5. SELL avg == 99.5 EXACT (hand-derived)', near(rs.avgPrice, 99.5), `avg=${rs.avgPrice}`)
  check('5. SELL slippage == 50.000 bps EXACT', near(rs.slippageBps, 50), `slip=${rs.slippageBps}`)

  // Integrity: an unsorted ask ladder must REFUSE (UNKNOWN), not silently mis-walk.
  const unsorted = { id: 'u', side: 'buy', ladder: [{ price: 101, qty: 2 }, { price: 100, qty: 3 }] }
  check('5. unsorted ask ladder → UNKNOWN (integrity)', rankLegs([unsorted], 4).legs[0].outcome === 'unknown')
}

// ── 6. REAL DATA — a real Kalshi book from disk, through the real ladder extractor. ──────
console.log('\n=== 6. REAL DATA: /tmp/kbook.json (real bytes from the running system) ===')
try {
  const raw = JSON.parse(fs.readFileSync('/tmp/kbook.json', 'utf8'))
  const book = raw.orderbook_fp || raw
  const { yesAsks, noAsks } = depth.laddersFromKalshiBook(book)
  console.log(`  raw no_dollars levels: ${(book.no_dollars || []).length}  yes_dollars levels: ${(book.yes_dollars || []).length}`)
  console.log(`  extracted executable ladders — yesAsks[0..2]=${JSON.stringify(yesAsks.slice(0, 3))}  noAsks[0..2]=${JSON.stringify(noAsks.slice(0, 3))}`)
  // Two real legs of a Kalshi YES/NO arb: buy YES (walk yesAsks) and buy NO (walk noAsks).
  const legs = [
    { id: 'kalshi-YES', side: 'buy', ladder: yesAsks },
    { id: 'kalshi-NO', side: 'buy', ladder: noAsks },
  ]
  const SIZE = 20000 // contracts — a size that actually walks the real book
  const r = rankLegs(legs, SIZE)
  console.log(`  rankLegs(size=${SIZE}) → usable=${r.usable} executableAtSize=${r.executableAtSize} reason="${r.reason}"`)
  for (const l of r.legs) {
    console.log(`    ${l.id.padEnd(11)} outcome=${l.outcome} top=${l.topPrice} avg=${l.avgPrice} slip=${l.slippageBps == null ? 'n/a' : l.slippageBps.toFixed(2) + 'bps'} walked=${l.levelsWalked} filled=${l.filledQty}`)
  }
  if (r.order) console.log(`  hardest-first order: [${r.order.map((l) => l.id + '(' + l.outcome + ')').join(', ')}]`)
  // The finding the run demands: did the on-disk shape match what rankLegs expects?
  const shapeOk = Array.isArray(yesAsks) && yesAsks.length > 0 && typeof yesAsks[0].price === 'number' && typeof yesAsks[0].qty === 'number'
  check('6. real on-disk Kalshi book → real {price,qty} ladders that rankLegs walks (no massaging)', shapeOk && (r.usable === true || r.legs.every((l) => l.outcome !== 'unknown')), `shapeOk=${shapeOk} usable=${r.usable}`)
} catch (e) {
  check('6. REAL DATA', false, `could not read/parse /tmp/kbook.json: ${e && e.message} — REPORTED as a finding, not massaged`)
}

console.log(`\n  total: ${pass + fail}   PASS: ${pass}   FAIL: ${fail}\n`)
if (fail > 0) process.exit(1)
