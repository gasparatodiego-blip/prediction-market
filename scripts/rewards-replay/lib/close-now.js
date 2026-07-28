'use strict';
// scripts/rewards-replay/lib/close-now.js — the IMMEDIATE-CLOSE inventory policy.
//
// The HOLD policy (markout.js) leaves directional inventory after a fill and measures the +5m mark-to-market
// as an unrealised cost. CLOSE-NOW instead EXITS the position the instant a fill is confirmed, and measures
// the REALISED cost of crossing the spread against the REAL observed book at the fill instant.
//
// EXIT MODEL (real book from the journal row nearest the fill): the journal carries a `levels` ladder
// (bidPrice/bidSizeAtLevel, askPrice/askSizeAtLevel, 1–32 levels) PLUS the aggregate in-band depth
// (bidDepthInBand/askDepthInBand). We walk the explicit ladder best-first, then, if the shown levels do not
// hold all the in-band size, add a single RESIDUAL tranche at the worst in-band price (bandLow for a sell,
// bandHigh for a buy). If the size still cannot be absorbed, the position is NOT closed — the remainder is
// reported STUCK, never assumed filled.
//
// LONG-ONLY / NAKED-SHORT GUARD: a BUY fill produces YES inventory, so closing it (a SELL into the bid) is
// backed. A SELL fill would require ERC-1155 YES inventory to have been delivered; under immediate-close we
// hold ~0, so a sell with no backing is a NAKED SHORT and is REFUSED (flagged, never modelled as a fill the
// book cannot support). Realised P&L is booked only over closeable (backed) fills.
//
// Offline; models nothing on-chain; places/signs nothing.

const { rowNear } = require('./journal');

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

/**
 * Build a walkable ladder from a journal row. side 'bid' (to SELL into) sorts high→low; 'ask' (to BUY into)
 * sorts low→high. A residual tranche for in-band depth not shown in `levels` is appended at the worst
 * in-band price (bandLow for bids, bandHigh for asks). Returns [{ price, size, residual? }].
 */
function ladderFromRow(row, side) {
  if (!row) return [];
  const levels = Array.isArray(row.levels) ? row.levels : [];
  let lad;
  if (side === 'bid') {
    lad = levels.filter((l) => fin(l.bidPrice) && fin(l.bidSizeAtLevel) && l.bidSizeAtLevel > 0).map((l) => ({ price: l.bidPrice, size: l.bidSizeAtLevel }));
    lad.sort((a, b) => b.price - a.price); // best (highest) first
    if (fin(row.bidDepthInBand) && fin(row.bandLow)) {
      const shownInBand = lad.filter((x) => x.price >= row.bandLow - 1e-9).reduce((s, x) => s + x.size, 0);
      const residual = row.bidDepthInBand - shownInBand;
      if (residual > 1e-6) lad.push({ price: row.bandLow, size: residual, residual: true });
    }
  } else {
    lad = levels.filter((l) => fin(l.askPrice) && fin(l.askSizeAtLevel) && l.askSizeAtLevel > 0).map((l) => ({ price: l.askPrice, size: l.askSizeAtLevel }));
    lad.sort((a, b) => a.price - b.price); // best (lowest) first
    if (fin(row.askDepthInBand) && fin(row.bandHigh)) {
      const shownInBand = lad.filter((x) => x.price <= row.bandHigh + 1e-9).reduce((s, x) => s + x.size, 0);
      const residual = row.askDepthInBand - shownInBand;
      if (residual > 1e-6) lad.push({ price: row.bandHigh, size: residual, residual: true });
    }
  }
  return lad;
}

/** Walk `size` shares through a price-ordered ladder. Returns filled/notional/avgPrice/stuck + the tranches. */
function walk(ladder, size) {
  let remaining = size, notional = 0, filled = 0;
  const tranches = [];
  for (const lvl of ladder) {
    if (remaining <= 1e-9) break;
    const take = Math.min(remaining, lvl.size);
    notional += take * lvl.price; filled += take; remaining -= take;
    tranches.push({ price: lvl.price, size: take, residual: !!lvl.residual });
  }
  return { filled, notional, avgPrice: filled > 0 ? notional / filled : null, stuck: Math.max(0, size - filled), tranches };
}

