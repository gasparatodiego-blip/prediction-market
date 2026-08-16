'use strict';
// scripts/rewards-worstcase/lib/structural.js — PHASE 4: the STRUCTURAL maximum capital at risk, stated not
// simulated. No Monte Carlo, no fitted distribution, no VaR. These are hard bounds readable from the
// allocation, the price and the tick: if a resting $size order is fully filled on the LOSING side and the
// market resolves against it, the shares are worth $0 and the loss is the full $size. The RATIO of that
// bound to the daily reward is how many days of reward one adverse fill erases. The PROBABILITY of reaching
// the bound is UNMEASURED with 11 fills — and is deliberately not modelled.

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }
function clampPrice(p) { return Math.max(0.01, Math.min(0.99, p)); }

/**
 * Structural bound for one allocated market.
 * @returns { maxLoss, daysErased, orderShares, depthShares, orderVsDepth }
 *   maxLoss      = sizeUsd — one full adverse fill of the resting order, shares resolve to $0
 *   daysErased   = maxLoss / grossPerDay — days of THIS market's reward one adverse fill erases ("—" if gross 0)
 *   orderVsDepth = our order shares / observed in-band depth shares (our order enters the book, "—" if depth 0)
 */
function structuralBound({ sizeUsd, grossPerDay, mid, depthShares }) {
  const maxLoss = fin(sizeUsd) ? sizeUsd : null;
  const daysErased = (fin(maxLoss) && fin(grossPerDay) && grossPerDay > 0) ? maxLoss / grossPerDay : null;
  const orderShares = (fin(sizeUsd) && fin(mid)) ? sizeUsd / clampPrice(mid) : null;
  const orderVsDepth = (fin(orderShares) && fin(depthShares) && depthShares > 0) ? orderShares / depthShares : null;
  return { maxLoss, daysErased, orderShares, depthShares: fin(depthShares) ? depthShares : null, orderVsDepth };
}

/**
 * Portfolio structural bounds over the allocated markets.
 * @param bounds [{ maxLoss }], totalNetPerDay
 * @returns { portfolioMaxLoss, worstSingleMarketLoss, daysToRecoverSingle, daysToRecoverPortfolio }
 */
function portfolioBounds(bounds, totalNetPerDay) {
  const losses = bounds.map((b) => b.maxLoss).filter(fin);
  const portfolioMaxLoss = losses.reduce((s, x) => s + x, 0);          // every market adverse (absolute ceiling)
  const worstSingle = losses.length ? Math.max(...losses) : null;      // the single largest-order market
  const rec = (loss) => (fin(loss) && fin(totalNetPerDay) && totalNetPerDay > 0) ? loss / totalNetPerDay : null;
  return {
    portfolioMaxLoss: losses.length ? portfolioMaxLoss : null,
    worstSingleMarketLoss: worstSingle,
    daysToRecoverSingle: rec(worstSingle),
    daysToRecoverPortfolio: rec(portfolioMaxLoss),
  };
}

module.exports = { structuralBound, portfolioBounds };
