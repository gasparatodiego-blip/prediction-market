#!/usr/bin/env node
'use strict';

const fs           = require('fs');
const https        = require('https');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// ── Config ─────────────────────────────────────────────────────────────────────
const MODEL       = 'claude-sonnet-4-6';
const INTERVAL_MS = 30 * 60 * 1000;
const TG_TOKEN    = '8920675182:AAExM7SaLI-t7j3_QgkfGb46MqEJkHRlmJ4';
const TG_CHAT     = '8844610430';
const MAX_AGE_MS  = 10 * 60 * 1000;

const FILES = {
  exchangePrices:   '/tmp/exchange-prices.json',
  kalshiRaw:        '/tmp/kalshi-raw.json',
  polymarketRaw:    '/tmp/polymarket-raw.json',
  manifoldRaw:      '/tmp/manifold-raw.json',
  metaculusRaw:     '/tmp/metaculus-raw.json',
  predictitRaw:     '/tmp/predictit-raw.json',
  oddsApiRaw:       '/tmp/odds-api-raw.json',
  rebalancerOutput: '/tmp/rebalancer-output.json',
  masterOut:        '/tmp/master-opportunities.json',
  arbOut:           '/tmp/arbitrage-opportunities.json',
  uiData:           '/tmp/ui-data.json',
  log:              '/tmp/master-log.json',
  hb:               '/tmp/agent-heartbeats.json',
};

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
  try { fs.writeFileSync(path, JSON.stringify(data, null, 2)); }
  catch (e) { console.error(`[master] write ${path} failed:`, e.message); }
}

function fresh(data) {
  if (!data) return null;
  const age = Date.now() - (data.fetchedAt ?? data.updatedAt ?? 0);
  return age < MAX_AGE_MS ? data : null;
}

