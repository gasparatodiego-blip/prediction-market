#!/usr/bin/env node
'use strict';

const fs    = require('fs');
const path  = require('path');
const { httpGet: _sharedGet, httpPost: _httpPost } = require('../lib/httpGet');

// ── Load .env (pm2 doesn't auto-load project env files) ────────────────────
// Read every candidate file (don't stop at the first one that merely exists —
// .env.local exists but only carries ODDS_API_KEY; TELEGRAM_* live in .env).
for (const envFile of ['.env.local', '.env']) {
  try {
    const envPath = path.join(__dirname, '..', envFile);
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)="?([^"]*?)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* try next */ }
}

// ── Config ────────────────────────────────────────────────────────────────────
const COINS         = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];
const SYMBOLS       = { BTC:'BTCUSDT', ETH:'ETHUSDT', SOL:'SOLUSDT', XRP:'XRPUSDT', DOGE:'DOGEUSDT' };
const CAPITAL       = 5000;      // total USD to allocate across all positions
const FR_THRESHOLD  = 0.005;     // % per 8h — below this = flat, no position
const REBAL_MIN_PCT = 1.0;       // allocation % shift needed to consider rebalancing
const REBAL_RATIO   = 2.0;       // monthly gain / rebalance cost must exceed this
const FEE_RATE      = 0.0002;    // 0.02% Binance taker per trade
const OUT_FILE      = '/tmp/rebalancer-output.json';
const STATE_FILE    = '/tmp/rebalancer-state.json';
const HB_FILE       = '/tmp/agent-heartbeats.json';
const TG_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT       = process.env.TELEGRAM_CHAT_ID;

// ── Utilities ─────────────────────────────────────────────────────────────────

function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb['agent14-rebalancer'] = Date.now();
  try { fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2)); } catch {}
}

function get(url) {
  return _sharedGet(url, { timeoutMs: 10_000, headers: { 'User-Agent': 'Mozilla/5.0 prediction-arb-scanner/1.0', 'Accept': 'application/json' } })
    .then(r => r.data).catch(() => null);
}

function sendTelegram(text) {
  if (process.env.TELEGRAM_ALERTS_ENABLED === 'false') return;
  const body = JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' });
  _httpPost(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, body, { timeoutMs: 10_000 })
    .then(r => { if (!r.data?.ok) console.error('[tg] failed:', r.data?.description); else console.log('[tg] sent OK'); })
    .catch(e => console.error('[tg] error:', e.message));
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { positions: [], timestamp: null, firstRun: true }; }
}

function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
}

function r4(n) { return Math.round(n * 10000) / 10000; }
function r2(n) { return Math.round(n * 100) / 100; }
function signStr(n) { return n >= 0 ? `+${n}` : `${n}`; }

// ── Funding rate fetch ────────────────────────────────────────────────────────

async function fetchFundingRates() {
  const data = await get('https://fapi.binance.com/fapi/v1/premiumIndex');
  if (!Array.isArray(data)) return null;

  const symToName = Object.fromEntries(Object.entries(SYMBOLS).map(([n, s]) => [s, n]));
  const rates = {};
  for (const t of data) {
    const name = symToName[t.symbol];
    if (!name) continue;
    rates[name] = {
      fundingRate:     parseFloat(t.lastFundingRate) * 100,  // decimal → % per 8h
      markPrice:       parseFloat(t.markPrice),
      nextFundingTime: parseInt(t.nextFundingTime ?? '0'),
    };
  }
  // Ensure all requested coins are present (some may be missing if API changes)
  for (const coin of COINS) {
    if (!rates[coin]) rates[coin] = { fundingRate: 0, markPrice: 0, nextFundingTime: 0 };
  }
  return rates;
}

// ── Kelly-like position sizing ────────────────────────────────────────────────
//
// Weight each active coin proportional to |fundingRate|.
// Coins below FR_THRESHOLD get no allocation (avoid fees eating thin margins).

