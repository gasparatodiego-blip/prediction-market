// rankLegs — decide which leg of a multi-leg arbitrage to place FIRST.
//
// WHY hardest-first: an arb is only an arb if EVERY leg fills. Fill the easy leg first
// and the hard leg misses, and you are left holding a naked directional position the user
// never asked for. So place the hardest leg first: if it fills, the easy leg almost
// certainly follows; if it does not, nothing else was risked.
//
// "Hardest" is MEASURED against real order-book depth — never OI, never a heuristic, never
// a proxy. Difficulty is the cost of crossing the book for the requested size: how far the
// walk goes, the executable average price, and the slippage from top-of-book to that
// average. Executable side only (asks to buy, bids to sell); never the midpoint.
//
// PURE. No I/O, no fetching, no clock, no side effects — the depth arrives as an argument
// (the caller supplies whatever real book it holds at execution time). That is what makes
// it testable without a network, which matters because there is no live path to check.
//
// FAIL-CLOSED, exactly like the venue withdrawal guard:
//   - depth missing / stale / unparseable / zero-size level / non-positive size → the
//     leg's difficulty is UNKNOWN. An UNKNOWN leg is never ranked easy, never ranked at
//     all, and is never defaulted to a middling score.
//   - a book that cannot absorb the size AT ALL is IMPOSSIBLE — a distinct outcome, not a
//     high score. (Placing an impossible leg first is safe: it fails, nothing else risked.)
//   - if ANY leg is UNKNOWN the whole ranking is UNUSABLE and says so; half a ranking on a
//     two-leg arb is worthless.
//   - ties are reported as ties. No invented tiebreaker.

/** One price level of an executable ladder. qty is in the leg's base units (coins/contracts). */
export interface BookLevel {
  price: number
  qty: number
}

/**
 * One leg of the arb, carrying the EXECUTABLE-side ladder the caller will cross:
 *   side 'buy'  → the ask ladder (ascending prices, best/lowest first)
 *   side 'sell' → the bid ladder (descending prices, best/highest first)
 * `stale` lets the caller — who alone knows freshness — mark the depth stale WITHOUT this
 * function needing a clock (keeping it pure). A stale leg is UNKNOWN.
 */
export interface LegBook {
  id: string
  side: 'buy' | 'sell'
  ladder: BookLevel[]
  stale?: boolean
}

export type LegOutcome = 'ranked' | 'impossible' | 'unknown'

/** Per-leg evidence — the numbers that justified (or refused) a rank. Always returned. */
export interface LegDifficulty {
  id: string
  side: 'buy' | 'sell'
  outcome: LegOutcome
  requestedQty: number
  /** How much of `size` the book could actually fill (== requestedQty when 'ranked'). */
  filledQty: number | null
  /** Best executable price (top of the executable side). */
  topPrice: number | null
  /** Executable AVERAGE price to fill the size (partial fill for 'impossible'). */
  avgPrice: number | null
  /** Magnitude of slippage top→avg, in basis points. THE difficulty score. Higher = harder. */
  slippageBps: number | null
  /** How many book levels the walk touched. */
  levelsWalked: number | null
  reason: string
}

export interface RankResult {
  /** false if ANY leg is 'unknown' — then the ranking cannot be trusted at all. */
  usable: boolean
  /** true only if EVERY leg is 'ranked' (no impossible, no unknown) — the arb fills at size. */
  executableAtSize: boolean
  reason: string
  /** Hardest-first when usable; null when unusable. Impossible legs precede ranked ones. */
  order: LegDifficulty[] | null
  /** Groups of ranked leg ids sharing the same slippage — reported, never broken. */
  ties: string[][]
  /** Per-leg evidence, ALWAYS present (even when the overall ranking is unusable). */
  legs: LegDifficulty[]
}

const EPS = 1e-9
const isFinitePos = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0

