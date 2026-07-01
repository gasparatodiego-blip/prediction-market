#!/usr/bin/env node
// agent25-kalshi-rewards.js — Kalshi Liquidity Incentive Program Scanner
//
// Every 15 min:
//   1. Fetches all active Kalshi LIP programs (public API, no auth).
//   2. Sorts by daily pool rate; processes top MAX_MARKETS.
//   3. For each market: fetches live Kalshi order book.
//   4. Computes FLAT PRO-RATA share estimate per capital level.
//   5. Applies TRAP / SHORT_BURST / BELOW_FLOOR / THIN_CAP flags.
//   6. Writes /root/prediction-market/data/kalshi-rewards.json.
//   7. Prints 10-row sample so humans can eyeball yield realism.
//
// SCORING MODEL: OBSERVED — NOT Kalshi's official formula.
//   Evidence basis: All sampled LIP order books show 1000+ share orders resting
//   at 1¢/99¢ (max distance from mid) with sizes matching target_size_fp exactly.
//   This only makes sense under flat pro-rata with no proximity weighting.
//   Formula: share = user_size / (user_size + competitor_qualifying_size) per side,
//   limited by the thinner side (conservative two-sided assumption).
//   Kalshi has NOT published their official scoring formula via any public API.
//
// DO NOT REUSE rewardScore.js (quadratic, Polymarket-specific, maxSpread required).
// DO NOT invent a maxSpread constant for Kalshi.
//
// No Claude API. No order placement. Read-only. Deterministic. ESTIMATE ONLY.
'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');

// ── Config ─────────────────────────────────────────────────────────────────
const SCAN_INTERVAL_MS = 15 * 60_000;
const STARTUP_DELAY_MS = 10_000;
const OUTPUT_FILE      = '/root/prediction-market/data/kalshi-rewards.json';
const KALSHI_BASE      = 'https://api.elections.kalshi.com/trade-api/v2';
const MAX_RPS          = 3.0;
const MAX_MARKETS      = 200;        // top-N by pool_day to fully process with order books
const CAPITAL_LEVELS   = [500, 5_000, 50_000];
const SANITY_CAP_PCT   = 2.0;       // day-yield% > 2% at any level → THIN_CAP flag. Mirrors lib/reward-gating.ts REWARD_SANITY_CAP_PCT — keep in sync (this is a plain Node script, can't import the .ts file).
const FLOOR_DAILY_USD  = 1.0;       // gross < $1/day at all levels → BELOW_FLOOR flag
const TRAP_HI          = 0.90;      // last_price > 0.90 → TRAP
const TRAP_LO          = 0.10;      // last_price < 0.10 → TRAP
const BURST_DAYS       = 1.0;       // period_days < 1 → SHORT_BURST

// LIP rewards are paid from Kalshi's incentive pool with no fee deducted from the disbursement.
// The winFee in lib/fees.ts (7%) applies to resolved winning positions, not to reward income.
// fee_discount_pct is a BENEFIT (discount on trading fees for LIP makers), not a cost.
const KALSHI_REWARD_FEE_RATE = 0;