function calcOptimalPositions(rates) {
  const active = COINS.filter(c => Math.abs(rates[c].fundingRate) >= FR_THRESHOLD);
  if (active.length === 0) return [];

  const totalAbs = active.reduce((s, c) => s + Math.abs(rates[c].fundingRate), 0);

  return active
    .map(coin => {
      const { fundingRate, markPrice, nextFundingTime } = rates[coin];
      const absFr     = Math.abs(fundingRate);
      const weight    = absFr / totalAbs;
      const allocUsd  = r2(CAPITAL * weight);
      const allocPct  = r2(weight * 100);

      // expected_8h_profit = allocUsd × (absFr / 100)
      // e.g. $2000 × (0.01 / 100) = $0.20
      const exp8h      = r4(allocUsd * (absFr / 100));
      const expMonthly = r2(exp8h * 3 * 30);  // 3 periods/day × 30 days

      return {
        coin,
        direction:               fundingRate > 0 ? 'long_futures_short_spot' : 'short_futures_long_spot',
        allocation_pct:          allocPct,
        allocation_usd:          allocUsd,
        funding_rate:            r4(fundingRate),          // % per 8h, signed
        expected_8h_profit:      exp8h,
        expected_monthly_profit: expMonthly,
        mark_price:              markPrice,
        next_funding_iso:        nextFundingTime ? new Date(nextFundingTime).toISOString() : null,
      };
    })
    .sort((a, b) => Math.abs(b.funding_rate) - Math.abs(a.funding_rate));
}

// ── Rebalance evaluation ──────────────────────────────────────────────────────
//
// Compare previous positions to new optimal set.
// Return whether rebalancing is justified given cost vs expected gain.
//
// Cost model (conservative):
//   - New position / exit:   alloc_usd × FEE_RATE × 2  (open or close both legs)
//   - Direction flip:        old_usd × FEE_RATE × 2  +  new_usd × FEE_RATE × 2
//   - Resize only:           |delta_usd| × FEE_RATE × 2

function evalRebalance(prev, next, isFirstRun) {
  if (isFirstRun || prev.length === 0) {
    return { needed: false, reasons: ['initial setup — positions established'], cost: 0, gainMonthly: 0, ratio: 0 };
  }

  const prevMap = Object.fromEntries(prev.map(p => [p.coin, p]));
  const nextMap = Object.fromEntries(next.map(p => [p.coin, p]));
  const reasons = [];
  let totalCostUsd = 0;

  for (const pos of next) {
    const p = prevMap[pos.coin];
    if (!p) {
      // New coin entering
      reasons.push(`${pos.coin} entered — ${signStr(r4(pos.funding_rate))}%/8h`);
      totalCostUsd += pos.allocation_usd * FEE_RATE * 2;
    } else if (p.direction !== pos.direction) {
      // Direction flip: close old both legs + open new both legs
      const sign = pos.funding_rate > 0 ? 'positive' : 'negative';
      reasons.push(`${pos.coin} flipped ${sign} (${signStr(r4(p.funding_rate))}% → ${signStr(r4(pos.funding_rate))}%/8h)`);
      totalCostUsd += (p.allocation_usd + pos.allocation_usd) * FEE_RATE * 2;
    } else {
      const diff = Math.abs(pos.allocation_pct - p.allocation_pct);
      if (diff >= REBAL_MIN_PCT) {
        reasons.push(`${pos.coin} reweighted ${p.allocation_pct}% → ${pos.allocation_pct}%`);
        totalCostUsd += Math.abs(pos.allocation_usd - p.allocation_usd) * FEE_RATE * 2;
      }
    }
  }

  for (const p of prev) {
    if (!nextMap[p.coin]) {
      reasons.push(`${p.coin} exited — rate below threshold`);
      totalCostUsd += p.allocation_usd * FEE_RATE * 2;
    }
  }

  if (reasons.length === 0) {
    return { needed: false, reasons: [], cost: 0, gainMonthly: 0, ratio: 0 };
  }

  const cost       = r4(totalCostUsd);
  const prevMo     = prev.reduce((s, p) => s + p.expected_monthly_profit, 0);
  const nextMo     = next.reduce((s, p) => s + p.expected_monthly_profit, 0);
  const gainMonthly = r2(nextMo - prevMo);
  const ratio       = cost > 0 ? r2(gainMonthly / cost) : 0;

  return {
    needed:      gainMonthly > 0 && ratio >= REBAL_RATIO,
    reasons,
    cost,
    gainMonthly,
    ratio,
  };
}

// ── Main run ──────────────────────────────────────────────────────────────────

