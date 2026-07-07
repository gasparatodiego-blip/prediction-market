'use strict';

/**
 * contract-liveness — dead / illiquid / cap-pinned contract detection.
 *
 * Shared by the funding pipeline (agent15 perp-vs-perp) and the perp-spot feed
 * (agent28). Honest-engine rule: a funding rate or price coming from a market that
 * is not actually trading — zero 24h volume, a frozen/stale feed, a price nowhere
 * near its peers, or funding clamped at the exchange's cap on a market nobody
 * trades — is a FABRICATED number. It must be excluded BEFORE it reaches any card
 * or annualized figure, and NEVER silently: every exclusion is returned with a
 * reason string the caller logs once per cycle.
 *
 * Inputs are ONLY fields already present in /tmp/exchange-prices.json (written by
 * agent10) plus the settled-funding ring buffer (agent15). NO new venue API calls.
 * Where a venue's payload carries no signal for a given rule, that rule is simply
 * not evaluated for that venue (left ungated) — liveness is never guessed.
 *
 * Liveness fields actually present per venue in exchange-prices.json futures[venue][coin]
 * (audited live 2026-07-07 — drives which rules can fire where):
 *   markPrice           — ALL venues  → rule (c) frozen-price (cross-venue median)
 *   fundingRate/interval — ALL venues  → rule (d) input (with ring buffer)
 *   vol24hUsd           — binance,bybit,dydx,bitget,aster,paradex,edgex,extended,
 *                         pacifica,apex (NULL for okx,gateio,lighter,hyperliquid)
 *                                       → rule (a) zero-volume (only when a hard 0)
 *   nextFundingTime     — binance,aster,hyperliquid,extended,apex (edgeX sometimes)
 *                                       → rule (b) stalled funding clock
 *   openInterestUsd     — most DEXes + bybit,bitget,paradex,edgex,grvt,pacifica,apex
 *                         (not a liveness signal on its own — a dead contract can
 *                          retain OI; used only for context, never to gate)
 * There is NO last-trade timestamp and NO separate index/oracle price in the
 * post-agent10 payload, so rule (b) relies on nextFundingTime and rule (c) on the
 * cross-venue mark median rather than a same-venue mark-vs-index gap.
 */

// ── Tunable thresholds (change only with explicit approval — honest-engine) ─────
const STALE_FEED_MS     = 24 * 60 * 60_000;   // (b) nextFundingTime older than this ⇒ funding clock stalled
const FROZEN_MARK_PCT   = 2.0;                // (c) |mark − peer median| / median > this % ⇒ frozen/broken price
const MIN_PEERS_FOR_MED = 3;                  // (c) need ≥ this many peer marks before trusting the median
const CAP_PIN_CONSEC    = 2;                  // (d) ≥ this many identical most-recent settlements ⇒ pinned at cap
const CAP_PIN_ANN_PCT   = 200;                // (d) …AND |annualized| beyond this %/yr ⇒ extreme cap (matches display cap)
const CAP_PIN_EPS       = 1e-9;               // (d) float-equality tolerance for "identical" settled rates

// rate is %/interval (already ×100 in exchange-prices.json). 24/h intervals per day.
function annualizePct(ratePerInterval, intervalHours) {
  const h = intervalHours > 0 ? intervalHours : 8;
  return ratePerInterval * (24 / h) * 365;
}

