#!/usr/bin/env node
'use strict';

const fs         = require('fs');
const https      = require('https');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// ── Config ─────────────────────────────────────────────────────────────────────
const MODEL          = 'claude-sonnet-4-6';
const INTERVAL_MS    = 30 * 60 * 1000;   // 30 minutes
const TG_TOKEN       = '8920675182:AAExM7SaLI-t7j3_QgkfGb46MqEJkHRlmJ4';
const TG_CHAT        = '8844610430';

const FILES = {
  exchangePrices:   '/tmp/exchange-prices.json',
  marketsRaw:       '/tmp/markets-raw.json',
  kalshiRaw:        '/tmp/kalshi-raw.json',
  polymarketRaw:    '/tmp/polymarket-raw.json',
  oddsApiRaw:       '/tmp/odds-api-raw.json',
  rebalancerOutput: '/tmp/rebalancer-output.json',
  masterOut:        '/tmp/master-opportunities.json',
  arbOut:           '/tmp/arbitrage-opportunities.json',
  uiData:           '/tmp/ui-data.json',
  log:              '/tmp/master-log.json',
  hb:               '/tmp/agent-heartbeats.json',
};

const MAX_AGE_MS = 10 * 60 * 1000;  // 10 min — stale threshold for source data

// ── Utilities ──────────────────────────────────────────────────────────────────

function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(FILES.hb, 'utf8')); } catch {}
  hb['agent-master'] = Date.now();
  try { fs.writeFileSync(FILES.hb, JSON.stringify(hb, null, 2)); } catch {}
}

function readJson(path) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return null; }
}

function writeJson(path, data) {
  try { fs.writeFileSync(path, JSON.stringify(data, null, 2)); } catch (e) {
    console.error(`[master] write ${path} failed:`, e.message);
  }
}

function get(url) {
  return new Promise(resolve => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 prediction-market/1.0', Accept: 'application/json' },
      timeout: 10000,
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', function () { this.destroy(); resolve(null); });
  });
}