async function run() {
  const ts = new Date().toISOString();
  console.log(`[rebalancer] run @ ${ts}`);
  beat();

  const rates = await fetchFundingRates();
  if (!rates) {
    console.error('[rebalancer] Binance API unavailable — skipping cycle');
    return;
  }

  // Log raw snapshot
  for (const coin of COINS) {
    const r = rates[coin];
    const frStr = r.fundingRate >= 0 ? `+${r.fundingRate.toFixed(5)}` : r.fundingRate.toFixed(5);
    const active = Math.abs(r.fundingRate) >= FR_THRESHOLD ? '✓' : '–';
    console.log(`  [${active}] ${coin.padEnd(4)} ${frStr}%/8h  mark $${r.markPrice.toLocaleString()}`);
  }

  const optPositions  = calcOptimalPositions(rates);
  const state         = loadState();
  const prevPositions = state.positions ?? [];
  const isFirstRun    = !!state.firstRun;

  const rebal = evalRebalance(prevPositions, optPositions, isFirstRun);

  const totalMonthly = r2(optPositions.reduce((s, p) => s + p.expected_monthly_profit, 0));
  const totalApy     = r2((totalMonthly / CAPITAL) * 12 * 100);

  const output = {
    timestamp:              ts,
    capital:                CAPITAL,
    positions:              optPositions,
    total_expected_monthly: totalMonthly,
    total_expected_apy:     totalApy,
    rebalance_needed:       rebal.needed,
    rebalance_reason:       rebal.reasons.length ? rebal.reasons.join('; ') : 'no change needed',
    rebalance_cost:         rebal.cost,
    rebalance_gain:         rebal.gainMonthly,
    rebalance_ratio:        rebal.ratio,
    rates_snapshot:         Object.fromEntries(
      COINS.map(c => [c, { rate_pct: r4(rates[c].fundingRate), mark_price: rates[c].markPrice }])
    ),
  };

  try { fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2)); } catch (e) {
    console.error('[rebalancer] failed to write output:', e.message);
  }

  console.log(`[rebalancer] ${optPositions.length} active | $${totalMonthly}/mo | ${totalApy}% APY | rebal=${rebal.needed}`);
  if (rebal.reasons.length) console.log(`[rebalancer] changes: ${rebal.reasons.join(' | ')}`);

  // ── Telegram alerts ────────────────────────────────────────────────────────

  if (rebal.needed) {
    const lines = rebal.reasons.map(r => `  • ${r}`).join('\n');
    const posLines = optPositions
      .map(p => `  ${p.coin}: ${p.allocation_pct}% ($${p.allocation_usd}) ${signStr(p.funding_rate)}%/8h → $${p.expected_monthly_profit}/mo`)
      .join('\n');
    sendTelegram(
      `⚖️ REBALANCE NEEDED\n\n` +
      lines + '\n\n' +
      `Cost: $${rebal.cost}  |  Monthly gain: +$${rebal.gainMonthly}  |  Ratio: ${rebal.ratio}×\n\n` +
      `New positions:\n${posLines}`
    );
  }

  // Alert when the best coin changes between cycles
  const best     = optPositions[0];
  const prevBest = prevPositions[0];
  if (!isFirstRun && best && prevBest && best.coin !== prevBest.coin) {
    sendTelegram(
      `🎯 BEST FUNDING NOW: ${best.coin} ${signStr(best.funding_rate)}%/8h\n\n` +
      `Switch allocation: ${prevBest.coin} ${prevBest.allocation_pct}% → ${best.coin} ${best.allocation_pct}%\n` +
      `Expected: $${best.expected_monthly_profit}/month on $${best.allocation_usd}`
    );
  }

  saveState({ positions: optPositions, timestamp: ts, firstRun: false });
}

// ── Scheduling ────────────────────────────────────────────────────────────────
// Run 5 min before each Binance funding settlement (00:00, 08:00, 16:00 UTC)
// so positions can be adjusted before the payment window opens.

function msUntilNextFunding() {
  const now     = new Date();
  const targets = [{ h: 7, m: 55 }, { h: 15, m: 55 }, { h: 23, m: 55 }];
  let minMs     = Infinity;
  for (const { h, m } of targets) {
    const t = new Date(now);
    t.setUTCHours(h, m, 0, 0);
    if (t <= now) t.setUTCDate(t.getUTCDate() + 1);
    const diff = t - now;
    if (diff < minMs) minMs = diff;
  }
  return minMs;
}

function scheduleNext() {
  const ms   = msUntilNextFunding();
  const next = new Date(Date.now() + ms).toISOString();
  console.log(`[rebalancer] next run at ${next} (in ${(ms / 60000).toFixed(1)} min)`);
  setTimeout(async () => {
    await run().catch(err => console.error('[rebalancer] run error:', err.message));
    scheduleNext();
  }, ms);
}

// Bootstrap: run immediately, then align to funding schedule
run()
  .catch(err => console.error('[rebalancer] initial run error:', err.message))
  .finally(scheduleNext);
