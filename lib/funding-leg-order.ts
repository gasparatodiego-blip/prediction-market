// Execution-order DRY-RUN for cross-venue funding rows.
//
// Joins agent15's persisted walkable ladders (/tmp/funding-books.json) onto the funding
// rows and asks lib/leg-order.ts which leg would have to be placed FIRST. It computes an
// ordering and the evidence behind it. It places nothing, submits nothing, reads no
// credential, and touches no venue client — this module only reads a local JSON file.
//
// Server-side ONLY: the sidecar holds 212 capped ladders (~320KB). The browser gets the
// small ranking result, never the books.
//
// FAIL-CLOSED throughout: a missing sidecar, a missing ladder on either leg, a stale
// ladder, or a non-finite mid all yield an UNUSABLE result that says why. A ranking is
// never derived from a leg we could not measure.

import fs from 'fs'
import {
  rankLegs,
  legFromLadder,
  DEFAULT_LADDER_MAX_AGE_MS,
  type TimestampedLadder,
  type LegDifficulty,
} from './leg-order'

// Overridable so the UNKNOWN/fail-closed path can be exercised against a doctored copy
// of the sidecar without touching the live one. Production never sets this.
const BOOKS_FILE = process.env.FUNDING_BOOKS_FILE || '/tmp/funding-books.json'

/** Notional the dry-run is computed at. Slippage without its size is meaningless, so this
 *  is surfaced in the payload and rendered next to every result. */
export const DRY_RUN_NOTIONAL_USD = 10_000

interface SidecarLadder { fetchedAt: number; mid: number; bids: [number, number][]; asks: [number, number][] }
interface Sidecar { generatedAt: number; cap: number; staleMs: number; books: Record<string, SidecarLadder> }

/** Per-leg evidence as SHIPPED. A trimmed projection of leg-order's LegDifficulty: the
 *  per-leg `reason` and `requestedQty` are dropped (the top-level reason covers refusals,
 *  and requestedQty always equals `qty`), and the numbers are rounded. This payload is
 *  attached to ~1400 rows on a public page, so every redundant field is real mobile bytes. */
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

