#!/usr/bin/env node
// agent24-liquidity-rewards.js — Polymarket Liquidity Reward Scanner
//
// Every 15 min:
//   1. Fetches all active Gamma markets with clobRewards[0].rewardsDailyRate > 0
//   2. For each, reads the CLOB order book.
//   3. Scores resting orders with Polymarket's exact quadratic formula:
//        S(v, s) = ((v - s) / v)^2,  v = rewardsMaxSpread/2 (cents), s = dist from mid (cents)
//      Q_competitors = Q_min(Q_bids, Q_asks) per the two-sided formula (c=3).
//   4. Estimates LP reward share for THREE capital levels: $500, $5k, $50k.
//        Typical placement: s = v/2 (half the half-band, S=0.25) — HEADLINE estimate.
//        Range: high = s=0.1¢ (near-mid floor, S≈0.91); low = s=0.8v (outer band, S=0.04).
//        share = Q_user / (Q_user + Q_competitors)  — ESTIMATE.
//   5. Classifies 24h mid-price volatility as LOW / MEDIUM / HIGH.
//   6. Applies sanity cap (>5%/day typical gross → THIN BOOK flag) and
//      floor (<$1/day typical gross → below-floor flag) PER CAPITAL LEVEL.
//   7. Writes /root/prediction-market/data/liquidity-rewards.json.
//   8. Prints formula verification + top 5 markets + gap sample + placement comparison.
//
// No Claude API. No order placement. Read-only. Deterministic.
'use strict';

const fs    = require('fs');
const https = require('https');
const { scoreBook, estimateCapitalLevelRange } = require('../lib/rewardScore');
const { categoryFromText } = require('../lib/category');
const { writeCombinedSnapshot } = require('../lib/rewards-normalize');

// ── Config ────────────────────────────────────────────────────────────────────
const SCAN_INTERVAL_MS  = 15 * 60_000;
const STARTUP_DELAY_MS  = 8_000;
const OUTPUT_FILE       = '/root/prediction-market/data/liquidity-rewards.json';
const MAX_RPS           = 1.5;
const CAPITAL_LEVELS    = [500, 5_000, 50_000];
const SANITY_CAP_PCT    = 2.0;   // %/day → THIN BOOK flag per level. Mirrors lib/reward-gating.ts REWARD_SANITY_CAP_PCT — keep in sync (this is a plain Node script, can't import the .ts file).
const FLOOR_DAILY_USD   = 1.0;   // $/day minimum gross; below = below-floor flag per level
const NEAR_EXPIRY_DAYS  = 14;    // markets closing within → force HIGH vol
const GAMMA_PAGE_SIZE   = 100;
const MAX_PAGES         = 21;    // offset 0..2000 (21 × 100)
const MAX_CLOB_MARKETS  = 120;   // top-N by rate for CLOB depth
const GAP_SHARE_THRESH  = 0.20;  // ≥20% estimated share at $500 → band is thinly covered

// ── Rate-limited HTTP queue ───────────────────────────────────────────────────
const _queue = [];
let _draining = false;

function httpGet(url, timeoutMs = 20_000) {
  return new Promise((res, rej) => {
    _queue.push({ url, timeoutMs, res, rej });
    if (!_draining) _drain();
  });
}

async function _drain() {
  _draining = true;
  while (_queue.length) {
    const { url, timeoutMs, res, rej } = _queue.shift();
    const t0 = Date.now();
    try   { res(await _rawGet(url, timeoutMs)); }
    catch (e) { rej(e); }
    const elapsed = Date.now() - t0;
    const gap     = Math.ceil(1000 / MAX_RPS) - elapsed;
    if (gap > 0) await sleep(gap);
  }
  _draining = false;
}

function _rawGet(url, ms) {
  return new Promise((res, rej) => {
    let settled = false;
    const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    // Hard wall-clock deadline — socket-inactivity timeout alone can't catch trickle-stalls
    const timer = setTimeout(() => {
      req.destroy();
      settle(rej, new Error('timeout'));
    }, ms);

    const req = https.get(url, r => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        clearTimeout(timer);
        const body = Buffer.concat(chunks).toString();
        try   { settle(res, { status: r.statusCode, data: JSON.parse(body) }); }
        catch (e) { settle(rej, new Error(`HTTP ${r.statusCode} / bad JSON: ${body.slice(0, 80)}`)); }
      });
    });
    req.on('error', e => { clearTimeout(timer); settle(rej, e); });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function atomicWrite(file, obj) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// ── Fetch reward-eligible markets from Gamma ──────────────────────────────────
