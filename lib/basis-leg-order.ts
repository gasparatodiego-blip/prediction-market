// Execution-order DRY-RUN for cash-and-carry (basis) rows.
//
// Joins agent19's persisted walkable ladders (/tmp/basis-books.json) onto the basis rows
// and asks lib/leg-order.ts which leg would have to be placed FIRST. It computes an
// ordering and the evidence behind it. It places nothing, submits nothing, reads no
// credential, and touches no venue client — this module only reads a local JSON file.
// Mirrors lib/funding-leg-order.ts; same contract, same fail-closed posture.
//
// Server-side ONLY: the sidecar holds ~58 capped ladders (~160KB). The browser gets the
// small ranking result, never the books.
//
// WHY hardest-first matters here specifically: the carry is only a carry if BOTH legs
// fill. Buy the spot and miss the short future and you are long naked crypto — the exact
// directional risk the strategy exists to avoid.
//
// FAIL-CLOSED throughout: a missing sidecar, a missing ladder on either leg, a stale
// ladder, or a non-finite price all yield an UNUSABLE result that says why. A ranking is
// never derived from a leg we could not measure.

import fs from 'fs'
import {
  rankLegs,
  legFromLadder,
  type TimestampedLadder,
  type LegDifficulty,
} from './leg-order'

// Overridable so the UNKNOWN/fail-closed path can be exercised against a doctored copy of
// the sidecar without touching the live one. Production never sets this.
const BOOKS_FILE = process.env.BASIS_BOOKS_FILE || '/tmp/basis-books.json'

/** Notional the dry-run is computed at. Slippage without its size is meaningless, so this
 *  is surfaced in the payload and rendered next to every result. Same figure the funding
 *  dry-run uses, so a slippage on the carry tab is comparable to one on the funding tab. */
export const DRY_RUN_NOTIONAL_USD = 10_000

/** Max ladder age accepted. Deliberately wider than leg-order's 5-min default: agent19's
 *  scan cycle IS 5 min, so a 5-min window would flap to UNKNOWN in the seconds before each
 *  refresh. Dated-futures basis also moves far slower than a perp funding rate — agent29
 *  already allows a 20-min window when re-verifying these same rows. Still a hard fail:
 *  past this, the leg is UNKNOWN, never ranked on stale depth. */
export const BASIS_LADDER_MAX_AGE_MS = 15 * 60_000

/** One persisted ladder. Future keys carry `bids` (we sell into them); spot keys carry
 *  `asks` (we buy from them). Only the side that leg crosses is stored. */
interface SidecarLadder {
  fetchedAt: number
  side: 'buy' | 'sell'
  top: number
  bids?: [number, number][]
  asks?: [number, number][]
}
interface Sidecar { generatedAt: string; cap: number; staleMs: number; books: Record<string, SidecarLadder> }

/** Per-leg evidence as SHIPPED — a trimmed, rounded projection of leg-order's
 *  LegDifficulty, matching the funding tab's wire shape field for field. */
export interface LegEvidence {
  id: string
  side: 'buy' | 'sell'
  outcome: 'ranked' | 'impossible' | 'unknown'
  filledQty: number | null
  topPrice: number | null
  avgPrice: number | null
  slippageBps: number | null
  levelsWalked: number | null
}

export interface BasisLegOrderDryRun {
  /** Size the ranking was computed at — never render a slippage without it. */
  notionalUsd: number
  qty: number | null
  /** Which sidecar key the qty was derived from (traceability). */
  qtyFrom: string | null
  usable: boolean
  executableAtSize: boolean
  reason: string
  /** Leg that would be placed first (hardest). null when unusable. */
  firstLegId: string | null
  ties: string[][]
  /** Per-leg evidence — always present, even when the ordering is unusable. */
  legs: LegEvidence[]
  /** Age of the oldest ladder used, ms. null when a ladder was missing. */
  ladderAgeMs: number | null
}

/** Round for the wire without inventing precision: null stays null. */
const r6 = (v: number | null) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1e6) / 1e6)
const r2 = (v: number | null) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100)

const project = (l: LegDifficulty): LegEvidence => ({
  id: l.id, side: l.side, outcome: l.outcome,
  filledQty: r6(l.filledQty), topPrice: l.topPrice,
  avgPrice: r6(l.avgPrice), slippageBps: r2(l.slippageBps), levelsWalked: l.levelsWalked,
})

function unusable(reason: string): BasisLegOrderDryRun {
  return {
    notionalUsd: DRY_RUN_NOTIONAL_USD,
    qty: null, qtyFrom: null,
    usable: false, executableAtSize: false,
    reason,
    firstLegId: null, ties: [], legs: [], ladderAgeMs: null,
  }
}

let _cache: { mtimeMs: number; sidecar: Sidecar } | null = null