function get(url) {
  return new Promise(resolve => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'prediction-arb-scanner/1.0', Accept: 'application/json' },
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
  const req  = https.request({
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
  req.write(body); req.end();
}

function appendLog(entry) {
  let log = [];
  try { log = JSON.parse(fs.readFileSync(FILES.log, 'utf8')); } catch {}
  if (!Array.isArray(log)) log = [];
  log.push(entry);
  if (log.length > 500) log = log.slice(-500);
  writeJson(FILES.log, log);
}

// ── Cross-platform market matching ─────────────────────────────────────────────

const STOPWORDS = new Set([
  'will','would','could','should','their','there','these','those','which','about',
  'after','before','between','during','through','with','from','have','been','that',
  'this','than','when','what','where','who','how','the','and','for','are','but',
  'not','you','all','can','was','one','our','out','had','has','its','into','over',
  'under','more','first','last','next','also','just','wins','does','gets','make',
]);

function keywords(text) {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
      .filter(w => w.length > 3 && !STOPWORDS.has(w))
  );
}

function jaccard(a, b) {
  const ka = keywords(a), kb = keywords(b);
  let inter = 0;
  ka.forEach(w => { if (kb.has(w)) inter++; });
  const union = ka.size + kb.size - inter;
  return union > 0 ? inter / union : 0;
}

function findCrossPlatformMatches(flatMarkets) {
  // flatMarkets = [{ platform, title, price, url }]
  const matches = [];
  const seen = new Set();

  for (let i = 0; i < flatMarkets.length; i++) {
    for (let j = i + 1; j < flatMarkets.length; j++) {
      const a = flatMarkets[i], b = flatMarkets[j];
      if (a.platform === b.platform) continue;
      if (a.price == null || b.price == null) continue;

      const sim = jaccard(a.title, b.title);
      if (sim < 0.22) continue;

      const spread = Math.abs(a.price - b.price);
      if (spread < 4) continue;

      const low  = a.price <= b.price ? a : b;
      const high = a.price >  b.price ? a : b;
      const roi  = low.price > 0 ? (spread / low.price) * 100 : 0;
      if (roi > 300) continue; // filter out noise

      const key = `${low.platform}:${high.platform}:${Math.round(low.price)}:${Math.round(high.price)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      matches.push({ low, high, spread: +spread.toFixed(1), roi: +roi.toFixed(1), similarity: +sim.toFixed(2) });
    }
  }
  return matches.sort((a, b) => b.roi - a.roi).slice(0, 15);
}

// ── Data collection ────────────────────────────────────────────────────────────

async function collectData() {
  const [fngNow, fng7d] = await Promise.all([
    get('https://api.alternative.me/fng/?limit=1'),
    get('https://api.alternative.me/fng/?limit=7'),
  ]);

  return {
    prices:     fresh(readJson(FILES.exchangePrices)),
    kalshi:     fresh(readJson(FILES.kalshiRaw)),
    polymarket: fresh(readJson(FILES.polymarketRaw)),
    manifold:   fresh(readJson(FILES.manifoldRaw)),
    metaculus:  fresh(readJson(FILES.metaculusRaw)),
    predictit:  fresh(readJson(FILES.predictitRaw)),
    odds:       fresh(readJson(FILES.oddsApiRaw)),
    rebal:      readJson(FILES.rebalancerOutput),
    fngNow,
    fng7d,
  };
}

// ── Context builder ────────────────────────────────────────────────────────────

function kalshiPrice(m) {
  const bid  = parseFloat(m.yes_bid_dollars  || '0');
  const ask  = parseFloat(m.yes_ask_dollars  || '0');
  const last = parseFloat(m.last_price_dollars || '0');
  if (bid > 0 && ask > 0) return +((bid + ask) / 2 * 100).toFixed(1);
  if (ask > 0) return +(ask * 100).toFixed(1);
  if (bid > 0) return +(bid * 100).toFixed(1);
  if (last > 0) return +(last * 100).toFixed(1);
  return null;
}

function polyPrice(m) {
  try {
    const prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
    if (Array.isArray(prices) && prices[0]) return +(parseFloat(prices[0]) * 100).toFixed(1);
  } catch {}
  const ltp = parseFloat(m.lastTradePrice || '0');
  return ltp > 0 ? +(ltp * 100).toFixed(1) : null;
}

function buildContext(data) {
  const { prices, kalshi, polymarket, manifold, metaculus, predictit, odds, rebal, fngNow, fng7d } = data;
  const lines = [];

  // Fear & Greed
  if (fngNow?.data?.[0]) {
    const f = fngNow.data[0];
    lines.push(`FEAR & GREED: ${f.value} (${f.value_classification})`);
  }
  if (fng7d?.data) {
    const trend = fng7d.data.slice(0, 7).map(d => `${d.value}(${d.value_classification.slice(0,4)})`).join(', ');
    lines.push(`7D TREND: ${trend}`);
  }

  // CEX prices + funding
  if (prices?.exchanges) {
    lines.push('\n=== CEX PRICES ===');
    for (const [ex, coins] of Object.entries(prices.exchanges)) {
      for (const [coin, d] of Object.entries(coins)) {
        if (d?.price) lines.push(`${ex.toUpperCase()} ${coin}: $${d.price.toLocaleString()} (${d.change24hPct >= 0 ? '+' : ''}${d.change24hPct?.toFixed(2) ?? '?'}%)`);
      }
    }
  }
  if (prices?.futures) {
    lines.push('\n=== FUNDING RATES ===');
    for (const [coin, d] of Object.entries(prices.futures?.binance ?? {})) {
      if (d?.fundingRate != null) {
        const fr = d.fundingRate;
        lines.push(`${coin}: ${fr >= 0 ? '+' : ''}${fr.toFixed(5)}%/8h = ${(fr * 3 * 365).toFixed(1)}% APY`);
      }
    }
  }
  if (prices?.cexArb?.length) {
    lines.push('\n=== CEX ARB ===');
    prices.cexArb.slice(0, 5).forEach(a => {
      lines.push(`${a.coin}: ${a.buyExchange}→${a.sellExchange} ${a.spreadPct?.toFixed(3)}%`);
    });
  }

  // Rebalancer
  if (rebal?.positions?.length) {
    lines.push('\n=== DELTA-NEUTRAL POSITIONS ===');
    rebal.positions.forEach(p => {
      lines.push(`${p.coin} ${p.direction}: ${p.allocation_pct}% ${p.funding_rate >= 0 ? '+' : ''}${p.funding_rate}%/8h → $${p.expected_monthly_profit}/mo`);
    });
  }

  // ── Build flat market list for cross-platform matching ─────────────────────

  const flatMarkets = [];

  if (kalshi?.markets) {
    kalshi.markets.slice(0, 60).forEach(m => {
      const price = kalshiPrice(m);
      if (price != null) flatMarkets.push({ platform: 'kalshi', title: m.title || '', price, url: `https://kalshi.com/markets/${m.ticker}` });
    });
  }
  if (polymarket?.markets) {
    polymarket.markets.filter(m => m.active).slice(0, 60).forEach(m => {
      const price = polyPrice(m);
      if (price != null && price > 3 && price < 97) flatMarkets.push({ platform: 'polymarket', title: m.question || '', price, url: m.slug ? `https://polymarket.com/event/${m.slug}` : null });
    });
  }
  if (manifold?.markets) {
    manifold.markets.filter(m => m.outcomeType === 'BINARY' && m.probability != null && !m.isResolved).slice(0, 40).forEach(m => {
      const price = +(m.probability * 100).toFixed(1);
      if (price > 3 && price < 97) flatMarkets.push({ platform: 'manifold', title: m.question || '', price, url: m.url || null });
    });
  }
  if (predictit?.markets) {
    predictit.markets.forEach(m => {
      (m.contracts ?? []).forEach(c => {
        if (c.lastTradePrice != null && c.lastTradePrice > 0) {
          const title = c.name && c.name !== 'Yes' ? `${m.name} — ${c.name}` : m.name;
          flatMarkets.push({ platform: 'predictit', title, price: +(c.lastTradePrice * 100).toFixed(1), url: m.url });
        }
      });
    });
  }
  if (metaculus?.questions) {
    metaculus.questions.slice(0, 20).forEach(q => {
      if (q.probability != null) flatMarkets.push({ platform: 'metaculus', title: q.question || '', price: +(q.probability * 100).toFixed(1), url: q.url });
    });
  }

  // ── Cross-platform matches ─────────────────────────────────────────────────

  const matches = findCrossPlatformMatches(flatMarkets);

  if (matches.length) {
    lines.push('\n=== CROSS-PLATFORM ARBITRAGE MATCHES ===');
    matches.forEach((m, i) => {
      lines.push(`MATCH ${i + 1}: "${m.low.title.slice(0, 70)}"`);
      lines.push(`  BUY on ${m.low.platform.toUpperCase()} at ${m.low.price}¢`);
      lines.push(`  SELL on ${m.high.platform.toUpperCase()} at ${m.high.price}¢`);
      lines.push(`  Spread: ${m.spread}¢ | ROI: ${m.roi}% | Similarity: ${m.similarity}`);
    });
  }

  // ── Sample prediction markets for context ──────────────────────────────────

  lines.push(`\n=== PLATFORM SUMMARY ===`);
  lines.push(`Kalshi: ${flatMarkets.filter(m => m.platform === 'kalshi').length} markets`);
  lines.push(`Polymarket: ${flatMarkets.filter(m => m.platform === 'polymarket').length} markets`);
  lines.push(`Manifold: ${flatMarkets.filter(m => m.platform === 'manifold').length} markets`);
  lines.push(`PredictIt: ${flatMarkets.filter(m => m.platform === 'predictit').length} markets`);
  lines.push(`Metaculus: ${flatMarkets.filter(m => m.platform === 'metaculus').length} questions`);

  // Sports odds
  if (odds?.events?.length) {
    lines.push('\n=== TOP SPORTS ODDS ===');
    odds.events.slice(0, 6).forEach(ev => {
      const bm   = ev.bookmakers?.[0];
      const h2h  = bm?.markets?.find(m => m.key === 'h2h');
      const outs = h2h?.outcomes?.map(o => `${o.name}: ${o.price}`).join(' | ') ?? '';
      if (outs) lines.push(`${ev.sport_title}: ${ev.home_team} vs ${ev.away_team} — ${outs}`);
    });
  }

  return { context: lines.join('\n'), flatMarkets, matches };
}

