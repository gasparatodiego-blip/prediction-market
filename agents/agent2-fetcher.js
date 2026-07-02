#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const https = require('https');
const http  = require('http');

const OUT          = '/tmp/markets-raw.json';
const ODDS_OUT     = '/tmp/odds-api-raw.json';
const HB_FILE      = '/tmp/agent-heartbeats.json';
const INTERVAL     = 60_000;
const ODDS_INTERVAL = 6 * 60 * 60 * 1000; // 6 h — ~4×/day, preserves monthly quota

// ── OddsAPI quota safety ──────────────────────────────────────────────────────
// Live fetch is DISABLED by default — set ODDS_API_LIVE=1 to enable.
// The free tier (500 req/month) burns out in <9h at the old 5-min cadence.
// When enabled, fetch at most 4× per day (every 6 h).
const ODDS_API_LIVE  = process.env.ODDS_API_LIVE === '1';
const ODDS_API_KEY   = process.env.ODDS_API_KEY || '';
const ODDS_SNAPSHOT  = '/tmp/odds-snapshot.json'; // offline cache; calculator prefers this
const ODDS_LOW_QUOTA = 20; // stop live fetching when fewer than this many requests remain
const ODDS_SPORTS    = [
  'soccer_fifa_world_cup',
  'americanfootball_nfl',
  'baseball_mlb',
  'basketball_nba',
  'tennis_atp_french_open',
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function beat(name) {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb[name] = Date.now();
  fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2));
}

function fetchJson(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'prediction-arb-scanner/1.0' }, timeout: 15000 }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// Fetch one OddsAPI URL and return { data, remaining, used, status }
function fetchOddsRaw(url) {
  return new Promise(resolve => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'prediction-arb-scanner/1.0' }, timeout: 15000 }, res => {
      const remaining = parseInt(res.headers['x-requests-remaining'] ?? '-1', 10);
      const used      = parseInt(res.headers['x-requests-used']      ?? '-1', 10);
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ data: JSON.parse(body), remaining, used, status: res.statusCode }); }
        catch { resolve({ data: null, remaining, used, status: res.statusCode }); }
      });
    });
    req.on('error', () => resolve({ data: null, remaining: -1, used: -1, status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ data: null, remaining: -1, used: -1, status: 0 }); });
  });
}

async function fetchOddsApi() {
  if (!ODDS_API_LIVE) {
    console.log('[fetcher] odds-api: ODDS_API_LIVE not set — skipping live fetch (quota guard)');
    return;
  }

  // Serve offline snapshot if it exists and is fresh enough
  if (fs.existsSync(ODDS_SNAPSHOT)) {
    try {
      const snap    = JSON.parse(fs.readFileSync(ODDS_SNAPSHOT, 'utf8'));
      const snapAge = Date.now() - (snap.fetchedAt || 0);
      if (snapAge < ODDS_INTERVAL && Array.isArray(snap.events) && snap.events.length > 0) {
        console.log(`[fetcher] odds-api: using snapshot (${Math.round(snapAge / 60000)}m old, ${snap.events.length} events)`);
        fs.writeFileSync(ODDS_OUT, JSON.stringify(snap, null, 2));
        return;
      }
    } catch {}
  }

  console.log('[fetcher] odds-api: fetching live...');
  const results = [];
  let quotaOk = true;

  for (const sport of ODDS_SPORTS) {
    const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`;
    const { data, remaining, used, status } = await fetchOddsRaw(url);

    if (status === 429) {
      console.log('[fetcher] odds-api: 429 rate-limited — stopping, not overwriting file');
      quotaOk = false;
      break;
    }
    if (status === 401) {
      console.log('[fetcher] odds-api: 401 unauthorized — check API key');
      quotaOk = false;
      break;
    }
    if (remaining >= 0) {
      console.log(`[fetcher] odds-api [${sport}]: remaining=${remaining} used=${used}`);
      if (remaining <= ODDS_LOW_QUOTA) {
        console.log(`[fetcher] odds-api: quota low (${remaining} left) — stopping to preserve reserve`);
        quotaOk = false;
        break;
      }
    }
    if (Array.isArray(data)) results.push(...data);
    await sleep(500);
  }

  if (!results.length) {
    console.log('[fetcher] odds-api: 0 events returned — not overwriting existing file');
    return;
  }

  const out = { fetchedAt: Date.now(), events: results };
  fs.writeFileSync(ODDS_OUT,      JSON.stringify(out, null, 2));
  fs.writeFileSync(ODDS_SNAPSHOT, JSON.stringify(out, null, 2)); // update offline cache
  console.log(`[fetcher] odds-api saved — ${results.length} events (quotaOk=${quotaOk})`);
}

function kalshiPageToMarkets(eventsData) {
  const markets = [];
  for (const ev of (eventsData?.events || [])) {
    for (const m of (ev.markets || [])) {
      const bid = parseFloat(m.yes_bid_dollars || '0');
      const ask = parseFloat(m.yes_ask_dollars || '0');
      if (bid <= 0 && ask <= 0) continue;
      markets.push({
        ticker:          m.ticker,
        title:           ev.title || '',
        yes_bid_dollars: m.yes_bid_dollars,
        yes_ask_dollars: m.yes_ask_dollars,
        // Kalshi's own human-readable outcome name (e.g. "Mark Cuban" for ticker
        // suffix "MC") — lets the matcher's same-event gate resolve real identity
        // instead of pattern-matching the short ticker code. See shared-matcher.js.
        yes_sub_title:   m.yes_sub_title || '',
        // When this market resolves — semantically the same as Polymarket's endDate
        // (matches the "before <date>" wording in the question). expiration_time is
        // a settlement-buffer fallback for the rare market missing close_time.
        close_time:      m.close_time || m.expiration_time || m.latest_expiration_time || null,
      });
    }
  }
  return markets;
}

async function fetchKalshiPaginated() {
  const all = [];
  let cursor = null;
  let page   = 0;
  const MAX_PAGES = 60;

  while (page < MAX_PAGES) {
    let url = 'https://api.elections.kalshi.com/trade-api/v2/events?limit=200&status=open&with_nested_markets=true';
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
    const data = await fetchJson(url);
    if (!data || !Array.isArray(data.events) || !data.events.length) break;
    all.push(...kalshiPageToMarkets(data));
    cursor = data.cursor || '';
    page++;
    if (!cursor || !data.events.length) break;
    await sleep(150);
  }

  console.log(`[fetcher] kalshi: ${page} pages, ${all.length} priced markets`);
  return all;
}

// ── Polymarket tag-based sport event discovery ────────────────────────────

const SPORT_TAG_KW = [
  'world-cup','nfl','nba','nhl','mlb','soccer','football','basketball',
  'baseball','hockey','tennis','boxing','ufc','mma','golf','cricket',
  'rugby','olympics','formula-one','motorsports','cycling','swimming',
  'athletics','volleyball','esport','chess',
];

// Slugs known to exist but not reliably returned by the /tags paginator
const MUST_INCLUDE_SLUGS = ['world-cup'];

async function discoverSportTagSlugs() {
  const slugs = [...MUST_INCLUDE_SLUGS];
  for (let offset = 0; offset < 600; offset += 100) {
    const data = await fetchJson(`https://gamma-api.polymarket.com/tags?limit=100&offset=${offset}`);
    if (!Array.isArray(data) || !data.length) break;
    for (const t of data) {
      const slug = (t.slug || t.id || '').toLowerCase();
      if (SPORT_TAG_KW.some(k => slug.includes(k))) slugs.push(t.slug || t.id);
    }
    if (data.length < 100) break;
    await sleep(100);
  }
  return [...new Set(slugs)];
}

