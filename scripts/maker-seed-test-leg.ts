// scripts/maker-seed-test-leg.ts — give agent35-maker ONE leg it can actually quote, and make the
// operating universe include that leg's market.
//
//   npx tsx scripts/maker-seed-test-leg.ts --dry-run   # print the plan, write nothing
//   npx tsx scripts/maker-seed-test-leg.ts             # upsert the selection + the leg
//
// PLACES NOTHING. Two idempotent upserts of configuration rows. It never deletes a row, never touches a
// credential, never reaches a venue. MAKER_MODE stays whatever it already is (it is 'off' by default, and
// off cannot reach a venue write at all), so seeding a leg arms nothing on its own.
//
// WHY A SELECTION ROW TOO, AND NOT JUST A LEG. agent35 gates quoting on TWO independent sets and a leg is
// only quoted when its market is in BOTH:
//   • the OPERATING UNIVERSE — resolveMakerUniverse() over /tmp/liquidity-rewards.json, capped at
//     maxMarkets (default 5, reward-ranked);
//   • agent34's LIVE BOOK FEED (/tmp/clob-live-books.json) — no live mid ⇒ no target ⇒ nothing postable.
// Measured 2026-07-29: those two sets were DISJOINT. The default reward-ranked top 5 contained no market
// agent34 was streaming, so a leg on any of them would have sat with mid=null forever, and a leg on a
// streamed market would have been filtered out of the universe. Allowlisting is the resolver's own
// mechanism for exactly this ("an explicit operator instruction"), and allowlisted markets sort FIRST so
// the cap cannot push them out.
//
// The market seeded is MAKER_LIVE_MIN_MARKET — the single market the live-min stage is already pinned to.
// Anything else would mean the first armed stage quotes a market that has no leg.

import fs from 'fs'
import path from 'path'
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

import { PrismaClient } from '@prisma/client'

const DRY = process.argv.includes('--dry-run')
const BOOKS = '/tmp/clob-live-books.json'
const REWARDS = '/tmp/liquidity-rewards.json'

// The market to seed. --market wins, then MAKER_LIVE_MIN_MARKET (the market the live-min stage is
// pinned to). Whichever it is, it must be BOTH in the reward feed and streamed by agent34 — the script
// proves that below rather than assuming it.
const marketArgIdx = process.argv.indexOf('--market')
const MARKET_ID = (marketArgIdx >= 0 ? process.argv[marketArgIdx + 1] : '')
  || process.env.MAKER_LIVE_MIN_MARKET
  || '0x6bd56627aa21311850825edb27e53434a0e17a4f782be0086bc07f71eee00d0d'

// ONE SIDE EARNS NOTHING WHEN THE MID IS IN THE TAILS, and is penalised everywhere else. Polymarket's
// reward formula pays two-sided liquidity: a one-sided book takes a ÷3 penalty, and when the mid is
// below 0.10 or above 0.90 a one-sided configuration scores exactly ZERO (lib/maker/quote-plan reports
// this as oneSidedZero). So the default is a PAIR. --one-sided seeds only the YES bid, for the case
// where you deliberately want the cheaper half.
const TWO_SIDED = !process.argv.includes('--one-sided')

const SELECTION_ID = 'singleton'

