#!/usr/bin/env node
'use strict';

/**
 * Agent Liquidity — Phase 6b
 * Monitors Polymarket liquidity positions (AMM).
 * Tracks: implied LP positions, impermanent loss, rebalance signals.
 * Writes /tmp/liquidity-positions.json for dashboard display.
 *
 * Strategy:
 *   1. Fetch active Polymarket markets with high volume
 *   2. For each market, compute current AMM LP metrics:
 *      - current price p, implied impermanent loss vs entry price p0
 *      - LP APY (from fees on volume)
 *   3. If IL > 3% or price diverged >10% from entry → alert for rebalance
 *   4. Runs every 10 minutes.
 */

const fs    = require('fs');
const https = require('https');

const TG_TOKEN   = '8920675182:AAExM7SaLI-t7j3_QgkfGb46MqEJkHRlmJ4';
const TG_CHAT    = '8844610430';
const HB_FILE    = '/tmp/agent-heartbeats.json';
const PM_RAW     = '/tmp/polymarket-raw.json';
const OUT_FILE   = '/tmp/liquidity-positions.json';
const INTERVAL_MS = 10 * 60 * 1000;

// Simulated LP positions (in production these would be loaded from a positions file / on-chain)
// Each entry: entryPrice (YES price at entry in cents), notionalUSD, entryTs
const LP_POSITIONS_FILE = '/tmp/lp-positions-config.json';

const DEFAULT_POSITIONS = [
  // Example positions — replace with real ones via API or manual config
  // { marketId: 'polymarket-slug', entryPrice: 50, notionalUSD: 1000, entryTs: Date.now() }
];

function readJson(path) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return null; }
}

function writeJson(path, data) {
  try { fs.writeFileSync(path, JSON.stringify(data, null, 2)); } catch {}
}

function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb['agent-liquidity'] = Date.now();
  try { fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2)); } catch {}
}

function sendTelegram(text) {
  const body = JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' });
  const req  = https.request({
    hostname: 'api.telegram.org',
    path:     `/bot${TG_TOKEN}/sendMessage`,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => { try { const r = JSON.parse(d); if (!r.ok) console.error('[lp] tg fail:', r.description); } catch {} });
  });
  req.on('error', e => console.error('[lp] tg error:', e.message));
  req.write(body); req.end();
}

/**
 * Impermanent loss for a binary AMM (CLOB-style approximation):
 * IL = 2*sqrt(p/p0) / (1 + p/p0) - 1
 * where p = current price, p0 = entry price (both in range 0..1)
 */
function computeIL(entryPrice, currentPrice) {
  const r = currentPrice / entryPrice;
  const il = 2 * Math.sqrt(r) / (1 + r) - 1;
  return +(il * 100).toFixed(3); // as %
}

/**
 * Estimate LP fee APY from 24h volume.
 * Assumes 0.1% fee rate on Polymarket AMM, LP earns ~50% of fees.
 */
function estimateLpApy(volume24h, notional) {
  if (!notional || notional <= 0) return 0;
  const dailyFees   = volume24h * 0.001 * 0.5; // 0.1% fee, LP gets 50%
  const dailyReturn = dailyFees / notional;
  return +(dailyReturn * 365 * 100).toFixed(2); // annualized %
}

function getCurrentPrice(market) {
  try {
    const prices = typeof market.outcomePrices === 'string'
      ? JSON.parse(market.outcomePrices)
      : market.outcomePrices;
    if (Array.isArray(prices) && prices[0]) return parseFloat(prices[0]);
  } catch {}
  const ltp = parseFloat(market.lastTradePrice || '0');
  return ltp > 0 ? ltp : null;
}

