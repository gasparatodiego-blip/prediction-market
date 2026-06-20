#!/usr/bin/env node
'use strict';

/**
 * matcher-v2: full-universe deterministic pairing — one-shot pipeline
 *
 * Stage 0  Load & clean markets from raw data (auto-refreshes if stale)
 * Stage 1  Inverted-index candidate pairing — deterministic, NO Claude
 * Stage 2  Arb pre-filter — fee-aware spread math, NO Claude
 * Stage 3  Haiku confirmation — ONLY on Stage-2 survivors, max 60 pairs
 *
 * Run once:  node agents/matcher-v2.js
 * Output:    /tmp/arbitrage-opportunities.json  (same format dashboard reads)
 */

const fs        = require('fs');
const https     = require('https');
const http      = require('http');
const path      = require('path');
const Anthropic = require('@anthropic-ai/sdk');

// Shared fee constants — single source of truth used by both matcher-v2 and agent23-prediction-repricer.
// Import here so the two tiers can never have divergent fee math.
const { PLATFORM_FEES: _PLATFORM_FEES } = require('../lib/arb-math');

// Load ANTHROPIC_API_KEY from .env.matcher (chmod 600, gitignored).
// Cron runs without the interactive shell environment — self-load so the key
// is always present regardless of how the script is invoked.
// SECURITY: the key value is read into process.env and never written to logs.
function loadEnvFile() {
  const envPath = path.join(__dirname, '..', '.env.matcher');
  try {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 1) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim();
      // Only set if not already in environment; never overwrite a caller-supplied value.
      if (k && v && !process.env[k]) process.env[k] = v;
    }
  } catch { /* file absent — key must come from environment */ }
}
loadEnvFile();

// ── Config ────────────────────────────────────────────────────────────────────

const RAW_FILE          = '/tmp/markets-raw.json';
const OUT_FILE          = '/tmp/arbitrage-opportunities.json';
const UNIFIED_FILE      = '/tmp/unified-opportunities.json';
const SPORTS_FILE       = '/tmp/sports-odds.json';
const CONFIRM_CACHE_FILE = path.join(__dirname, '..', 'data', 'confirmation-cache.json');
const MODEL             = 'claude-haiku-4-5-20251001';
const MAX_STALE_MS      = 10 * 60 * 1000;   // auto-refresh if older than 10 min

// Stage 1 — IDF-weighted gating (no flat candidate cap)
const MIN_TOKEN_LEN  = 3;
const MIN_INDEX_IDF      = 3.0;  // index tokens with IDF ≥ this  (df < N/e^3 ≈ 2660)
const MAX_POSTING        = 2000; // safety cap: skip tokens appearing in > 2000 markets
const MIN_IDF_SCORE      = 8.0;  // pair must accumulate ≥ this total IDF from shared tokens
const HIGH_IDF_THRESHOLD = 4.0;  // "truly distinctive" token threshold (df < N/e^4 ≈ 979)
const MIN_HIGH_IDF_SHARED = 2;   // pair must share ≥ 2 truly-distinctive tokens
                                  // separates entity matches (correct) from context matches (noise)

// Stage 2 — executable bid/ask arb math
const MIN_SIGNAL_SPREAD = 5;      // mid-spread threshold for signal (play-money) pairs
const MAX_SPREAD_WIDTH  = 0.10;   // yesAsk-yesBid > 10¢ on either leg → illiquid, skip cashable
const SUSPICIOUS_ROI    = 15;     // netROI above 15% → quarantine (real arbs are ~1-8%)

// Stage 3 — cache-first confirmation
const CONFIRM_BATCH      = 10;   // pairs per Haiku call
const MAX_NEW_PAIRS      = parseInt(process.env.NEW_PAIRS_PER_RUN || '200', 10);  // new (uncached) cap per run
const CACHE_RECONFIRM_MS = 90 * 24 * 60 * 60 * 1000;  // re-confirm entries older than 90 days
// Real executable arbs cluster in the plausible band; outside it candidates are
// either too thin (noise) or suspiciously wide (semantic mismatch / stale price).
const ARB_BAND_LOW       = 2.0;  // netROI% lower bound for plausible-band priority
const ARB_BAND_HIGH      = 8.0;  // netROI% upper bound for plausible-band priority

// ── Platform metadata ─────────────────────────────────────────────────────────

// Imported from lib/arb-math.js — do NOT duplicate here.
const PLATFORM_FEES = _PLATFORM_FEES;
// realBook = true means the platform exposes executable bid/ask (CLOB or best-bid/ask).
// Cashable arb requires realBook=true on BOTH legs.
// realMoney=true but realBook=false → signal-only (Futuur: mid-price from orderbook API only)
const REAL_BOOK = new Set(['kalshi', 'polymarket', 'predictit']);
const DISPLAY   = { kalshi: 'Kalshi', polymarket: 'Polymarket', predictit: 'PredictIt', manifold: 'Manifold', futuur: 'Futuur' };

// ── Text normalisation ────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'will','the','a','an','in','by','of','at','to','for','and','or','is','are',
  'be','as','its','it','win','wins','winning','market','prediction','happen',
  'occur','make','have','has','that','this','with','from','on','not','no',
  'yes','next','how','which','who','what','when','where','why','than','their',
  'they','he','she','we','do','did','does','before','after','during','outcome',
  'over','under','more','less','most','least','any','all','each','first','last',
  'new','old','get','got','been','were','was','would','could','should','may',
  'might','can','shall','must','about','between','against','without','within',
  'through','into','onto','upon','around','per','if',
]);