async function fetchRewardMarkets() {
  const markets = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * GAMMA_PAGE_SIZE;
    const url    = `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=${GAMMA_PAGE_SIZE}&offset=${offset}`;
    let r;
    try { r = await httpGet(url); }
    catch (e) { console.warn(`  Gamma page ${page} error: ${e.message}`); break; }

    if (r.status !== 200 || !Array.isArray(r.data) || r.data.length === 0) break;

    for (const m of r.data) {
      const cr = m.clobRewards;
      if (!cr || !cr.length) continue;

      const rate      = parseFloat(cr[0].rewardsDailyRate);
      const maxSpread = parseFloat(m.rewardsMaxSpread);
      const minSize   = parseFloat(m.rewardsMinSize);

      if (!rate || rate <= 0.01) continue;
      if (!maxSpread || maxSpread <= 0) continue;

      let tokenIds = [];
      try {
        tokenIds = typeof m.clobTokenIds === 'string'
          ? JSON.parse(m.clobTokenIds)
          : (Array.isArray(m.clobTokenIds) ? m.clobTokenIds : []);
      } catch (_) {}

      if (!tokenIds.length) continue;

      markets.push({
        conditionId:      m.conditionId,
        // Polymarket deep-link needs the EVENT slug (…/event/<slug>), NOT the per-market
        // slug (which carries a numeric suffix and 404s on the SINGLE-segment /event/<slug>).
        // Gamma nests the event slug under events[0].slug. null when absent → no link.
        slug:             (Array.isArray(m.events) && m.events[0] && m.events[0].slug) || null,
        // Per-OUTCOME market slug (m.slug). On a multi-outcome (negRisk) event every outcome
        // shares one event slug but has its own m.slug — the real two-segment page is
        // …/event/<eventSlug>/<marketSlug>. Kept so the UI can deep-link the exact outcome
        // (e.g. the England leg of world-cup-winner) instead of the parent event page.
        marketSlug:       m.slug || null,
        // Human outcome label (e.g. "England", "No Prison Time") for the multi-outcome hint.
        groupItemTitle:   m.groupItemTitle || null,
        question:         m.question,
        rewardsDailyRate: rate,
        rewardsMinSize:   minSize || 0,
        rewardsMaxSpread: maxSpread,
        tokenId:          tokenIds[0],
        tokenIdNo:        tokenIds[1] || null,
        endDate:          m.endDate || null,
        lastTradePrice:   parseFloat(m.lastTradePrice) || 0,
        bestBid:          parseFloat(m.bestBid) || 0,
        bestAsk:          parseFloat(m.bestAsk) || 0,
        negRisk:          Boolean(m.negRisk),
        assetAddress:     cr[0].assetAddress,
      });
    }

    if (r.data.length < GAMMA_PAGE_SIZE) break;
  }

  return markets;
}

