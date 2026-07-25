'use strict';
// scripts/rewards-ceiling/lib/gamma.js — read the collectable Polymarket reward universe from the
// PRIMARY SOURCE: Polymarket's Gamma markets API. Mirrors agent24's filter exactly (clobRewards[0].
// rewardsDailyRate > 0.01 AND rewardsMaxSpread > 0) so this analysis reads the same real pots the lane
// pays, straight from the venue — not from our own /tmp feed. Kalshi is a separate exchange and is not
// in Gamma, so this set IS the collectable (Polymarket-only) universe by construction.

const { getJson } = require('./fetch');

const GAMMA_ENDPOINT = 'https://gamma-api.polymarket.com/markets?active=true&closed=false';
const PAGE = 100;
const MAX_PAGES = 80; // 8000 active markets scanned — well beyond the ~hundreds that carry rewards

// Fetch every active reward market with a real published daily pot. Returns markets + a raw sample of the
// primary response (the FIRST reward market's untouched Gamma object) for the verification print.
async function fetchRewardMarkets() {
  const markets = [];
  let rawSample = null;
  let pagesScanned = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${GAMMA_ENDPOINT}&limit=${PAGE}&offset=${page * PAGE}`;
    const r = await getJson(url);
    pagesScanned++;
    if (r.status !== 200 || !Array.isArray(r.data) || r.data.length === 0) break;
    for (const m of r.data) {
      const cr = m.clobRewards;
      if (!cr || !cr.length) continue;
      const rate = parseFloat(cr[0].rewardsDailyRate);
      const maxSpread = parseFloat(m.rewardsMaxSpread);
      const minSize = parseFloat(m.rewardsMinSize);
      if (!rate || rate <= 0.01) continue;   // agent24's exact reward filter
      if (!maxSpread || maxSpread <= 0) continue;
      let tokenIds = [];
      try { tokenIds = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : (Array.isArray(m.clobTokenIds) ? m.clobTokenIds : []); } catch (_) {}
      if (!tokenIds.length) continue;
      if (!rawSample) rawSample = m;         // untouched primary object for the traceability print
      markets.push({
        conditionId: m.conditionId,
        question: m.question,
        rewardsDailyRate: rate,              // THE PUBLISHED DAILY POT ($/day) — primary source
        rewardsMaxSpread: maxSpread,         // cents (full band; radius = /2)
        rewardsMinSize: minSize || 0,        // shares (venue size cutoff)
        tokenIdYes: tokenIds[0],
        tokenIdNo: tokenIds[1] || null,
        endDate: m.endDate || null,
        bestBid: parseFloat(m.bestBid) || null,
        bestAsk: parseFloat(m.bestAsk) || null,
        lastTradePrice: parseFloat(m.lastTradePrice) || null,
      });
    }
    if (r.data.length < PAGE) break;
  }
  return { markets, rawSample, endpoint: GAMMA_ENDPOINT, pagesScanned };
}

module.exports = { fetchRewardMarkets, GAMMA_ENDPOINT };