function tokenize(text) {
  const clean    = (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const rawWords = clean.split(/\s+/).filter(Boolean);
  const words    = rawWords.filter(t => t.length >= MIN_TOKEN_LEN && !STOPWORDS.has(t));
  const toks     = new Set(words);
  // Bigrams from filtered words: "world cup" → "world_cup"
  for (let i = 0; i < words.length - 1; i++) toks.add(`${words[i]}_${words[i + 1]}`);
  // Bigrams that preserve single-letter labels: "group a" → "group_a", "group b" → "group_b"
  // These are filtered out by MIN_TOKEN_LEN but are critical group/round identifiers
  for (let i = 0; i < rawWords.length - 1; i++) {
    const a = rawWords[i], b = rawWords[i + 1];
    if (a.length >= MIN_TOKEN_LEN && !STOPWORDS.has(a) && b.length === 1 && /[a-z0-9]/.test(b)) {
      toks.add(`${a}_${b}`);
    }
  }
  return toks;
}

// ── One-shot data fetch (runs only if raw data is stale) ──────────────────────

function fetchJson(url) {
  return new Promise(resolve => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'prediction-arb-scanner/1.0' }, timeout: 20000 }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// Like fetchJson but also returns the HTTP status code and Retry-After header.
function fetchJsonWithStatus(url) {
  return new Promise(resolve => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'prediction-arb-scanner/1.0' }, timeout: 20000 }, res => {
      const status     = res.statusCode;
      const retryAfter = parseInt(res.headers['retry-after'] || '0', 10) || 0;
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ data: JSON.parse(body), status, retryAfter }); }
        catch { resolve({ data: null, status, retryAfter }); }
      });
    });
    req.on('error', () => resolve({ data: null, status: 0, retryAfter: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ data: null, status: 0, retryAfter: 0 }); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Confirmation cache ────────────────────────────────────────────────────────
// Stable pair key: djb2 hash of sorted (platform|url) leg pairs.
// Matches the stableOppId scheme used in app/api/prediction/route.ts.

function stableOppId(a, b) {
  const parts = [
    (a.platform ?? '') + '|' + (a.url ?? ''),
    (b.platform ?? '') + '|' + (b.url ?? ''),
  ].sort();
  const src = parts.join('\n');
  let h = 5381;
  for (let i = 0; i < src.length; i++) {
    h = (Math.imul(h, 33) ^ src.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

function loadConfirmCache() {
  try { return JSON.parse(fs.readFileSync(CONFIRM_CACHE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveConfirmCache(cache) {
  const tmp = CONFIRM_CACHE_FILE + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, CONFIRM_CACHE_FILE);
}

// ── Kalshi URL helpers ───────────────────────────────────────────────────────

function slugify(str) {
  return (str || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Derives event_ticker from market ticker by stripping the market-specific suffix.
// e.g. KXWCSTAGEOFELIM-26BIH-R16 + series KXWCSTAGEOFELIM → KXWCSTAGEOFELIM-26BIH
function kalshiEventTicker(marketTicker, seriesTicker) {
  if (!seriesTicker || !marketTicker || !marketTicker.startsWith(seriesTicker + '-')) return marketTicker;
  const remainder = marketTicker.slice(seriesTicker.length + 1);
  const dashIdx   = remainder.indexOf('-');
  if (dashIdx === -1) return marketTicker; // single segment after series → event = market ticker
  return seriesTicker + '-' + remainder.slice(0, dashIdx);
}

// In-memory cache: series_ticker → slugified series title from external-api.kalshi.com
const _kalshiSeriesSlugCache = new Map();

async function fetchKalshiSeriesSlug(seriesTicker) {
  if (_kalshiSeriesSlugCache.has(seriesTicker)) return _kalshiSeriesSlugCache.get(seriesTicker);
  try {
    const data = await fetchJson(`https://external-api.kalshi.com/trade-api/v2/series/${seriesTicker}`);
    const slug = slugify(data?.series?.title || '');
    _kalshiSeriesSlugCache.set(seriesTicker, slug || null);
    return slug || null;
  } catch {
    _kalshiSeriesSlugCache.set(seriesTicker, null);
    return null;
  }
}

async function prefetchKalshiSeriesSlugs(kalshiMarkets) {
  const tickers = [...new Set((kalshiMarkets || []).map(m => m.series_ticker).filter(Boolean))];
  if (tickers.length === 0) return;
  console.log(`[v2/kalshi] pre-fetching series slugs for ${tickers.length} series…`);
  await Promise.allSettled(tickers.map(t => fetchKalshiSeriesSlug(t)));
  const hits = [..._kalshiSeriesSlugCache.values()].filter(Boolean).length;
  console.log(`[v2/kalshi] series slug cache: ${hits}/${tickers.length} resolved`);
}

// ─────────────────────────────────────────────────────────────────────────────

function kalshiPageToMarkets(data) {
  const out = [];
  for (const ev of (data?.events || [])) {
    for (const m of (ev.markets || [])) {
      const bid = parseFloat(m.yes_bid_dollars || '0');
      const ask = parseFloat(m.yes_ask_dollars || '0');
      if (bid <= 0 && ask <= 0) continue;
      out.push({
        ticker:          m.ticker,
        event_ticker:    ev.event_ticker || null,   // authoritative event-level ticker for URL
        series_ticker:   ev.series_ticker || null,
        title:           ev.title || '',
        yes_bid_dollars: m.yes_bid_dollars,
        yes_ask_dollars: m.yes_ask_dollars,
        close_time:      m.close_time || ev.close_time || null,
      });
    }
  }
  return out;
}

async function fetchKalshiAll() {
  const all = []; let cursor = null, page = 0;
  let consecutiveErrors = 0;
  while (page < 60) {
    let url = 'https://api.elections.kalshi.com/trade-api/v2/events?limit=200&status=open&with_nested_markets=true';
    if (cursor) url += '&cursor=' + encodeURIComponent(cursor);
    const { data, status, retryAfter } = await fetchJsonWithStatus(url);
    if (status === 429) {
      const wait = Math.max(retryAfter || 5, 5) * 1000;
      console.log(`[v2/fetch] Kalshi 429 — waiting ${wait / 1000}s before retry`);
      await sleep(wait);
      continue; // retry same page, don't increment
    }
    if (!data || !Array.isArray(data.events) || !data.events.length) {
      if (++consecutiveErrors >= 3) break;
      await sleep(1000);
      continue;
    }
    consecutiveErrors = 0;
    all.push(...kalshiPageToMarkets(data));
    cursor = data.cursor || '';
    page++;
    if (!cursor) break;
    await sleep(150);
  }
  console.log(`[v2/fetch] kalshi: ${page} pages → ${all.length} priced markets`);
  return all;
}

const SPORT_SLUGS_MUST = ['world-cup'];
const SPORT_KW = [
  'world-cup','nfl','nba','nhl','mlb','soccer','football','basketball',
  'baseball','hockey','tennis','boxing','ufc','mma','golf','cricket',
  'rugby','olympics','formula-one','motorsports','cycling','swimming',
  'athletics','volleyball','esport','chess',
];

async function discoverPolymarketSlugs() {
  const slugs = [...SPORT_SLUGS_MUST];
  for (let offset = 0; offset < 600; offset += 100) {
    const data = await fetchJson(`https://gamma-api.polymarket.com/tags?limit=100&offset=${offset}`);
    if (!Array.isArray(data) || !data.length) break;
    for (const t of data) {
      const s = (t.slug || t.id || '').toLowerCase();
      if (SPORT_KW.some(k => s.includes(k))) slugs.push(t.slug || t.id);
    }
    if (data.length < 100) break;
    await sleep(80);
  }
  return [...new Set(slugs)];
}

async function fetchPolymarketAll() {
  const pmRaw = await fetchJson('https://gamma-api.polymarket.com/markets?active=true&limit=200');
  const pmBase = Array.isArray(pmRaw) ? pmRaw : [];
  const byId = new Map(pmBase.map(m => [String(m.id || m.conditionId || ''), m]));

  const slugs = await discoverPolymarketSlugs();
  let added = 0;
  for (const slug of slugs) {
    let offset = 0;
    while (true) {
      const data = await fetchJson(`https://gamma-api.polymarket.com/events?active=true&limit=50&offset=${offset}&tag_slug=${slug}`);
      const evs = Array.isArray(data) ? data : [];
      if (!evs.length) break;
      for (const ev of evs) {
        for (const m of (ev.markets || [])) {
          const id = String(m.id || m.conditionId || m.questionID || '');
          // Attach the parent event slug so URL building can use event/{eventSlug}/{marketSlug}.
          // Markets from the base /markets endpoint already carry m.events[0].slug; markets
          // fetched here (nested inside event responses) do not — save it explicitly.
          if (id && !byId.has(id)) { byId.set(id, { ...m, _eventSlug: ev.slug || null }); added++; }
        }
      }
      if (evs.length < 50) break;
      offset += 50;
      await sleep(80);
    }
  }
  const all = [...byId.values()];
  console.log(`[v2/fetch] polymarket: ${pmBase.length} base + ${added} tag-added (${slugs.length} slugs) → ${all.length} total`);
  return all;
}

async function fetchFutuurAll() {
  const all = [];
  let offset = 0;
  while (true) {
    const data = await fetchJson(`https://api.futuur.com/api/v1/markets/?status=open&limit=100&offset=${offset}`);
    if (!data?.results?.length) break;
    all.push(...data.results);
    const total = data.pagination?.total ?? all.length;
    if (all.length >= total) break;
    offset += 100;
    await sleep(150);
  }
  console.log(`[v2/fetch] futuur: ${all.length} markets`);
  return all;
}

async function freshFetch() {
  console.log('[v2/fetch] Raw data stale — running one-shot fetch...');
  const [kalshi, piRaw, mfRaw, futuur] = await Promise.all([
    fetchKalshiAll(),
    fetchJson('https://www.predictit.org/api/marketdata/all/'),
    fetchJson('https://api.manifold.markets/v0/markets?limit=100&sort=last-bet-time&order=desc'),
    fetchFutuurAll(),
  ]);
  const polymarket = await fetchPolymarketAll();
  const result = {
    fetchedAt:  Date.now(),
    predictit:  piRaw?.markets ?? [],
    manifold:   Array.isArray(mfRaw) ? mfRaw : [],
    kalshi,
    polymarket,
    futuur,
  };
  fs.writeFileSync(RAW_FILE, JSON.stringify(result, null, 2));
  console.log(`[v2/fetch] saved — KA:${kalshi.length} PM:${polymarket.length} PI:${result.predictit.length} MF:${result.manifold.length} FU:${futuur.length}`);
  return result;
}

// ── Country/entity code expansion ────────────────────────────────────────────
// Kalshi ticker suffixes use 3-letter codes (FIFA, IOC, etc.) while Polymarket
// uses full names.  Map code → full name so both sides share a token.

const CODE_TO_NAME = {
  // World Cup 2026 Group A–L countries (covers most)
  MEX: 'mexico',  USA: 'usa',      KOR: 'south korea', SAF: 'south africa', CZE: 'czechia',
  BRA: 'brazil',  ARG: 'argentina', FRA: 'france',      ENG: 'england',     GER: 'germany',
  ESP: 'spain',   POR: 'portugal',  ITA: 'italy',       NED: 'netherlands', BEL: 'belgium',
  URU: 'uruguay', COL: 'colombia',  CHI: 'chile',       ECU: 'ecuador',     PER: 'peru',
  PAR: 'paraguay',BOL: 'bolivia',   JAM: 'jamaica',     PAN: 'panama',      CRC: 'costa rica',
  HON: 'honduras',ELS: 'el salvador',GUA: 'guatemala',  TRI: 'trinidad',    CAN: 'canada',
  AUS: 'australia',JPN: 'japan',    CHN: 'china',       IRN: 'iran',        SAU: 'saudi arabia',
  QAT: 'qatar',   MAR: 'morocco',   NGA: 'nigeria',     SEN: 'senegal',     EGY: 'egypt',
  CMR: 'cameroon',GHA: 'ghana',     CIV: 'ivory coast', ALG: 'algeria',
  // US politics (just pass through common abbrevs verbatim but ensure length-3 isn't filtered)
};

function expandCode(code) {
  return CODE_TO_NAME[code.toUpperCase()] || '';
}

// ── Kalshi ticker expansion ───────────────────────────────────────────────────
// Kalshi event titles are often short ("Group A Winner") — the ticker encodes
// sport context (WC=world cup, NFL, NBA…) that must be added for matching.

const TICKER_EXPANDS = {
  WC:       'world cup',
  NFL:      'football nfl',
  NBA:      'basketball nba',
  MLB:      'baseball mlb',
  NHL:      'hockey nhl',
  SOCCER:   'soccer football',
  FIFA:     'fifa world cup soccer',
  UFC:      'ufc mma fighting',
  GOLF:     'golf',
  TENNIS:   'tennis',
  CRICKET:  'cricket',
  RUGBY:    'rugby',
  OLYMPIC:  'olympics',
};

function kalshiTickerExtra(ticker) {
  const prefix = (ticker || '').toUpperCase().replace(/^KX/, '').split('-')[0];
  const words  = [];
  for (const [abbr, expansion] of Object.entries(TICKER_EXPANDS)) {
    if (prefix.includes(abbr)) words.push(expansion);
  }
  return words.join(' ');
}

// ── Stage 0: Load & Clean ─────────────────────────────────────────────────────

function loadAndClean(raw) {
  const markets = [];
  const counts  = { ka: 0, pm: 0, pi: 0, mf: 0, fu: 0 };

  // PredictIt — one market per CONTRACT (each contract = a specific outcome)
  for (const m of (raw.predictit || [])) {
    const title = m.shortName || m.name || '';
    if (!title) continue;
    for (const c of (m.contracts || [])) {
      if (c.lastTradePrice == null) continue;
      const prob = Math.round(c.lastTradePrice * 100);
      if (prob <= 1 || prob >= 99) continue;
      const outcome = c.shortName || c.name || '';
      // yesBid = 1 - bestBuyNoCost (what buyers would pay for NO → implied YES bid)
      // yesAsk = bestBuyYesCost (lowest ask for YES)
      const piYesAsk = c.bestBuyYesCost != null ? c.bestBuyYesCost : c.lastTradePrice;
      const piYesBid = c.bestBuyNoCost  != null ? (1 - c.bestBuyNoCost) : c.lastTradePrice;
      markets.push({
        id: `pi-${m.id}-${c.id}`,
        platform:   'predictit',
        rawTitle:   outcome ? `${title} [outcome: ${outcome}]` : title,
        baseTitle:  title,
        outcome,
        probability: prob,
        yesBid:     +piYesBid.toFixed(4),
        yesAsk:     +piYesAsk.toFixed(4),
        realMoney:  true,
        realBook:   true,
        url: `https://www.predictit.org/markets/detail/${m.id}`,
        urlVerified: true,
      });
      counts.pi++;
    }
  }

  // Manifold — BINARY only (play money, no real order book)
  for (const m of (raw.manifold || [])) {
    if (m.outcomeType !== 'BINARY' || m.probability == null) continue;
    const q = m.question || '';
    if (!q) continue;
    const prob = Math.round(m.probability * 100);
    if (prob <= 1 || prob >= 99) continue;
    const single = m.probability;
    markets.push({
      id: `mf-${m.id}`,
      platform:   'manifold',
      rawTitle:   q,
      baseTitle:  q,
      outcome:    '',
      probability: prob,
      yesBid:     single,  // play-money: no real book, use prob as pointlike price
      yesAsk:     single,
      realMoney:  false,
      realBook:   false,
      url: m.url || `https://manifold.markets/`,
      urlVerified: !!(m.url && m.url !== 'https://manifold.markets/'),
    });
    counts.mf++;
  }

  // Kalshi — outcome = ticker suffix (e.g. "MEX", "DEM", "YES")
  for (const m of (raw.kalshi || [])) {
    const bid = parseFloat(m.yes_bid_dollars || '0');
    const ask = parseFloat(m.yes_ask_dollars || '0');
    if (bid <= 0 && ask <= 0) continue;
    const title = m.title || '';
    if (!title) continue;
    const prob = bid > 0 && ask > 0
      ? Math.round(((bid + ask) / 2) * 100)
      : Math.round((ask || bid) * 100);
    if (prob <= 1 || prob >= 99) continue;
    const tickerSuffix   = m.ticker ? m.ticker.split('-').pop() : '';
    const tickerExtra    = kalshiTickerExtra(m.ticker);
    const suffixFullName = tickerSuffix ? expandCode(tickerSuffix) : '';
    markets.push({
      id: `ka-${m.ticker}`,
      platform:   'kalshi',
      rawTitle:   tickerSuffix ? `${title} [outcome: ${tickerSuffix}]` : title,
      baseTitle:  title,
      outcome:    tickerSuffix,
      tickerExtra,
      suffixFullName,
      probability: prob,
      yesBid:     bid,
      yesAsk:     ask,
      realMoney:  true,
      realBook:   true,
      closeTime:  m.close_time || null,
      // Three-segment canonical URL: /markets/{series}/{series_slug}/{event_ticker}
      // series_slug comes from the external-api series endpoint (pre-fetched into cache).
      // event_ticker is stored at fetch time (ev.event_ticker) or derived by stripping the
      // market-specific suffix from the market ticker.
      ...(() => {
        const evTicker   = m.event_ticker || kalshiEventTicker(m.ticker, m.series_ticker);
        const seriesLow  = m.series_ticker?.toLowerCase();
        const seriesSlug = m.series_ticker ? (_kalshiSeriesSlugCache.get(m.series_ticker) ?? null) : null;
        if (seriesLow && seriesSlug && evTicker) {
          return { url: `https://kalshi.com/markets/${seriesLow}/${seriesSlug}/${evTicker.toLowerCase()}`, urlVerified: true };
        } else if (seriesLow) {
          return { url: `https://kalshi.com/markets/${seriesLow}`, urlVerified: false };
        }
        return { url: 'https://kalshi.com', urlVerified: false };
      })(),
    });
    counts.ka++;
  }

  // Polymarket — YES price for similarity; bestBid/bestAsk for executable arb
  for (const m of (raw.polymarket || [])) {
    const q = m.question || '';
    if (!q) continue;
    let prob = null;
    try {
      const prices = typeof m.outcomePrices === 'string'
        ? JSON.parse(m.outcomePrices) : m.outcomePrices;
      if (Array.isArray(prices) && prices[0]) prob = Math.round(parseFloat(prices[0]) * 100);
    } catch {}
    if (prob == null) {
      const ltp = parseFloat(m.lastTradePrice || '0');
      if (ltp > 0) prob = Math.round(ltp * 100);
    }
    if (prob == null) {
      const bid = parseFloat(m.bestBid || '0');
      const ask = parseFloat(m.bestAsk || '0');
      if (bid > 0 && ask > 0)       prob = Math.round(((bid + ask) / 2) * 100);
      else if (bid > 0.01)          prob = Math.round(bid * 100);
      else if (ask > 0 && ask < 1)  prob = Math.round(ask * 100);
    }
    if (prob == null || prob <= 1 || prob >= 99) continue;
    // Executable prices: prefer bestBid/bestAsk; fall back to outcomePrices as pointlike
    const pmBid = parseFloat(m.bestBid || '0');
    const pmAsk = parseFloat(m.bestAsk || '0');
    const pmSingle = prob / 100;
    const yB = pmBid > 0 ? pmBid : pmSingle;
    const yA = (pmAsk > 0 && pmAsk < 1) ? pmAsk : pmSingle;
    let clobTokenId = null;
    try { clobTokenId = JSON.parse(m.clobTokenIds || '[]')[0] || null; } catch {}
    markets.push({
      id: `pm-${m.id || m.conditionId}`,
      platform:     'polymarket',
      rawTitle:     q,
      baseTitle:    q,
      outcome:      '',
      probability:  prob,
      yesBid:       yB,
      yesAsk:       yA,
      realMoney:    true,
      realBook:     true,
      closeTime:    m.endDate || m.endDateIso || null,
      clobTokenId,
      // Build canonical URL: event/{eventSlug}/{marketSlug} when both available.
      // eventSlug comes from (a) _eventSlug set by fetchPolymarketAll for tag-endpoint markets,
      // or (b) m.events[0].slug for markets from the base /markets endpoint.
      // Falls back to markets homepage (verified=false) when neither is available.
      ...((() => {
        const eventSlug  = m._eventSlug || (Array.isArray(m.events) && m.events[0]?.slug) || null;
        const marketSlug = m.slug || null;
        if (eventSlug && marketSlug) return { url: `https://polymarket.com/event/${eventSlug}/${marketSlug}`, urlVerified: true };
        if (eventSlug)               return { url: `https://polymarket.com/event/${eventSlug}`,               urlVerified: true };
        return                              { url: 'https://polymarket.com/markets',                          urlVerified: false };
      })()),
    });
    counts.pm++;
  }

  // Futuur — multi-outcome, real-money USDC; mid-price only (realBook=false → signal-only)
  // Each market outcome becomes a separate entry.  Single-outcome markets are effectively binary.
  for (const m of (raw.futuur || [])) {
    const baseTitle = (m.title || '').trim();
    if (!baseTitle) continue;
    const useMoney  = m.real_currency_available;
    const rawOutcomes = Array.isArray(m.outcomes) ? m.outcomes : [];
    for (const o of rawOutcomes) {
      if (o.disabled) continue;
      const mid = useMoney
        ? (o.price?.USDC ?? o.price?.OOM ?? null)
        : (o.price?.OOM ?? null);
      if (mid == null) continue;
      const prob = Math.round(mid * 100);
      if (prob <= 1 || prob >= 99) continue;
      const outcomeTitle = (o.title || '').trim();
      // For single-outcome markets (effectively "Will X happen?"), the outcome label
      // is usually redundant with the question — include it only if it adds info.
      const rawTitle = rawOutcomes.length === 1
        ? baseTitle
        : `${baseTitle} [outcome: ${outcomeTitle}]`;
      markets.push({
        id:          `fu-${m.id}-${o.id}`,
        platform:    'futuur',
        rawTitle,
        baseTitle,
        outcome:     outcomeTitle,
        probability: prob,
        yesBid:      mid,  // mid-price only — no real executable book
        yesAsk:      mid,
        realMoney:   useMoney,
        realBook:    false,  // signal-only; never enters cashable arb path
        volume:      useMoney ? (m.volume_real_money ?? 0) : (m.volume_play_money ?? 0),
        url: `https://futuur.com/q/${m.slug || m.id}`,
        urlVerified: !!(m.slug || m.id),
      });
      counts.fu++;
    }
  }

  console.log(`[v2] Stage 0: KA:${counts.ka} PM:${counts.pm} PI:${counts.pi} MF:${counts.mf} FU:${counts.fu} → ${markets.length} pass (prob 2–98)`);
  return markets;
}

// ── Stage 1: IDF-weighted candidate pairing ──────────────────────────────────

// Gate by outcome: only skip pairs where BOTH sides have explicit, different outcomes
function outcomesCompatible(a, b) {
  const oa = (a.outcome || '').toLowerCase();
  const ob = (b.outcome || '').toLowerCase();
  if (!oa || !ob) return true;
  if (oa === ob)  return true;
  const oa_e = CODE_TO_NAME[a.outcome.toUpperCase()] || oa;
  const ob_e = CODE_TO_NAME[b.outcome.toUpperCase()] || ob;
  if (oa_e === ob_e) return true;
  if (oa === 'yes' || oa === 'no' || ob === 'yes' || ob === 'no') return true;
  return false;
}

function candidatePairing(markets) {
  const N = markets.length;

  // Token sets: base title + outcome + ticker expansion + suffix full name
  const tokenSets = markets.map(m =>
    tokenize(`${m.baseTitle} ${m.outcome} ${m.tickerExtra || ''} ${m.suffixFullName || ''}`)
  );

  // Document frequency → IDF(t) = log(N / df(t))
  const df = new Map();
  for (const ts of tokenSets) for (const t of ts) df.set(t, (df.get(t) || 0) + 1);
  const idf = new Map();
  for (const [t, freq] of df) idf.set(t, Math.log(N / freq));

  // Inverted index: only tokens with IDF ≥ MIN_INDEX_IDF and df ≤ MAX_POSTING
  const posting = new Map();
  for (let i = 0; i < markets.length; i++) {
    for (const t of tokenSets[i]) {
      if ((idf.get(t) || 0) < MIN_INDEX_IDF) continue;
      if ((df.get(t) || 0) > MAX_POSTING)    continue;
      if (!posting.has(t)) posting.set(t, []);
      posting.get(t).push(i);
    }
  }

  // Accumulate IDF score per cross-platform pair (sum of shared indexed-token IDFs)
  const pairIdf = new Map();
  let tokIndexed = 0;
  for (const [token, idxs] of posting) {
    if (idxs.length < 2) continue;
    tokIndexed++;
    const idfV = idf.get(token);
    for (let ii = 0; ii < idxs.length; ii++) {
      for (let jj = ii + 1; jj < idxs.length; jj++) {
        const a = idxs[ii], b = idxs[jj];
        if (markets[a].platform === markets[b].platform) continue;
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        pairIdf.set(key, (pairIdf.get(key) || 0) + idfV);
      }
    }
  }

  console.log(`[v2] Stage 1: N=${N}, ${tokIndexed} indexed tokens (IDF≥${MIN_INDEX_IDF}), ${pairIdf.size} raw cross-platform pairs`);

  // Gate: full IDF score (ALL shared tokens) ≥ MIN_IDF_SCORE + outcome compatible
  // No pre-filter — fullScore includes non-indexed tokens that boost genuine pairs
  const candidates = [];
  for (const [key] of pairIdf) {
    const [ai, bi] = key.split(':').map(Number);
    const tokA = tokenSets[ai], tokB = tokenSets[bi];

    let fullScore = 0;
    let highIdfCount = 0;
    for (const t of tokA) {
      if (!tokB.has(t)) continue;
      const v = idf.get(t) || 0;
      fullScore += v;
      if (v >= HIGH_IDF_THRESHOLD) highIdfCount++;
    }
    if (fullScore < MIN_IDF_SCORE) continue;
    if (highIdfCount < MIN_HIGH_IDF_SHARED) continue;  // must share ≥2 truly-distinctive tokens

    if (!outcomesCompatible(markets[ai], markets[bi])) continue;
    candidates.push({ ai, bi, idfScore: +fullScore.toFixed(2) });
  }

  console.log(`[v2] Stage 1: ${pairIdf.size} raw pairs → ${candidates.length} gated (idfScore≥${MIN_IDF_SCORE}, outcome-compatible)`);
  return { candidates };
}

// ── Stage 2: Executable arb pre-filter ───────────────────────────────────────
// ROI formula: buy YES on one platform + buy NO (= 1 - yesBid) on the other.
// Correct arb: cost = yesAsk_A + (1 - yesBid_B); profit = 1 - cost; ROI = profit/cost.
// We try both directions and take the cheaper one.

function arbPrefilter(candidates, markets) {
  const survivors   = [];
  const quarantined = [];

  for (const c of candidates) {
    const a = markets[c.ai], b = markets[c.bi];

    // ── Signal path: either leg lacks executable orderbook (Manifold, Futuur) ──
    if (!a.realBook || !b.realBook) {
      const spreadMid = Math.abs(a.probability - b.probability);
      if (spreadMid >= MIN_SIGNAL_SPREAD) {
        survivors.push({ ...c, a, b, spread: spreadMid, gross: 0, net: 0, type: 'signal' });
      }
      continue;
    }

    // ── Cashable path: both real-money ────────────────────────────────────

    // Guard 1: one-sided market (no bid or ask at limit)
    if (a.yesBid <= 0 || a.yesAsk >= 1) continue;
    if (b.yesBid <= 0 || b.yesAsk >= 1) continue;

    // Guard 2: illiquid (bid-ask spread > 10¢ on either leg)
    if ((a.yesAsk - a.yesBid) > MAX_SPREAD_WIDTH) continue;
    if ((b.yesAsk - b.yesBid) > MAX_SPREAD_WIDTH) continue;

    // Try both directions; pick the cheaper one
    const dir1Cost = a.yesAsk + (1 - b.yesBid); // buy YES on A, buy NO on B
    const dir2Cost = b.yesAsk + (1 - a.yesBid); // buy YES on B, buy NO on A
    const [bestCost, bestDir] = dir1Cost <= dir2Cost
      ? [dir1Cost, 1] : [dir2Cost, 2];

    const grossProfit = 1 - bestCost;
    if (grossProfit <= 0) continue; // not an arb at these prices

    const grossROI = (grossProfit / bestCost) * 100;

    // Fee-aware net ROI (win fees applied to both platforms)
    const feeA  = PLATFORM_FEES[a.platform] || 0;
    const feeB  = PLATFORM_FEES[b.platform] || 0;
    const netROI = grossROI * (1 - feeA - feeB);
    if (netROI <= 0) continue;

    const entry = {
      ...c, a, b,
      spread:   Math.abs(a.probability - b.probability),
      gross:    +grossROI.toFixed(2),
      net:      +netROI.toFixed(2),
      bestCost: +bestCost.toFixed(4),
      bestDir,
      type: 'cashable',
    };

    // Sanity quarantine: real executable arbs are typically 1-8%
    if (netROI > SUSPICIOUS_ROI) {
      quarantined.push(entry);
      continue;
    }

    survivors.push(entry);
  }

  // Cashable first (by netROI), then signal (by spread)
  survivors.sort((a, b) =>
    a.type === b.type
      ? (b.net || b.spread) - (a.net || a.spread)
      : a.type === 'cashable' ? -1 : 1
  );

  const nc = survivors.filter(s => s.type === 'cashable').length;
  const ns = survivors.filter(s => s.type === 'signal').length;
  console.log(`[v2] Stage 2: ${candidates.length} candidates → ${survivors.length} survivors (${nc} cashable, ${ns} signal), ${quarantined.length} quarantined (netROI>${SUSPICIOUS_ROI}%)`);
  return { survivors, quarantined };
}

// ── Stage 3: Cache-first Haiku confirmation ───────────────────────────────────
// Only cashable pairs go to Haiku.  Signal pairs are already categorised.
//
// Strategy:
//   1. Load persistent cache (platform|url keyed, permanent true/false verdicts).
//   2. For every cashable candidate, compute its pairKey and check the cache.
//      Cache hit (≤90 days old) → reuse verdict for free (no API call).
//   3. From uncached candidates, select up to MAX_NEW_PAIRS to confirm this run.
//      Priority: plausible band (ARB_BAND_LOW–ARB_BAND_HIGH) first, then by ROI desc.
//   4. Run Haiku on selected new pairs; persist BOTH true and false verdicts.
//   5. confirmed = cached-true hits + newly confirmed true pairs.

function selectNewPairs(uncached) {
  const band = uncached.filter(s => s.net >= ARB_BAND_LOW && s.net <= ARB_BAND_HIGH);
  const rest = uncached.filter(s => s.net < ARB_BAND_LOW  || s.net > ARB_BAND_HIGH);
  band.sort((a, b) => b.net - a.net);  // highest plausible ROI first
  rest.sort((a, b) => b.net - a.net);
  return [...band, ...rest].slice(0, MAX_NEW_PAIRS);
}

async function haikuConfirm(survivors) {
  const cashable = survivors.filter(s => s.type === 'cashable');

  if (cashable.length === 0) {
    console.log('[v2] Stage 3: no cashable survivors to confirm');
    return { confirmed: [], claudeCalls: 0, newSent: 0, cacheHits: 0, totalCandidates: 0 };
  }

  const totalCandidates = cashable.length;

  // Load persistent cache
  const cache = loadConfirmCache();
  const now   = Date.now();

  // Partition: cached (fresh) vs needs confirmation
  const cachedTrue  = [];
  const uncached    = [];

  for (const p of cashable) {
    const key   = stableOppId(p.a, p.b);
    p._pairKey  = key;
    const entry = cache[key];
    if (entry && (now - new Date(entry.confirmedAt).getTime()) < CACHE_RECONFIRM_MS) {
      if (entry.identical) cachedTrue.push({ ...p, confirmReason: entry.reason, _fromCache: true });
      // false verdicts: counted but not added to confirmed
    } else {
      uncached.push(p);
    }
  }

  const cacheHits = cashable.length - uncached.length;
  console.log(`[v2] Stage 3: ${totalCandidates} cashable candidates`);
  console.log(`[v2]   cache: ${cacheHits} hits (${cachedTrue.length} true, ${cacheHits - cachedTrue.length} false) · ${uncached.length} uncached`);
  console.log(`[v2]   new confirmations this run: up to ${MAX_NEW_PAIRS} (NEW_PAIRS_PER_RUN=${MAX_NEW_PAIRS})`);

  const toSend = selectNewPairs(uncached);

  if (toSend.length === 0) {
    console.log('[v2] Stage 3: all candidates already cached — 0 API calls this run');
    return { confirmed: cachedTrue, claudeCalls: 0, newSent: 0, cacheHits, totalCandidates };
  }

  // Instantiate client here so the key check in main() runs first.
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const rois   = toSend.map(p => p.net).sort((a, b) => a - b);
  const median = rois[Math.floor(rois.length / 2)] ?? 0;
  const inBand = rois.filter(r => r >= ARB_BAND_LOW && r <= ARB_BAND_HIGH).length;
  console.log(`[v2] Stage 3: sending ${toSend.length} NEW pairs to Haiku in batches of ${CONFIRM_BATCH}`);
  console.log(`[v2]   plausible band (${ARB_BAND_LOW}–${ARB_BAND_HIGH}%): ${inBand}/${toSend.length}`);
  console.log(`[v2]   ROI dist: min=${rois[0]?.toFixed(2)}%  median=${median.toFixed(2)}%  max=${rois.at(-1)?.toFixed(2)}%`);

  // Estimated cost: ~500 input + ~200 output tokens per 10-pair batch
  const batches  = Math.ceil(toSend.length / CONFIRM_BATCH);
  const estCostUsd = ((batches * 500 / 1e6) * 0.25 + (batches * 200 / 1e6) * 1.25).toFixed(4);
  console.log(`[v2]   estimated API cost this run: $${estCostUsd} (${batches} batches)`);

  let claudeCalls    = 0;
  const newlyConfirmed = [];

  for (let start = 0; start < toSend.length; start += CONFIRM_BATCH) {
    const batch = toSend.slice(start, start + CONFIRM_BATCH);
    const pairsText = batch.map((p, i) =>
      `${i}. A: [${p.a.platform}] "${p.a.rawTitle}" @ ${p.a.probability}%\n   B: [${p.b.platform}] "${p.b.rawTitle}" @ ${p.b.probability}%`
    ).join('\n\n');

    const prompt =
`You are a prediction market analyst. For each pair, decide: do BOTH legs price the IDENTICAL real-world outcome?

${pairsText}

Rules:
- IDENTICAL means the same specific team/candidate/entity wins (or the same specific event happens)
- If A prices "Mexico wins Group A" and B prices "Mexico wins Group A" → identical=true
- If A prices outcome X and B prices outcome Y of the same multi-choice event → identical=false
- Different phrasing ("will X win?" vs "X to win") of the same trigger → identical=true

Respond ONLY with a JSON array (one entry per pair, in order):
[{"index":0,"identical":true,"reason":"brief"},{"index":1,"identical":false,"reason":"brief"},...]`;

    let responseText = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const msg = await anthropic.messages.create({
          model:      MODEL,
          max_tokens: 1024,
          messages:   [{ role: 'user', content: prompt }],
        });
        responseText = msg.content?.[0]?.text ?? null;
        claudeCalls++;
        break;
      } catch (e) {
        const detail = e.status ? `HTTP ${e.status}` : e.message?.slice(0, 80);
        if (attempt === 0) {
          console.log(`[v2] Stage 3 batch retry (attempt 1 failed: ${detail})`);
          await sleep(3000);
        } else {
          console.error(`[v2] Stage 3 batch failed: ${detail}`);
        }
      }
    }
    if (!responseText) continue;
    try {
      const text   = responseText.trim();
      const start2 = text.indexOf('['), end2 = text.lastIndexOf(']');
      if (start2 === -1 || end2 === -1) continue;
      const results = JSON.parse(text.slice(start2, end2 + 1));
      for (const r of (Array.isArray(results) ? results : [])) {
        if (r.index == null || !batch[r.index]) continue;
        const p       = batch[r.index];
        const reason  = r.reason || '';
        // Persist verdict (both true and false) permanently
        cache[p._pairKey] = {
          pairKey:     p._pairKey,
          identical:   !!r.identical,
          reason,
          model:       MODEL,
          confirmedAt: new Date().toISOString(),
        };
        if (r.identical) {
          newlyConfirmed.push({ ...p, confirmReason: reason });
        }
      }
    } catch (e) {
      console.error(`[v2] Stage 3 parse failed: ${e.message?.slice(0, 80)}`);
    }

    if (start + CONFIRM_BATCH < toSend.length) await sleep(1500);
  }

  // Persist updated cache atomically
  saveConfirmCache(cache);

  const cacheSize = Object.keys(cache).length;
  const runsToFullCoverage = Math.ceil(uncached.length / MAX_NEW_PAIRS);
  console.log(`[v2] Stage 3: ${claudeCalls} Haiku API calls → ${newlyConfirmed.length} new confirmed`);
  console.log(`[v2]   cache now has ${cacheSize} entries · ${uncached.length - toSend.length} uncached pairs deferred to future runs`);
  console.log(`[v2]   runs to cover remaining uncached: ~${runsToFullCoverage} (at ${MAX_NEW_PAIRS}/run)`);

  const confirmed = [...cachedTrue, ...newlyConfirmed];
  return { confirmed, claudeCalls, newSent: toSend.length, cacheHits, totalCandidates };
}

// ── Output formatting ─────────────────────────────────────────────────────────

function formatOutput(confirmed, totalCashableCandidates) {
  const opps = confirmed.map((p, i) => {
    const low   = p.a.probability <= p.b.probability ? p.a : p.b;
    const high  = p.a.probability >  p.b.probability ? p.a : p.b;
    const title = high.rawTitle.replace(/\s*\[outcome:[^\]]*\]/gi, '').trim();
    return {
      id:              `v2-${Date.now()}-${i}`,
      title,
      type:            'prediction_market',
      platform_a:      DISPLAY[low.platform]  || low.platform,
      platform_b:      DISPLAY[high.platform] || high.platform,
      expected_return: p.type === 'cashable' ? `+${p.net.toFixed(1)}%` : `~${p.spread}pp`,
      roi:             p.type === 'cashable' ? p.net : 0,
      confidence:      +Math.min(1, p.idfScore / 20).toFixed(3),
      urgency:         p.spread >= 10 ? 'high' : p.spread >= 5 ? 'medium' : 'low',
      cashable:        p.type === 'cashable',
      spread:          p.spread,
      grossRoi:        p.gross,
      bestCost:        p.bestCost,
      bestDir:         p.bestDir,
      lowMarket:       { id: low.id,  platform: low.platform,  probability: low.probability,  yesBid: low.yesBid,  yesAsk: low.yesAsk,  url: low.url,  urlVerified: low.urlVerified  ?? false, clobTokenId: low.clobTokenId  ?? null },
      highMarket:      { id: high.id, platform: high.platform, probability: high.probability, yesBid: high.yesBid, yesAsk: high.yesAsk, url: high.url, urlVerified: high.urlVerified ?? false, clobTokenId: high.clobTokenId ?? null },
      outcome_a:       low.outcome,
      outcome_b:       high.outcome,
      confirmReason:   p.confirmReason,
      // Time / capital-efficiency enrichment
      resolutionDate:  p.resolutionDate  ?? null,
      daysToResolution: p.daysToResolution ?? null,
      annualizedROI:   p.annualizedROI   ?? null,
      lockupFlag:      p.lockupFlag      ?? null,
      // Depth enrichment
      capacityUsd:     p.capacityUsd     ?? null,
      capacityFlag:    p.capacityFlag    ?? null,
    };
  });

  const confirmedCashable = opps.filter(o => o.cashable).length;
  const pending = Math.max(0, (totalCashableCandidates ?? 0) - confirmedCashable);

  return {
    updatedAt: Date.now(),
    opportunities: opps,
    stats: {
      total:                   opps.length,
      confirmedCashable,
      totalCashableCandidates: totalCashableCandidates ?? confirmedCashable,
      pendingVerification:     pending,
      bestRoi:     opps.filter(o => o.cashable).reduce((b, o) => Math.max(b, o.roi), 0),
      totalSpread: opps.reduce((s, o) => s + o.spread, 0),
    },
  };
}

// ── Sanity check helpers ──────────────────────────────────────────────────────

function reportSanityCheck(markets, candidates) {
  const showPair = (label, findA, findB) => {
    console.log(`\n── Sanity Check: ${label} ──`);
    const mA = markets.find(findA);
    const mB = markets.find(findB);

    if (!mA) { console.log('  WARN: market A NOT found'); return; }
    if (!mB) { console.log('  WARN: market B NOT found'); return; }

    const fmtBidAsk = m => `bid=${m.yesBid} ask=${m.yesAsk} mid=${m.probability}%`;
    console.log(`  A: "${mA.rawTitle}" — ${fmtBidAsk(mA)}`);
    console.log(`  B: "${mB.rawTitle}" — ${fmtBidAsk(mB)}`);

    const ai = markets.indexOf(mA), bi = markets.indexOf(mB);
    const pair = candidates.find(c =>
      (c.ai === ai && c.bi === bi) || (c.ai === bi && c.bi === ai)
    );
    if (pair) {
      console.log(`  Stage 1: FOUND ✓  idfScore=${pair.idfScore}`);
      // Compute arb cost manually to show why it's cashable or not
      if (mA.realMoney && mB.realMoney) {
        const d1 = mA.yesAsk + (1 - mB.yesBid);
        const d2 = mB.yesAsk + (1 - mA.yesBid);
        const best = Math.min(d1, d2);
        const profit = 1 - best;
        console.log(`  Arb costs: dir1=${d1.toFixed(4)} dir2=${d2.toFixed(4)} bestCost=${best.toFixed(4)}`);
        console.log(`  Gross profit: ${profit.toFixed(4)} → ${profit > 0 ? `grossROI=${((profit/best)*100).toFixed(2)}%` : 'NO ARB (cost>$1)'}`);
        if (mA.yesBid <= 0 || mA.yesAsk >= 1) console.log('  GUARD: mA is one-sided (yesBid<=0 or yesAsk>=1)');
        if (mB.yesBid <= 0 || mB.yesAsk >= 1) console.log('  GUARD: mB is one-sided');
        if ((mA.yesAsk - mA.yesBid) > MAX_SPREAD_WIDTH) console.log(`  GUARD: mA bid-ask spread ${(mA.yesAsk-mA.yesBid).toFixed(2)} > ${MAX_SPREAD_WIDTH}`);
        if ((mB.yesAsk - mB.yesBid) > MAX_SPREAD_WIDTH) console.log(`  GUARD: mB bid-ask spread ${(mB.yesAsk-mB.yesBid).toFixed(2)} > ${MAX_SPREAD_WIDTH}`);
      }
    } else {
      console.log('  Stage 1: NOT FOUND — pairing miss');
    }
  };

  showPair(
    'KXWCGROUPWIN-26A-MEX ⟷ Polymarket Mexico Group A',
    m => m.id === 'ka-KXWCGROUPWIN-26A-MEX',
    m => m.platform === 'polymarket' && m.rawTitle.toLowerCase().includes('mexico') && m.rawTitle.toLowerCase().includes('group a')
  );

  // Brazil FPA: find all markets matching, group by platform
  const brazilFpa = markets.filter(m => m.rawTitle.toLowerCase().includes('brazil') && m.rawTitle.toLowerCase().includes('fair play'));
  if (brazilFpa.length < 2) {
    console.log('\n── Sanity Check: Brazil WC Fair Play ──');
    brazilFpa.forEach(m => console.log(`  Found: "${m.rawTitle}" (${m.platform}) bid=${m.yesBid} ask=${m.yesAsk}`));
    if (brazilFpa.length === 0) console.log('  NOT in cleaned markets — may have resolved');
    else console.log('  Only 1 market found — no cross-platform pair');
  } else {
    showPair('Brazil WC Fair Play', m => brazilFpa.indexOf(m) === 0, m => brazilFpa.indexOf(m) === 1);
  }

  const englandFpa = markets.filter(m => m.rawTitle.toLowerCase().includes('england') && m.rawTitle.toLowerCase().includes('fair play'));
  if (englandFpa.length < 2) {
    console.log('\n── Sanity Check: England WC Fair Play ──');
    englandFpa.forEach(m => console.log(`  Found: "${m.rawTitle}" (${m.platform}) bid=${m.yesBid} ask=${m.yesAsk}`));
    if (englandFpa.length === 0) console.log('  NOT in cleaned markets — may have resolved');
    else console.log('  Only 1 market found — no cross-platform pair');
  } else {
    showPair('England WC Fair Play', m => englandFpa.indexOf(m) === 0, m => englandFpa.indexOf(m) === 1);
  }
}

// ── Enrichment: time + capacity ───────────────────────────────────────────────
// computeCapacity sweeps YES-ask and NO-ask ladders simultaneously and
// accumulates $ deployed until the combined per-unit cost reaches $1.00.
// Returns total $ deployable, or null if book data was unavailable.
//
// Kalshi orderbook_fp: { yes_dollars: [["price$","qty$"],...], no_dollars: [[...]] }
//   yes_dollars = YES bids (buyers); no_dollars = NO bids (buyers)
//   YES ask derived from NO bids: ask = 1 - no_bid_price; qty in $
//   NO  ask derived from YES bids: no_ask = 1 - yes_bid_price; qty in $
//
// Polymarket CLOB: { bids: [{price,size},...], asks: [{price,size},...] }
//   asks[] = YES ask prices (ascending); bids[] = YES bid prices (descending)
//   NO ask prices derived from YES bids: no_ask = 1 - bid_price

function computeCapacity(arb, yesLeg, noLeg, kalshiBook, pmBook) {
  let yesAsks = [];
  let noAsks  = [];

  if (yesLeg.platform === 'kalshi' && kalshiBook) {
    // YES ask derived from NO bids: sort descending by price, YES ask = 1 - no_bid
    const noBids = (kalshiBook.no_dollars || [])
      .map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }))
      .sort((a, b) => b.price - a.price);
    yesAsks = noBids
      .map(x => ({ price: 1 - x.price, qty: x.qty }))
      .filter(x => x.price > 0 && x.price < 1);
  } else if (yesLeg.platform === 'polymarket' && pmBook) {
    yesAsks = (pmBook.asks || [])
      .map(a => ({ price: parseFloat(a.price), qty: parseFloat(a.size) }))
      .filter(x => x.price > 0 && x.price < 1 && x.qty > 0)
      .sort((a, b) => a.price - b.price);
  }

  if (noLeg.platform === 'kalshi' && kalshiBook) {
    // NO ask derived from YES bids: sort descending, NO ask = 1 - yes_bid
    const yesBids = (kalshiBook.yes_dollars || [])
      .map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }))
      .sort((a, b) => b.price - a.price);
    noAsks = yesBids
      .map(x => ({ price: 1 - x.price, qty: x.qty }))
      .filter(x => x.price > 0 && x.price < 1);
  } else if (noLeg.platform === 'polymarket' && pmBook) {
    const yesBids = (pmBook.bids || [])
      .map(b => ({ price: parseFloat(b.price), qty: parseFloat(b.size) }))
      .filter(x => x.price > 0 && x.price < 1 && x.qty > 0)
      .sort((a, b) => b.price - a.price);
    noAsks = yesBids.map(b => ({ price: 1 - b.price, qty: b.qty }));
  }

  if (yesAsks.length === 0 || noAsks.length === 0) return null;

  let totalDeployed = 0;
  let yi = 0, ni = 0;
  let yqty = yesAsks[0].qty, nqty = noAsks[0].qty;

  while (yi < yesAsks.length && ni < noAsks.length) {
    const yP = yesAsks[yi].price;
    const nP = noAsks[ni].price;
    if (yP + nP >= 1.00) break;
    const stepQty = Math.min(yqty, nqty);
    totalDeployed += stepQty * (yP + nP);
    yqty -= stepQty;
    nqty -= stepQty;
    if (yqty < 1e-8) { yi++; if (yi < yesAsks.length) yqty = yesAsks[yi].qty; }
    if (nqty < 1e-8) { ni++; if (ni < noAsks.length)  nqty = noAsks[ni].qty;  }
  }

  return totalDeployed > 0 ? +totalDeployed.toFixed(2) : 0;
}

