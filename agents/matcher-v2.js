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

// Stage 2
const MIN_SPREAD_PP     = 3;     // gross spread threshold for cashable arb
const MIN_SIGNAL_SPREAD = 5;     // spread threshold for signal (play-money) pair
const ROI_CAP           = 80;    // discard ROI > 80% (false-positive guard)

// Stage 3
const MAX_CLAUDE_PAIRS  = 60;
const CONFIRM_BATCH     = 10;    // pairs per Haiku call

// ── Platform metadata ─────────────────────────────────────────────────────────

const PLATFORM_FEES = {
  kalshi:     0.07,
  polymarket: 0.02,
  predictit:  0.15,   // 10% win + 5% withdrawal
  manifold:   0.00,
};
const REAL_MONEY = new Set(['kalshi', 'polymarket', 'predictit']);
const DISPLAY    = { kalshi: 'Kalshi', polymarket: 'Polymarket', predictit: 'PredictIt', manifold: 'Manifold' };

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

async function freshFetch() {
  console.log('[v2/fetch] Raw data stale — running one-shot fetch...');
  const [kalshi, piRaw, mfRaw] = await Promise.all([
    fetchKalshiAll(),
    fetchJson('https://www.predictit.org/api/marketdata/all/'),
    fetchJson('https://api.manifold.markets/v0/markets?limit=100&sort=last-bet-time&order=desc'),
  ]);
  const polymarket = await fetchPolymarketAll();
  const result = {
    fetchedAt:  Date.now(),
    predictit:  piRaw?.markets ?? [],
    manifold:   Array.isArray(mfRaw) ? mfRaw : [],
    kalshi,
    polymarket,
  };
  fs.writeFileSync(RAW_FILE, JSON.stringify(result, null, 2));
  console.log(`[v2/fetch] saved — KA:${kalshi.length} PM:${polymarket.length} PI:${result.predictit.length} MF:${result.manifold.length}`);
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
  const counts  = { ka: 0, pm: 0, pi: 0, mf: 0 };

  // PredictIt — one market per CONTRACT (each contract = a specific outcome)
  for (const m of (raw.predictit || [])) {
    const title = m.shortName || m.name || '';
    if (!title) continue;
    for (const c of (m.contracts || [])) {
      if (c.lastTradePrice == null) continue;
      const prob = Math.round(c.lastTradePrice * 100);
      if (prob <= 1 || prob >= 99) continue;
      const outcome = c.shortName || c.name || '';
      markets.push({
        id: `pi-${m.id}-${c.id}`,
        platform:   'predictit',
        rawTitle:   outcome ? `${title} [outcome: ${outcome}]` : title,
        baseTitle:  title,
        outcome,
        probability: prob,
        realMoney:  true,
        url: `https://www.predictit.org/markets/detail/${m.id}`,
      });
      counts.pi++;
    }
  }

  // Manifold — BINARY only
  for (const m of (raw.manifold || [])) {
    if (m.outcomeType !== 'BINARY' || m.probability == null) continue;
    const q = m.question || '';
    if (!q) continue;
    const prob = Math.round(m.probability * 100);
    if (prob <= 1 || prob >= 99) continue;
    markets.push({
      id: `mf-${m.id}`,
      platform:   'manifold',
      rawTitle:   q,
      baseTitle:  q,
      outcome:    '',
      probability: prob,
      realMoney:  false,
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
      tickerExtra,             // e.g. "world cup" for KXWC* tickers
      suffixFullName,          // e.g. "mexico" for MEX suffix
      probability: prob,
      realMoney:  true,
      url: `https://kalshi.com/markets/${m.ticker}`,
    });
    counts.ka++;
  }

  // Polymarket — YES price from outcomePrices[0]
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
    // Fallback: bestBid/bestAsk midpoint (tag-event markets often lack outcomePrices)
    if (prob == null) {
      const bid = parseFloat(m.bestBid || '0');
      const ask = parseFloat(m.bestAsk || '0');
      if (bid > 0 && ask > 0)       prob = Math.round(((bid + ask) / 2) * 100);
      else if (bid > 0.01)          prob = Math.round(bid * 100);
      else if (ask > 0 && ask < 1)  prob = Math.round(ask * 100);
    }
    if (prob == null || prob <= 1 || prob >= 99) continue;
    markets.push({
      id: `pm-${m.id || m.conditionId}`,
      platform:   'polymarket',
      rawTitle:   q,
      baseTitle:  q,
      outcome:    '',
      probability: prob,
      realMoney:  true,
      url: m.slug ? `https://polymarket.com/event/${m.slug}` : 'https://polymarket.com',
    });
    counts.pm++;
  }

  console.log(`[v2] Stage 0: KA:${counts.ka} PM:${counts.pm} PI:${counts.pi} MF:${counts.mf} → ${markets.length} pass (prob 2–98)`);
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

