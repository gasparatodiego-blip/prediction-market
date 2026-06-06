#!/usr/bin/env node
'use strict';

const fs             = require('fs');
const https          = require('https');
const nodemailer     = require('nodemailer');
const { execFile }   = require('child_process');
const { promisify }  = require('util');
const { Pool }       = require('pg');

const execFileAsync  = promisify(execFile);

const db = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://predmarket:PredMarket2024!@localhost:5432/predmarket' });

function createMailTransport() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

const emailLastSent = {}; // userId -> timestamp, rate limit 1 email/hour/user

async function sendEmailAlert(userEmail, userName, opp) {
  const transport = createMailTransport();
  if (!transport) return;
  const from = process.env.FROM_EMAIL || 'alerts@predictionscanner.com';
  const html = `<div style="font-family:sans-serif;max-width:520px;background:#111;color:#e5e7eb;padding:32px;border-radius:12px">
    <div style="background:#16a34a;display:inline-block;color:white;padding:6px 14px;border-radius:6px;font-size:20px;font-weight:700;margin-bottom:16px">+${opp.roi?.toFixed(1) ?? '?'}%</div>
    <h2 style="margin:0 0 8px;color:white">${(opp.title || '').slice(0,80)}</h2>
    <p style="color:#9ca3af;font-size:14px">${(opp.description || '').slice(0,200)}</p>
    ${opp.platform_a && opp.platform_b ? `<p style="color:#6b7280;font-size:13px">${opp.platform_a} → ${opp.platform_b} | Conf: ${opp.confidence}%</p>` : ''}
    <a href="${process.env.NEXTAUTH_URL || 'http://localhost:3000'}/dashboard" style="display:inline-block;margin-top:16px;padding:10px 20px;background:#2563eb;color:white;border-radius:8px;text-decoration:none;font-weight:600">View Dashboard →</a>
    <p style="margin-top:20px;font-size:11px;color:#4b5563">Not financial advice.</p>
  </div>`;
  try {
    await transport.sendMail({ from, to: userEmail, subject: `🎯 Arb Alert: ${(opp.title||'').slice(0,50)}`, html });
    console.log(`[master] email alert sent to ${userEmail}`);
  } catch (e) {
    console.error('[master] email failed:', e.message);
  }
}

// ── Config ─────────────────────────────────────────────────────────────────────
const MODEL       = 'claude-sonnet-4-6';
const INTERVAL_MS = 30 * 60 * 1000;
const TG_TOKEN    = '8920675182:AAExM7SaLI-t7j3_QgkfGb46MqEJkHRlmJ4';
const TG_CHAT     = '8844610430';
const MAX_AGE_MS  = 10 * 60 * 1000;
const ACCURACY_CHECK_AFTER_MS = 24 * 3600 * 1000; // 24h

