#!/usr/bin/env node
// agent18-mm-analyzer.js — Polymarket Liquidity Reward Eligibility Scanner (read-only)
//
// Scans reward-eligible Polymarket CLOB markets and reports:
//   • Whether the market qualifies for LP rewards (rewardsMaxSpread/rewardsMinSize set)
//   • Competing book depth (CLOB snapshot — who you'd compete with)
//   • Maker rebate per fill (what you earn each time a taker hits your order)
//   • Adverse-selection risk (qualitative structural proxy)
//
// What it does NOT claim:
//   • LP Rewards daily rate — rewards.rates is NULL in CLOB API for all markets.
//     Polymarket does not publish the actual LP Reward program amounts in any public API.
//   • Daily yield estimate — fill rate depends on queue position & price level,
//     unknowable without live order placement.
//
// Replaces agent18-liquidity-rewards v1 which used pool formula (vol × fee × rebate)
// to fabricate daily yield estimates — that formula computed maker fee rebates, not LP
// Reward amounts, and produced inflated yields (46-128%/day) due to empty-book markets.
//
// NO order placement. NO Claude API calls. NO synthetic fill simulation.
// OUTPUT: /tmp/mm-analysis.json
'use strict';

const fs    = require('fs');
const https = require('https');

// ── Config ────────────────────────────────────────────────────────────────────
const SCAN_INTERVAL_MS = 15 * 60_000;
const STARTUP_DELAY_MS = 10_000;
const MAX_RPS          = 0.8;
const SAMPLE_CAPITAL   = 200;
const MAX_MARKETS      = 30;
const OUTPUT_FILE      = '/tmp/mm-analysis.json';

const NOTE = [
  'LP Reward daily rate: rewards.rates is NULL in the Polymarket CLOB API for all markets.',
  'Polymarket does not publish the actual LP Reward program amounts in any public API endpoint.',
  'makerRebatePerFill = sampleCapital × takerFeeRate × rebateRate — this is the USDC rebate',
  'you receive each time a taker fills your entire position. It is fill-dependent; you only',
  'earn it when a taker crosses your quote. Daily fill frequency is unknowable without live trading.',
  'competingDepth = USDC resting in the CLOB reward band (snapshot, changes continuously).',
  'Markets are sorted by competingDepth ASC: low depth = less competition = higher fill probability.',
  'Adverse risk: HIGH near resolution (informed flow); LOW for negRisk correlated outcomes; MED otherwise.',
].join(' ');

const DISCLAIMER =
  'Data from public Gamma + CLOB APIs. LP Reward rate not available in any public API. ' +
  'Maker rebate is real but fill-dependent — you earn it only when a taker fills your order. ' +
  'Daily yield is NOT estimable without fill-rate data from live trading. ' +
  'Read-only. No orders placed. Not financial advice.';

// ── Rate-limited HTTP queue ───────────────────────────────────────────────────
const _q = [];
let _running = false;

function httpGet(url, timeoutMs = 15_000) {
  return new Promise((res, rej) => {
    _q.push({ url, timeoutMs, res, rej });
    _drain();
  });
}

async function _drain() {
  if (_running) return;
  _running = true;
  while (_q.length) {
    const { url, timeoutMs, res, rej } = _q.shift();
    const t0 = Date.now();
    try   { res(await _rawGet(url, timeoutMs)); }
    catch (e) { rej(e); }
    const gap = Math.ceil(1000 / MAX_RPS) - (Date.now() - t0);
    if (gap > 0) await sleep(gap);
  }
  _running = false;
}

function _rawGet(url, ms) {
  return new Promise((res, rej) => {
    const req = https.get(url, { timeout: ms }, r => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        try   { res({ status: r.statusCode, data: JSON.parse(body) }); }
        catch (e) { rej(new Error(`JSON(${r.statusCode}): ${body.slice(0, 80)}`)); }
      });
    });
    req.on('error', rej);
    req.on('timeout', () => { req.destroy(); rej(new Error('timeout')); });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function atomicWrite(path, obj) {
  const tmp = path + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, path);
}