async function fetchPolymarketTagEvents(sportSlugs) {
  const byId = new Map();
  for (const slug of sportSlugs) {
    let offset = 0;
    while (true) {
      const data = await fetchJson(
        `https://gamma-api.polymarket.com/events?active=true&limit=50&offset=${offset}&tag_slug=${slug}`
      );
      const events = Array.isArray(data) ? data : [];
      if (!events.length) break;
      for (const ev of events) {
        for (const m of (ev.markets || [])) {
          const id = String(m.id || m.conditionId || m.questionID || '');
          if (id) byId.set(id, m);
        }
      }
      if (events.length < 50) break;
      offset += 50;
      await sleep(100);
    }
  }
  return [...byId.values()];
}

async function fetchAll() {
  console.log('[fetcher] fetching all platforms...');

  // Kalshi pagination + non-Kalshi fetches run concurrently
  const [kalshiMarkets, piRaw, mfRaw, pmRaw] = await Promise.all([
    fetchKalshiPaginated(),
    fetchJson('https://www.predictit.org/api/marketdata/all/'),
    fetchJson('https://api.manifold.markets/v0/markets?limit=100&sort=last-bet-time&order=desc'),
    fetchJson('https://gamma-api.polymarket.com/markets?active=true&limit=200'),
  ]);

  // Polymarket: merge volume-sorted base with tag-discovered sport events
  const pmBase = Array.isArray(pmRaw) ? pmRaw : [];
  const pmById = new Map(pmBase.map(m => [String(m.id || m.conditionId || ''), m]));

  const sportSlugs = await discoverSportTagSlugs();
  const tagMarkets = await fetchPolymarketTagEvents(sportSlugs);
  let tagAdded = 0;
  for (const m of tagMarkets) {
    const id = String(m.id || m.conditionId || m.questionID || '');
    if (id && !pmById.has(id)) { pmById.set(id, m); tagAdded++; }
  }
  const polymarketAll = [...pmById.values()];
  console.log(`[fetcher] polymarket: ${pmBase.length} base + ${tagAdded} tag-added (${sportSlugs.length} slugs) = ${polymarketAll.length} total`);

  const result = {
    fetchedAt: Date.now(),
    predictit:  piRaw?.markets  ?? [],
    manifold:   Array.isArray(mfRaw) ? mfRaw : [],
    kalshi:     kalshiMarkets,
    polymarket: polymarketAll,
  };

  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  beat('fetcher');

  console.log(`[fetcher] saved — PI:${result.predictit.length} MF:${result.manifold.length} KA:${result.kalshi.length} PM:${result.polymarket.length}`);
}

fetchAll();
setInterval(fetchAll, INTERVAL);
// OddsAPI: only run when explicitly enabled (ODDS_API_LIVE=1) to protect monthly quota
if (ODDS_API_LIVE) {
  fetchOddsApi();
  setInterval(fetchOddsApi, ODDS_INTERVAL);
} else {
  console.log('[fetcher] odds-api live fetch disabled (set ODDS_API_LIVE=1 to enable)');
}