/** Walk one leg's executable ladder for `size`. Pure; returns the leg's difficulty + evidence. */
function walkLeg(leg: LegBook, size: number): LegDifficulty {
  const base: LegDifficulty = {
    id: leg.id,
    side: leg.side,
    outcome: 'unknown',
    requestedQty: size,
    filledQty: null,
    topPrice: null,
    avgPrice: null,
    slippageBps: null,
    levelsWalked: null,
    reason: '',
  }
  const unknown = (reason: string): LegDifficulty => ({ ...base, outcome: 'unknown', reason })

  if (!isFinitePos(size)) return unknown('requested size is not a positive number')
  if (leg.stale === true) return unknown('depth marked stale by caller')
  if (!Array.isArray(leg.ladder) || leg.ladder.length === 0) return unknown('no order book (empty or missing ladder)')

  // Validate EVERY level. A single malformed or zero-size level makes the whole leg UNKNOWN
  // — we do not silently skip it (a hole in the book we cannot read is not "a bit thinner").
  for (const lvl of leg.ladder) {
    if (lvl === null || typeof lvl !== 'object') return unknown('malformed book level (not an object)')
    if (!Number.isFinite(lvl.price) || lvl.price <= 0) return unknown('malformed book level (non-positive or non-finite price)')
    if (!Number.isFinite(lvl.qty)) return unknown('malformed book level (non-finite size)')
    if (lvl.qty <= 0) return unknown('zero-size (or negative) book level')
  }

  // The ladder MUST be best-first and monotonic for its side: asks non-decreasing (buy),
  // bids non-increasing (sell). An out-of-order ladder is not a book we can trust to walk.
  for (let i = 1; i < leg.ladder.length; i++) {
    const prev = leg.ladder[i - 1].price
    const cur = leg.ladder[i].price
    if (leg.side === 'buy' && cur < prev - EPS) return unknown('ask ladder not sorted best-first (ascending)')
    if (leg.side === 'sell' && cur > prev + EPS) return unknown('bid ladder not sorted best-first (descending)')
  }

  const top = leg.ladder[0].price
  let remaining = size
  let cost = 0
  let filled = 0
  let walked = 0
  for (const lvl of leg.ladder) {
    const take = Math.min(remaining, lvl.qty)
    cost += take * lvl.price
    filled += take
    remaining -= take
    walked++
    if (remaining <= EPS) break
  }

  if (remaining > EPS) {
    // The book cannot absorb the size AT ALL — IMPOSSIBLE, a distinct outcome. Report the
    // partial-fill evidence, but this is not a "hard" score; the arb cannot fill at size.
    const partialAvg = filled > EPS ? cost / filled : null
    return {
      ...base,
      outcome: 'impossible',
      filledQty: filled,
      topPrice: top,
      avgPrice: partialAvg,
      slippageBps: null,
      levelsWalked: walked,
      reason: `book absorbs only ${filled} of ${size} — impossible at this size`,
    }
  }

  const avg = cost / filled // filled == size here
  // Slippage magnitude from top to executable average (buy: avg≥top; sell: avg≤top).
  const slippageBps = (Math.abs(avg - top) / top) * 10000
  return {
    ...base,
    outcome: 'ranked',
    filledQty: filled,
    topPrice: top,
    avgPrice: avg,
    slippageBps,
    levelsWalked: walked,
    reason: `fills ${size} across ${walked} level(s); avg ${avg} vs top ${top} = ${slippageBps.toFixed(2)} bps`,
  }
}

/** Group ranked legs whose slippage is equal (within a tight tolerance) — reported, never broken. */
function findTies(ranked: LegDifficulty[]): string[][] {
  const ties: string[][] = []
  const tol = 1e-6
  const used = new Set<number>()
  for (let i = 0; i < ranked.length; i++) {
    if (used.has(i)) continue
    const group = [ranked[i].id]
    for (let j = i + 1; j < ranked.length; j++) {
      if (used.has(j)) continue
      if (Math.abs((ranked[i].slippageBps as number) - (ranked[j].slippageBps as number)) <= tol) {
        group.push(ranked[j].id)
        used.add(j)
      }
    }
    if (group.length > 1) ties.push(group)
  }
  return ties
}

/**
 * rankLegs — order the legs hardest-first, each carrying the measured evidence for its rank.
 *
 * @param legs  the arb's legs, each with its executable-side ladder (best price first)
 * @param size  the requested quantity, in the legs' shared base units
 */
export function rankLegs(legs: LegBook[], size: number): RankResult {
  const evaluated = (Array.isArray(legs) ? legs : []).map((l) => walkLeg(l, size))

  const anyUnknown = evaluated.some((l) => l.outcome === 'unknown')
  if (evaluated.length === 0) {
    return { usable: false, executableAtSize: false, reason: 'no legs supplied', order: null, ties: [], legs: evaluated }
  }
  if (anyUnknown) {
    const n = evaluated.filter((l) => l.outcome === 'unknown').length
    return {
      usable: false,
      executableAtSize: false,
      reason: `${n} of ${evaluated.length} leg(s) have UNKNOWN depth — the ranking is unusable. A ranking is only valid when every leg is measured.`,
      order: null, // never a partial ranking
      ties: [],
      legs: evaluated,
    }
  }

  const impossible = evaluated.filter((l) => l.outcome === 'impossible')
  const ranked = evaluated
    .filter((l) => l.outcome === 'ranked')
    .sort((a, b) => (b.slippageBps as number) - (a.slippageBps as number)) // hardest (most slippage) first

  // Hardest-first overall: an impossible leg is the hardest thing there is (it cannot fill),
  // so it precedes every ranked leg. Placing it first is the safe move — it fails, nothing
  // else is risked. But it carries outcome:'impossible', not an inflated slippage score.
  const order = [...impossible, ...ranked]
  const executableAtSize = impossible.length === 0
  const ties = findTies(ranked)

  return {
    usable: true,
    executableAtSize,
    reason: executableAtSize
      ? `ranked hardest-first by measured slippage${ties.length ? ' (with ties reported)' : ''}`
      : `${impossible.length} leg(s) IMPOSSIBLE at this size — the arb cannot fill; the impossible leg(s) sort first`,
    order,
    ties,
    legs: evaluated,
  }
}