async function run() {
  beat();
  const ts  = new Date().toISOString();
  const now = Date.now();

  const pmData = readJson(PM_RAW);
  if (!pmData?.markets?.length) {
    console.log('[lp] no polymarket data available');
    return;
  }

  const markets = pmData.markets.filter(m => m.active);

  // Load user LP positions (if any configured)
  const userPositions = readJson(LP_POSITIONS_FILE) ?? DEFAULT_POSITIONS;

  // Compute metrics for each position
  const positionResults = [];
  const rebalanceAlerts = [];

  for (const pos of userPositions) {
    const market = markets.find(m => m.slug === pos.marketId || m.id === pos.marketId);
    if (!market) {
      positionResults.push({ ...pos, status: 'market_not_found', currentPrice: null });
      continue;
    }

    const currentPrice = getCurrentPrice(market);
    if (!currentPrice) continue;

    const entryPrice = pos.entryPrice / 100; // convert cents to 0..1
    const il         = computeIL(entryPrice, currentPrice);
    const priceDiff  = Math.abs((currentPrice - entryPrice) / entryPrice * 100);
    const vol24h     = market.volume24hr ?? market.volume ?? 0;
    const lpApy      = estimateLpApy(vol24h, pos.notionalUSD);
    const daysHeld   = (now - pos.entryTs) / (1000 * 3600 * 24);
    const feesEarned = pos.notionalUSD * (lpApy / 100 / 365) * daysHeld;
    const netPnl     = feesEarned + (il / 100) * pos.notionalUSD;

    const result = {
      marketId:     pos.marketId,
      question:     market.question?.slice(0, 80),
      url:          market.slug ? `https://polymarket.com/event/${market.slug}` : null,
      entryPrice:   +(entryPrice * 100).toFixed(1),
      currentPrice: +(currentPrice * 100).toFixed(1),
      priceDiff:    +priceDiff.toFixed(2),
      notionalUSD:  pos.notionalUSD,
      il,
      lpApy,
      daysHeld:     +daysHeld.toFixed(1),
      feesEarned:   +feesEarned.toFixed(2),
      netPnl:       +netPnl.toFixed(2),
      status:       'active',
      needsRebalance: Math.abs(il) > 3 || priceDiff > 10,
    };

    positionResults.push(result);

    if (result.needsRebalance) {
      rebalanceAlerts.push(result);
    }
  }

  // Top Polymarket markets by liquidity (for potential new LP positions)
  const topMarkets = markets
    .filter(m => {
      const price = getCurrentPrice(m);
      return price && price > 0.2 && price < 0.8; // near 50/50 = good for LP
    })
    .sort((a, b) => (b.volume24hr ?? b.volume ?? 0) - (a.volume24hr ?? a.volume ?? 0))
    .slice(0, 15)
    .map(m => {
      const price   = getCurrentPrice(m);
      const vol24h  = Number(m.volume24hr ?? m.volume ?? 0);
      const lpApy   = estimateLpApy(vol24h, 1000);
      return {
        id:           m.id,
        question:     m.question?.slice(0, 80),
        url:          m.slug ? `https://polymarket.com/event/${m.slug}` : null,
        price:        +(price * 100).toFixed(1),
        volume24h:    Math.round(Number(vol24h)),
        lpApyEstimate: lpApy,
        isNear50:     Math.abs(price - 0.5) < 0.15,
      };
    });

  const output = {
    updatedAt:       now,
    ts,
    positions:       positionResults,
    topMarketsForLp: topMarkets,
    summary: {
      totalPositions:    positionResults.length,
      needsRebalance:    rebalanceAlerts.length,
      totalNotional:     positionResults.reduce((s, p) => s + (p.notionalUSD ?? 0), 0),
      totalNetPnl:       +positionResults.reduce((s, p) => s + (p.netPnl ?? 0), 0).toFixed(2),
    },
  };

  writeJson(OUT_FILE, output);
  console.log(`[lp] ${ts} | positions: ${positionResults.length} | rebalance alerts: ${rebalanceAlerts.length} | top LP markets: ${topMarkets.length}`);

  // Send rebalance alerts
  if (rebalanceAlerts.length) {
    const lines = rebalanceAlerts.map(r =>
      `• <b>${r.question}</b>\n  IL: ${r.il}% | Price: ${r.entryPrice}¢ → ${r.currentPrice}¢ | Net PnL: $${r.netPnl}`
    ).join('\n');
    sendTelegram(`⚖️ <b>LP REBALANCE NEEDED</b>\n${rebalanceAlerts.length} position(s):\n\n${lines}\n\nFees earned offset: $${positionResults.reduce((s, p) => s + (p.feesEarned ?? 0), 0).toFixed(2)}`);
  }
}

async function tick() {
  try { await run(); } catch (e) { console.error('[lp] crash:', e.message); }
  setTimeout(tick, INTERVAL_MS);
}

tick();
