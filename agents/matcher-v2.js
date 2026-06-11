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
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// ── Config ────────────────────────────────────────────────────────────────────

const RAW_FILE          = '/tmp/markets-raw.json';
const OUT_FILE          = '/tmp/arbitrage-opportunities.json';
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

// Stage 3
const MAX_CLAUDE_PAIRS  = 60;
const CONFIRM_BATCH     = 10;    // pairs per Haiku call

// ── Platform metadata ─────────────────────────────────────────────────────────

const PLATFORM_FEES = {
  kalshi:     0.07,
  polymarket: 0.02,
  predictit:  0.15,   // 10% win + 5% withdrawal
  manifold:   0.00,
  futuur:     0.05,   // ~4-6% win fee (tax_real_money field); signal-only so not used in arb math
};
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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function kalshiPageToMarkets(data) {
  const out = [];
  for (const ev of (data?.events || [])) {
    for (const m of (ev.markets || [])) {
      const bid = parseFloat(m.yes_bid_dollars || '0');
      const ask = parseFloat(m.yes_ask_dollars || '0');
      if (bid <= 0 && ask <= 0) continue;
      out.push({ ticker: m.ticker, title: ev.title || '', yes_bid_dollars: m.yes_bid_dollars, yes_ask_dollars: m.yes_ask_dollars });
    }
  }
  return out;
}

async function fetchKalshiAll() {
  const all = []; let cursor = null, page = 0;
  while (page < 60) {
    let url = 'https://api.elections.kalshi.com/trade-api/v2/events?limit=200&status=open&with_nested_markets=true';
    if (cursor) url += '&cursor=' + encodeURIComponent(cursor);
    const data = await fetchJson(url);
    if (!data || !Array.isArray(data.events) || !data.events.length) break;
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
          if (id && !byId.has(id)) { byId.set(id, m); added++; }
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
      yesBid:     bid,   // raw executable best bid for YES
      yesAsk:     ask,   // raw executable best ask for YES
      realMoney:  true,
      realBook:   true,
      url: `https://kalshi.com/markets/${m.ticker}`,
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
    markets.push({
      id: `pm-${m.id || m.conditionId}`,
      platform:   'polymarket',
      rawTitle:   q,
      baseTitle:  q,
      outcome:    '',
      probability: prob,
      yesBid:     yB,
      yesAsk:     yA,
      realMoney:  true,
      realBook:   true,
      url: m.slug ? `https://polymarket.com/event/${m.slug}` : 'https://polymarket.com',
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

// ── Stage 3: Haiku confirmation ───────────────────────────────────────────────

async function haikuConfirm(survivors) {
  const toSend = survivors.slice(0, MAX_CLAUDE_PAIRS);
  if (toSend.length === 0) {
    console.log('[v2] Stage 3: no survivors to confirm');
    return { confirmed: [], claudeCalls: 0 };
  }
  console.log(`[v2] Stage 3: sending ${toSend.length} pairs to Haiku in batches of ${CONFIRM_BATCH}`);

  let claudeCalls = 0;
  const confirmed = [];

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

    let stdout = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        ({ stdout } = await execFileAsync('claude', ['-p', prompt, '--model', MODEL], {
          timeout: 90_000, env: { ...process.env, HOME: '/root' },
        }));
        claudeCalls++;
        break;
      } catch (e) {
        if (attempt === 0) {
          console.log(`[v2] Stage 3 batch retry (attempt 1 failed: ${e.message?.slice(0, 60)})`);
          await sleep(3000);
        } else {
          console.error(`[v2] Stage 3 batch failed: ${e.message?.slice(0, 120)}`);
        }
      }
    }
    if (!stdout) continue;
    try {
      const text  = stdout.trim();
      const start2 = text.indexOf('['), end2 = text.lastIndexOf(']');
      if (start2 === -1 || end2 === -1) continue;
      const results = JSON.parse(text.slice(start2, end2 + 1));
      for (const r of (Array.isArray(results) ? results : [])) {
        if (r.identical && batch[r.index]) {
          confirmed.push({ ...batch[r.index], confirmReason: r.reason || '' });
        }
      }
    } catch (e) {
      console.error(`[v2] Stage 3 parse failed: ${e.message?.slice(0, 80)}`);
    }

    if (start + CONFIRM_BATCH < toSend.length) await sleep(1500);
  }

  console.log(`[v2] Stage 3: ${claudeCalls} Claude calls → ${confirmed.length} confirmed`);
  return { confirmed, claudeCalls };
}

// ── Output formatting ─────────────────────────────────────────────────────────

function formatOutput(confirmed) {
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
      lowMarket:       { id: low.id,  platform: low.platform,  probability: low.probability,  yesBid: low.yesBid,  yesAsk: low.yesAsk,  url: low.url  },
      highMarket:      { id: high.id, platform: high.platform, probability: high.probability, yesBid: high.yesBid, yesAsk: high.yesAsk, url: high.url },
      outcome_a:       low.outcome,
      outcome_b:       high.outcome,
      confirmReason:   p.confirmReason,
    };
  });

  return {
    updatedAt: Date.now(),
    opportunities: opps,
    stats: {
      total:       opps.length,
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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[v2] ═══════════════════════════════════════');
  console.log('[v2]  matcher-v2 one-shot full-universe run');
  console.log('[v2] ═══════════════════════════════════════');
  const t0 = Date.now();

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

  // Stage 0
  const markets = loadAndClean(raw);

  // Stage 1
  const { candidates } = candidatePairing(markets);

  // Stage 2
  const { survivors, quarantined } = arbPrefilter(candidates, markets);

  // Stage 3
  const { confirmed, claudeCalls } = await haikuConfirm(survivors);

  // Output
  const output = formatOutput(confirmed);
  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const cashable = output.opportunities.filter(o => o.cashable);
  const signal   = output.opportunities.filter(o => !o.cashable);

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
  console.log(`║  Sent to Haiku    (Stage 3)   : ${String(Math.min(survivors.length, MAX_CLAUDE_PAIRS)).padEnd(16)} ║`);
  console.log(`║  Claude calls                 : ${String(claudeCalls).padEnd(16)} ║`);
  console.log(`║  Final cashable               : ${String(cashable.length).padEnd(16)} ║`);
  console.log(`║  Final signal                 : ${String(signal.length).padEnd(16)} ║`);
  console.log(`║  Elapsed                      : ${String(elapsed + 's').padEnd(16)} ║`);
  console.log('╚══════════════════════════════════════════════════╝');

  // Sanity check
  reportSanityCheck(markets, candidates);

  // Top cashable
  if (cashable.length > 0) {
    console.log('\n── Top Cashable Opportunities ──────────────────────');
    cashable.slice(0, 5).forEach(o => {
      console.log(`  ${o.platform_a} ↔ ${o.platform_b}: ${o.title.slice(0, 65)}`);
      console.log(`    spread=${o.spread}pp  grossROI=${o.grossRoi}%  netROI=${o.roi}%  bestCost=${o.bestCost}  dir=${o.bestDir}`);
      console.log(`    A: bid=${o.lowMarket.yesBid}  ask=${o.lowMarket.yesAsk}  mid=${o.lowMarket.probability}%  (${o.lowMarket.platform})`);
      console.log(`    B: bid=${o.highMarket.yesBid}  ask=${o.highMarket.yesAsk}  mid=${o.highMarket.probability}%  (${o.highMarket.platform})`);
      if (o.lowMarket.url) console.log(`    url: ${o.lowMarket.url.slice(0, 75)}`);
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
