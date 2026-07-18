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
// agent10's SPOT ladder sidecar — same shape, separate file because agent15 rewrites the
// perp sidecar wholesale every cycle and the two writers must not race.
const SPOT_BOOKS_FILE = process.env.SPOT_BOOKS_FILE || '/tmp/spot-books.json'

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
let _spotCache: { mtimeMs: number; sidecar: Sidecar } | null = null

/** Reads a sidecar, memoized on mtime so repeated rows in one request parse it once. */
function readSidecarFile(file: string, cache: { mtimeMs: number; sidecar: Sidecar } | null):
  { sidecar: Sidecar | null; cache: { mtimeMs: number; sidecar: Sidecar } | null } {
  try {
    const st = fs.statSync(file)
    if (cache && cache.mtimeMs === st.mtimeMs) return { sidecar: cache.sidecar, cache }
    const sidecar = JSON.parse(fs.readFileSync(file, 'utf8')) as Sidecar
    if (!sidecar || typeof sidecar.books !== 'object' || sidecar.books === null) return { sidecar: null, cache }
    return { sidecar, cache: { mtimeMs: st.mtimeMs, sidecar } }
  } catch {
    return { sidecar: null, cache }   // no sidecar → every row is unusable, stated as such
  }
}

function readSidecar(): Sidecar | null {
  const r = readSidecarFile(BOOKS_FILE, _cache)
  _cache = r.cache
  return r.sidecar
}

/** agent10's spot ladders. Absent → the spot leg stays UNKNOWN, exactly as before. */
function readSpotSidecar(): Sidecar | null {
  const r = readSidecarFile(SPOT_BOOKS_FILE, _spotCache)
  _spotCache = r.cache
  return r.sidecar
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

  // Short the perp → SELL into its bids. Buy the spot hedge → cross the SPOT asks, from
  // agent10's spot sidecar. Strictly the spot book for that venue: the perp sidecar's
  // `COIN|binance` is binance's PERP book, a different instrument, and is never
  // substituted here. No spot ladder → no ladder passed → UNKNOWN, exactly as before.
  const spotSidecar = readSpotSidecar()
  const sBook = spotVenue ? spotSidecar?.books[`${coin}|${spotVenue}`] : undefined

  const legs = [
    legFromLadder(`${perpVenue} · sell perp`, 'sell', toTimestamped(pBook, 'sell'), now, maxAgeMs),
    legFromLadder(`${spotVenue ?? 'spot'} · buy spot`, 'buy', toTimestamped(sBook, 'buy'), now, maxAgeMs),
  ]

  const r = rankLegs(legs, qty)
  // Name the specific gap so the refusal is actionable — but derive it from the ACTUAL
  // ranking outcome, never from the assumption that a leg ranked. A stale ladder makes its
  // leg UNKNOWN too, and reporting it as "measured" would be a lie.
  const perpUnknown = r.legs[0]?.outcome === 'unknown'
  const spotUnknown = r.legs[1]?.outcome === 'unknown'
  const spotName = spotVenue ?? 'the spot venue'
  // Name the COIN too: the venue is usually covered and it is this coin's spot book that
  // is not walked, which "no spot depth for binance" would misstate as a dead venue.
  const spotWhy = !sBook ? `no persisted spot depth for ${coin} on ${spotName}` : `${spotName}'s spot ladder for ${coin} is too stale to rank`
  const reason = r.usable
    ? r.reason
    : perpUnknown && spotUnknown ? `no usable depth: ${perpVenue}'s perp ladder is stale, and ${spotWhy}`
      : perpUnknown             ? `${perpVenue}'s perp ladder is too stale to rank`
      :                           spotWhy

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
    // Oldest of the ladders actually used — the perp book alone when no spot ladder was
    // found, both once the spot sidecar covers this venue.
    ladderAgeMs: (() => {
      const ages = [pBook.fetchedAt, sBook?.fetchedAt]
        .filter((t): t is number => Number.isFinite(t as number))
        .map(t => now - t)
      return ages.length ? Math.max(...ages) : null
    })(),
  }
}