// ── Last 24h log summary for context ──────────────────────────────────────────

function buildHistoryContext() {
  const log = readJson(FILES.log);
  if (!Array.isArray(log) || !log.length) return '';
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const recent = log.filter(e => new Date(e.ts).getTime() > cutoff && e.status === 'success');
  if (!recent.length) return '';
  const avgConf = Math.round(recent.reduce((s, e) => s + (e.avg_confidence ?? 0), 0) / recent.length);
  const types   = recent.flatMap(e => e.best ? [e.best.type] : []);
  const topType = types.sort().find((t, i, a) => a.filter(x => x === t).length > 1) ?? types[0] ?? 'unknown';
  return `\nLAST 24H: ${recent.length} scans | avg confidence ${avgConf}% | most common type: ${topType}`;
}

// ── System prompt ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert arbitrage analyst with access to real-time data from 5 prediction market platforms plus CEX crypto prices and sports odds.

Analyze ALL provided data. Find the top 5 opportunities ranked by (confidence × ROI).

Return ONLY a valid JSON array with exactly 5 objects. No text before or after. Each object:
{
  "rank": 1-5,
  "type": "prediction_market|funding_rate|cex_arb|sports_arb|info_lag|cash_carry",
  "title": "max 60 chars",
  "description": "what to do, max 150 chars",
  "platform_a": "platform name or exchange",
  "price_a": number or null,
  "platform_b": "platform name or exchange",
  "price_b": number or null,
  "spread_pct": number or null,
  "expected_return": "e.g. +13% or +0.05%/8h",
  "profit_on_1000usd": number,
  "fees_estimate": number,
  "net_profit": number,
  "confidence": 0-100,
  "urgency": "low|medium|high",
  "action": "exact numbered steps to execute",
  "expiry_hours": number or null,
  "risk": "low|medium|high",
  "reasoning": "max 200 chars"
}

