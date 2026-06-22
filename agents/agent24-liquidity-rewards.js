#!/usr/bin/env node
// agent24-liquidity-rewards.js — Polymarket Liquidity Reward Scanner
//
// Every 15 min:
//   1. Fetches all active Gamma markets with clobRewards[0].rewardsDailyRate > 0
//   2. For each, reads the CLOB order book and sums resting depth within
//      the qualifying band (rewardsMaxSpread / 2 each side of mid) as
//      DOLLAR NOTIONAL (price × size) — dimensionally consistent with capital.
//   3. Estimates LP reward share for THREE capital levels: $500, $5k, $50k.
//      share = C / (C + existing_depth_usd)   — linear first-order estimate.
//      Real scoring weights orders closer to mid quadratically and rewards
//      two-sided depth — actual share will differ.
//   4. Classifies 24h mid-price volatility as LOW / MEDIUM / HIGH.
//   5. Applies sanity cap (>5%/day gross → THIN BOOK flag) and
//      floor (<$1/day gross → below-floor flag) PER CAPITAL LEVEL.
//   6. Writes /root/prediction-market/data/liquidity-rewards.json.
//   7. Prints top 5 markets (3 capital levels each) to console.
//
// No Claude API. No order placement. Read-only. Deterministic.
'use strict';

const fs    = require('fs');
const https = require('https');

// ── Config ────────────────────────────────────────────────────────────────────
const SCAN_INTERVAL_MS  = 15 * 60_000;
const STARTUP_DELAY_MS  = 8_000;
const OUTPUT_FILE       = '/root/prediction-market/data/liquidity-rewards.json';
const MAX_RPS           = 1.5;
const CAPITAL_LEVELS    = [500, 5_000, 50_000];
const SANITY_CAP_PCT    = 5.0;   // %/day → THIN BOOK flag per level
const FLOOR_DAILY_USD   = 1.0;   // $/day minimum gross; below = below-floor flag per level
const NEAR_EXPIRY_DAYS  = 14;    // markets closing within → force HIGH vol
const GAMMA_PAGE_SIZE   = 100;
const MAX_PAGES         = 21;    // offset 0..2000 (21 × 100)
const MAX_CLOB_MARKETS  = 120;   // top-N by rate for CLOB depth

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
    const req = https.get(url, { timeout: ms }, r => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        try   { res({ status: r.statusCode, data: JSON.parse(body) }); }
        catch (e) { rej(new Error(`HTTP ${r.statusCode} / bad JSON: ${body.slice(0, 80)}`)); }
      });
    });
    req.on('error', rej);
    req.on('timeout', () => { req.destroy(); rej(new Error('timeout')); });
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
        question:         m.question,
        rewardsDailyRate: rate,
        rewardsMinSize:   minSize || 0,
        rewardsMaxSpread: maxSpread,
        tokenId:          tokenIds[0],
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