// ── Rate-limited HTTP queue ─────────────────────────────────────────────────
const _queue    = [];
let   _draining = false;

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
    const timer  = setTimeout(() => { req.destroy(); settle(rej, new Error('timeout')); }, ms);
    const req    = https.get(url, r => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        clearTimeout(timer);
        const body = Buffer.concat(chunks).toString();
        try   { settle(res, { status: r.statusCode, data: JSON.parse(body) }); }
        catch (e) { settle(rej, new Error(`HTTP ${r.statusCode} bad JSON: ${body.slice(0, 80)}`)); }
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

// ── Kalshi flat pro-rata scorer ─────────────────────────────────────────────
// OBSERVED MODEL — not Kalshi's official formula. See module header.
function scoreBookKalshi(ob, minSize) {
  const yesRaw = ob.yes_dollars || [];  // YES bids: [[price, size], ...]
  const noRaw  = ob.no_dollars  || [];  // NO bids:  [[price, size], ...]  (= YES asks inverted)

  let Qbids   = 0;
  let bestBid = null;
  for (const entry of yesRaw) {
    const price = parseFloat(entry[0]);
    const size  = parseFloat(entry[1]);
    if (size >= minSize) Qbids += size;
    if (bestBid === null || price > bestBid) bestBid = price;
  }

  // NO bid at price p → YES ask at (1 − p)
  let Qasks      = 0;
  let bestNoBid  = null;
  for (const entry of noRaw) {
    const price = parseFloat(entry[0]);
    const size  = parseFloat(entry[1]);
    if (size >= minSize) Qasks += size;
    if (bestNoBid === null || price > bestNoBid) bestNoBid = price;
  }

  const bestAsk = bestNoBid !== null ? (1 - bestNoBid) : null;
  let   mid     = null;
  if      (bestBid !== null && bestAsk !== null) mid = (bestBid + bestAsk) / 2;
  else if (bestBid !== null)  mid = bestBid;
  else if (bestAsk !== null)  mid = bestAsk;

  return { Qbids, Qasks, mid, bestBid, bestAsk };
}

function estimateKalshiLevels(bookScore, minSize, poolDay, lastPrice) {
  const { Qbids, Qasks, mid } = bookScore;
  const price  = Math.max(0.01, Math.min(0.99, mid ?? lastPrice ?? 0.50));
  const result = {};

  for (const capital of CAPITAL_LEVELS) {
    const userSize = capital / price;
    const aboveMin = userSize >= minSize;

    if (!aboveMin) {
      result[capital] = { aboveMin: false, share: 0, bidShare: 0, askShare: 0,
                          grossRewardDay: 0, dayYieldPct: 0 };
      continue;
    }

    // Both sides independently; conservative: take the limiting (thinner) side
    // If one side has zero qualifying competitors, user gets 100% of that side —
    // but that typically signals a lopsided/TRAP market, flagged separately.
    const bidShare = Qbids > 0 ? userSize / (userSize + Qbids)
                               : (userSize > 0 ? 1.0 : 0.0);
    const askShare = Qasks > 0 ? userSize / (userSize + Qasks)
                               : (userSize > 0 ? 1.0 : 0.0);
    const share    = Math.min(bidShare, askShare);

    const grossRewardDay = share * poolDay;
    const dayYieldPct    = (grossRewardDay / capital) * 100;
    // net = gross: LIP reward is paid from incentive pool with no fee; KALSHI_REWARD_FEE_RATE = 0.
    const netRewardDay   = grossRewardDay * (1 - KALSHI_REWARD_FEE_RATE);
    const netYieldPct    = (netRewardDay / capital) * 100;

    result[capital] = {
      aboveMin:       true,
      share:          parseFloat(share.toFixed(6)),
      bidShare:       parseFloat(bidShare.toFixed(6)),
      askShare:       parseFloat(askShare.toFixed(6)),
      grossRewardDay: parseFloat(grossRewardDay.toFixed(4)),
      dayYieldPct:    parseFloat(dayYieldPct.toFixed(3)),
      netRewardDay:   parseFloat(netRewardDay.toFixed(4)),
      netYieldPct:    parseFloat(netYieldPct.toFixed(3)),
    };
  }
  return result;
}

// ── API helpers ─────────────────────────────────────────────────────────────
async function fetchAllPrograms() {
  const programs = [];
  let   cursor   = null;

  for (let page = 0; page < 5; page++) {
    const qs  = `type=liquidity&status=active&limit=10000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const url = `${KALSHI_BASE}/incentive_programs?${qs}`;
    let r;
    try { r = await httpGet(url, 30_000); }
    catch (e) { console.warn(`  LIP programs page ${page} error: ${e.message}`); break; }

    if (r.status !== 200) { console.warn(`  LIP programs HTTP ${r.status}`); break; }
    const batch = r.data.incentive_programs || [];
    programs.push(...batch);
    cursor = r.data.next_cursor || null;
    if (!cursor || batch.length === 0) break;
  }
  return programs;
}

async function fetchMarket(ticker) {
  try {
    const r = await httpGet(`${KALSHI_BASE}/markets/${encodeURIComponent(ticker)}`);
    if (r.status !== 200) return null;
    return r.data.market ?? r.data ?? null;
  } catch (_) { return null; }
}

async function fetchOrderBook(ticker) {
  try {
    const r = await httpGet(`${KALSHI_BASE}/markets/${encodeURIComponent(ticker)}/orderbook?depth=50`);
    if (r.status !== 200) return null;
    return r.data.orderbook_fp ?? null;
  } catch (_) { return null; }
}

// ── Main scan ────────────────────────────────────────────────────────────────
async function scan() {
  const t0 = Date.now();
  console.log(`\n[${new Date().toISOString()}] ── Kalshi LIP scan starting ──`);

  // 1. Pull all active LIP programs
  console.log('  Fetching LIP programs …');
  const programs = await fetchAllPrograms();
  if (!programs.length) {
    console.warn('  No programs returned — aborting scan.');
    return;
  }
  console.log(`  ${programs.length} active liquidity programs loaded.`);

  // 2. Enrich with computed daily rate and select top N
  const now = new Date();
  const enriched = programs.map(p => {
    const start      = new Date(p.start_date);
    const end        = new Date(p.end_date);
    const periodDays = (end - start) / 864e5;            // ms → days
    const totalUsd   = p.period_reward / 10_000;         // centi-cents → USD
    const poolDay    = periodDays > 0 ? totalUsd / periodDays : 0;
    const shortBurst = periodDays < BURST_DAYS;
    const minSize    = parseFloat(p.target_size_fp) || 1000;
    const feeDiscount = (p.discount_factor_bps ?? 0) / 10_000;

    return {
      ticker:       p.market_ticker,
      marketId:     p.market_id,
      poolDay:      parseFloat(poolDay.toFixed(4)),
      totalUsd:     parseFloat(totalUsd.toFixed(4)),
      periodDays:   parseFloat(periodDays.toFixed(4)),
      periodStart:  p.start_date,
      periodEnd:    p.end_date,
      minSize,
      feeDiscount,
      description:  p.incentive_description || '',
      shortBurst,
    };
  });

  // Sort descending by poolDay; take top N for full processing
  enriched.sort((a, b) => b.poolDay - a.poolDay);
  const toProcess = enriched.slice(0, MAX_MARKETS);
  const totalPrograms = enriched.length;

  console.log(`  Processing top ${toProcess.length} markets (of ${totalPrograms}) by $/day …`);

  // 3. Fetch market details + order books
  const results = [];
  let   fetched  = 0;

  for (const prog of toProcess) {
    // Fetch in series (rate-limited queue handles pacing)
    const [mkt, ob] = await Promise.all([
      fetchMarket(prog.ticker),
      fetchOrderBook(prog.ticker),
    ]);

    fetched++;
    if (fetched % 25 === 0) {
      process.stdout.write(`  … ${fetched}/${toProcess.length} markets processed\n`);
    }

    // Price: last trade > book mid > fallback 0.50
    const lastPrice  = mkt ? parseFloat(mkt.last_price_dollars ?? 0.5) : 0.5;
    const question   = mkt ? (mkt.title ?? prog.ticker) : prog.ticker;
    const mktStatus  = mkt ? (mkt.status ?? 'unknown') : 'unknown';

    // Score order book
    let bookScore = { Qbids: 0, Qasks: 0, mid: null, bestBid: null, bestAsk: null };
    if (ob) bookScore = scoreBookKalshi(ob, prog.minSize);

    const price = bookScore.mid ?? lastPrice;

    // Compute levels
    const levels = estimateKalshiLevels(bookScore, prog.minSize, prog.poolDay, lastPrice);

    // ── Flags ──────────────────────────────────────────────────────────────
    const isTrap = lastPrice > TRAP_HI || lastPrice < TRAP_LO;
    let   trapReason = null;
    if (lastPrice > TRAP_HI) trapReason = `last_price=${lastPrice.toFixed(2)} > 0.90: near-certain outcome, NO side empty`;
    if (lastPrice < TRAP_LO) trapReason = `last_price=${lastPrice.toFixed(2)} < 0.10: near-certain NO, YES side empty`;

    // THIN_CAP: any level's day-yield > sanity cap
    const thinCap = CAPITAL_LEVELS.some(c => {
      const lv = levels[c];
      return lv.aboveMin && lv.dayYieldPct > SANITY_CAP_PCT;
    });

    // BELOW_FLOOR: ALL levels that clear minSize are below $1/day
    const allAboveMin = CAPITAL_LEVELS.filter(c => levels[c].aboveMin);
    const belowFloor  = allAboveMin.length === 0
      ? true
      : allAboveMin.every(c => levels[c].grossRewardDay < FLOOR_DAILY_USD);

    // ONE_SIDED: both sides must have qualifying depth for a valid estimate
    const oneSided = !isTrap && ob && (bookScore.Qbids === 0 || bookScore.Qasks === 0);

    results.push({
      ticker:          prog.ticker,
      question,
      status:          mktStatus,
      pool_day:        prog.poolDay,
      total_period_usd: prog.totalUsd,
      period_days:     prog.periodDays,
      period_start:    prog.periodStart,
      period_end:      prog.periodEnd,
      min_size:        prog.minSize,
      fee_discount_pct: Math.round(prog.feeDiscount * 100),
      description:     prog.description,
      last_price:      parseFloat(lastPrice.toFixed(4)),
      book_mid:        bookScore.mid !== null ? parseFloat(bookScore.mid.toFixed(4)) : null,
      best_bid:        bookScore.bestBid !== null ? parseFloat(bookScore.bestBid.toFixed(4)) : null,
      best_ask:        bookScore.bestAsk !== null ? parseFloat(bookScore.bestAsk.toFixed(4)) : null,
      competitor_qualifying_bids: Math.round(bookScore.Qbids),
      competitor_qualifying_asks: Math.round(bookScore.Qasks),
      levels,
      flags: {
        TRAP:        isTrap,
        SHORT_BURST: prog.shortBurst,
        BELOW_FLOOR: belowFloor,
        THIN_CAP:    thinCap,
        ONE_SIDED:   oneSided,
      },
      trap_reason:    trapReason,
      scoring_model:  'OBSERVED · flat pro-rata · not Kalshi official formula',
      timestamp:      now.toISOString(),
    });
  }

  // 4. Write JSON
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const output = {
    _meta: {
      source:           'Kalshi Trade API v2',
      total_programs:   totalPrograms,
      processed:        results.length,
      scan_elapsed_sec: parseFloat(elapsed),
      timestamp:        now.toISOString(),
      scoring_model:    'FLAT PRO-RATA · OBSERVED · not Kalshi official formula',
      disclaimer:       'ESTIMATE ONLY · Kalshi LIP scoring formula not public · behavioral inference · not financial advice',
      evidence_basis:   '1¢/99¢ stacking in all LIP order books; consistent with flat pro-rata, not quadratic proximity weighting',
    },
    markets: results,
  };
  atomicWrite(OUTPUT_FILE, output);
  console.log(`  Written: ${OUTPUT_FILE} (${results.length} markets, ${elapsed}s)`);

  // 5. Print sample ──────────────────────────────────────────────────────────
  printSample(results, totalPrograms, enriched);
}

function printSample(results, totalPrograms, allEnriched) {
  const sep  = '═'.repeat(80);
  const sep2 = '─'.repeat(80);
  const now  = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  // Flag counts across processed results AND shortBurst from the full enriched list
  const allShortBurst   = allEnriched.filter(p => p.shortBurst).length;
  const countTrap       = results.filter(r => r.flags.TRAP).length;
  const countBurst      = results.filter(r => r.flags.SHORT_BURST).length;
  const countBelowFloor = results.filter(r => r.flags.BELOW_FLOOR).length;
  const countThinCap    = results.filter(r => r.flags.THIN_CAP).length;
  const countOneSided   = results.filter(r => r.flags.ONE_SIDED).length;
  const countViable     = results.filter(r =>
    !r.flags.TRAP && !r.flags.SHORT_BURST && !r.flags.BELOW_FLOOR && !r.flags.THIN_CAP
  ).length;

  console.log(`\n${sep}`);
  console.log('  KALSHI LIQUIDITY REWARDS — SCAN SAMPLE    ' + now);
  console.log(sep);
  console.log(`  Programs total: ${totalPrograms}  |  Processed (top by $/day): ${results.length}`);
  console.log(`  FLAGS (within processed): TRAP=${countTrap}  SHORT_BURST=${countBurst}  BELOW_FLOOR=${countBelowFloor}  THIN_CAP=${countThinCap}  ONE_SIDED=${countOneSided}`);
  console.log(`  VIABLE (no flags): ${countViable} markets in top-${results.length}`);

  // Viable markets — top 8 by pool_day
  const viable = results
    .filter(r => !r.flags.TRAP && !r.flags.SHORT_BURST && !r.flags.BELOW_FLOOR && !r.flags.THIN_CAP)
    .slice(0, 8);

  if (viable.length) {
    console.log(`\n${sep2}`);
    console.log('  VIABLE MARKETS (no flags, sorted by $/day)');
    console.log(sep2);
    console.log(`  ${'TICKER'.padEnd(38)}  $/day   min  price  Qbid   Qask   $5k share  $5k/day  $50k/day`);
    console.log('  ' + '─'.repeat(78));
    for (const r of viable) {
      const l5k  = r.levels[5000];
      const l50k = r.levels[50_000];
      const sh5k = l5k.aboveMin  ? `${(l5k.share  * 100).toFixed(2)}%` : 'below-min';
      const g5k  = l5k.aboveMin  ? `$${l5k.grossRewardDay.toFixed(2)}`  : '—';
      const g50k = l50k.aboveMin ? `$${l50k.grossRewardDay.toFixed(2)}` : '—';
      const tk   = r.ticker.slice(0, 37).padEnd(37);
      const pd   = `$${r.pool_day.toFixed(2)}`.padStart(7);
      const ms   = String(r.min_size).padStart(5);
      const pr   = r.last_price.toFixed(3).padStart(5);
      const qb   = String(Math.round(r.competitor_qualifying_bids)).padStart(6);
      const qa   = String(Math.round(r.competitor_qualifying_asks)).padStart(6);
      console.log(`  ${tk}  ${pd}  ${ms}  ${pr}  ${qb}  ${qa}  ${sh5k.padStart(9)}  ${g5k.padStart(8)}  ${g50k.padStart(9)}`);
    }
  } else {
    console.log('\n  No viable markets in top results — see flags above.');
  }

  // TRAP examples
  const traps = results.filter(r => r.flags.TRAP).slice(0, 3);
  if (traps.length) {
    console.log(`\n${sep2}`);
    console.log('  TRAP EXAMPLES (extreme price — inflated $/day, adverse selection risk)');
    console.log(sep2);
    for (const r of traps) {
      const hrs = (r.period_days * 24).toFixed(1);
      console.log(`  ! ${r.ticker.slice(0, 48)}`);
      console.log(`    $/day=${r.pool_day.toFixed(2)}  total=$${r.total_period_usd.toFixed(2)}/${hrs}h  price=${r.last_price.toFixed(3)}  Qbid=${Math.round(r.competitor_qualifying_bids)}  Qask=${Math.round(r.competitor_qualifying_asks)}`);
      console.log(`    ${r.trap_reason}`);
    }
  }

  // SHORT BURST examples
  const bursts = results.filter(r => r.flags.SHORT_BURST && !r.flags.TRAP).slice(0, 2);
  if (bursts.length) {
    console.log(`\n${sep2}`);
    console.log('  SHORT BURST EXAMPLES (period < 1 day — $/day inflated by short window)');
    console.log(sep2);
    for (const r of bursts) {
      const hrs = (r.period_days * 24).toFixed(1);
      console.log(`  ~ ${r.ticker.slice(0, 48)}`);
      console.log(`    $/day=${r.pool_day.toFixed(2)}  REAL TOTAL=$${r.total_period_usd.toFixed(2)} over ${hrs}h  price=${r.last_price.toFixed(3)}`);
    }
  }

  // BELOW FLOOR examples
  const floor = results.filter(r => r.flags.BELOW_FLOOR && !r.flags.TRAP && !r.flags.SHORT_BURST).slice(0, 2);
  if (floor.length) {
    console.log(`\n${sep2}`);
    console.log('  BELOW FLOOR EXAMPLES (< $1/day gross at all qualifying capital levels)');
    console.log(sep2);
    for (const r of floor) {
      const l50k = r.levels[50_000];
      const g50k = l50k.aboveMin ? `$${l50k.grossRewardDay.toFixed(3)}/day at $50k` : 'below-min at $50k';
      console.log(`  _ ${r.ticker.slice(0, 48)}`);
      console.log(`    $/day=${r.pool_day.toFixed(2)}  ${g50k}  min_size=${r.min_size}  Qbid=${Math.round(r.competitor_qualifying_bids)}`);
    }
  }

  console.log(`\n${sep}`);
  console.log('  SCORING: FLAT PRO-RATA · user_size / (user_size + competitor_qualifying_size)');
  console.log('  OBSERVED MODEL — Kalshi official formula not public. Evidence: 1¢/99¢ stacking.');
  console.log('  ESTIMATE ONLY · competitors re-quote · pool split changes · not financial advice.');
  console.log(sep);
}

// ── Entry point ──────────────────────────────────────────────────────────────
async function main() {
  console.log('[agent25] Kalshi Liquidity Rewards Scanner starting …');
  console.log(`  Output: ${OUTPUT_FILE}`);
  console.log(`  Processing top ${MAX_MARKETS} markets per run at ${MAX_RPS} RPS`);
  console.log(`  Interval: ${SCAN_INTERVAL_MS / 60_000} min`);
  console.log(`  Scoring: FLAT PRO-RATA · OBSERVED · not Kalshi official formula`);

  await sleep(STARTUP_DELAY_MS);

  while (true) {
    try {
      await scan();
    } catch (e) {
      console.error(`[agent25] Scan error: ${e.message}`);
    }
    await sleep(SCAN_INTERVAL_MS);
  }
}

main().catch(e => { console.error('[agent25] Fatal:', e); process.exit(1); });