function median(arr) {
  const s = arr.filter(v => typeof v === 'number' && isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * @param {string} venue  exchange key (e.g. 'edgex')
 * @param {string} coin   e.g. 'TRX'
 * @param {object} data   futures[venue][coin] = { fundingRate, fundingIntervalHours, markPrice, vol24hUsd?, nextFundingTime? }
 * @param {Array}  hist   settled ring-buffer for (venue,coin): [{ t, rate }] newest-first (may be empty)
 * @param {object} ctx    { now?:number, peerMarks?:number[] } peerMarks = other venues' markPrice for this coin (rule c)
 * @returns {{ dead: boolean, reason: string|null }}
 */
function isDeadContract(venue, coin, data, hist, ctx = {}) {
  if (!data || typeof data !== 'object') return { dead: false, reason: null };
  const now = typeof ctx.now === 'number' ? ctx.now : 0;

  // (a) explicit zero 24h volume. NULL/undefined means "venue does not report volume"
  //     (okx, gateio, lighter, hyperliquid) — NOT dead; only a hard 0 counts. Venues
  //     that DO report it (edgeX, binance, bybit, …) returning exactly 0 is a real
  //     no-trade signal.
  if (data.vol24hUsd === 0) {
    return { dead: true, reason: 'zero 24h volume' };
  }

  // (b) stalled funding clock: the venue publishes nextFundingTime but it is already
  //     > STALE_FEED_MS in the past ⇒ the feed stopped advancing. Only venues that
  //     expose nextFundingTime are gated; others left ungated.
  if (now && typeof data.nextFundingTime === 'number' && data.nextFundingTime > 0 &&
      (now - data.nextFundingTime) > STALE_FEED_MS) {
    const staleH = Math.round((now - data.nextFundingTime) / 3_600_000);
    return { dead: true, reason: `funding clock stalled (nextFundingTime ${staleH}h in the past)` };
  }

  // (c) frozen/broken price: this venue's mark deviates > FROZEN_MARK_PCT from the median
  //     of its peers' marks for the same coin (peers = marks already fetched for other
  //     venues, no new API call). Needs ≥ MIN_PEERS_FOR_MED peers so a single-venue coin
  //     or a thin peer set can't trigger a false positive.
  const peers = Array.isArray(ctx.peerMarks)
    ? ctx.peerMarks.filter(m => typeof m === 'number' && isFinite(m) && m > 0)
    : [];
  if (typeof data.markPrice === 'number' && isFinite(data.markPrice) && data.markPrice > 0 &&
      peers.length >= MIN_PEERS_FOR_MED) {
    const med = median(peers);
    if (med && med > 0) {
      const devPct = Math.abs(data.markPrice - med) / med * 100;
      if (devPct > FROZEN_MARK_PCT) {
        return { dead: true, reason: `frozen price (mark ${data.markPrice} is ${devPct.toFixed(1)}% off peer median ${med})` };
      }
    }
  }

  // (d) funding pinned at an extreme cap: the most-recent CAP_PIN_CONSEC settled rates are
  //     identical to float precision AND that value annualizes beyond CAP_PIN_ANN_PCT. Real
  //     funding never lands on the exact same value twice by chance; identical extremes =
  //     the venue clamping to its funding cap on a market that isn't trading (the edgeX TRX
  //     signature: -0.1875%/4h ⇒ -411%/yr, seen twice in a row). The |ann| gate spares
  //     legitimate small caps repeatedly hit (e.g. +0.01%/8h ⇒ +11%/yr, never flagged).
  const rates = Array.isArray(hist)
    ? hist.map(p => (typeof p === 'number' ? p : (p && p.rate))).filter(v => typeof v === 'number' && isFinite(v))
    : [];
  if (rates.length >= CAP_PIN_CONSEC) {
    const head = rates.slice(0, CAP_PIN_CONSEC);
    const allEqual = head.every(r => Math.abs(r - head[0]) <= CAP_PIN_EPS);
    const intervalH = typeof data.fundingIntervalHours === 'number' && data.fundingIntervalHours > 0
      ? data.fundingIntervalHours : 8;
    const ann = annualizePct(head[0], intervalH);
    if (allEqual && Math.abs(ann) > CAP_PIN_ANN_PCT) {
      return { dead: true, reason: `funding pinned at cap ${head[0]}%/${intervalH}h for ${CAP_PIN_CONSEC}+ settlements (${ann.toFixed(0)}%/yr)` };
    }
  }

  return { dead: false, reason: null };
}

/**
 * Build a coin → [markPrice, …] map across all venues, for rule (c) peer medians.
 * @param {object} futures  futures[venue][coin] = { markPrice, … }
 */
function buildPeerMarks(futures) {
  const byCoin = {};
  for (const coins of Object.values(futures || {})) {
    for (const [coin, d] of Object.entries(coins || {})) {
      const m = d && d.markPrice;
      if (typeof m === 'number' && isFinite(m) && m > 0) {
        (byCoin[coin] || (byCoin[coin] = [])).push(m);
      }
    }
  }
  return byCoin;
}

module.exports = {
  isDeadContract,
  buildPeerMarks,
  annualizePct,
  median,
  _consts: { STALE_FEED_MS, FROZEN_MARK_PCT, MIN_PEERS_FOR_MED, CAP_PIN_CONSEC, CAP_PIN_ANN_PCT, CAP_PIN_EPS },
};