function readJson(p: string): any {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

async function main() {
  console.log('maker — seed ONE quotable test leg (configuration only: places nothing, deletes nothing)\n')
  console.log(`market: ${MARKET_ID}`)

  // ── 1. prove the market is in the LIVE BOOK FEED, and read its REAL venue rules from it ──
  const books = readJson(BOOKS)
  const bm = books && books.markets ? books.markets[MARKET_ID] : null
  if (!bm) throw new Error(`market is NOT in agent34's live book feed (${BOOKS}) — a leg there could never be priced (no mid). Refusing to seed a leg that can never quote.`)
  const mid = Number(bm.mid)
  const minSize = Number(bm.minSize)
  const maxSpreadC = Number(bm.maxSpread)
  if (!Number.isFinite(mid) || !Number.isFinite(minSize) || !Number.isFinite(maxSpreadC)) {
    throw new Error('the book feed has no usable mid/minSize/maxSpread for this market — refusing to guess venue rules')
  }
  console.log(`  live book : mid=${mid} minSize=${minSize} maxSpread=${maxSpreadC}c live=${bm.live} — "${String(bm.title).slice(0, 60)}"`)

  // ── 2. prove it is in the REWARD feed, or the universe resolver cannot force it in ──
  const rewards = readJson(REWARDS)
  const rlist = rewards?.data?.markets || rewards?.markets || []
  const rm = rlist.find((m: any) => String(m.marketId) === MARKET_ID)
  if (!rm) throw new Error(`market is NOT in the reward feed (${REWARDS}) — resolveMakerUniverse() only force-in ALLOWLISTED markets that are eligible there. Refusing to seed a leg the universe can never include.`)
  console.log(`  reward    : dailyPool=${rm.dailyPool} category=${rm.category}`)

  // ── 3. the legs. Every number below is derived from the venue's OWN rules read above, never guessed ──
  // A follow leg re-computes target = bookMid + offsetC/100 every cycle, then snaps to tick. offsetC of
  // -0.5 puts each order half a cent inside its own book's mid — well within the reward band (radius =
  // maxSpread/2), so both score > 0.
  //
  // BOTH LEGS ARE BUYS, and that is deliberate. A SELL delivers an ERC-1155 outcome token you must
  // already own, so with zero inventory the position guard blocks every SELL (fail-closed, by design).
  // BUY NO is the same resting order as SELL YES — buying NO at q IS offering YES at 1−q — but it is
  // paid for with collateral, which we have. So a BUY YES + BUY NO pair is a genuine two-sided book.
  const offsetC = -0.5
  const bandRadiusC = maxSpreadC / 2
  if (Math.abs(offsetC) >= bandRadiusC) throw new Error(`offsetC ${offsetC} is outside the reward band radius ${bandRadiusC}c — the leg would score 0 forever`)
  // size must be >= min_incentive_size or the leg earns nothing (quote-plan flags belowMinSize).
  const sizeShares = minSize

  // Each book is priced in ITS OWN space: the NO book's mid is 1 − yesMid.
  const mk = (book: 'yes' | 'no') => {
    const bookMid = book === 'no' ? +(1 - mid).toFixed(6) : mid
    const price = +(bookMid + offsetC / 100).toFixed(4)
    return {
      userId: 'svc-admin-maker',
      marketId: MARKET_ID,
      venue: 'polymarket',
      book,
      kind: 'buy',
      price,
      mode: 'follow',
      offsetC,
      // onFill 'hold' — do nothing on a fill. For a first test the follow-up order is the part you want
      // OFF: a fill should leave you holding a known position, not silently opening another order.
      onFill: 'hold',
      enabled: true,
      sizeShares,
    }
  }
  const legs = TWO_SIDED ? [mk('yes'), mk('no')] : [mk('yes')]

  console.log(`\nlegs to seed (${TWO_SIDED ? 'TWO-SIDED — required to earn' : 'ONE-SIDED — see --one-sided warning'}):`)
  const capUsd = Number(process.env.MAKER_LIVE_MIN_CAP_USD)
  let total = 0
  let overCap = false
  for (const l of legs) {
    const notional = +(l.price * l.sizeShares).toFixed(2)
    total += notional
    const over = Number.isFinite(capUsd) && notional > capUsd
    if (over) overCap = true
    console.log(`  ${l.kind.toUpperCase()} ${l.book.toUpperCase().padEnd(3)} ${l.sizeShares} shares @ ~${l.price}  ≈ $${notional}${over ? '   *** OVER the $' + capUsd + ' per-order live-min cap ***' : ''}`)
  }
  console.log(`  band radius ±${bandRadiusC}c · each leg sits ${Math.abs(offsetC)}c from its book mid ⇒ both score > 0`)
  console.log(`  total collateral if both rest: ≈ $${total.toFixed(2)}`)
  if (Number.isFinite(capUsd)) {
    // The live-min cap is PER ORDER (adapter.js rejects a single postOrder above it), not a total.
    console.log(`  MAKER_LIVE_MIN_CAP_USD=$${capUsd} is a PER-ORDER cap ⇒ ${overCap ? 'AT LEAST ONE LEG WOULD BE REJECTED — raise the cap or pick a cheaper market' : 'every leg fits'}`)
  }
  if (!TWO_SIDED) {
    console.log('  WARNING: one-sided liquidity takes the ÷3 reward penalty, and scores ZERO outright when')
    console.log('           the mid is in the tails (<0.10 or >0.90). This will likely earn nothing.')
  }

  if (DRY) { console.log('\n--dry-run: nothing written.'); return }

  const prisma = new PrismaClient()
  try {
    // ── selection: force this market into the operating universe. Additive — the allowlist is a set of
    //    force-INs; the existing filters/denylist/maxMarkets are preserved when a row already exists. ──
    const existing = await prisma.makerUniverseSelection.findUnique({ where: { id: SELECTION_ID } })
    const allowlist = Array.from(new Set([...(existing?.allowlist ?? []), MARKET_ID]))
    await prisma.makerUniverseSelection.upsert({
      where: { id: SELECTION_ID },
      update: { allowlist, updatedBy: 'maker-seed-test-leg' },
      create: {
        id: SELECTION_ID,
        filters: existing?.filters ?? {},
        venues: existing?.venues ?? ['polymarket'],
        allowlist,
        denylist: existing?.denylist ?? [],
        maxMarkets: existing?.maxMarkets ?? 5,
        updatedBy: 'maker-seed-test-leg',
      },
    })
    console.log(`\nuniverse allowlist now: ${allowlist.join(', ')}`)

    // ── the legs. Keyed on the model's own unique constraint so re-running updates instead of
    //    duplicating. Nothing is ever deleted: a superseded leg from an earlier run stays in the table
    //    and must be retired deliberately (disable it), never silently by this script. ──
    for (const leg of legs) {
      const row = await prisma.rewardsLeg.upsert({
        where: { userId_marketId_book_kind_price: { userId: leg.userId, marketId: leg.marketId, book: leg.book, kind: leg.kind, price: leg.price } },
        update: { mode: leg.mode, offsetC: leg.offsetC, onFill: leg.onFill, enabled: leg.enabled, sizeShares: leg.sizeShares },
        create: leg,
      })
      console.log(`  ${leg.kind} ${leg.book} @ ${leg.price} → leg id ${row.id}`)
    }
    const totalRows = await prisma.rewardsLeg.count()
    console.log(`RewardsLeg rows now: ${totalRows}`)
    console.log('\nSeeded. agent35 re-reads legs AND the selection every cycle — no restart needed.')
    console.log('MAKER_MODE is unchanged; in `off` the engine reaches no venue write at all.')
  } finally {
    await prisma.$disconnect()
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('seed failed:', String(e && e.message ? e.message : e).slice(0, 300))
  process.exit(1)
})