function sendTelegram(text) {
  const body = JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' });
  const req = https.request({
    hostname: 'api.telegram.org',
    path:     `/bot${TG_TOKEN}/sendMessage`,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, res => {
    let data = '';
    res.on('data', d => data += d);
    res.on('end', () => {
      try { const r = JSON.parse(data); if (!r.ok) console.error('[master] tg failed:', r.description); }
      catch {}
    });
  });
  req.on('error', err => console.error('[master] tg error:', err.message));
  req.write(body);
  req.end();
}

function appendLog(entry) {
  let log = [];
  try { log = JSON.parse(fs.readFileSync(FILES.log, 'utf8')); } catch {}
  if (!Array.isArray(log)) log = [];
  log.push(entry);
  if (log.length > 200) log = log.slice(-200);  // keep last 200 entries
  writeJson(FILES.log, log);
}

// ── Data collection ────────────────────────────────────────────────────────────

async function collectData() {
  const now = Date.now();

  // Exchange prices (from agent10-binance)
  const exchangeData = readJson(FILES.exchangePrices);
  const pricesAge    = exchangeData ? now - (exchangeData.fetchedAt || 0) : Infinity;
  const prices       = pricesAge < MAX_AGE_MS ? exchangeData : null;

  // Prediction markets — prefer dedicated agent files, fall back to markets-raw.json
  const marketsRaw  = readJson(FILES.marketsRaw);
  const marketsAge  = marketsRaw ? now - (marketsRaw.fetchedAt || 0) : Infinity;
  const markets     = marketsAge < MAX_AGE_MS ? marketsRaw : null;

  const kalshiData  = readJson(FILES.kalshiRaw);
  const kalshiAge   = kalshiData ? now - (kalshiData.fetchedAt || 0) : Infinity;
  const kalshi      = kalshiAge < MAX_AGE_MS ? kalshiData : null;

  const pmData      = readJson(FILES.polymarketRaw);
  const pmAge       = pmData ? now - (pmData.fetchedAt || 0) : Infinity;
  const polymarket  = pmAge < MAX_AGE_MS ? pmData : null;

  // Sports odds (from agent12-sports)
  const oddsRaw  = readJson(FILES.oddsApiRaw);
  const oddsAge  = oddsRaw ? now - (oddsRaw.fetchedAt || 0) : Infinity;
  const odds     = oddsAge < MAX_AGE_MS ? oddsRaw : null;

  // Rebalancer output (from agent14-rebalancer)
  const rebal = readJson(FILES.rebalancerOutput);

  // Fear & Greed index
  const [fngNow, fng7d] = await Promise.all([
    get('https://api.alternative.me/fng/?limit=1'),
    get('https://api.alternative.me/fng/?limit=7'),
  ]);

  return { prices, markets, kalshi, polymarket, odds, rebal, fngNow, fng7d };
}

// ── Context builder ────────────────────────────────────────────────────────────

function buildContext(data) {
  const { prices, markets, kalshi, polymarket, odds, rebal, fngNow, fng7d } = data;
  const lines = [];

  // Fear & Greed
  if (fngNow?.data?.[0]) {
    const f = fngNow.data[0];
    lines.push(`FEAR & GREED INDEX: ${f.value} (${f.value_classification}) — ${f.timestamp}`);
  }
  if (fng7d?.data) {
    const trend = fng7d.data.slice(0, 7).map(d => `${d.value}(${d.value_classification.slice(0,4)})`).join(', ');
    lines.push(`7-DAY TREND: ${trend}`);
  }

  // Exchange prices & funding rates
  if (prices?.exchanges) {
    lines.push('\n=== CEX PRICES ===');
    for (const [ex, coins] of Object.entries(prices.exchanges)) {
      for (const [coin, d] of Object.entries(coins)) {
        if (d?.price) {
          lines.push(`${ex.toUpperCase()} ${coin}: $${d.price.toLocaleString()} (${d.change24hPct >= 0 ? '+' : ''}${d.change24hPct?.toFixed(2) ?? '?'}%)`);
        }
      }
    }
  }
  if (prices?.futures) {
    lines.push('\n=== PERPETUAL FUNDING RATES ===');
    for (const [coin, d] of Object.entries(prices.futures?.binance ?? {})) {
      if (d?.fundingRate != null) {
        const fr = d.fundingRate;
        const apy = (fr * 3 * 365).toFixed(1);
        lines.push(`${coin}: ${fr >= 0 ? '+' : ''}${fr.toFixed(5)}%/8h = ${apy}% APY`);
      }
    }
  }
  if (prices?.cexArb?.length) {
    lines.push('\n=== CEX ARBITRAGE ===');
    prices.cexArb.slice(0, 5).forEach(a => {
      lines.push(`${a.coin}: ${a.buyExchange}→${a.sellExchange} spread ${a.spreadPct?.toFixed(3)}%`);
    });
  }

  // Rebalancer
  if (rebal?.positions?.length) {
    lines.push('\n=== DELTA-NEUTRAL POSITIONS ===');
    rebal.positions.forEach(p => {
      lines.push(`${p.coin} ${p.direction}: ${p.allocation_pct}% ($${p.allocation_usd}) ${p.funding_rate >= 0 ? '+' : ''}${p.funding_rate}%/8h → $${p.expected_monthly_profit}/mo`);
    });
    lines.push(`Total: $${rebal.total_expected_monthly}/mo (${rebal.total_expected_apy}% APY)`);
  }

  // Prediction markets — merge dedicated files + markets-raw fallback
  const pmSources = [
    { platform: 'predictit',  items: markets?.predictit ?? [] },
    { platform: 'manifold',   items: markets?.manifold  ?? [] },
    { platform: 'kalshi',     items: (kalshi?.markets ?? markets?.kalshi ?? []).filter(m =>
        parseFloat(m.yes_bid_dollars||'0') > 0 || parseFloat(m.yes_ask_dollars||'0') > 0 || parseFloat(m.last_price_dollars||'0') > 0
      )
    },
    { platform: 'polymarket', items: (polymarket?.markets ?? markets?.polymarket ?? []).filter(m => m.active) },
  ];
  const allMarkets = [];
  for (const { platform, items } of pmSources) {
    if (!Array.isArray(items)) continue;
    items.slice(0, 8).forEach(m => allMarkets.push({ platform, ...m }));
  }
  if (allMarkets.length) {
    lines.push('\n=== PREDICTION MARKETS (sample) ===');
    allMarkets.slice(0, 24).forEach(m => {
      // Kalshi: derive probability from bid/ask/last
      let p = m.price ?? m.probability ?? null;
      if (p == null && m.yes_bid_dollars != null) {
        const bid  = parseFloat(m.yes_bid_dollars  || '0');
        const ask  = parseFloat(m.yes_ask_dollars  || '0');
        const last = parseFloat(m.last_price_dollars || '0');
        p = bid > 0 && ask > 0 ? ((bid + ask) / 2 * 100).toFixed(0)
          : ask > 0 ? (ask * 100).toFixed(0)
          : bid > 0 ? (bid * 100).toFixed(0)
          : last > 0 ? (last * 100).toFixed(0) : '?';
      }
      if (p == null && m.outcomePrices != null) {
        try {
          const prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
          if (Array.isArray(prices) && prices[0]) p = (parseFloat(prices[0]) * 100).toFixed(0) + '%';
        } catch {}
      }
      lines.push(`[${m.platform.toUpperCase()}] ${(m.question || m.title || m.name || '').slice(0, 80)}: ${p ?? '?'}`);
    });
  }

  // Sports odds
  if (odds?.events?.length) {
    lines.push('\n=== SPORTS ODDS (top events) ===');
    odds.events.slice(0, 8).forEach(ev => {
      const bms = ev.bookmakers || [];
      if (!bms.length) return;
      const outcomes = (bms[0]?.markets?.[0]?.outcomes || []);
      const odds_str = outcomes.map(o => `${o.name}: ${o.price}`).join(' | ');
      lines.push(`${ev.sport_title}: ${ev.home_team} vs ${ev.away_team} — ${odds_str}`);
    });
  }

  return lines.join('\n');
}

// ── Claude AI call ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a superintelligent arbitrage analyst. You receive real-time market data and must identify the top 5 best opportunities across all asset classes.

Return ONLY a valid JSON array with exactly 5 objects. No text before or after.

Each object must have these fields:
{
  "rank": 1-5,
  "type": "funding_rate|cex_arb|prediction_market|sports_arb|cash_carry|info_lag",
  "title": "short title (max 60 chars)",
  "description": "what to do (max 150 chars)",
  "expected_return": "e.g. +0.05%/8h or +$15/mo",
  "confidence": 0-100,
  "urgency": "low|medium|high",
  "action": "specific actionable step",
  "risk": "low|medium|high"
}

Order by confidence × urgency score. Focus on real, actionable opportunities with positive expected value.`;

async function callClaude(context) {
  const prompt = `${SYSTEM_PROMPT}\n\nMARKET DATA:\n${context}\n\nReturn top 5 opportunities as JSON array:`;

  try {
    const { stdout, stderr } = await execFileAsync(
      'claude',
      ['-p', prompt, '--model', MODEL],
      { timeout: 120_000, env: { ...process.env, HOME: '/root' } }
    );

    if (stderr && stderr.toLowerCase().includes('error')) {
      console.error('[master] claude stderr:', stderr.slice(0, 300));
    }

    const text  = stdout.trim();
    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) {
      console.error('[master] no JSON array in response, snippet:', text.slice(0, 200));
      return null;
    }
    return JSON.parse(match[0]);
  } catch (err) {
    console.error('[master] claude call failed:', err.message);
    return null;
  }
}

// ── Main run ───────────────────────────────────────────────────────────────────

async function run() {
  const ts = new Date().toISOString();
  console.log(`[master] run @ ${ts}`);
  beat();

  const data = await collectData();

  const fngValue = data.fngNow?.data?.[0]?.value ?? '?';
  const fngLabel = data.fngNow?.data?.[0]?.value_classification ?? '?';
  console.log(`[master] FNG: ${fngValue} (${fngLabel}) | prices: ${data.prices ? 'ok' : '-'} | markets: ${data.markets ? 'ok' : '-'} | kalshi: ${data.kalshi ? 'ok' : '-'} | polymarket: ${data.polymarket ? 'ok' : '-'} | odds: ${data.odds ? 'ok' : '-'}`);

  const context = buildContext(data);

  const opportunities = await callClaude(context);
  if (!opportunities || !opportunities.length) {
    console.error('[master] no opportunities returned — skipping write');
    appendLog({ ts, status: 'error', reason: 'no opportunities from claude', fng: fngValue });
    return;
  }

  console.log(`[master] got ${opportunities.length} opportunities`);
  opportunities.forEach((o, i) => {
    console.log(`  [${i + 1}] ${o.type} | conf=${o.confidence} | urgency=${o.urgency} | ${o.title}`);
  });

  // ── Save master opportunities ──
  const masterOutput = {
    timestamp:     ts,
    fear_greed:    { value: fngValue, label: fngLabel },
    opportunities,
    data_sources:  {
      exchange_prices: !!data.prices,
      markets:         !!data.markets,
      odds:            !!data.odds,
      rebalancer:      !!data.rebal,
    },
  };
  writeJson(FILES.masterOut, masterOutput);

  // ── Update arbitrage-opportunities.json (dashboard feed) ──
  const arbOpps = opportunities.map(o => ({
    id:          `master-${o.rank}-${Date.now()}`,
    source:      'AI Master',
    type:        o.type,
    title:       o.title,
    description: o.description,
    roi:         parseFloat(String(o.expected_return).replace(/[^0-9.+-]/g, '')) || 0,
    confidence:  o.confidence,
    urgency:     o.urgency,
    action:      o.action,
    risk:        o.risk,
    timestamp:   ts,
  }));

  // Merge with existing non-master opportunities if present
  const existingArb = readJson(FILES.arbOut);
  const prevOpps    = (existingArb?.opportunities || []).filter(o => o.source !== 'AI Master');
  writeJson(FILES.arbOut, {
    updatedAt:     Date.now(),
    opportunities: [...arbOpps, ...prevOpps],
    stats: {
      total:    arbOpps.length + prevOpps.length,
      bestRoi:  Math.max(...arbOpps.map(o => o.roi), 0),
      aiMaster: arbOpps.length,
    },
  });

  // ── Update ui-data.json ──
  const uiData = readJson(FILES.uiData) || {};
  uiData.masterOpportunities = arbOpps;
  uiData.fearGreed            = { value: fngValue, label: fngLabel };
  uiData.masterUpdatedAt      = ts;
  writeJson(FILES.uiData, uiData);

  // ── Telegram alerts for high-confidence + high-urgency ──
  const alertOpps = opportunities.filter(o => o.confidence > 75 && o.urgency === 'high');
  if (alertOpps.length) {
    const lines = alertOpps.map(o =>
      `<b>${o.rank}. ${o.title}</b>\n` +
      `${o.description}\n` +
      `Return: ${o.expected_return} | Confidence: ${o.confidence}% | Risk: ${o.risk}\n` +
      `Action: ${o.action}`
    ).join('\n\n');

    sendTelegram(
      `🧠 AI MASTER ALERT — ${alertOpps.length} opportunity${alertOpps.length > 1 ? 'ies' : 'y'}\n` +
      `FNG: ${fngValue} (${fngLabel})\n\n${lines}`
    );
  }

  // ── Self-improvement log ──
  const avgConf  = Math.round(opportunities.reduce((s, o) => s + o.confidence, 0) / opportunities.length);
  const bestOpp  = opportunities[0];
  appendLog({
    ts,
    status:        'success',
    opportunities: opportunities.length,
    avg_confidence: avgConf,
    best:          { rank: 1, type: bestOpp.type, title: bestOpp.title, confidence: bestOpp.confidence },
    alerts_sent:   alertOpps.length,
    fng:           fngValue,
    data_sources:  masterOutput.data_sources,
  });

  console.log(`[master] done | avg_conf=${avgConf}% | alerts=${alertOpps.length}`);
}

// ── Entry ──────────────────────────────────────────────────────────────────────

async function tick() {
  try {
    await run();
  } catch (err) {
    console.error('[master] uncaught error:', err.message);
    appendLog({ ts: new Date().toISOString(), status: 'crash', error: err.message });
  }
  setTimeout(tick, INTERVAL_MS);
}

tick();