// ── Measure book depth + quadratic competitor score from CLOB ─────────────────
// Returns:
//   existingDepthUsd  — dollar notional (price×size) of in-band orders (UI display only)
//   Qbids, Qasks, Qmin — quadratic competitor scores (used for share estimation)
//   mid               — size-cutoff-adjusted midpoint
async function measureBookDepth(tokenId, rewardsMaxSpread, minSize, fallbackMid) {
  try {
    const r = await httpGet(`https://clob.polymarket.com/book?token_id=${tokenId}`);
    if (r.status !== 200 || !r.data) {
      return { mid: fallbackMid, existingDepthUsd: 0, bookSpread: null, emptyBook: true, Qbids: 0, Qasks: 0, Qmin: 0 };
    }

    const bids = (r.data.bids || [])
      .map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
      .filter(b => b.price > 0 && b.size > 0)
      .sort((a, b) => b.price - a.price);

    const asks = (r.data.asks || [])
      .map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
      .filter(a => a.price > 0 && a.size > 0)
      .sort((a, b) => a.price - b.price);

    if (!bids.length && !asks.length) {
      return { mid: fallbackMid, existingDepthUsd: 0, bookSpread: null, emptyBook: true, Qbids: 0, Qasks: 0, Qmin: 0 };
    }

    const bestBid  = bids.length ? bids[0].price : fallbackMid - 0.01;
    const bestAsk  = asks.length ? asks[0].price : fallbackMid + 0.01;
    const plainMid = (bestBid + bestAsk) / 2;
    const bookSprd = parseFloat((bestAsk - bestBid).toFixed(4));

    // Dollar notional (kept for UI display; NOT used for share math)
    const halfBand = rewardsMaxSpread / 2 / 100;
    const qBidsUsd = bids.filter(b => b.price >= plainMid - halfBand).reduce((acc, b) => acc + b.price * b.size, 0);
    const qAsksUsd = asks.filter(a => a.price <= plainMid + halfBand).reduce((acc, a) => acc + a.price * a.size, 0);
    const existingDepthUsd = Math.round(qBidsUsd + qAsksUsd);

    // Quadratic competitor scoring (the actual denominator for share estimates)
    const qs = scoreBook({ bids, asks }, rewardsMaxSpread, minSize, plainMid);

    return {
      mid:              qs.mid,
      bookSpread:       bookSprd,
      existingDepthUsd,
      emptyBook:        false,
      Qbids:            qs.Qbids,
      Qasks:            qs.Qasks,
      Qmin:             qs.Qmin,
    };
  } catch (e) {
    return { mid: fallbackMid, existingDepthUsd: 0, bookSpread: null, error: e.message, Qbids: 0, Qasks: 0, Qmin: 0 };
  }
}

// ── 24h price history → volatility stats ─────────────────────────────────────
async function measure24hVolatility(tokenId) {
  try {
    const now  = Math.floor(Date.now() / 1000);
    const from = now - 86400;
    const url  = `https://clob.polymarket.com/prices-history?market=${tokenId}&startTs=${from}&endTs=${now}&fidelity=120`;
    const r    = await httpGet(url);

    if (r.status !== 200 || !r.data?.history?.length) return { stdev: null, range: null, nPts: 0 };

    const prices = r.data.history.map(h => h.p);
    if (prices.length < 2) return { stdev: 0, range: 0, nPts: prices.length };

    const mean  = prices.reduce((s, p) => s + p, 0) / prices.length;
    const stdev = Math.sqrt(prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length);
    const range = Math.max(...prices) - Math.min(...prices);

    return {
      stdev: parseFloat(stdev.toFixed(5)),
      range: parseFloat(range.toFixed(4)),
      nPts:  prices.length,
    };
  } catch (e) {
    return { stdev: null, range: null, nPts: 0 };
  }
}

// ── Volatility risk classification ────────────────────────────────────────────
function classifyVol(stdev, range, endDateStr, rewardsMaxSpread) {
  const daysLeft = endDateStr ? (new Date(endDateStr) - Date.now()) / 86400_000 : 999;
  if (daysLeft <= NEAR_EXPIRY_DAYS) return 'HIGH';

  const v        = stdev ?? range ?? 0;
  const halfBand = rewardsMaxSpread / 2 / 100;

  if (v > halfBand)          return 'HIGH';
  if (v > halfBand * 0.25)   return 'MEDIUM';
  return 'LOW';
}