/** Reads the sidecar, memoized on mtime so repeated rows in one request parse it once. */
function readSidecar(): Sidecar | null {
  try {
    const st = fs.statSync(BOOKS_FILE)
    if (_cache && _cache.mtimeMs === st.mtimeMs) return _cache.sidecar
    const sidecar = JSON.parse(fs.readFileSync(BOOKS_FILE, 'utf8')) as Sidecar
    if (!sidecar || typeof sidecar.books !== 'object' || sidecar.books === null) return null
    _cache = { mtimeMs: st.mtimeMs, sidecar }
    return sidecar
  } catch {
    return null   // no sidecar → every row is unusable, stated as such
  }
}

function toTimestamped(l: SidecarLadder | undefined, side: 'buy' | 'sell'): TimestampedLadder | null {
  if (!l) return null
  // side 'buy' crosses the ASK ladder (ascending); side 'sell' crosses the BID ladder (descending)
  const levels = side === 'buy' ? l.asks : l.bids
  if (!Array.isArray(levels)) return null
  return { fetchedAt: l.fetchedAt, levels }
}

/**
 * Dry-run the execution order for one cash-and-carry row.
 *   LONG SPOT     → we BUY  the coin   → side 'buy'  → spot ASK ladder  (SPOT|ASSET)
 *   SHORT FUTURE  → we SELL the future → side 'sell' → future BID ladder (VENUE|CONTRACT)
 *
 * Both ladders are stored in base-coin qty by agent19, so one shared size walks both —
 * which is what rankLegs requires (a single `size` across legs).
 *
 * `now` is supplied by the caller so leg-order.ts stays clockless and testable.
 */
export function dryRunBasisLegOrder(
  asset: string,
  venueKey: string,
  contract: string,
  now: number = Date.now(),
  maxAgeMs: number = BASIS_LADDER_MAX_AGE_MS,
): BasisLegOrderDryRun {
  if (!asset || !venueKey || !contract) return unusable('row is missing an asset, venue or contract')

  const sidecar = readSidecar()
  if (!sidecar) return unusable('no persisted depth available (sidecar unreadable)')

  const futKey  = `${venueKey}|${contract}`
  const spotKey = `SPOT|${asset}`
  const fBook = sidecar.books[futKey]
  const sBook = sidecar.books[spotKey]

  // Name the specific gap so the refusal is actionable.
  if (!fBook && !sBook) return unusable(`no persisted depth for ${contract} or ${asset} spot`)
  if (!fBook)           return unusable(`no persisted depth for ${contract} on ${venueKey}`)
  if (!sBook)           return unusable(`no persisted spot depth for ${asset}`)

  // Size in coins, from the REAL measured top of the spot ask ladder — the price the carry
  // actually pays to open its long leg. Never a mid, never a guess.
  const spotTop = sBook.top
  if (!Number.isFinite(spotTop) || spotTop <= 0) return unusable(`no usable spot price for ${asset}`)
  const qty = DRY_RUN_NOTIONAL_USD / spotTop

  const legs = [
    legFromLadder(`buy ${asset} spot`, 'buy', toTimestamped(sBook, 'buy'), now, maxAgeMs),
    legFromLadder(`sell ${contract}`, 'sell', toTimestamped(fBook, 'sell'), now, maxAgeMs),
  ]

  const r = rankLegs(legs, qty)

  // Derive the refusal from the ACTUAL ranking outcome, never from an assumption that a leg
  // ranked — a stale ladder makes its leg UNKNOWN too, and calling that "measured" is a lie.
  //
  // The cause is quoted from leg-order's own per-leg reason rather than asserted here. A leg
  // goes UNKNOWN for several distinct reasons — stale depth, a zero/negative-size level, an
  // out-of-order ladder — and naming the wrong one is its own small dishonesty: it sends a
  // reader to check the agent's clock when the real fault is a malformed book.
  const spotLeg = r.legs[0]
  const futLeg  = r.legs[1]
  const why = (l: LegDifficulty | undefined) => (l?.reason ? l.reason : 'depth could not be measured')
  const spotUnknown = spotLeg?.outcome === 'unknown'
  const futUnknown  = futLeg?.outcome === 'unknown'
  const reason = r.usable
    ? r.reason
    : spotUnknown && futUnknown ? `neither leg is rankable — ${asset} spot: ${why(spotLeg)}; ${contract}: ${why(futLeg)}`
      : spotUnknown            ? `${asset}'s spot ladder is not rankable — ${why(spotLeg)}`
      : futUnknown             ? `${contract}'s ladder is not rankable — ${why(futLeg)}`
      :                          r.reason

  const ages = [fBook.fetchedAt, sBook.fetchedAt]
    .filter(t => Number.isFinite(t))
    .map(t => now - t)

  return {
    notionalUsd: DRY_RUN_NOTIONAL_USD,
    qty: r6(qty),
    qtyFrom: spotKey,
    usable: r.usable,
    executableAtSize: r.executableAtSize,
    reason,
    firstLegId: r.usable && r.order && r.order.length ? r.order[0].id : null,
    ties: r.ties,
    legs: r.legs.map(project),
    ladderAgeMs: ages.length ? Math.max(...ages) : null,
  }
}