async function enrichArbs(confirmed) {
  if (confirmed.length === 0) return confirmed;
  console.log(`[v2/enrich] enriching ${confirmed.length} confirmed cashable arb(s)...`);
  const now = Date.now();

  for (const arb of confirmed) {
    if (arb.type !== 'cashable') continue;
    const legA = arb.a, legB = arb.b;

    // ── Time ────────────────────────────────────────────────────────────
    const tsA = legA.closeTime ? new Date(legA.closeTime).getTime() : null;
    const tsB = legB.closeTime ? new Date(legB.closeTime).getTime() : null;
    const resTs = (tsA && tsB) ? Math.min(tsA, tsB) : (tsA || tsB || null);

    arb.resolutionDate   = resTs ? new Date(resTs).toISOString().slice(0, 10) : null;
    arb.daysToResolution = resTs ? Math.round((resTs - now) / 86_400_000) : null;
    arb.annualizedROI    = (arb.daysToResolution > 0)
      ? +(arb.net * 365 / arb.daysToResolution).toFixed(2) : null;
    arb.lockupFlag       = (arb.daysToResolution > 120 && arb.net < 3)
      ? 'low value - capital lockup' : null;

    // ── Capacity ────────────────────────────────────────────────────────
    const yesLeg = arb.bestDir === 1 ? legA : legB;
    const noLeg  = arb.bestDir === 1 ? legB : legA;

    arb.capacityUsd  = null;
    arb.capacityFlag = 'depth unknown';

    let kalshiBook = null, pmBook = null;

    const kalshiLeg = [legA, legB].find(l => l.platform === 'kalshi');
    if (kalshiLeg) {
      const ticker = kalshiLeg.id.replace(/^ka-/, '');
      try {
        const data = await fetchJson(`https://api.elections.kalshi.com/trade-api/v2/markets/${ticker}/orderbook`);
        if (data?.orderbook_fp) kalshiBook = data.orderbook_fp;
        else console.log(`[v2/enrich] Kalshi book empty for ${ticker}: keys=${Object.keys(data||{}).join(',')}`);
      } catch (e) {
        console.log(`[v2/enrich] Kalshi book fetch failed: ${e.message}`);
      }
    }

    const pmLeg = [legA, legB].find(l => l.platform === 'polymarket');
    if (pmLeg?.clobTokenId) {
      try {
        const data = await fetchJson(`https://clob.polymarket.com/book?token_id=${pmLeg.clobTokenId}`);
        if (data?.bids || data?.asks) pmBook = data;
        else console.log(`[v2/enrich] PM CLOB book empty for ${pmLeg.clobTokenId?.slice(0, 20)}...`);
      } catch (e) {
        console.log(`[v2/enrich] PM CLOB fetch failed: ${e.message}`);
      }
    } else if (pmLeg) {
      console.log(`[v2/enrich] PM leg has no clobTokenId (id=${pmLeg.id})`);
    }

    const cap = computeCapacity(arb, yesLeg, noLeg, kalshiBook, pmBook);
    arb.capacityUsd  = cap;
    arb.capacityFlag = (cap !== null) ? null : 'depth unknown';

    await sleep(300);
  }

  // Rank by annualizedROI desc (nulls last)
  confirmed.sort((x, y) => {
    if (x.annualizedROI !== null && y.annualizedROI !== null) return y.annualizedROI - x.annualizedROI;
    return (x.annualizedROI !== null) ? -1 : 1;
  });

  return confirmed;
}