// ── Compute per-level estimates (quadratic scoring, three placement scenarios) ─
// Headline = typical (s=v/2, S=0.25).  Range: high (s=0.1¢) → low (s=0.8v).
// atMid (s=0, S=1.0) stored as _atMidShare for comparison output only.
function computeLevels(rewardsDailyRate, competitorQ, maxSpreadCents, minSize) {
  const levels = {};
  for (const C of CAPITAL_LEVELS) {
    const range  = estimateCapitalLevelRange(competitorQ, maxSpreadCents, minSize, rewardsDailyRate, C);
    const { typical, high, low, atMid } = range;
    const thinBookFlag   = typical.dayYieldPct > SANITY_CAP_PCT;
    const belowFloorFlag = typical.grossRewardDay < FLOOR_DAILY_USD;
    const flags = [];
    if (thinBookFlag)   flags.push('THIN BOOK — share will compress');
    if (belowFloorFlag) flags.push(`below $${FLOOR_DAILY_USD} payout floor at this capital`);

    levels[String(C)] = {
      capital:         C,
      share:           typical.share,
      grossRewardDay:  typical.grossRewardDay,
      dayYieldPct:     typical.dayYieldPct,
      // net = gross here: Polymarket CLOB maker fee = 0%; reward is paid from pool with no fee deducted.
      // Polygon gas ≈ $0 (negligible). The 2% settlement winFee applies to resolved winning positions, not rewards.
      netRewardDay:    typical.netRewardDay,
      netYieldPct:     typical.netYieldPct,
      shareHigh:       high.share,
      grossHigh:       high.grossRewardDay,
      netHigh:         high.netRewardDay,
      shareLow:        low.share,
      grossLow:        low.grossRewardDay,
      netLow:          low.netRewardDay,
      thinBookFlag,
      belowFloorFlag,
      flags,
      _atMidShare:     atMid.share,  // ceiling; comparison output only, not displayed in UI
    };
  }
  return levels;
}

// ── Gap / open-band classification ────────────────────────────────────────────
// gapScore: band-coverage measure = share at $500 expressed as a %, bounded 0–100.
//   Higher → thinner band → more uncovered.  NOT a yield or return figure.
// gapClass:
//   "OPEN"  — thinly covered (share ≥ GAP_SHARE_THRESH) + above $1/day floor
//              + LOW or MEDIUM volatility → real entry window, not an adverse trap.
//   "TRAP"  — thinly covered but HIGH volatility: band is thin precisely because
//              informed flow deters makers.  NOT a free opportunity.
//   "none"  — band is adequately covered or below floor.
function classifyGap(levels, volatilityRisk) {
  const lv500   = levels['500'];
  const share500 = lv500.share;
  const gross500 = lv500.grossRewardDay;
  const gapScore = parseFloat((share500 * 100).toFixed(1));

  let gapClass = 'none';
  if (share500 >= GAP_SHARE_THRESH && gross500 >= FLOOR_DAILY_USD) {
    if (volatilityRisk === 'LOW' || volatilityRisk === 'MEDIUM') {
      gapClass = 'OPEN';
    } else {
      gapClass = 'TRAP';
    }
  }
  return { gapClass, gapScore };
}

// ── Friendly depth string (e.g. $2.3k, $1.2M) ─────────────────────────────────
function fmtUsd(d) {
  if (d >= 1_000_000) return `$${(d/1_000_000).toFixed(1)}M`;
  if (d >= 1_000)     return `$${(d/1_000).toFixed(1)}k`;
  return `$${d}`;
}