// ── Stage 2: Arb pre-filter ───────────────────────────────────────────────────

function arbPrefilter(candidates, markets) {
  const survivors = [];

  for (const c of candidates) {
    const a = markets[c.ai], b = markets[c.bi];
    const spread = Math.abs(a.probability - b.probability);

    if (a.realMoney && b.realMoney && spread >= MIN_SPREAD_PP) {
      const low  = a.probability <= b.probability ? a : b;
      const high = a.probability >  b.probability ? a : b;
      const gross = low.probability > 0 ? (spread / low.probability) * 100 : 0;
      if (gross > ROI_CAP || gross <= 0) continue;
      const feeA  = PLATFORM_FEES[low.platform]  || 0;
      const feeB  = PLATFORM_FEES[high.platform] || 0;
      const net   = gross * (1 - feeA - feeB);
      if (net <= 0) continue;
      survivors.push({ ...c, a, b, spread, gross: +gross.toFixed(1), net: +net.toFixed(1), type: 'cashable' });

    } else if ((!a.realMoney || !b.realMoney) && spread >= MIN_SIGNAL_SPREAD) {
      survivors.push({ ...c, a, b, spread, gross: 0, net: 0, type: 'signal' });
    }
  }

  // Prioritise cashable by net ROI, then signal by spread
  survivors.sort((a, b) =>
    a.type === b.type
      ? (b.net || b.spread) - (a.net || a.spread)
      : a.type === 'cashable' ? -1 : 1
  );

  const nc = survivors.filter(s => s.type === 'cashable').length;
  const ns = survivors.filter(s => s.type === 'signal').length;
  console.log(`[v2] Stage 2: ${candidates.length} candidates → ${survivors.length} survivors (${nc} cashable, ${ns} signal)`);
  return survivors;
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
      lowMarket:       { id: low.id,  platform: low.platform,  probability: low.probability,  url: low.url  },
      highMarket:      { id: high.id, platform: high.platform, probability: high.probability, url: high.url },
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
  console.log('\n── Sanity Check: KXWCGROUPWIN-26A-MEX ⟷ Polymarket Mexico Group A ──');
  const kaWc = markets.find(m => m.id === 'ka-KXWCGROUPWIN-26A-MEX');
  const pmMex = markets.find(m =>
    m.platform === 'polymarket' &&
    m.rawTitle.toLowerCase().includes('mexico') &&
    m.rawTitle.toLowerCase().includes('group a')
  );

  if (!kaWc)  console.log('  WARN: Kalshi KXWCGROUPWIN-26A-MEX NOT in cleaned markets');
  else        console.log(`  Kalshi:     "${kaWc.rawTitle}" @ ${kaWc.probability}%`);
  if (!pmMex) console.log('  WARN: Polymarket Mexico Group A NOT in cleaned markets');
  else        console.log(`  Polymarket: "${pmMex.rawTitle}" @ ${pmMex.probability}%`);

  if (kaWc && pmMex) {
    const ki = markets.indexOf(kaWc), pi = markets.indexOf(pmMex);
    const pair = candidates.find(c =>
      (c.ai === ki && c.bi === pi) || (c.ai === pi && c.bi === ki)
    );
    if (pair) {
      const spread = Math.abs(kaWc.probability - pmMex.probability);
      console.log(`  Stage 1:  FOUND ✓  idfScore=${pair.idfScore}  spread=${spread}pp  (${spread < 3 ? 'spread<3pp → Stage 2 drops correctly' : 'spread≥3pp → cashable candidate'})`);
    } else {
      console.log('  Stage 1:  NOT FOUND — pairing miss');
    }
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
  const survivors = arbPrefilter(candidates, markets);

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
  console.log(`║  Total markets loaded         : ${String(markets.length).padEnd(16)} ║`);
  console.log(`║  Candidate pairs  (Stage 1)   : ${String(candidates.length).padEnd(16)} ║`);
  console.log(`║  Survivors        (Stage 2)   : ${String(survivors.length).padEnd(16)} ║`);
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
      console.log(`    spread=${o.spread}pp  netROI=${o.roi}%  conf=${o.confidence}`);
      console.log(`    low=${o.lowMarket.probability}% (${o.lowMarket.url?.slice(0, 55)})`);
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