const FILES = {
  exchangePrices:   '/tmp/exchange-prices.json',
  kalshiRaw:        '/tmp/kalshi-raw.json',
  polymarketRaw:    '/tmp/polymarket-raw.json',
  manifoldRaw:      '/tmp/manifold-raw.json',
  metaculusRaw:     '/tmp/metaculus-raw.json',
  predictitRaw:     '/tmp/predictit-raw.json',
  oddsApiRaw:       '/tmp/odds-api-raw.json',
  betfairRaw:       '/tmp/betfair-raw.json',
  augurRaw:         '/tmp/augur-raw.json',
  gnosisRaw:        '/tmp/gnosis-raw.json',
  futuurRaw:        '/tmp/futuur-raw.json',
  goodjudgmentRaw:  '/tmp/goodjudgment-raw.json',
  rebalancerOutput: '/tmp/rebalancer-output.json',
  masterOut:        '/tmp/master-opportunities.json',
  arbOut:           '/tmp/arbitrage-opportunities.json',
  uiData:           '/tmp/ui-data.json',
  log:              '/tmp/master-log.json',
  tracker:          '/tmp/prediction-tracker.json',
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

function sendTelegramTo(chatId, text) {
  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
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

function sendTelegram(text) { sendTelegramTo(TG_CHAT, text); }

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
      if (roi > 300) continue;

      const key = `${low.platform}:${high.platform}:${Math.round(low.price)}:${Math.round(high.price)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      matches.push({ low, high, spread: +spread.toFixed(1), roi: +roi.toFixed(1), similarity: +sim.toFixed(2) });
    }
  }
  return matches.sort((a, b) => b.roi - a.roi).slice(0, 15);
}

// ── Accuracy tracker ───────────────────────────────────────────────────────────

function loadTracker() {
  const data = readJson(FILES.tracker);
  if (!data || !Array.isArray(data.predictions)) return { predictions: [] };
  return data;
}

function saveTracker(tracker) {
  // Keep at most 500 resolved + all unresolved
  const unresolved = tracker.predictions.filter(p => !p.resolved);
  const resolved   = tracker.predictions.filter(p => p.resolved).slice(-300);
  writeJson(FILES.tracker, { predictions: [...resolved, ...unresolved], updatedAt: Date.now() });
}

function savePredictions(opportunities, flatMarkets) {
  const tracker = loadTracker();
  const now     = Date.now();

  for (const opp of opportunities) {
    if (!opp.platform_a || !opp.platform_b) continue;

    // Find matching markets in flat list for this opportunity
    const mktA = flatMarkets.find(m => m.platform.toLowerCase() === opp.platform_a?.toLowerCase() && m.price != null);
    const mktB = flatMarkets.find(m => m.platform.toLowerCase() === opp.platform_b?.toLowerCase() && m.price != null);

    tracker.predictions.push({
      id:            `pred-${now}-${opp.rank}`,
      predictedAt:   now,
      type:          opp.type,
      title:         opp.title,
      platform_a:    opp.platform_a,
      price_a_then:  opp.price_a ?? mktA?.price,
      url_a:         mktA?.url ?? null,
      platform_b:    opp.platform_b,
      price_b_then:  opp.price_b ?? mktB?.price,
      url_b:         mktB?.url ?? null,
      spread_then:   opp.spread_pct,
      confidence:    opp.confidence,
      resolved:      false,
      correct:       null,
      outcome_note:  null,
    });
  }

  saveTracker(tracker);
}

function checkAccuracy(currentFlatMarkets) {
  const tracker = loadTracker();
  const now     = Date.now();
  let changed   = false;

  for (const pred of tracker.predictions) {
    if (pred.resolved) continue;
    if (now - pred.predictedAt < ACCURACY_CHECK_AFTER_MS) continue;

    // Find current prices for both sides
    const nowA = currentFlatMarkets.find(m => m.platform.toLowerCase() === pred.platform_a?.toLowerCase() && m.url === pred.url_a);
    const nowB = currentFlatMarkets.find(m => m.platform.toLowerCase() === pred.platform_b?.toLowerCase() && m.url === pred.url_b);

    if (!nowA && !nowB) {
      // Markets likely resolved or unavailable
      pred.resolved    = true;
      pred.correct     = null;
      pred.outcome_note = 'markets unavailable after 24h (likely resolved)';
      changed = true;
      continue;
    }

    if (nowA && nowB) {
      const spreadThen = pred.spread_then ?? Math.abs((pred.price_a_then ?? 50) - (pred.price_b_then ?? 50));
      const spreadNow  = Math.abs(nowA.price - nowB.price);
      const converged  = spreadNow < spreadThen * 0.6; // spread narrowed by >40%
      pred.resolved     = true;
      pred.correct      = converged;
      pred.price_a_now  = nowA.price;
      pred.price_b_now  = nowB.price;
      pred.spread_now   = +spreadNow.toFixed(1);
      pred.outcome_note = converged
        ? `spread ${spreadThen.toFixed(1)}¢ → ${spreadNow.toFixed(1)}¢ (converged ✓)`
        : `spread ${spreadThen.toFixed(1)}¢ → ${spreadNow.toFixed(1)}¢ (widened ✗)`;
      changed = true;
      console.log(`[master] accuracy: "${pred.title?.slice(0, 50)}" → ${pred.outcome_note}`);
    }
  }

  if (changed) saveTracker(tracker);
  return tracker;
}

function computeAccuracyStats(tracker) {
  const now     = Date.now();
  const cutoff7d = now - 7 * 24 * 3600 * 1000;

  const resolved7d  = tracker.predictions.filter(p => p.resolved && p.correct !== null && p.predictedAt > cutoff7d);
  const correct7d   = resolved7d.filter(p => p.correct === true);
  const accuracy7d  = resolved7d.length > 0 ? Math.round(100 * correct7d.length / resolved7d.length) : null;

  const totalResolved = tracker.predictions.filter(p => p.resolved && p.correct !== null).length;
  const totalCorrect  = tracker.predictions.filter(p => p.resolved && p.correct === true).length;
  const accuracyAll   = totalResolved > 0 ? Math.round(100 * totalCorrect / totalResolved) : null;

  // Recent resolved examples
  const recentResolved = tracker.predictions
    .filter(p => p.resolved && p.correct !== null)
    .slice(-5)
    .map(p => `  • ${p.title?.slice(0, 50)} → ${p.correct ? '✓' : '✗'} (${p.outcome_note})`);

  // Accuracy by type
  const byType = {};
  for (const p of tracker.predictions) {
    if (!p.resolved || p.correct === null) continue;
    if (!byType[p.type]) byType[p.type] = { c: 0, n: 0 };
    byType[p.type].n++;
    if (p.correct) byType[p.type].c++;
  }
  const typeAccuracy = Object.entries(byType)
    .map(([t, s]) => `${t}: ${Math.round(100 * s.c / s.n)}% (${s.n})`)
    .join(', ');

  return { accuracy7d, accuracyAll, totalResolved, totalCorrect, recentResolved, typeAccuracy };
}

// ── Data collection ────────────────────────────────────────────────────────────

async function collectData() {
  const [fngNow, fng7d] = await Promise.all([
    get('https://api.alternative.me/fng/?limit=1'),
    get('https://api.alternative.me/fng/?limit=7'),
  ]);

  return {
    prices:       fresh(readJson(FILES.exchangePrices)),
    kalshi:       fresh(readJson(FILES.kalshiRaw)),
    polymarket:   fresh(readJson(FILES.polymarketRaw)),
    manifold:     fresh(readJson(FILES.manifoldRaw)),
    metaculus:    fresh(readJson(FILES.metaculusRaw)),
    predictit:    fresh(readJson(FILES.predictitRaw)),
    odds:         fresh(readJson(FILES.oddsApiRaw)),
    betfair:      readJson(FILES.betfairRaw),
    augur:        readJson(FILES.augurRaw),
    gnosis:       readJson(FILES.gnosisRaw),
    futuur:       readJson(FILES.futuurRaw),
    goodjudgment: readJson(FILES.goodjudgmentRaw),
    rebal:        readJson(FILES.rebalancerOutput),
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
  const { prices, kalshi, polymarket, manifold, metaculus, predictit, odds, betfair, augur, gnosis, futuur, goodjudgment, rebal, fngNow, fng7d } = data;
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
  if (augur?.markets?.length) {
    augur.markets.slice(0, 20).forEach(m => {
      const yes = m.outcomes?.find(o => o.description?.toLowerCase().includes('yes'));
      const p   = yes ? +(parseFloat(yes.price || '0') * 100).toFixed(1) : null;
      if (p != null && p > 3 && p < 97) flatMarkets.push({ platform: 'augur', title: m.description || '', price: p, url: `https://augur.net` });
    });
  }
  if (gnosis?.markets?.length) {
    gnosis.markets.slice(0, 20).forEach(m => {
      const yes = m.prices?.find(o => o.outcome?.toLowerCase().includes('yes') || o.outcome?.toLowerCase().includes('true'));
      const p   = yes ? +(yes.price * 100).toFixed(1) : (m.prices?.[0] ? +(m.prices[0].price * 100).toFixed(1) : null);
      if (p != null && p > 3 && p < 97) flatMarkets.push({ platform: 'gnosis', title: m.title || '', price: p, url: m.url || 'https://omen.eth.limo' });
    });
  }
  if (futuur?.markets?.length) {
    futuur.markets.slice(0, 20).forEach(m => {
      const yes = m.outcomes?.find(o => o.label?.toLowerCase().includes('yes') || o.label?.toLowerCase().includes('true'));
      const p   = yes?.prob != null ? +(yes.prob * 100).toFixed(1) : null;
      if (p != null && p > 3 && p < 97) flatMarkets.push({ platform: 'futuur', title: m.title || '', price: p, url: m.url || 'https://futuur.com' });
    });
  }
  if (goodjudgment?.questions?.length) {
    goodjudgment.questions.slice(0, 20).forEach(q => {
      const p = q.probability != null ? +(q.probability * 100).toFixed(1) : null;
      if (p != null && p > 3 && p < 97) flatMarkets.push({ platform: 'goodjudgment', title: q.title || '', price: p, url: q.url || 'https://www.gjopen.com' });
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

  // ── Platform summary ───────────────────────────────────────────────────────

  lines.push(`\n=== PLATFORM SUMMARY ===`);
  const pCount = p => flatMarkets.filter(m => m.platform === p).length;
  lines.push(`Kalshi: ${pCount('kalshi')} | Polymarket: ${pCount('polymarket')} | Manifold: ${pCount('manifold')}`);
  lines.push(`PredictIt: ${pCount('predictit')} | Metaculus: ${pCount('metaculus')} | Augur: ${pCount('augur')}`);
  lines.push(`Gnosis: ${pCount('gnosis')} | Futuur: ${pCount('futuur')} | GoodJudgment: ${pCount('goodjudgment')}`);
  if (betfair?.markets?.length) lines.push(`Betfair: ${betfair.markets.length} markets (${betfair.exchangeCount ?? 0} exchange, ${betfair.oddsApiCount ?? 0} odds-api)`);

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

// ── History + accuracy context ─────────────────────────────────────────────────

function buildHistoryContext(accuracyStats) {
  const log = readJson(FILES.log);
  if (!Array.isArray(log) || !log.length) return '';

  const lines = ['\n=== ANALYST HISTORY (last 24h) ==='];
  const cutoff24h = Date.now() - 24 * 3600 * 1000;
  const recent = log.filter(e => new Date(e.ts).getTime() > cutoff24h && e.status === 'success');

  if (recent.length) {
    const avgConf = Math.round(recent.reduce((s, e) => s + (e.avg_confidence ?? 0), 0) / recent.length);
    const types   = recent.flatMap(e => e.best ? [e.best.type] : []);
    const typeCount = {};
    types.forEach(t => { typeCount[t] = (typeCount[t] ?? 0) + 1; });
    const topType = Object.entries(typeCount).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';
    lines.push(`Scans: ${recent.length} | avg confidence: ${avgConf}% | most frequent type: ${topType}`);

    // Show top opportunities from last 3 scans
    const last3 = recent.slice(-3);
    for (const entry of last3) {
      if (entry.best) {
        lines.push(`  ${new Date(entry.ts).toISOString().slice(11, 16)}: [${entry.best.type}] "${entry.best.title?.slice(0, 55)}" conf=${entry.best.confidence}%`);
      }
    }
  } else {
    lines.push('No successful scans in last 24h yet (first run)');
  }

  // Accuracy feedback
  if (accuracyStats.totalResolved > 0) {
    lines.push('\n=== PREDICTION ACCURACY FEEDBACK ===');
    if (accuracyStats.accuracy7d !== null) {
      lines.push(`7-day accuracy: ${accuracyStats.accuracy7d}% (${accuracyStats.totalCorrect}/${accuracyStats.totalResolved} predictions resolved)`);
    }
    if (accuracyStats.typeAccuracy) {
      lines.push(`Accuracy by type: ${accuracyStats.typeAccuracy}`);
    }
    if (accuracyStats.recentResolved.length) {
      lines.push('Recent outcomes:');
      accuracyStats.recentResolved.forEach(r => lines.push(r));
    }

    // Calibration hint based on accuracy
    const acc = accuracyStats.accuracy7d ?? accuracyStats.accuracyAll;
    if (acc !== null) {
      if (acc < 40) {
        lines.push('CALIBRATION NOTE: Recent predictions were mostly wrong. Be more conservative with confidence scores — prefer lower confidence (40-60%) unless the arb is mechanical (CEX/funding rate).');
      } else if (acc >= 70) {
        lines.push('CALIBRATION NOTE: Recent predictions have been accurate. Current methodology is working well.');
      } else {
        lines.push('CALIBRATION NOTE: Mixed accuracy. Focus on mechanical arbitrage (funding rates, CEX spreads) over subjective prediction market mispricing.');
      }
    }
  } else {
    lines.push('\n=== PREDICTION ACCURACY ===');
    lines.push('No resolved predictions yet (tracker started fresh). Use standard confidence scoring.');
  }

  return lines.join('\n');
}

// ── System prompt ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert arbitrage analyst with access to real-time data from 5 prediction market platforms plus CEX crypto prices and sports odds. You also receive feedback on your past predictions' accuracy.

Analyze ALL provided data. Find the top 5 opportunities ranked by (confidence × ROI).

IMPORTANT: Use the PREDICTION ACCURACY FEEDBACK section to calibrate your confidence scores. If past predictions were wrong, be more conservative. If mechanical arbitrage (funding rates, CEX spreads) performed well, favor those.

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

Priority: pre-computed cross-platform matches > funding rate arb > CEX arb > sports arb.
For cross-platform matches: use the exact platforms and prices provided.
For confidence: factor in liquidity, time to resolution, similarity score, AND historical accuracy.`;

// ── Claude call ────────────────────────────────────────────────────────────────

async function callClaude(contextText, historyText) {
  const prompt = `${SYSTEM_PROMPT}\n\nMARKET DATA:${historyText}\n${contextText}\n\nReturn top 5 opportunities as JSON array:`;

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

  const { context, flatMarkets, matches } = buildContext(data);
  console.log(`[master] context built | cross-platform matches: ${matches.length}`);

  // Check accuracy for past predictions using current prices
  const tracker       = checkAccuracy(flatMarkets);
  const accuracyStats = computeAccuracyStats(tracker);
  console.log(`[master] accuracy: ${accuracyStats.accuracy7d ?? '?'}% 7d | ${accuracyStats.totalResolved} resolved`);

  const historyText = buildHistoryContext(accuracyStats);
  const opportunities = await callClaude(context, historyText);

  if (!opportunities?.length) {
    console.error('[master] no opportunities returned');
    appendLog({ ts, status: 'error', reason: 'no opportunities from claude', sources });
    return;
  }

  console.log(`[master] got ${opportunities.length} opportunities:`);
  opportunities.forEach((o, i) => {
    console.log(`  [${i+1}] ${o.type} | conf=${o.confidence} | urgency=${o.urgency} | ${o.title}`);
  });

  // Save predictions for future accuracy tracking
  savePredictions(opportunities, flatMarkets);

  const fngValue = data.fngNow?.data?.[0]?.value ?? '?';
  const fngLabel = data.fngNow?.data?.[0]?.value_classification ?? '?';

  // Write master-opportunities.json (full detail)
  writeJson(FILES.masterOut, {
    timestamp:              ts,
    fear_greed:             { value: fngValue, label: fngLabel },
    opportunities,
    cross_platform_matches: matches.length,
    accuracy_7d:            accuracyStats.accuracy7d,
    data_sources:           sources,
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
      total:      arbOpps.length + prevOpps.length,
      bestRoi:    Math.max(...arbOpps.map(o => o.roi), 0),
      aiMaster:   arbOpps.length,
      accuracy7d: accuracyStats.accuracy7d,
    },
  });

  // Update ui-data.json
  const ui = readJson(FILES.uiData) || {};
  ui.masterOpportunities  = arbOpps;
  ui.fearGreed            = { value: fngValue, label: fngLabel };
  ui.masterUpdatedAt      = ts;
  ui.crossPlatformMatches = matches.length;
  ui.accuracy7d           = accuracyStats.accuracy7d;
  writeJson(FILES.uiData, ui);

  // Personalized per-user alerts (Telegram + Email)
  const accNote = accuracyStats.accuracy7d !== null ? ` | 7d accuracy: ${accuracyStats.accuracy7d}%` : '';
  try {
    const { rows: users } = await db.query(
      `SELECT u.id, u.email, u.name, u."telegramChatId", u.plan,
              p."minRoi", p."minConfidence", p."alertTypes", p."platforms", p."alertsEnabled", p."emailAlerts"
       FROM "User" u
       JOIN "UserPreferences" p ON p."userId" = u.id
       WHERE p."alertsEnabled" = true
         AND (
           (u."telegramChatId" IS NOT NULL AND u."telegramChatId" != '')
           OR (p."emailAlerts" = true AND u.plan IN ('pro','profit_share'))
         )`
    );
    for (const user of users) {
      const { id: userId, email, name, telegramChatId, plan, minRoi, minConfidence, alertTypes, platforms, emailAlerts } = user;
      const userAlerts = opportunities.filter(o => {
        if (o.confidence < (minConfidence ?? 80)) return false;
        if (o.urgency !== 'high') return false;
        const roi = parseFloat(o.net_profit ?? 0) / 10; // approximate ROI% on $1000
        if (roi < (minRoi ?? 3)) return false;
        if (Array.isArray(alertTypes) && alertTypes.length && !alertTypes.includes(o.type)) return false;
        if (Array.isArray(platforms) && platforms.length) {
          const inPlatforms = [o.platform_a, o.platform_b].some(p => p && platforms.includes(p.toLowerCase()));
          if (!inPlatforms) return false;
        }
        return true;
      });
      if (!userAlerts.length) continue;

      // Telegram alert
      if (telegramChatId) {
        const lines = userAlerts.map(o =>
          `<b>${o.rank}. ${o.title}</b>\n${o.description}\n` +
          (o.platform_a && o.platform_b ? `${o.platform_a} ${o.price_a}¢ → ${o.platform_b} ${o.price_b}¢\n` : '') +
          `Net profit on $1000: <b>$${o.net_profit ?? '?'}</b> | Conf: ${o.confidence}%\n` +
          `Action: ${o.action}\nRisk: ${o.risk} | Expires: ${o.expiry_hours ? o.expiry_hours + 'h' : 'open'}`
        ).join('\n\n');
        sendTelegramTo(telegramChatId, `🧠 AI MASTER — ${userAlerts.length} alert${userAlerts.length > 1 ? 's' : ''}\nFNG: ${fngValue} (${fngLabel})${accNote}\n\n${lines}`);
      }

      // Email alert (PRO/profit_share only, 1 email per hour per user)
      if (emailAlerts && email && ['pro', 'profit_share'].includes(plan)) {
        const now = Date.now();
        if (now - (emailLastSent[userId] ?? 0) > 3600000) {
          emailLastSent[userId] = now;
          const topOpp = userAlerts[0];
          const roi = parseFloat(topOpp.net_profit ?? 0) / 10;
          await sendEmailAlert(email, name, { ...topOpp, roi });
        }
      }
    }
  } catch (e) {
    console.error('[master] personalized alerts db error:', e.message);
    // fallback: send to default chat
    const alerts = opportunities.filter(o => o.confidence >= 80 && o.urgency === 'high');
    if (alerts.length) {
      const lines = alerts.map(o =>
        `<b>${o.rank}. ${o.title}</b>\n${o.description}\n` +
        (o.platform_a && o.platform_b ? `${o.platform_a} ${o.price_a}¢ → ${o.platform_b} ${o.price_b}¢\n` : '') +
        `Net profit on $1000: <b>$${o.net_profit ?? '?'}</b> | Conf: ${o.confidence}%\n` +
        `Action: ${o.action}\nRisk: ${o.risk} | Expires: ${o.expiry_hours ? o.expiry_hours + 'h' : 'open'}`
      ).join('\n\n');
      sendTelegram(`🧠 AI MASTER — ${alerts.length} HIGH alert${alerts.length > 1 ? 's' : ''}\nFNG: ${fngValue} (${fngLabel})${accNote}\n\n${lines}`);
    }
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
    accuracy_7d:    accuracyStats.accuracy7d,
    data_sources:   sources,
  });

  console.log(`[master] done | avg_conf=${avgConf}% | alerts=${alerts.length} | matches=${matches.length} | accuracy_7d=${accuracyStats.accuracy7d ?? 'n/a'}%`);
}

async function tick() {
  try { await run(); } catch (err) {
    console.error('[master] crash:', err.message);
    appendLog({ ts: new Date().toISOString(), status: 'crash', error: err.message });
  }
  setTimeout(tick, INTERVAL_MS);
}

tick();