// ── Measure qualifying depth from CLOB order book (DOLLAR NOTIONAL) ──────────
// Qualifying depth = sum of (price × size) for all resting orders within
// rewardsMaxSpread/2 of mid on each side.  Dollar-notional is dimensionally
// consistent with the capital levels we compare against.
async function measureBookDepth(tokenId, rewardsMaxSpread, fallbackMid) {
  try {
    const r = await httpGet(`https://clob.polymarket.com/book?token_id=${tokenId}`);
    if (r.status !== 200 || !r.data) {
      return { mid: fallbackMid, existingDepthUsd: 0, bookSpread: null, emptyBook: true };
    }

    const bids = (r.data.bids || [])
      .map(b => ({ p: parseFloat(b.price), s: parseFloat(b.size) }))
      .filter(b => b.p > 0 && b.s > 0)
      .sort((a, b) => b.p - a.p);

    const asks = (r.data.asks || [])
      .map(a => ({ p: parseFloat(a.price), s: parseFloat(a.size) }))
      .filter(a => a.p > 0 && a.s > 0)
      .sort((a, b) => a.p - b.p);

    if (!bids.length && !asks.length) {
      return { mid: fallbackMid, existingDepthUsd: 0, bookSpread: null, emptyBook: true };
    }

    const bestBid  = bids.length ? bids[0].p : fallbackMid - 0.01;
    const bestAsk  = asks.length ? asks[0].p : fallbackMid + 0.01;
    const mid      = (bestBid + bestAsk) / 2;
    const bookSprd = parseFloat((bestAsk - bestBid).toFixed(4));

    const halfBand = rewardsMaxSpread / 2 / 100;

    // Dollar notional: price × size for each qualifying resting order
    const qBidsUsd = bids
      .filter(b => b.p >= mid - halfBand)
      .reduce((acc, b) => acc + b.p * b.s, 0);
    const qAsksUsd = asks
      .filter(a => a.p <= mid + halfBand)
      .reduce((acc, a) => acc + a.p * a.s, 0);

    return {
      mid:              parseFloat(mid.toFixed(4)),
      bookSpread:       bookSprd,
      existingDepthUsd: Math.round(qBidsUsd + qAsksUsd),
      emptyBook:        false,
    };
  } catch (e) {
    return { mid: fallbackMid, existingDepthUsd: 0, bookSpread: null, error: e.message };
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

// ── Compute per-level estimates ───────────────────────────────────────────────
function computeLevels(rewardsDailyRate, existingDepthUsd) {
  const levels = {};
  for (const C of CAPITAL_LEVELS) {
    const share          = C / (C + existingDepthUsd);
    const grossRewardDay = share * rewardsDailyRate;
    const dayYieldPct    = (grossRewardDay / C) * 100;
    const thinBookFlag   = dayYieldPct > SANITY_CAP_PCT;
    const belowFloorFlag = grossRewardDay < FLOOR_DAILY_USD;
    const flags = [];
    if (thinBookFlag)   flags.push('THIN BOOK — share will compress');
    if (belowFloorFlag) flags.push(`below $${FLOOR_DAILY_USD} payout floor at this capital`);

    levels[String(C)] = {
      capital:         C,
      share:           parseFloat(share.toFixed(6)),
      grossRewardDay:  parseFloat(grossRewardDay.toFixed(4)),
      dayYieldPct:     parseFloat(dayYieldPct.toFixed(3)),
      thinBookFlag,
      belowFloorFlag,
      flags,
    };
  }
  return levels;
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

    const [book, vol] = await Promise.all([
      measureBookDepth(m.tokenId, m.rewardsMaxSpread, fallbackMid),
      measure24hVolatility(m.tokenId),
    ]);

    const volatilityRisk = classifyVol(vol.stdev, vol.range, m.endDate, m.rewardsMaxSpread);
    const existingDepthUsd = book.existingDepthUsd;
    const levels = computeLevels(m.rewardsDailyRate, existingDepthUsd);

    // sane/flagged based on $500 level (for sorting; UI re-evaluates per selected level)
    const level500 = levels['500'];
    const sane     = level500.flags.length === 0;

    results.push({
      question:          m.question,
      conditionId:       m.conditionId,
      rewardsDailyRate:  m.rewardsDailyRate,
      rewardsMaxSpread:  m.rewardsMaxSpread,
      rewardsMinSize:    m.rewardsMinSize,
      assetAddress:      m.assetAddress,
      mid:               book.mid,
      bookSpread:        book.bookSpread,
      existing_depth_usd: existingDepthUsd,
      volatilityRisk,
      volatilityStdev:   vol.stdev,
      volatilityRange:   vol.range,
      endDate:           m.endDate,
      negRisk:           m.negRisk,
      levels,
      sane500:           sane,  // convenience flag; UI re-evaluates per level
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
        'grossRewardDay and share are FIRST-ORDER LINEAR ESTIMATES.',
        'Real LP reward scoring weights orders closer to mid quadratically and rewards two-sided depth.',
        'existing_depth_usd is a point-in-time CLOB snapshot measured as dollar NOTIONAL (price × size).',
        `THIN_BOOK flag: dayYieldPct > ${SANITY_CAP_PCT}% — book is thin, real share will compress as MMs arrive.`,
        `BELOW_FLOOR flag: grossRewardDay < $${FLOOR_DAILY_USD} — minimum daily payout not met.`,
        'Figures are GROSS — adverse-fill risk (being picked off) is not subtracted.',
        'Not financial advice.',
      ].join(' '),
    },
    markets: results,
  };

  atomicWrite(OUTPUT_FILE, out);

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
    console.log(`  Pool: $${r.rewardsDailyRate}/day  Spread: ${r.rewardsMaxSpread}¢  Depth: ${fmtUsd(r.existing_depth_usd)}  Vol: ${r.volatilityRisk}`);
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

  console.log(`\n${divider}`);
  console.log(`Written: ${OUTPUT_FILE}`);
  console.log(`NOTE: depth measured as dollar NOTIONAL (price×size). Share is LINEAR estimate (real: quadratic + two-sided bonus).`);
  console.log(divider);
}

// ── Entry point ───────────────────────────────────────────────────────────────
(async () => {
  console.log(`[agent24-liquidity-rewards] starting (capital levels: ${CAPITAL_LEVELS.map(c => '$'+c).join(', ')})…`);
  await sleep(STARTUP_DELAY_MS);
  while (true) {
    try   { await scan(); }
    catch (e) { console.error(`[agent24] uncaught:`, e.message, e.stack?.split('\n')[1]); }
    await sleep(SCAN_INTERVAL_MS);
  }
})();