/**
 * Close ONE fill immediately and independently against the book `row`.
 *  • BUY fill  → long: SELL `sizeShares` into the bids. realisedPnL = proceeds − sizeShares·orderPrice
 *    (≤0 when we cross down); spreadPaid = −realisedPnL of the closed portion (≥0). Stuck = size the book
 *    could not absorb (still held long).
 *  • SELL fill → needs YES inventory to have been delivered. `opts.held` (default 0, immediate-close) backs
 *    up to that many shares; the rest is a NAKED SHORT and is REFUSED (realisedPnL/spread null).
 */
function closeFill(fill, row, opts = {}) {
  const shares = fill.sizeShares, orderPrice = fill.price;
  if (!fin(shares) || shares <= 0) return { ok: false, reason: 'bad size' };
  if (!row) return { ok: false, reason: 'no book at fill instant' };
  if (fill.side === 'buy') {
    const lad = ladderFromRow(row, 'bid');
    if (!lad.length) return { ok: false, reason: 'no bid book' };
    const w = walk(lad, shares);
    const closed = w.filled, proceeds = w.notional, costBasis = closed * orderPrice;
    return {
      ok: true, side: 'buy', shares, orderPrice, closedShares: closed, stuckShares: w.stuck, stuck: w.stuck > 1e-6,
      exitAvg: w.avgPrice, proceeds, costBasis, realisedPnL: proceeds - costBasis, spreadPaid: costBasis - proceeds,
      naked: false, tranches: w.tranches,
    };
  }
  // sell fill
  const held = fin(opts.held) ? Math.max(0, opts.held) : 0;
  const backed = Math.min(held, shares);
  const naked = shares - backed;
  return {
    ok: true, side: 'sell', shares, orderPrice, backedShares: backed, nakedShares: naked,
    naked: naked > 1e-6, refused: naked > 1e-6,
    realisedPnL: null, spreadPaid: null, // backed portion needs a cost basis we do not carry per-fill; naked refused
    reason: naked > 1e-6 ? 'sell needs ERC-1155 YES inventory; under immediate-close held≈0 ⇒ naked short refused' : 'backed by held inventory',
  };
}

/**
 * Apply CLOSE-NOW to a set of fills, using each fill's nearest journal row as the exit book. Immediate-close
 * holds no standing inventory (opts.held defaults 0), so sell fills are naked-refused. Returns per-fill
 * results, per-market spreadPaid (for the allocator), and an aggregate.
 */
function closeNowPolicy(fills, journalByMarket, opts = {}) {
  const tol = fin(opts.toleranceMs) ? opts.toleranceMs : 40_000;
  const sorted = [...fills].sort((a, b) => a.tsMs - b.tsMs);
  const agg = { fills: 0, closed: 0, partiallyStuck: 0, stuck: 0, nakedRefused: 0, noBook: 0, spreadPaid: 0, realisedPnL: 0, stuckShares: 0 };
  const spreadByMarket = new Map();
  const results = [];
  for (const f of sorted) {
    agg.fills++;
    const rows = journalByMarket.get(f.marketId) || [];
    const row = rowNear(rows, f.tsMs, tol);
    const res = closeFill(f, row, { held: 0 });
    if (!res.ok) { agg.noBook++; results.push({ fill: f, res }); continue; }
    if (res.side === 'buy') {
      agg.spreadPaid += res.spreadPaid; agg.realisedPnL += res.realisedPnL;
      spreadByMarket.set(f.marketId, (spreadByMarket.get(f.marketId) || 0) + res.spreadPaid);
      if (res.stuck) { agg.stuck++; agg.stuckShares += res.stuckShares; if (res.closedShares > 1e-6) agg.partiallyStuck++; }
      else agg.closed++;
    } else if (res.refused) {
      agg.nakedRefused++;
    }
    results.push({ fill: f, res });
  }
  return { aggregate: agg, spreadByMarket, results };
}

module.exports = { ladderFromRow, walk, closeFill, closeNowPolicy };