// ── Unified opportunities writer ──────────────────────────────────────────────
// Zero Claude cost — pure reformatting of already-computed data.
// Reads /tmp/sports-odds.json if present (written by agent12-sports, optional).
// Writes /tmp/unified-opportunities.json for the dashboard OpportunitiesPanel.

function predVerdictFor(o) {
  if (!o.cashable) return 'signal';
  return o.lockupFlag ? 'capital-lockup-skip' : 'Actionable';
}

function predOppToUnified(o) {
  const legs = o.cashable
    ? [
        // buy YES on the cheaper (low-prob) side
        { platform: o.platform_a, side: 'YES', price: o.lowMarket.yesAsk,             url: o.lowMarket.url  },
        // buy NO  on the more-expensive (high-prob) side
        { platform: o.platform_b, side: 'NO',  price: +(1 - o.highMarket.yesBid).toFixed(4), url: o.highMarket.url },
      ]
    : [
        // signal: show mid-probability on each side
        { platform: o.platform_a, side: 'MID', price: +(o.lowMarket.probability  / 100).toFixed(4), url: o.lowMarket.url  },
        { platform: o.platform_b, side: 'MID', price: +(o.highMarket.probability / 100).toFixed(4), url: o.highMarket.url },
      ];

  return {
    type:             o.cashable ? 'CASHABLE' : 'SIGNAL',
    id:               o.id,
    question:         o.title,
    legs,
    annualizedROI:    o.annualizedROI    ?? null,
    netROI:           o.cashable ? o.roi : null,
    grossROI:         o.grossRoi         ?? null,
    spread:           o.spread           ?? null,
    daysToResolution: o.daysToResolution ?? null,
    resolutionDate:   o.resolutionDate   ?? null,
    capacityUsd:      o.capacityUsd      ?? null,
    lockupFlag:       o.lockupFlag       ?? null,
    verdict:          predVerdictFor(o),
    confidence:       o.confidence,
  };
}