// ── Fetch all reward-eligible markets from Gamma ──────────────────────────────
async function fetchRewardMarkets() {
  const markets = [];
  for (let offset = 0; offset < 800; offset += 100) {
    let res;
    try {
      res = await httpGet(
        `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&offset=${offset}`
      );
    } catch (e) {
      console.warn(`[gamma] offset=${offset}: ${e.message}`);
      break;
    }
    if (res.status !== 200 || !Array.isArray(res.data)) break;

    for (const m of res.data) {
      if (!m.acceptingOrders || m.closed || !m.active) continue;

      const rms = parseFloat(m.rewardsMaxSpread ?? 0);
      const rmn = parseFloat(m.rewardsMinSize   ?? 0);
      if (rms <= 0 || rmn <= 0) continue;  // not in reward program

      let tids = [];
      try { tids = JSON.parse(m.clobTokenIds || '[]'); } catch {}
      if (!tids[0]) continue;

      let bid = parseFloat(m.bestBid ?? 0);
      let ask = parseFloat(m.bestAsk ?? 0);
      if (bid <= 0 || ask <= 0) {
        try {
          const px = JSON.parse(m.outcomePrices || '["0.5","0.5"]');
          const p  = parseFloat(px[0]);
          bid = Math.max(0.001, p - 0.001);
          ask = Math.min(0.999, p + 0.001);
        } catch {}
      }
      if (bid <= 0 || ask <= 0 || ask <= bid) continue;
      const mid = (bid + ask) / 2;

      let takerFeeRate = m.negRisk ? 0.03 : 0.05;
      let rebateRate   = 0.25;
      try {
        const fs2 = typeof m.feeSchedule === 'string'
          ? JSON.parse(m.feeSchedule)
          : (m.feeSchedule || {});
        if (fs2.rate)       takerFeeRate = parseFloat(fs2.rate);
        if (fs2.rebateRate) rebateRate   = parseFloat(fs2.rebateRate);
      } catch {}

      const vol24    = parseFloat(m.volume24hr ?? m.volumeNum ?? 0);
      const end      = m.endDate ? new Date(m.endDate).getTime() : 0;
      const daysLeft = end > 0 ? Math.max(0, (end - Date.now()) / 86_400_000) : 0;

      markets.push({
        cid:          m.conditionId,
        title:        m.question ?? m.slug ?? m.conditionId.slice(0, 12),
        slug:         m.slug ?? '',
        yesTokenId:   tids[0],
        negRisk:      !!m.negRisk,
        bid, ask, mid,
        spread:       ask - bid,
        vol24,
        daysLeft,
        rewardsMaxSpread: rms,
        rewardsMinSize:   rmn,
        takerFeeRate,
        rebateRate,
      });
    }

    if (res.data.length < 100) break;
  }

  console.log(`[gamma] found ${markets.length} reward-eligible markets`);
  return markets;
}

// ── Fetch CLOB book depth within the reward band ──────────────────────────────
async function fetchCompetingDepth(market) {
  try {
    const res = await httpGet(
      `https://clob.polymarket.com/book?token_id=${market.yesTokenId}`
    );
    if (res.status !== 200 || !res.data) return null;

    const mid      = market.mid;
    const bandHalf = market.rewardsMaxSpread / 100;
    const lo       = mid - bandHalf;
    const hi       = mid + bandHalf;

    const bidDepth = (res.data.bids || [])
      .filter(b => parseFloat(b.price) >= lo)
      .reduce((s, b) => s + parseFloat(b.size) * parseFloat(b.price), 0);

    const askDepth = (res.data.asks || [])
      .filter(a => parseFloat(a.price) <= hi)
      .reduce((s, a) => s + parseFloat(a.size) * parseFloat(a.price), 0);

    return Math.round((bidDepth + askDepth) * 100) / 100;
  } catch (e) {
    console.warn(`[depth] ${market.cid.slice(0, 8)}: ${e.message}`);
    return null;
  }
}

// ── Adverse-selection risk scoring ────────────────────────────────────────────
function scoreAdverseRisk(m) {
  const mid = m.mid;

  if (mid < 0.03 || mid > 0.97) {
    return {
      level: 'HIGH',
      note: 'Near resolution — informed traders likely know outcome. Fills are probably adverse.',
    };
  }
  if (mid < 0.05 || mid > 0.95) {
    return {
      level: 'MED-HIGH',
      note: 'Close to resolution — elevated risk of informed fills.',
    };
  }
  if (m.negRisk && mid >= 0.05 && mid <= 0.90) {
    return {
      level: 'LOW',
      note: 'negRisk — correlated outcomes, slow drift, low jump risk.',
    };
  }
  if (mid >= 0.30 && mid <= 0.70) {
    return {
      level: 'MED',
      note: 'Balanced binary — news-driven jumps possible.',
    };
  }
  return {
    level: 'MED',
    note: 'Directional — monitor for resolution triggers.',
  };
}