Priority order: pre-computed cross-platform matches (highest quality) > funding rate arb > CEX arb > sports arb.
For cross-platform matches: use the exact platforms and prices provided.
For confidence: factor in liquidity, time to resolution, and similarity score.`;

// ── Claude call ────────────────────────────────────────────────────────────────

async function callClaude(contextText) {
  const historyNote = buildHistoryContext();
  const prompt = `${SYSTEM_PROMPT}\n\nMARKET DATA:${historyNote}\n${contextText}\n\nReturn top 5 opportunities as JSON array:`;

  try {
    const { stdout, stderr } = await execFileAsync(
      'claude',
      ['-p', prompt, '--model', MODEL],
      { timeout: 120_000, env: { ...process.env, HOME: '/root' } }
    );
    if (stderr?.toLowerCase().includes('error')) console.error('[master] claude stderr:', stderr.slice(0, 300));
    const text  = stdout.trim();
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) { console.error('[master] no JSON array, snippet:', text.slice(0, 200)); return null; }
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
  const sources = {
    prices:     !!data.prices,
    kalshi:     !!data.kalshi,
    polymarket: !!data.polymarket,
    manifold:   !!data.manifold,
    metaculus:  !!data.metaculus,
    predictit:  !!data.predictit,
    odds:       !!data.odds,
  };
  console.log('[master] sources:', Object.entries(sources).map(([k, v]) => `${k}:${v ? 'ok' : '-'}`).join(' | '));

  const { context, matches } = buildContext(data);
  console.log(`[master] context built | cross-platform matches: ${matches.length}`);

  const opportunities = await callClaude(context);
  if (!opportunities?.length) {
    console.error('[master] no opportunities returned');
    appendLog({ ts, status: 'error', reason: 'no opportunities from claude', sources });
    return;
  }

  console.log(`[master] got ${opportunities.length} opportunities:`);
  opportunities.forEach((o, i) => {
    console.log(`  [${i+1}] ${o.type} | conf=${o.confidence} | urgency=${o.urgency} | ${o.title}`);
  });

  const fngValue = data.fngNow?.data?.[0]?.value ?? '?';
  const fngLabel = data.fngNow?.data?.[0]?.value_classification ?? '?';

  // Write master-opportunities.json (full detail)
  writeJson(FILES.masterOut, {
    timestamp:    ts,
    fear_greed:   { value: fngValue, label: fngLabel },
    opportunities,
    cross_platform_matches: matches.length,
    data_sources: sources,
  });

  // Write arbitrage-opportunities.json (dashboard feed)
  const arbOpps = opportunities.map(o => ({
    id:              `master-${o.rank}-${Date.now()}`,
    source:          'AI Master',
    type:            o.type,
    title:           o.title,
    description:     o.description,
    platform_a:      o.platform_a,
    price_a:         o.price_a,
    platform_b:      o.platform_b,
    price_b:         o.price_b,
    spread_pct:      o.spread_pct,
    roi:             parseFloat(String(o.expected_return).replace(/[^0-9.]/g, '')) || 0,
    expected_return: o.expected_return,
    profit_on_1000:  o.profit_on_1000usd,
    fees_estimate:   o.fees_estimate,
    net_profit:      o.net_profit,
    confidence:      o.confidence,
    urgency:         o.urgency,
    action:          o.action,
    expiry_hours:    o.expiry_hours,
    risk:            o.risk,
    reasoning:       o.reasoning,
    timestamp:       ts,
  }));

  const existing  = readJson(FILES.arbOut);
  const prevOpps  = (existing?.opportunities ?? []).filter(o => o.source !== 'AI Master');
  writeJson(FILES.arbOut, {
    updatedAt:     Date.now(),
    opportunities: [...arbOpps, ...prevOpps],
    stats: {
      total:    arbOpps.length + prevOpps.length,
      bestRoi:  Math.max(...arbOpps.map(o => o.roi), 0),
      aiMaster: arbOpps.length,
    },
  });

  // Update ui-data.json
  const ui = readJson(FILES.uiData) || {};
  ui.masterOpportunities = arbOpps;
  ui.fearGreed           = { value: fngValue, label: fngLabel };
  ui.masterUpdatedAt     = ts;
  ui.crossPlatformMatches = matches.length;
  writeJson(FILES.uiData, ui);

  // Telegram — only high-confidence + high-urgency
  const alerts = opportunities.filter(o => o.confidence >= 80 && o.urgency === 'high');
  if (alerts.length) {
    const lines = alerts.map(o =>
      `<b>${o.rank}. ${o.title}</b>\n${o.description}\n` +
      (o.platform_a && o.platform_b ? `${o.platform_a} ${o.price_a}¢ → ${o.platform_b} ${o.price_b}¢\n` : '') +
      `Net profit on $1000: <b>$${o.net_profit ?? '?'}</b> | Conf: ${o.confidence}%\n` +
      `Action: ${o.action}\nRisk: ${o.risk} | Expires: ${o.expiry_hours ? o.expiry_hours + 'h' : 'open'}`
    ).join('\n\n');
    sendTelegram(`🧠 AI MASTER — ${alerts.length} HIGH alert${alerts.length > 1 ? 's' : ''}\nFNG: ${fngValue} (${fngLabel})\n\n${lines}`);
  }

  // Log
  const avgConf = Math.round(opportunities.reduce((s, o) => s + (o.confidence ?? 0), 0) / opportunities.length);
  appendLog({
    ts,
    status:         'success',
    opportunities:  opportunities.length,
    avg_confidence: avgConf,
    best:           { rank: 1, type: opportunities[0].type, title: opportunities[0].title, confidence: opportunities[0].confidence },
    alerts_sent:    alerts.length,
    fng:            fngValue,
    matches:        matches.length,
    data_sources:   sources,
  });

  console.log(`[master] done | avg_conf=${avgConf}% | alerts=${alerts.length} | matches=${matches.length}`);
}

async function tick() {
  try { await run(); } catch (err) {
    console.error('[master] crash:', err.message);
    appendLog({ ts: new Date().toISOString(), status: 'crash', error: err.message });
  }
  setTimeout(tick, INTERVAL_MS);
}

tick();