function sportsOppToUnified(s) {
  const now     = Date.now();
  const matchTs = s.commenceTime ? new Date(s.commenceTime).getTime() : null;
  const daysToResolution = matchTs ? Math.round((matchTs - now) / 86_400_000) : null;
  // Sports arbs resolve at kickoff — annualize only if > 0 days away
  const annualizedROI = (daysToResolution != null && daysToResolution > 0)
    ? +(s.arbPct * 365 / daysToResolution).toFixed(2) : null;

  // arbBets: [{outcome, bookmaker, odds (decimal), stake (on $100)}]
  const legs = (s.arbBets || []).map(b => ({
    platform: b.bookmaker,
    side:     b.outcome,
    price:    b.odds,    // decimal odds (e.g. 2.10)
    stake:    b.stake,   // optimal stake split for $100 bankroll
    url:      null,
  }));

  const isStale = s.arbPct > 5;   // > 5% is almost certainly limit-only / stale

  return {
    type:             'SPORTS',
    id:               `sports-${s.id}`,
    question:         `${s.homeTeam} vs ${s.awayTeam}`,
    sport:            s.sportLabel || s.sport,
    legs,
    annualizedROI,
    netROI:           s.arbPct,
    grossROI:         s.arbPct,
    spread:           null,
    daysToResolution,
    resolutionDate:   matchTs ? new Date(matchTs).toISOString().slice(0, 10) : null,
    capacityUsd:      null,
    lockupFlag:       null,
    verdict:          isStale ? 'stale-check' : 'Actionable',
    confidence:       isStale ? 0.3 : 0.9,
  };
}