// ── Main scan ─────────────────────────────────────────────────────────────────
async function scan() {
  console.log('[scan] starting Gamma scan…');

  let allMarkets;
  try {
    allMarkets = await fetchRewardMarkets();
  } catch (e) {
    console.error('[scan] Gamma fetch failed:', e.message);
    return;
  }

  if (allMarkets.length === 0) {
    console.warn('[scan] no reward markets found — skipping write');
    return;
  }

  // Pick top MAX_MARKETS by vol24 (highest volume = most likely to earn rebates when filled)
  allMarkets.sort((a, b) => b.vol24 - a.vol24);
  const candidates = allMarkets.slice(0, MAX_MARKETS);

  const results = [];
  for (const m of candidates) {
    const competingDepth = await fetchCompetingDepth(m);

    // Maker rebate per fill: the USDC you receive each time a taker fills your
    // entire sampleCapital position. Real number from published feeSchedule.
    // NOT a daily yield — fill frequency is unknowable without live trading.
    const capital          = Math.max(SAMPLE_CAPITAL, m.rewardsMinSize);
    const makerRebatePerFill = round2(capital * m.takerFeeRate * m.rebateRate);

    const risk = scoreAdverseRisk(m);

    const entry = {
      cid:              m.cid,
      title:            m.title,
      slug:             m.slug,
      negRisk:          m.negRisk,
      mid:              round4(m.mid),
      bid:              round4(m.bid),
      ask:              round4(m.ask),
      spread:           round4(m.spread),
      vol24:            Math.round(m.vol24),
      daysLeft:         Math.round(m.daysLeft * 10) / 10,
      rewardsMaxSpread: m.rewardsMaxSpread,
      rewardsMinSize:   m.rewardsMinSize,
      takerFeeRate:     m.takerFeeRate,
      rebateRate:       m.rebateRate,
      sampleCapital:    capital,
      // LP reward rate: NOT published in any public API
      lpRewardRateAvailable: false,
      // Maker rebate per fill: real, from feeSchedule, but fill-dependent
      makerRebatePerFill,
      // Competing depth: who you'd share fills with
      competingDepth:   competingDepth !== null ? Math.round(competingDepth) : null,
      adverseRiskLevel: risk.level,
      adverseRiskNote:  risk.note,
    };

    results.push(entry);
    console.log(
      `[market] ${m.title.slice(0, 40)} | vol24=$${(m.vol24/1000).toFixed(0)}k` +
      ` | depth=$${competingDepth !== null ? Math.round(competingDepth) : '?'}` +
      ` | rebate/fill=$${makerRebatePerFill}` +
      ` | risk=${risk.level}`
    );
  }

  // Sort: competing depth ASC (null last) — less competition = more opportunity
  results.sort((a, b) => {
    if (a.competingDepth === null && b.competingDepth === null) return 0;
    if (a.competingDepth === null) return 1;
    if (b.competingDepth === null) return -1;
    return a.competingDepth - b.competingDepth;
  });

  const withDepth  = results.filter(m => m.competingDepth !== null);
  const lowRisk    = results.filter(m => m.adverseRiskLevel === 'LOW');
  const emptyBook  = results.filter(m => m.competingDepth !== null && m.competingDepth < 100);

  atomicWrite(OUTPUT_FILE, {
    updatedAt:    new Date().toISOString(),
    agentVersion: 'agent18-eligibility-scanner v2',
    sampleCapital: SAMPLE_CAPITAL,
    note:          NOTE,
    // LP reward rates: confirmed NOT available in public API
    lpRewardRatePublished: false,
    lpRewardRateNote: 'rewards.rates is null in CLOB API for all markets. ' +
      'Polymarket does not publish LP Reward program daily amounts in any public endpoint.',
    markets: results,
    aggregate: {
      totalMarkets:          results.length,
      marketsWithDepth:      withDepth.length,
      lowRiskMarkets:        lowRisk.length,
      emptyBookMarkets:      emptyBook.length,
      lpRewardRatePublished: false,
      headlineNote:          'LP reward rate not in public API — no yield estimate possible',
    },
    disclaimer: DISCLAIMER,
  });

  console.log(
    `[scan] wrote ${results.length} markets. ` +
    `${emptyBook.length} with empty/thin book (<$100 depth). ` +
    `${lowRisk.length} low-risk.`
  );
}

function round2(n) { return Math.round((n ?? 0) * 100) / 100; }
function round4(n) { return Math.round((n ?? 0) * 10000) / 10000; }

// ── Main loop ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('[agent18] Liquidity Eligibility Scanner starting…');
  await sleep(STARTUP_DELAY_MS);

  while (true) {
    try   { await scan(); }
    catch (e) { console.error('[main] scan error:', e.message); }
    await sleep(SCAN_INTERVAL_MS);
  }
}

main().catch(e => { console.error('[fatal]', e); process.exit(1); });