// ── USDC-margined divergence ─────────────────────────────────────────────────
//
// Mixed-margin lane: a USDC-margined leg against either another USDC-margined leg or a
// USDT-margined one. agent15's sidecar holds ONLY USDT-margined perp books, so:
//   USDT leg → real persisted ladder (keyed COIN|venue), real evidence.
//   USDC leg → nothing persisted. `bitget-usdc` is a DIFFERENT INSTRUMENT from `bitget`
//              with its own book; silently falling back to the USDT sibling would fabricate
//              depth for a contract we never read. So it is passed no ladder → UNKNOWN.
//
// Consequence today: every row is unusable, because every row has at least one USDC leg.
// The USDT leg's evidence is still real and still shown.
export function dryRunUsdcLegOrder(
  coin: string,
  shortVenue: string,
  shortMargin: string,
  longVenue: string,
  longMargin: string,
  now: number = Date.now(),
  maxAgeMs: number = DEFAULT_LADDER_MAX_AGE_MS,
): LegOrderDryRun {
  if (!coin || !shortVenue || !longVenue) return unusable('row is missing a coin or a venue')

  const sidecar = readSidecar()
  if (!sidecar) return unusable('no persisted depth available (sidecar unreadable)')

  // A leg is measurable only when it is USDT-margined AND its book is in the sidecar.
  // USDC-margined legs are never looked up — there is no USDC book to look up.
  const resolve = (venue: string, margin: string): SidecarLadder | null =>
    margin === 'USDT' ? (sidecar.books[`${coin}|${venue}`] ?? null) : null

  const sBook = resolve(shortVenue, shortMargin)
  const lBook = resolve(longVenue, longMargin)

  // Size off whichever leg gave us a real venue mid; with neither, the notional stands
  // alone and qty stays null rather than being guessed off a mark price.
  const midFrom = sBook && Number.isFinite(sBook.mid) && sBook.mid > 0
    ? { book: sBook, key: `${coin}|${shortVenue}` }
    : lBook && Number.isFinite(lBook.mid) && lBook.mid > 0
      ? { book: lBook, key: `${coin}|${longVenue}` }
      : null

  const legs = [
    legFromLadder(`${shortVenue} · sell`, 'sell', toTimestamped(sBook ?? undefined, 'sell'), now, maxAgeMs),
    legFromLadder(`${longVenue} · buy`,   'buy',  toTimestamped(lBook ?? undefined, 'buy'),  now, maxAgeMs),
  ]

  const qty = midFrom ? DRY_RUN_NOTIONAL_USD / midFrom.book.mid : null
  const r = rankLegs(legs, qty ?? 0)
  const ages = [sBook?.fetchedAt, lBook?.fetchedAt]
    .filter((t): t is number => Number.isFinite(t as number))
    .map(t => now - t)

  // Explain each leg we could not measure, keyed off the ACTUAL ranking outcome rather
  // than off book presence — a USDT ladder that is present but stale is still unmeasured,
  // and must be named as such instead of being silently treated as fine.
  const why = (venue: string, margin: string, book: SidecarLadder | null) =>
    margin !== 'USDT' ? `${venue} (USDC-margined — no book persisted)`
      : !book          ? `${venue} (no persisted ladder)`
      :                  `${venue} (ladder too stale to rank)`
  const unmeasured = [
    r.legs[0]?.outcome === 'unknown' ? why(shortVenue, shortMargin, sBook) : null,
    r.legs[1]?.outcome === 'unknown' ? why(longVenue, longMargin, lBook) : null,
  ].filter(Boolean)

  return {
    notionalUsd: DRY_RUN_NOTIONAL_USD,
    qty: r6(qty),
    qtyFrom: midFrom ? midFrom.key : null,
    usable: r.usable,
    executableAtSize: r.executableAtSize,
    reason: r.usable ? r.reason : `no persisted depth for ${unmeasured.join(' and ')}`,
    firstLegId: r.usable && r.order && r.order.length ? r.order[0].id : null,
    ties: r.ties,
    legs: r.legs.map(project),
    ladderAgeMs: ages.length ? Math.max(...ages) : null,
  }
}
