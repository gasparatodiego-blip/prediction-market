'use strict';
// lib/maker/arm-preview.js — assemble the "what you're about to arm" summary from the maker's OWN computed
// state (/tmp/maker-state.json, which agent35 writes every cycle = EXACTLY what it would post). Pure and
// node-testable. Every number is a real read or "—"; if ANY market in the operating universe is missing a
// readable bid/ask/mid/size, readable=false and the caller BLOCKS arming — never a fabricated preview.

function num(x) { return typeof x === 'number' && Number.isFinite(x) ? x : null; }

/**
 * @param {object} makerState  parsed /tmp/maker-state.json (or null)
 * @param {object} opts  perSideSizeUsd, ttlSeconds, collateralCapUsd (from the arm form)
 * @returns {{readable, blockedReason, markets:[{marketId,title,mid,bid,ask,sizePerSideUsd,collateralUsd,readable}],
 *            totalCollateralUsd, perSideSizeUsd, ttlSeconds, collateralCapUsd}}
 */
function buildArmPreview(makerState, { perSideSizeUsd = null, ttlSeconds = null, collateralCapUsd = null } = {}) {
  const src = makerState && makerState.markets && typeof makerState.markets === 'object' ? makerState.markets : null;
  if (!src) {
    return { readable: false, blockedReason: 'maker state (/tmp/maker-state.json) is not readable — cannot preview what would be posted; arming blocked', markets: [], totalCollateralUsd: null, perSideSizeUsd, ttlSeconds, collateralCapUsd };
  }
  const markets = [];
  let anyUnreadable = false;
  let totalCollateral = 0, totalKnown = true;
  for (const [marketId, m] of Object.entries(src)) {
    const mid = num(m.mid);
    const legs = Array.isArray(m.legs) ? m.legs : [];
    // The maker's own leg target prices: the buy side IS the bid we'd rest, the sell side the ask.
    const buys = legs.filter((l) => l.side === 'BUY' && num(l.targetPrice) != null).map((l) => l.targetPrice);
    const sells = legs.filter((l) => l.side === 'SELL' && num(l.targetPrice) != null).map((l) => l.targetPrice);
    const bid = buys.length ? Math.max(...buys) : null;
    const ask = sells.length ? Math.min(...sells) : null;
    const legNotional = legs.map((l) => num(l.notionalUsd)).filter((v) => v != null);
    const sizePerSideUsd = perSideSizeUsd != null ? perSideSizeUsd : (legNotional.length ? Math.max(...legNotional) : null);
    const readable = mid != null && bid != null && ask != null && sizePerSideUsd != null;
    if (!readable) anyUnreadable = true;
    // Two-sided quote reserves collateral on both legs; one-sided on one.
    const sides = (bid != null && ask != null) ? 2 : (bid != null || ask != null ? 1 : 0);
    const collateralUsd = (sizePerSideUsd != null && sides > 0) ? sizePerSideUsd * sides : null;
    if (collateralUsd != null) totalCollateral += collateralUsd; else totalKnown = false;
    markets.push({ marketId, title: m.title || '', mid, bid, ask, sizePerSideUsd, collateralUsd, readable });
  }
  const readable = markets.length > 0 && !anyUnreadable && totalKnown;
  return {
    readable,
    blockedReason: readable ? null
      : (markets.length === 0 ? 'no markets in the operating universe — nothing to arm' : 'a market is missing a readable bid/ask/mid/size (shown "—") — arming blocked'),
    markets,
    totalCollateralUsd: totalKnown ? Number(totalCollateral.toFixed(2)) : null,
    perSideSizeUsd, ttlSeconds, collateralCapUsd,
  };
}

module.exports = { buildArmPreview };
