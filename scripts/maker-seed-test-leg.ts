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

// The market the live-min stage is pinned to. Overridable, but it must be a market that is BOTH in the
// reward feed and being streamed by agent34 — the script proves that below rather than assuming it.
const MARKET_ID = process.env.MAKER_LIVE_MIN_MARKET
  || '0x6bd56627aa21311850825edb27e53434a0e17a4f782be0086bc07f71eee00d0d'

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

  // ── 3. the leg. Every number below is derived from the venue's OWN rules read above, never guessed ──
  // A follow leg re-computes target = mid + offsetC/100 every cycle, then snaps to tick. offsetC = -0.5
  // puts the bid half a cent under the mid: comfortably inside the reward band (radius = maxSpread/2 =
  // 1.75c), so it scores > 0, and on the 0.01 tick it lands exactly on a tick with no snap drift.
  const offsetC = -0.5
  const bandRadiusC = maxSpreadC / 2
  if (Math.abs(offsetC) >= bandRadiusC) throw new Error(`offsetC ${offsetC} is outside the reward band radius ${bandRadiusC}c — the leg would score 0 forever`)
  // size must be >= min_incentive_size or the leg earns nothing (quote-plan flags belowMinSize).
  const sizeShares = minSize
  const price = +(mid + offsetC / 100).toFixed(4)
  const notional = +(price * sizeShares).toFixed(2)

  // onFill 'hold' — do nothing on a fill. For a first test leg the follow-up order is the part you want
  // OFF: a fill should leave you holding a known position, not silently open another order.
  const leg = {
    userId: 'svc-admin-maker',
    marketId: MARKET_ID,
    venue: 'polymarket',
    book: 'yes',
    kind: 'buy',      // a BUY YES: needs collateral, not inventory, so no position guard can block it
    price,
    mode: 'follow',
    offsetC,
    onFill: 'hold',
    enabled: true,
    sizeShares,
  }
  console.log('\nleg to seed:')
  console.log(`  ${leg.kind.toUpperCase()} ${leg.book.toUpperCase()} ${leg.sizeShares} shares @ ~${leg.price}  (mode=${leg.mode} offsetC=${leg.offsetC}c onFill=${leg.onFill})`)
  console.log(`  notional ≈ $${notional}   band radius ±${bandRadiusC}c   distance to mid ${Math.abs(offsetC)}c ⇒ scores > 0`)
  const capUsd = Number(process.env.MAKER_LIVE_MIN_CAP_USD)
  if (Number.isFinite(capUsd)) {
    console.log(`  MAKER_LIVE_MIN_CAP_USD=${capUsd} ⇒ ${notional <= capUsd ? 'WITHIN' : '*** OVER ***'} the live-min hard cap`)
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

    // ── the leg. Keyed on the model's own unique constraint so re-running updates instead of duplicating. ──
    const row = await prisma.rewardsLeg.upsert({
      where: { userId_marketId_book_kind_price: { userId: leg.userId, marketId: leg.marketId, book: leg.book, kind: leg.kind, price: leg.price } },
      update: { mode: leg.mode, offsetC: leg.offsetC, onFill: leg.onFill, enabled: leg.enabled, sizeShares: leg.sizeShares },
      create: leg,
    })
    console.log(`leg id: ${row.id}`)
    const total = await prisma.rewardsLeg.count()
    console.log(`RewardsLeg rows now: ${total}`)
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
