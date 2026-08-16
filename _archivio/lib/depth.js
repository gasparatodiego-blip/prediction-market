'use strict';

// Single source of truth for order-book ladder extraction + capacity walk.
// Both the discovery matcher (matcher-v2.js) and the live re-pricer (agent23)
// import from here so capacity numbers can never diverge between tiers.
//
// Kalshi orderbook_fp: { yes_dollars: [["price$","qty"],...], no_dollars: [[...]] }
//   yes_dollars = YES bids (buyers); no_dollars = NO bids (buyers)
//   YES ask derived from NO bids: ask = 1 - no_bid_price
//   NO  ask derived from YES bids: no_ask = 1 - yes_bid_price
//
// Polymarket CLOB: { bids: [{price,size},...], asks: [{price,size},...] }
//   asks[] = YES ask prices (ascending); bids[] = YES bid prices (descending)
//   NO ask prices derived from YES bids: no_ask = 1 - bid_price
//
// All ladders returned by the functions below are EXECUTABLE-side only (the
// price you'd actually pay to acquire the position), sorted best price first.

function laddersFromKalshiBook(book) {
  if (!book) return { yesAsks: [], noAsks: [] };

  const noBids = (book.no_dollars || [])
    .map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }))
    .sort((a, b) => b.price - a.price);
  const yesAsks = noBids
    .map(x => ({ price: 1 - x.price, qty: x.qty }))
    .filter(x => x.price > 0 && x.price < 1);

  const yesBids = (book.yes_dollars || [])
    .map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }))
    .sort((a, b) => b.price - a.price);
  const noAsks = yesBids
    .map(x => ({ price: 1 - x.price, qty: x.qty }))
    .filter(x => x.price > 0 && x.price < 1);

  return { yesAsks, noAsks };
}

function laddersFromPmBook(book) {
  if (!book) return { yesAsks: [], noAsks: [] };

  const yesAsks = (book.asks || [])
    .map(a => ({ price: parseFloat(a.price), qty: parseFloat(a.size) }))
    .filter(x => x.price > 0 && x.price < 1 && x.qty > 0)
    .sort((a, b) => a.price - b.price);

  const yesBids = (book.bids || [])
    .map(b => ({ price: parseFloat(b.price), qty: parseFloat(b.size) }))
    .filter(x => x.price > 0 && x.price < 1 && x.qty > 0)
    .sort((a, b) => b.price - a.price);
  const noAsks = yesBids.map(b => ({ price: 1 - b.price, qty: b.qty }));

  return { yesAsks, noAsks };
}

function laddersForLeg(platform, kalshiBook, pmBook) {
  if (platform === 'kalshi')     return laddersFromKalshiBook(kalshiBook);
  if (platform === 'polymarket') return laddersFromPmBook(pmBook);
  return { yesAsks: [], noAsks: [] }; // Manifold/PredictIt: no order book exists
}

// Walks the YES-ask ladder of one leg against the NO-ask ladder of the other,
// accumulating $ deployed until the combined per-unit cost reaches $1.00
// (breakeven). Assumption: each level fills fully at its quoted price before
// moving to the next (no intra-level slippage beyond the level's own price;
// no fee/slippage buffer beyond the $1.00 breakeven test itself).
// Returns total $ deployable across both legs combined, or null if either
// leg has no executable ladder (no book — e.g. Manifold/PredictIt).
function computeCapacity(yesLeg, noLeg, kalshiBook, pmBook) {
  const { yesAsks } = laddersForLeg(yesLeg.platform, kalshiBook, pmBook);
  const { noAsks }  = laddersForLeg(noLeg.platform,  kalshiBook, pmBook);

  if (yesAsks.length === 0 || noAsks.length === 0) return null;

  let totalDeployed = 0;
  let yi = 0, ni = 0;
  let yqty = yesAsks[0].qty, nqty = noAsks[0].qty;

  while (yi < yesAsks.length && ni < noAsks.length) {
    const yP = yesAsks[yi].price;
    const nP = noAsks[ni].price;
    if (yP + nP >= 1.00) break;
    const stepQty = Math.min(yqty, nqty);
    totalDeployed += stepQty * (yP + nP);
    yqty -= stepQty;
    nqty -= stepQty;
    if (yqty < 1e-8) { yi++; if (yi < yesAsks.length) yqty = yesAsks[yi].qty; }
    if (nqty < 1e-8) { ni++; if (ni < noAsks.length)  nqty = noAsks[ni].qty;  }
  }

  return totalDeployed > 0 ? +totalDeployed.toFixed(2) : 0;
}

// Normalizes a leg's own executable YES-ask ladder into the wire format used
// by the prediction API: price in cents (0-100), size in USD, best price
// first. Truncated to maxLevels — deeper levels are noise for a UI ladder.
function ladderToWireFormat(yesAsks, maxLevels = 5) {
  return yesAsks.slice(0, maxLevels).map(l => ({
    price:   +(l.price * 100).toFixed(2),
    sizeUsd: +l.qty.toFixed(2),
  }));
}

module.exports = {
  laddersFromKalshiBook,
  laddersFromPmBook,
  laddersForLeg,
  computeCapacity,
  ladderToWireFormat,
};