export interface LegOrderDryRun {
  /** Size the ranking was computed at — never render a slippage without it. */
  notionalUsd: number
  qty: number | null
  /** Which venue mid the qty was derived from (traceability). */
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

const unusable = (reason: string, legs: LegEvidence[] = []): LegOrderDryRun => ({
  notionalUsd: DRY_RUN_NOTIONAL_USD, qty: null, qtyFrom: null,
  usable: false, executableAtSize: false, reason,
  firstLegId: null, ties: [], legs, ladderAgeMs: null,
})

function toTimestamped(l: SidecarLadder | undefined, side: 'buy' | 'sell'): TimestampedLadder | null {
  if (!l) return null
  // side 'buy' crosses the ASK ladder (ascending); side 'sell' crosses the BID ladder (descending)
  const levels = side === 'buy' ? l.asks : l.bids
  if (!Array.isArray(levels)) return null
  return { fetchedAt: l.fetchedAt, levels }
}

/**
 * Dry-run the execution order for one cross-venue funding row.
 *   shortExchange → we SELL that perp  → side 'sell' → bid ladder
 *   longExchange  → we BUY  that perp  → side 'buy'  → ask ladder
 * `now` is supplied by the caller so leg-order.ts stays clockless and testable.
 */
export function dryRunLegOrder(
  coin: string,
  shortExchange: string,
  longExchange: string,
  now: number = Date.now(),
  maxAgeMs: number = DEFAULT_LADDER_MAX_AGE_MS,
): LegOrderDryRun {
  if (!coin || !shortExchange || !longExchange) return unusable('row is missing a coin or a venue')

  const sidecar = readSidecar()
  if (!sidecar) return unusable('no persisted depth available (sidecar unreadable)')

  const shortKey = `${coin}|${shortExchange}`
  const longKey  = `${coin}|${longExchange}`
  const sBook = sidecar.books[shortKey]
  const lBook = sidecar.books[longKey]

  const missing = [!sBook && shortKey, !lBook && longKey].filter(Boolean)
  // Read naturally: the sidecar key is "COIN|venue"; users see "COIN on venue". Venue ids
  // stay verbatim (no title-casing — it would render "Edgex"/"Gateio" for edgeX/Gate.io).
  if (missing.length) {
    const shown = missing.map(k => String(k).replace('|', ' on ')).join(' and ')
    return unusable(`no persisted depth for ${shown}`)
  }

  // Size in coins, from a REAL venue mid — never a guess. Derived from the short leg's mid.
  const mid = sBook.mid
  if (!Number.isFinite(mid) || mid <= 0) return unusable(`no usable mid for ${shortKey}`)
  const qty = DRY_RUN_NOTIONAL_USD / mid

  const legs = [
    legFromLadder(`${shortExchange} · sell`, 'sell', toTimestamped(sBook, 'sell'), now, maxAgeMs),
    legFromLadder(`${longExchange} · buy`,   'buy',  toTimestamped(lBook, 'buy'),  now, maxAgeMs),
  ]

  const r = rankLegs(legs, qty)
  const ages = [sBook.fetchedAt, lBook.fetchedAt]
    .filter(t => Number.isFinite(t))
    .map(t => now - t)

  return {
    notionalUsd: DRY_RUN_NOTIONAL_USD,
    qty: r6(qty),
    qtyFrom: shortKey,
    usable: r.usable,
    executableAtSize: r.executableAtSize,
    reason: r.reason,
    firstLegId: r.usable && r.order && r.order.length ? r.order[0].id : null,
    ties: r.ties,
    legs: r.legs.map(project),
    ladderAgeMs: ages.length ? Math.max(...ages) : null,
  }
}

// ── Perp-vs-Spot (delta-neutral carry) ───────────────────────────────────────
//
// The lane's two legs are NOT symmetric in what we have persisted:
//   PERP leg  — shortVenue's perp book IS in the sidecar (agent15 persists it).
//   SPOT  leg — NO spot ladder is persisted anywhere. agent10 walks the spot book to
//               produce spotCapacityUsd, but keeps only that scalar (agent28 line 90);
//               /tmp/perp-spot.json carries spotBid/spotAsk/spotBookAt and no levels.
//
// The sidecar DOES hold `COIN|binance` — but its own note says "perp order-book ladders".
// That is binance's PERP book, a different instrument from binance SPOT. Ranking the spot
// leg against it would be a fabricated ladder, so the spot leg is passed no ladder at all
// and comes back UNKNOWN. The perp leg still reports real, measured evidence; the ordering
// as a whole is unusable, which is the honest answer until the spot ladder is persisted.
export function dryRunPerpSpotLegOrder(
  coin: string,
  perpVenue: string,
  spotVenue: string | null,
  now: number = Date.now(),
  maxAgeMs: number = DEFAULT_LADDER_MAX_AGE_MS,
): LegOrderDryRun {
  if (!coin || !perpVenue) return unusable('row is missing a coin or a perp venue')

  const sidecar = readSidecar()
  if (!sidecar) return unusable('no persisted depth available (sidecar unreadable)')

  const perpKey = `${coin}|${perpVenue}`
  const pBook = sidecar.books[perpKey]
  if (!pBook) return unusable(`no persisted depth for ${coin} on ${perpVenue}`)

  const mid = pBook.mid
  if (!Number.isFinite(mid) || mid <= 0) return unusable(`no usable mid for ${perpKey}`)
  const qty = DRY_RUN_NOTIONAL_USD / mid

  // Short the perp → SELL into its bids. Buy the spot hedge → would cross the spot asks,
  // which we have not persisted, so: no ladder → stale → UNKNOWN (never the perp book).
  const legs = [
    legFromLadder(`${perpVenue} · sell perp`, 'sell', toTimestamped(pBook, 'sell'), now, maxAgeMs),
    legFromLadder(`${spotVenue ?? 'spot'} · buy spot`, 'buy', null, now, maxAgeMs),
  ]

  const r = rankLegs(legs, qty)
  // Name the specific gap so the refusal is actionable — but derive it from the ACTUAL
  // ranking outcome, never from the assumption that the perp leg ranked. A stale perp
  // ladder makes that leg UNKNOWN too, and reporting it as "measured" would be a lie.
  const perpMeasured = r.legs[0]?.outcome !== 'unknown'
  const spotName = spotVenue ?? 'the spot venue'
  const reason = r.usable
    ? r.reason
    : perpMeasured
      ? `spot depth is not persisted for ${spotName} — perp leg measured, spot leg not`
      : `no usable depth: ${perpVenue}'s ladder is stale, and spot depth is not persisted for ${spotName}`

  return {
    notionalUsd: DRY_RUN_NOTIONAL_USD,
    qty: r6(qty),
    qtyFrom: perpKey,
    usable: r.usable,
    executableAtSize: r.executableAtSize,
    reason,
    firstLegId: r.usable && r.order && r.order.length ? r.order[0].id : null,
    ties: r.ties,
    legs: r.legs.map(project),
    ladderAgeMs: Number.isFinite(pBook.fetchedAt) ? now - pBook.fetchedAt : null,
  }
}