// ── Main scan ─────────────────────────────────────────────────────────────────
async function scan() {
  const t0 = Date.now();
  console.log(`\n[${new Date().toISOString()}] agent24: scanning Polymarket liquidity rewards…`);

  let markets;
  try {
    markets = await fetchRewardMarkets();
  } catch (e) {
    console.error(`  Failed to fetch markets: ${e.message}`);
    return;
  }

  console.log(`  ${markets.length} reward-eligible markets found`);
  if (!markets.length) {
    atomicWrite(OUTPUT_FILE, { meta: { generatedAt: new Date().toISOString(), totalMarkets: 0 }, markets: [] });
    return;
  }

  markets.sort((a, b) => b.rewardsDailyRate - a.rewardsDailyRate);
  const toProcess = markets.slice(0, MAX_CLOB_MARKETS);
  console.log(`  Processing top ${toProcess.length} of ${markets.length} reward markets for CLOB depth`);

  const results = [];

  for (const m of toProcess) {
    const fallbackMid = m.lastTradePrice
      || (m.bestBid && m.bestAsk ? (m.bestBid + m.bestAsk) / 2 : 0.5);

    // Fetch BOTH CLOB token books LIVE — the YES token book and the NO token book —
    // never synthesizing one from the other. Polymarket's fungibility keeps the two
    // books near mirror-complements at the price level (YES bid p ≈ NO ask 1−p), but
    // each side's REWARD band is centered on that token's own mid, so the in-band
    // qualifying depth (and thus the per-side reward math) genuinely differs. 24h
    // volatility is identical for both tokens (NO = 1 − YES ⇒ Var(NO) = Var(YES)), so
    // we fetch it once and reuse it — exact, saves a call. NO book only when tokenIdNo.
    const [book, bookNo, vol] = await Promise.all([
      measureBookDepth(m.tokenId, m.rewardsMaxSpread, m.rewardsMinSize, fallbackMid),
      m.tokenIdNo
        ? measureBookDepth(m.tokenIdNo, m.rewardsMaxSpread, m.rewardsMinSize, 1 - fallbackMid)
        : Promise.resolve(null),
      measure24hVolatility(m.tokenId),
    ]);

    const volatilityRisk   = classifyVol(vol.stdev, vol.range, m.endDate, m.rewardsMaxSpread);
    const existingDepthUsd = book.existingDepthUsd;
    const competitorQ      = { Qmin: book.Qmin, Qbids: book.Qbids, Qasks: book.Qasks, mid: book.mid };
    const levels           = computeLevels(m.rewardsDailyRate, competitorQ, m.rewardsMaxSpread, m.rewardsMinSize);
    const { gapClass, gapScore } = classifyGap(levels, volatilityRisk);

    // Per-side estimator inputs (real, independent books). twoSidedRequired is
    // evaluated on EACH side's own mid — Polymarket requires two-sided when a
    // token's mid sits outside [0.10, 0.90]. emptyBook is surfaced truthfully so the
    // UI can show "book unavailable" for a side rather than a fabricated number.
    const sideYes = {
      mid:                book.mid,
      existing_depth_usd: book.existingDepthUsd,
      bookSpread:         book.bookSpread,
      emptyBook:          !!book.emptyBook,
      twoSidedRequired:   book.mid != null && (book.mid < 0.10 || book.mid > 0.90),
      volatilityStdev:    vol.stdev,
      derivedByComplement: false,   // real CLOB book, real bids AND asks
    };
    const sideNo = bookNo ? {
      mid:                bookNo.mid,
      existing_depth_usd: bookNo.existingDepthUsd,
      bookSpread:         bookNo.bookSpread,
      emptyBook:          !!bookNo.emptyBook,
      twoSidedRequired:   bookNo.mid != null && (bookNo.mid < 0.10 || bookNo.mid > 0.90),
      volatilityStdev:    vol.stdev,   // Var(NO) = Var(1−YES) = Var(YES), exact
      derivedByComplement: false,   // independent NO-token CLOB book, real bids AND asks
    } : null;

    // OLD linear share for side-by-side comparison in console
    const linearShare500 = existingDepthUsd > 0 ? 500 / (500 + existingDepthUsd) : 1.0;

    // sane/flagged based on $500 level (for sorting; UI re-evaluates per selected level)
    const level500 = levels['500'];
    const sane     = level500.flags.length === 0;

    results.push({
      question:          m.question,
      category:          categoryFromText(m.question),  // tags-first not available on Gamma market obj; keyword taxonomy (honest 'other' when unmatched)
      conditionId:       m.conditionId,
      slug:              m.slug || null,          // real Gamma event slug, carried through for platform deep-link
      marketSlug:        m.marketSlug || null,    // per-outcome slug → two-segment multi-outcome deep-link
      groupItemTitle:    m.groupItemTitle || null,// outcome label (e.g. "England")
      rewardsDailyRate:  m.rewardsDailyRate,
      rewardsMaxSpread:  m.rewardsMaxSpread,
      rewardsMinSize:    m.rewardsMinSize,
      assetAddress:      m.assetAddress,
      tokenId:           m.tokenId,
      tokenIdNo:         m.tokenIdNo || null,
      mid:               book.mid,
      bookSpread:        book.bookSpread,
      existing_depth_usd: existingDepthUsd,
      // Per-side (YES/NO) real independent books — estimator inputs. Top-level fields
      // above mirror the YES side for backward compatibility; `sides` carries both.
      sides:             { yes: sideYes, no: sideNo },
      volatilityRisk,
      volatilityStdev:   vol.stdev,
      volatilityRange:   vol.range,
      endDate:           m.endDate,
      negRisk:           m.negRisk,
      levels,
      sane500:           sane,  // convenience flag; UI re-evaluates per level
      gapClass,
      gapScore,
      _linearShare500:   parseFloat(linearShare500.toFixed(6)),  // old linear (notional) — historical reference
      _atMidShare500:    parseFloat((levels['500']._atMidShare || 0).toFixed(6)), // ceiling; not UI headline
    });
  }

  // Default sort: LOW vol sane first, then MED, then HIGH, then flagged; by rate desc within group
  const volOrder = { LOW: 0, MEDIUM: 1, HIGH: 2 };
  results.sort((a, b) => {
    const aSane = a.sane500 ? 0 : 1;
    const bSane = b.sane500 ? 0 : 1;
    if (aSane !== bSane) return aSane - bSane;
    const vA = volOrder[a.volatilityRisk] ?? 2;
    const vB = volOrder[b.volatilityRisk] ?? 2;
    if (vA !== vB) return vA - vB;
    return b.rewardsDailyRate - a.rewardsDailyRate;
  });

  const out = {
    meta: {
      generatedAt:        new Date().toISOString(),
      scanDurationMs:     Date.now() - t0,
      rewardMarketsFound: markets.length,
      totalMarkets:       results.length,
      saneAt500:          results.filter(r => r.sane500).length,
      flaggedAt500:       results.filter(r => !r.sane500).length,
      capitalLevels:      CAPITAL_LEVELS,
      disclaimer: [
        'share and grossRewardDay use Polymarket\'s quadratic scoring formula S(v,s)=((v-s)/v)^2 with c=3 two-sided combine.',
        'TYPICAL placement: user posts both sides at s=v/2 (half the half-band, S=0.25) — a realistic farming position, not the ceiling.',
        'Range: shareHigh/grossHigh = near-mid floor (s=0.1¢); shareLow/grossLow = outer band (s=0.8v, S=0.04).',
        'Actual share depends on exact resting distance; competitors continuously re-quote.',
        'existing_depth_usd is a point-in-time CLOB snapshot (price×size, display only; not used for share math).',
        'Q_competitors is the quadratic-weighted score of all existing resting orders in the YES book.',
        'sides.yes / sides.no carry each token\'s OWN live CLOB book. YES + NO mids ≈ 100¢ (Polymarket fungibility keeps the books near mirror-complements), but each side\'s in-band reward depth — and thus the per-side reward math — genuinely differs.',
        `THIN_BOOK flag: typical dayYieldPct > ${SANITY_CAP_PCT}% — book is thin, real share will compress as MMs arrive.`,
        `BELOW_FLOOR flag: typical grossRewardDay < $${FLOOR_DAILY_USD} — minimum daily payout not met.`,
        'netRewardDay = grossRewardDay × (1 − 0) because Polymarket CLOB maker fee = 0% and Polygon gas ≈ $0. Platform fees on the reward disbursement are deterministically zero. Does NOT account for inventory/adverse-selection risk from fills — that is non-deterministic and not a fee.',
        'Not financial advice.',
      ].join(' '),
    },
    markets: results,
  };

  atomicWrite(OUTPUT_FILE, out);

  // Parallel history sink (non-fatal): snapshot Polymarket LP reward markets as computed.
  try {
    require('../lib/history-logger').appendSnapshot('rewards-poly', Date.now(), results);
  } catch (e) { console.log('[history] rewards-poly snapshot skipped:', e.message); }

  // Rebuild the unified normalized snapshot (/tmp/liquidity-rewards.json) for the
  // Liquidity Rewards tab + estimator. Reads both venues' on-disk files; idempotent
  // and race-safe (atomic rename). Non-fatal.
  try {
    const nm = writeCombinedSnapshot();
    console.log(`  [normalize] /tmp/liquidity-rewards.json: ${nm.totalMarkets} markets (poly ${nm.polymarket} + kalshi ${nm.kalshi}, ${nm.withRealPool} real pools)`);
  } catch (e) { console.log('  [normalize] combined snapshot skipped:', e.message); }

  // ── Terminal output: top 5 markets with three capital levels ─────────────────
  const W = 130;
  const divider = '─'.repeat(W);
  console.log(`\n${divider}`);
  console.log(`POLYMARKET LIQUIDITY REWARD SCANNER  —  ${new Date().toISOString()}`);
  console.log(divider);
  console.log(`Markets scanned: ${results.length}   Sane@$500: ${out.meta.saneAt500}   Flagged@$500: ${out.meta.flaggedAt500}`);
  console.log(divider);

  const top5 = results.slice(0, 5);
  for (const r of top5) {
    const q = r.question.slice(0, 80);
    console.log(`\n  ${q}`);
    console.log(`  Pool: $${r.rewardsDailyRate}/day  Spread: ${r.rewardsMaxSpread}¢  Depth: ${fmtUsd(r.existing_depth_usd)}  Vol: ${r.volatilityRisk}  Gap: ${r.gapClass} (score ${r.gapScore}%)`);
    console.log(`  ${'Capital'.padEnd(10)}  ${'Share%'.padStart(8)}  ${'Gross/day'.padStart(10)}  ${'Yield%'.padStart(8)}  Flags`);
    for (const C of CAPITAL_LEVELS) {
      const lv  = r.levels[String(C)];
      const cap = `$${C >= 1000 ? (C/1000)+'k' : C}`.padEnd(10);
      const shr = `${(lv.share * 100).toFixed(2)}%`.padStart(8);
      const grs = `$${lv.grossRewardDay.toFixed(2)}`.padStart(10);
      const yld = `${lv.dayYieldPct.toFixed(2)}%`.padStart(8);
      const flg = lv.flags.length ? lv.flags.map(f => f.split('—')[0].trim()).join('; ') : '—';
      console.log(`  ${cap}  ${shr}  ${grs}  ${yld}  ${flg}`);
    }
  }

  // ── Placement comparison: at-mid (ceiling) vs typical (headline) vs outer-band (low) ─
  console.log(`\n${divider}`);
  console.log(`PLACEMENT COMPARISON  —  AT-MID (ceiling, S=1.0) vs TYPICAL (s=v/2, S=0.25) vs OUTER-BAND (s=0.8v, S=0.04)`);
  console.log(divider);
  console.log(`  ${'Market'.padEnd(50)} ${'Cap'.padStart(6)}  ${'AtMid%'.padStart(8)}  ${'Typical%'.padStart(9)}  ${'OuterBand%'.padStart(11)}  ${'Typ$/day'.padStart(9)}  Cap`);
  console.log(`  ${'-'.repeat(50)} ${'-'.repeat(6)}  ${'-'.repeat(8)}  ${'-'.repeat(9)}  ${'-'.repeat(11)}  ${'-'.repeat(9)}  ---`);
  for (const r of top5) {
    const q = r.question.slice(0, 50).padEnd(50);
    for (const C of CAPITAL_LEVELS) {
      const lv  = r.levels[String(C)];
      const cap = `$${C >= 1000 ? (C/1000)+'k' : C}`.padStart(6);
      const atM = `${(lv._atMidShare * 100).toFixed(2)}%`.padStart(8);
      const typ = `${(lv.share     * 100).toFixed(2)}%`.padStart(9);
      const low = `${(lv.shareLow  * 100).toFixed(2)}%`.padStart(11);
      const grs = `$${lv.grossRewardDay.toFixed(2)}`.padStart(9);
      const flg = lv.dayYieldPct > SANITY_CAP_PCT ? '⚠' : '✓';
      console.log(`  ${q} ${cap}  ${atM}  ${typ}  ${low}  ${grs}  ${flg}`);
    }
  }

  // ── Gap sample: 8 markets showing gapClass + inputs (sanity check) ────────────
  const opens = results.filter(r => r.gapClass === 'OPEN');
  const traps = results.filter(r => r.gapClass === 'TRAP');
  const gapSample = [
    ...opens.slice(0, 5),
    ...traps.slice(0, 3),
  ].slice(0, 8);

  if (gapSample.length > 0) {
    console.log(`\n${divider}`);
    console.log(`GAP ANALYSIS  —  OPEN: ${opens.length}  TRAP: ${traps.length}  (threshold: share@$500 ≥ ${GAP_SHARE_THRESH * 100}%, gross ≥ $${FLOOR_DAILY_USD}/day)`);
    console.log(divider);
    console.log(`  ${'Market (truncated)'.padEnd(55)} ${'Gap'.padEnd(6)} ${'Score'.padStart(6)} ${'Depth'.padStart(8)} ${'Shr@500'.padStart(9)} ${'Grs@500'.padStart(9)} Vol`);
    console.log(`  ${'-'.repeat(55)} ${'-'.repeat(6)} ${'-'.repeat(6)} ${'-'.repeat(8)} ${'-'.repeat(9)} ${'-'.repeat(9)} ---`);
    for (const r of gapSample) {
      const q   = r.question.slice(0, 55).padEnd(55);
      const gc  = r.gapClass.padEnd(6);
      const gs  = `${r.gapScore}%`.padStart(6);
      const dep = fmtUsd(r.existing_depth_usd).padStart(8);
      const shr = `${(r.levels['500'].share * 100).toFixed(1)}%`.padStart(9);
      const grs = `$${r.levels['500'].grossRewardDay.toFixed(2)}`.padStart(9);
      const vol = r.volatilityRisk;
      console.log(`  ${q} ${gc} ${gs} ${dep} ${shr} ${grs} ${vol}`);
    }
  } else {
    console.log(`\n  GAP ANALYSIS: no open bands or traps at this threshold (share@$500 < ${GAP_SHARE_THRESH * 100}%)`);
  }

  console.log(`\n${divider}`);
  console.log(`Written: ${OUTPUT_FILE}`);
  console.log(`FORMULA: S(v,s)=((v-s)/v)^2, c=3. Headline=typical (s=v/2,S=0.25). Range: high s=0.1¢, low s=0.8v.`);
  console.log(`ESTIMATE: snapshot-in-time; competitors re-quote; share compresses as makers enter; not a guarantee.`);
  console.log(divider);
}