function writeUnified(matcherV2Output) {
  const predOpps = matcherV2Output.opportunities || [];
  const unified  = predOpps.map(predOppToUnified);

  // Optional: merge sports arb if file is present and < 24 h old
  let sportsMeta = null;
  try {
    if (fs.existsSync(SPORTS_FILE)) {
      const sports = JSON.parse(fs.readFileSync(SPORTS_FILE, 'utf8'));
      const ageMs  = Date.now() - (sports.fetchedAt || 0);
      if (ageMs < 24 * 3_600_000) {
        const arbOpps = sports.arbOpportunities || [];
        for (const s of arbOpps) unified.push(sportsOppToUnified(s));
        sportsMeta = { fetchedAt: sports.fetchedAt, arbCount: arbOpps.length, totalEvents: sports.totalEvents || 0 };
        console.log(`[v2/unified] sports: ${arbOpps.length} arb opportunities merged`);
      } else {
        console.log(`[v2/unified] sports file is ${Math.round(ageMs / 3_600_000)}h old — skipped`);
      }
    } else {
      console.log('[v2/unified] no sports-odds.json present — SPORTS items absent');
    }
  } catch (e) {
    console.log(`[v2/unified] sports read error: ${e.message}`);
  }

  // Type-preserving merge: read existing file and keep FUNDING items we don't own
  let existingFunding = [];
  let existingSources = {};
  try {
    const existing = JSON.parse(fs.readFileSync(UNIFIED_FILE, 'utf8'));
    existingFunding = (existing.opportunities || []).filter(o => o.type === 'FUNDING');
    existingSources = existing.sources || {};
  } catch { /* file absent or corrupt — start without existing data */ }

  const merged = [...unified, ...existingFunding];

  // Re-sort after merge
  const TYPE_RANK2 = { CASHABLE: 0, SPORTS: 1, SIGNAL: 2, FUNDING: 3 };
  merged.sort((a, b) => {
    const ra = TYPE_RANK2[a.type] ?? 9, rb = TYPE_RANK2[b.type] ?? 9;
    if (ra !== rb) return ra - rb;
    if (a.annualizedROI !== null && b.annualizedROI !== null) return b.annualizedROI - a.annualizedROI;
    if (a.annualizedROI !== null) return -1;
    if (b.annualizedROI !== null) return 1;
    return (b.netROI ?? 0) - (a.netROI ?? 0);
  });

  const cashableCount = merged.filter(o => o.type === 'CASHABLE').length;
  const signalCount   = merged.filter(o => o.type === 'SIGNAL').length;
  const sportsCount   = merged.filter(o => o.type === 'SPORTS').length;
  const fundingCount  = merged.filter(o => o.type === 'FUNDING').length;

  const result = {
    generatedAt: Date.now(),
    sources: {
      ...existingSources,
      matcherV2: {
        generatedAt:   matcherV2Output.updatedAt,
        cashableCount: predOpps.filter(o => o.cashable).length,
        signalCount:   predOpps.filter(o => !o.cashable).length,
      },
      sports: sportsMeta,
    },
    summary: {
      total:          merged.length,
      cashable:       cashableCount,
      signal:         signalCount,
      sports:         sportsCount,
      funding:        fundingCount,
      bestAnnualized: (() => { const r = merged.map(o => o.annualizedROI).filter(v => v != null); return r.length ? Math.max(...r) : null; })(),
    },
    opportunities: merged,
  };

  // Atomic write: write to temp file, then rename (atomic on Linux same filesystem)
  const tmpPath = UNIFIED_FILE + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(result, null, 2));
  fs.renameSync(tmpPath, UNIFIED_FILE);
  console.log(`[v2/unified] wrote ${merged.length} items → ${UNIFIED_FILE}`);
  console.log(`[v2/unified]   CASHABLE:${cashableCount}  SIGNAL:${signalCount}  SPORTS:${sportsCount}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[v2] ═══════════════════════════════════════');
  console.log('[v2]  matcher-v2 one-shot full-universe run');
  console.log('[v2] ═══════════════════════════════════════');
  const t0 = Date.now();

  // SECURITY: validate key before any work.
  // Exit without touching arbitrage-opportunities.json so the banner stays
  // honest ("stale") rather than showing zero results on a config error.
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) {
    console.error('[v2] FATAL: ANTHROPIC_API_KEY is not set.');
    console.error('[v2]   Paste your key into /root/prediction-market/.env.matcher');
    console.error('[v2]   File must contain:  ANTHROPIC_API_KEY=sk-ant-...');
    console.error('[v2]   Existing arbitrage-opportunities.json left unchanged.');
    process.exit(1);
  }
  // Confirm key is loaded — print length only, never the value.
  console.log(`[v2] API key loaded (${apiKey.length} chars)`);

  // Ensure data freshness
  let raw;
  const existing = fs.existsSync(RAW_FILE)
    ? JSON.parse(fs.readFileSync(RAW_FILE, 'utf8'))
    : null;
  const age = existing ? Date.now() - (existing.fetchedAt || 0) : Infinity;

  if (age > MAX_STALE_MS) {
    raw = await freshFetch();
  } else {
    console.log(`[v2] Using existing raw data (${Math.round(age / 60000)}m old)`);
    raw = existing;
  }

  // Pre-fetch Kalshi series slugs (needed for 3-segment canonical URLs).
  // Runs once per series (few series, many markets) before loadAndClean reads the cache.
  await prefetchKalshiSeriesSlugs(raw.kalshi);

  // Stage 0
  const markets = loadAndClean(raw);

  // Stage 1
  const { candidates } = candidatePairing(markets);

  // Stage 2
  const { survivors, quarantined } = arbPrefilter(candidates, markets);

  // Stage 3
  const { confirmed, claudeCalls, newSent, cacheHits, totalCandidates } = await haikuConfirm(survivors);

  // Enrichment (time + capacity); enrichArbs sorts confirmed in-place by annualizedROI
  await enrichArbs(confirmed);

  // Output
  const output = formatOutput(confirmed, totalCandidates);
  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));

  // Unified opportunities file (zero Claude cost — pure reformatting)
  writeUnified(output);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const cashable = output.opportunities.filter(o => o.cashable);
  const signal   = output.opportunities.filter(o => !o.cashable);
  const { confirmedCashable, totalCashableCandidates, pendingVerification } = output.stats;

  // Steady-state cost estimate (once all candidates are cached)
  const batchesPerRun   = Math.ceil(MAX_NEW_PAIRS / CONFIRM_BATCH);
  const costPerRunFill  = ((batchesPerRun * 500 / 1e6) * 0.25 + (batchesPerRun * 200 / 1e6) * 1.25);
  const runsToFull      = Math.ceil((totalCandidates - cacheHits) / MAX_NEW_PAIRS);

  // ── Summary table ──────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  matcher-v2 run summary                          ║');
  console.log('╠══════════════════════════════════════════════════╣');
  const fuCount = markets.filter(m => m.platform === 'futuur').length;
  console.log(`║  Total markets loaded         : ${String(markets.length).padEnd(16)} ║`);
  console.log(`║    of which Futuur            : ${String(fuCount).padEnd(16)} ║`);
  console.log(`║  Candidate pairs  (Stage 1)   : ${String(candidates.length).padEnd(16)} ║`);
  console.log(`║  Survivors        (Stage 2)   : ${String(survivors.length).padEnd(16)} ║`);
  console.log(`║  Quarantined      (ROI>${SUSPICIOUS_ROI}%)    : ${String(quarantined.length).padEnd(16)} ║`);
  console.log(`║  Cashable candidates          : ${String(totalCandidates).padEnd(16)} ║`);
  console.log(`║  Cache hits (reused free)     : ${String(cacheHits).padEnd(16)} ║`);
  console.log(`║  New pairs sent to Haiku      : ${String(newSent).padEnd(16)} ║`);
  console.log(`║  Claude API calls             : ${String(claudeCalls).padEnd(16)} ║`);
  console.log(`║  Confirmed cashable           : ${String(confirmedCashable).padEnd(16)} ║`);
  console.log(`║  Pending verification         : ${String(pendingVerification).padEnd(16)} ║`);
  console.log(`║  Final signal                 : ${String(signal.length).padEnd(16)} ║`);
  console.log(`║  Est. cost this run           : $${String(costPerRunFill.toFixed(4)).padEnd(15)} ║`);
  console.log(`║  Est. monthly (fill phase)    : $${String((costPerRunFill * 8 * 30).toFixed(2)).padEnd(15)} ║`);
  console.log(`║  Runs to full cache coverage  : ${String('~' + runsToFull).padEnd(16)} ║`);
  console.log(`║  Elapsed                      : ${String(elapsed + 's').padEnd(16)} ║`);
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`\n[v2] HONEST COUNT: ${confirmedCashable} confirmed · ${totalCashableCandidates} candidates · ${pendingVerification} pending verification`);

  // Sanity check
  reportSanityCheck(markets, candidates);

  // Top cashable
  if (cashable.length > 0) {
    console.log('\n── Cashable Opportunities (ranked by annualizedROI) ─');
    cashable.forEach(o => {
      console.log(`\n  ${o.platform_a} ↔ ${o.platform_b}: ${o.title.slice(0, 65)}`);
      console.log(`    netROI=${o.roi}%  annualROI=${o.annualizedROI !== null ? o.annualizedROI + '%/yr' : 'n/a'}  bestCost=$${o.bestCost}  dir=${o.bestDir}`);
      console.log(`    resolution: ${o.resolutionDate ?? 'unknown'}  days: ${o.daysToResolution ?? '?'}`);
      if (o.lockupFlag) console.log(`    ⚠ ${o.lockupFlag}`);
      const capStr = o.capacityUsd !== null ? `$${o.capacityUsd}` : o.capacityFlag;
      console.log(`    capacity: ${capStr}`);
      console.log(`    A(low):  bid=${o.lowMarket.yesBid}  ask=${o.lowMarket.yesAsk}  mid=${o.lowMarket.probability}%  [${o.lowMarket.platform}]`);
      console.log(`    B(high): bid=${o.highMarket.yesBid}  ask=${o.highMarket.yesAsk}  mid=${o.highMarket.probability}%  [${o.highMarket.platform}]`);
      if (o.lowMarket.url) console.log(`    url: ${o.lowMarket.url.slice(0, 80)}`);
    });
  }

  // Top signal
  if (signal.length > 0) {
    console.log('\n── Top Signal Pairs ────────────────────────────────');
    signal.slice(0, 5).forEach(o => {
      console.log(`  ${o.platform_a} ↔ ${o.platform_b}: ${o.title.slice(0, 65)}`);
      console.log(`    spread=${o.spread}pp  conf=${o.confidence}`);
    });
  }

  console.log(`\n[v2] Done. Output → ${OUT_FILE}`);
  process.exit(0);
}

main().catch(e => { console.error('[v2] FATAL:', e.stack || e); process.exit(1); });
