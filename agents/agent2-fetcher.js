#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const https = require('https');
const http  = require('http');

const OUT          = '/tmp/markets-raw.json';
const ODDS_OUT     = '/tmp/odds-api-raw.json';
const HB_FILE      = '/tmp/agent-heartbeats.json';
const INTERVAL     = 60_000;
const ODDS_INTERVAL = 300_000; // 5 min — be quota-friendly

const ODDS_API_KEY  = 'aff711ab10f3f1fba585e30405329c7c';
const ODDS_SPORTS   = [
  'soccer_fifa_world_cup',
  'americanfootball_nfl',
  'baseball_mlb',
  'basketball_nba',
  'tennis_atp_french_open',
];

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

async function fetchOddsApi() {
  console.log('[fetcher] fetching The Odds API...');
  const results = [];
  for (const sport of ODDS_SPORTS) {
    const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`;
    const data = await fetchJson(url);
    if (Array.isArray(data)) results.push(...data);
  }
  fs.writeFileSync(ODDS_OUT, JSON.stringify({ fetchedAt: Date.now(), events: results }, null, 2));
  console.log(`[fetcher] odds-api saved — ${results.length} events`);
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
fetchOddsApi();
setInterval(fetchAll, INTERVAL);
setInterval(fetchOddsApi, ODDS_INTERVAL);