// ── Formula self-test (runs once at startup) ──────────────────────────────────
function runFormulaVerification() {
  const { scoreBook: sb } = require('../lib/rewardScore');
  const testBook = {
    bids: [{ price: '0.49', size: '100' }, { price: '0.48', size: '100' }],
    asks: [{ price: '0.51', size: '100' }, { price: '0.505', size: '100' }],
  };
  const r  = sb(testBook, 6, 1, 0.50);  // maxSpread=6¢ → v=3¢, minSize=1
  const ok = Math.abs(r.Qmin - 73.61) < 0.02;
  const W  = 130;
  console.log('─'.repeat(W));
  console.log('FORMULA VERIFICATION  S(v,s)=((v-s)/v)^2  c=3  adjusted-mid');
  console.log(`  Test: bids=[0.49×100, 0.48×100] asks=[0.51×100, 0.505×100]  v=3¢  minSize=1`);
  console.log(`  adjustedMid = (0.49+0.505)/2 = ${r.mid}  (bestBid=0.49, bestAsk=0.505)`);
  console.log(`  Qbids = S(0.75¢)×100 + S(1.75¢)×100 = ${r.Qbids.toFixed(2)}   (0.5625×100 + 0.1736×100)`);
  console.log(`  Qasks = S(1.25¢)×100 + S(0.75¢)×100 = ${r.Qasks.toFixed(2)}  (0.3403×100 + 0.5625×100)`);
  console.log(`  Qmin(${r.Qbids.toFixed(2)}, ${r.Qasks.toFixed(2)}, 0.4975) = max(min,max(÷3)) = ${r.Qmin.toFixed(2)}  ${ok ? '✓ CORRECT' : '✗ MISMATCH'}`);
  console.log(`  NOTE: prior "111.11" was wrong — traced to Qbids×2 with size=200, no qMin, wrong mid.`);
  console.log(`  Polymarket docs show the formula steps but do not state a Q_min value for their example.`);
  console.log(`  HEADLINE = typical placement (s=v/2, S=0.25). Range: high s=0.1¢ / low s=0.8v.`);
  console.log('─'.repeat(W));
}

// ── Entry point ───────────────────────────────────────────────────────────────
(async () => {
  console.log(`[agent24-liquidity-rewards] starting (capital levels: ${CAPITAL_LEVELS.map(c => '$'+c).join(', ')})…`);
  runFormulaVerification();
  await sleep(STARTUP_DELAY_MS);
  while (true) {
    try   { await scan(); }
    catch (e) { console.error(`[agent24] uncaught:`, e.message, e.stack?.split('\n')[1]); }
    await sleep(SCAN_INTERVAL_MS);
  }
})();
