#!/usr/bin/env node
'use strict';
// Consolidated data collector — replaces 8 individual platform agents
// Platforms: Kalshi, Polymarket, Manifold, Metaculus, PredictIt, Betfair, Futuur, GoodJudgment
// Runs every 3 minutes, all platforms fetched in parallel

const fs    = require('fs');
const https = require('https');

const HB_FILE     = '/tmp/agent-heartbeats.json';
const INTERVAL_MS = 3 * 60 * 1000;

// ── Shared utils ──────────────────────────────────────────────────────────────

function beat(name) {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb[name] = Date.now();
  try { fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2)); } catch {}
}

function get(url, opts = {}) {
  return new Promise(resolve => {
    const lib = url.startsWith('https') ? https : require('http');
    const req = lib.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 prediction-arb-scanner/1.0', Accept: 'application/json', ...opts.headers },
      timeout: 15000,
    }, res => {
      if (res.statusCode === 401 || res.statusCode === 403) { resolve({ _blocked: true, status: res.statusCode }); return; }
      if (res.statusCode === 404) { resolve({ _notFound: true }); return; }
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', function() { this.destroy(); resolve(null); });
  });
}

function write(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) { console.error(`[collector] write ${file} failed:`, e.message); }
}

// ── Kalshi ────────────────────────────────────────────────────────────────────

async function fetchKalshi() {
  try {
    beat('agent-kalshi');
    const all = [];
    let cursor = null;
    let page   = 0;
    const MAX_PAGES = 60;

    while (page < MAX_PAGES) {
      let url = 'https://api.elections.kalshi.com/trade-api/v2/events?limit=200&status=open&with_nested_markets=true';
      if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
      const data = await get(url);
      if (!data || data._blocked) break;
      const events = data.events || [];
      if (!events.length) break;

      for (const ev of events) {
        for (const m of (ev.markets || [])) {
          all.push({
            ticker:          m.ticker,
            title:           ev.title || '',
            yes_bid_dollars: m.yes_bid_dollars,
            yes_ask_dollars: m.yes_ask_dollars,
          });
        }
      }

      cursor = data.cursor || '';
      page++;
      if (!cursor || !events.length) break;
      await new Promise(r => setTimeout(r, 150));
    }

    const priced = all.filter(m => parseFloat(m.yes_bid_dollars||0) > 0 || parseFloat(m.yes_ask_dollars||0) > 0);
    write('/tmp/kalshi-raw.json', { fetchedAt: Date.now(), pages: page, total: all.length, priced: priced.length, markets: all });
    console.log(`[kalshi] ${page} pages, ${all.length} markets (${priced.length} priced)`);
  } catch (e) { console.error('[kalshi] error:', e.message); }
}

// ── Polymarket ────────────────────────────────────────────────────────────────

const _SPORT_TAG_KW = [
  'world-cup','nfl','nba','nhl','mlb','soccer','football','basketball',
  'baseball','hockey','tennis','boxing','ufc','mma','golf','cricket',
  'rugby','olympics','formula-one','motorsports','cycling','swimming',
  'athletics','volleyball','esport','chess',
];

const _MUST_INCLUDE_SLUGS = ['world-cup'];

async function _pmSportSlugs() {
  const slugs = [..._MUST_INCLUDE_SLUGS];
  for (let offset = 0; offset < 600; offset += 100) {
    const data = await get(`https://gamma-api.polymarket.com/tags?limit=100&offset=${offset}`);
    if (!Array.isArray(data) || !data.length) break;
    for (const t of data) {
      const slug = (t.slug || t.id || '').toLowerCase();
      if (_SPORT_TAG_KW.some(k => slug.includes(k))) slugs.push(t.slug || t.id);
    }
    if (data.length < 100) break;
    await new Promise(r => setTimeout(r, 100));
  }
  return [...new Set(slugs)];
}

async function fetchPolymarket() {
  try {
    beat('agent-polymarket');

    // Volume-sorted base (3 pages)
    const base = [];
    for (let page = 0; page < 3; page++) {
      const data = await get(`https://gamma-api.polymarket.com/markets?limit=100&offset=${page * 100}&active=true&closed=false`);
      if (!data || data._blocked) break;
      const items = Array.isArray(data) ? data : (data.markets ?? data.data ?? []);
      if (!items.length) break;
      base.push(...items);
      if (items.length < 100) break;
    }

    // Tag-based sport event discovery
    const byId = new Map(base.map(m => [String(m.id || m.conditionId || ''), m]));
    const slugs = await _pmSportSlugs();
    let tagAdded = 0;
    for (const slug of slugs) {
      let offset = 0;
      while (true) {
        const data = await get(`https://gamma-api.polymarket.com/events?active=true&limit=50&offset=${offset}&tag_slug=${slug}`);
        const events = Array.isArray(data) ? data : [];
        if (!events.length) break;
        for (const ev of events) {
          for (const m of (ev.markets || [])) {
            const id = String(m.id || m.conditionId || m.questionID || '');
            if (id && !byId.has(id)) { byId.set(id, m); tagAdded++; }
          }
        }
        if (events.length < 50) break;
        offset += 50;
        await new Promise(r => setTimeout(r, 100));
      }
    }

    const results = [...byId.values()];
    write('/tmp/polymarket-raw.json', { fetchedAt: Date.now(), total: results.length, base: base.length, tagAdded, active: results.filter(m => m.active).length, markets: results });
    console.log(`[polymarket] ${base.length} base + ${tagAdded} tag-added (${slugs.length} slugs) = ${results.length} total`);
  } catch (e) { console.error('[polymarket] error:', e.message); }
}

// ── Manifold ──────────────────────────────────────────────────────────────────

async function fetchManifold() {
  try {
    beat('agent-manifold');
    const all = [];
    for (let page = 0; page < 3; page++) {
      let url = `https://api.manifold.markets/v0/markets?limit=100&sort=last-bet-time`;
      if (all.length > 0) url += `&before=${all[all.length - 1].id}`;
      const data = await get(url);
      if (!Array.isArray(data) || !data.length) break;
      all.push(...data);
      if (data.length < 100) break;
    }
    const binary = all.filter(m => m.outcomeType === 'BINARY' && m.probability != null && m.probability > 0.02 && m.probability < 0.98 && !m.isResolved);
    write('/tmp/manifold-raw.json', { fetchedAt: Date.now(), total: all.length, binary: binary.length, markets: all });
    console.log(`[manifold] ${all.length} markets (${binary.length} binary)`);
  } catch (e) { console.error('[manifold] error:', e.message); }
}

// ── Metaculus ─────────────────────────────────────────────────────────────────

async function fetchMetaculus() {
  try {
    beat('agent-metaculus');
    const ENDPOINTS = [
      'https://api.metaculus.com/api/posts/?limit=100&has_group=false',
      'https://www.metaculus.com/api2/questions/?status=open&limit=100&has_group=false',
    ];
    let questions = [];
    for (const url of ENDPOINTS) {
      const data = await get(url);
      if (!data || data._blocked) continue;
      const results = Array.isArray(data.results) ? data.results : [];
      if (results.length) {
        questions = results.map(q => ({
          id: q.id, question: q.title ?? q.question ?? '', probability: q.community_prediction?.full?.q2 ?? q.community_prediction ?? null,
          url: q.page_url ? `https://www.metaculus.com${q.page_url}` : (q.url ?? null),
          closeTime: q.close_time ?? q.scheduled_resolve_time ?? null, numForecasts: q.forecasts_count ?? q.number_of_predictions ?? 0,
        })).filter(q => q.question);
        break;
      }
    }
    write('/tmp/metaculus-raw.json', { fetchedAt: Date.now(), total: questions.length, questions });
    console.log(`[metaculus] ${questions.length} questions`);
  } catch (e) { console.error('[metaculus] error:', e.message); }
}

// ── PredictIt ─────────────────────────────────────────────────────────────────

async function fetchPredictit() {
  try {
    beat('agent-predictit');
    const ENDPOINTS = [
      'https://www.predictit.org/api/marketdata/all/',
      'https://predictit-f497e.firebaseio.com/markets.json',
    ];
    let markets = [];
    for (const url of ENDPOINTS) {
      const data = await get(url);
      if (!data || data._blocked) continue;
      const raw = Array.isArray(data) ? data : (data.markets ?? []);
      if (raw.length) { markets = raw; break; }
    }
    const normalised = markets.map(m => ({
      id: m.id, name: m.name, url: m.url ?? `https://www.predictit.org/markets/detail/${m.id}`,
      status: m.status, tradedVolume: m.tradedVolume ?? null, end: m.end ?? null,
      contracts: (m.contracts ?? []).map(c => ({
        id: c.id, name: c.name, status: c.status,
        lastTradePrice: c.lastTradePrice ?? null, bestBuyYesCost: c.bestBuyYesCost ?? null, bestBuyNoCost: c.bestBuyNoCost ?? null,
      })),
    }));
    write('/tmp/predictit-raw.json', { fetchedAt: Date.now(), total: normalised.length, priced: normalised.filter(m => m.contracts.some(c => c.lastTradePrice != null)).length, markets: normalised });
    console.log(`[predictit] ${normalised.length} markets`);
  } catch (e) { console.error('[predictit] error:', e.message); }
}

// ── Betfair ───────────────────────────────────────────────────────────────────

async function fetchBetfair() {
  try {
    beat('agent-betfair');
    // Betfair requires auth; derive markets from the odds-api-raw.json (written by agent-master/sports)
    const oddsApiMarkets = [];
    try {
      const raw = JSON.parse(fs.readFileSync('/tmp/odds-api-raw.json', 'utf8'));
      for (const ev of raw?.events ?? []) {
        for (const bm of ev.bookmakers ?? []) {
          if (!bm.key.startsWith('betfair')) continue;
          const h2h = (bm.markets ?? []).find(m => m.key === 'h2h');
          if (!h2h) continue;
          oddsApiMarkets.push({ id: ev.id, sport: ev.sport_key, event: `${ev.home_team} vs ${ev.away_team}`, commenceTime: ev.commence_time, bookmaker: bm.title, outcomes: h2h.outcomes.map(o => ({ name: o.name, price: o.price })), source: 'odds-api' });
        }
      }
    } catch {}
    write('/tmp/betfair-raw.json', { fetchedAt: Date.now(), total: oddsApiMarkets.length, exchangeCount: 0, oddsApiCount: oddsApiMarkets.length, markets: oddsApiMarkets });
    console.log(`[betfair] ${oddsApiMarkets.length} markets (odds-api)`);
  } catch (e) { console.error('[betfair] error:', e.message); }
}

// ── Futuur ────────────────────────────────────────────────────────────────────

async function fetchFutuur() {
  try {
    beat('agent-futuur');
    // Public API — no auth required: https://api.futuur.com/api/v1/markets/
    const all = [];
    let offset = 0;
    while (true) {
      const data = await get(`https://api.futuur.com/api/v1/markets/?status=open&limit=100&offset=${offset}`);
      if (!data?.results?.length) break;
      all.push(...data.results);
      const total = data.pagination?.total ?? all.length;
      if (all.length >= total) break;
      offset += 100;
      await new Promise(r => setTimeout(r, 150));
    }
    // Normalise: expand each outcome into its own arb-ready entry
    const normalized = all.map(m => ({
      id:                    m.id,
      title:                 m.title ?? '',
      slug:                  m.slug ?? String(m.id),
      status:                m.status,
      real_currency_available: m.real_currency_available ?? false,
      is_binary:             m.is_binary ?? false,
      volume_real_money:     m.volume_real_money ?? 0,
      volume_play_money:     m.volume_play_money ?? 0,
      tax_real_money:        m.tax_real_money ?? 0,
      bet_end_date:          m.bet_end_date ?? null,
      category:              m.category ?? null,
      outcomes: (m.outcomes ?? []).map(o => ({
        id:       o.id,
        title:    o.title ?? '',
        disabled: o.disabled ?? false,
        price: {
          OOM:  o.price?.OOM  ?? null,
          USDC: o.price?.USDC ?? null,
        },
      })),
    }));
    write('/tmp/futuur-raw.json', { fetchedAt: Date.now(), total: normalized.length, markets: normalized });
    console.log(`[futuur] ${normalized.length} markets (${all.filter(m => m.real_currency_available).length} real-money)`);
  } catch (e) { console.error('[futuur] error:', e.message); }
}

// ── GoodJudgment ──────────────────────────────────────────────────────────────

async function fetchGoodJudgment() {
  try {
    beat('agent-goodjudgment');
    const ENDPOINTS = [
      'https://www.gjopen.com/api/v1/questions?status=active&per_page=100',
      'https://www.gjopen.com/challenges/questions?status=active&per_page=100',
    ];
    let questions = [];
    for (const url of ENDPOINTS) {
      const data = await get(url);
      if (!data || data._blocked || data._notFound) continue;
      const items = Array.isArray(data) ? data : (data.questions ?? data.data ?? data.results ?? []);
      if (items.length) { questions = items; break; }
    }
    const normalized = questions.map(q => ({
      id: q.id, title: q.name ?? q.title ?? q.question ?? 'Unknown', description: q.description ?? '',
      probability: q.probability ?? q.community_prediction ?? null, status: q.status ?? 'active',
      closesAt: q.close_time ?? q.closes_at ?? null, forecasters: q.forecasters_count ?? 0,
      url: q.url ?? (q.id ? `https://www.gjopen.com/questions/${q.id}` : null),
    }));
    write('/tmp/goodjudgment-raw.json', { fetchedAt: Date.now(), total: normalized.length, questions: normalized });
    console.log(`[goodjudgment] ${normalized.length} questions`);
  } catch (e) { console.error('[goodjudgment] error:', e.message); }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function run() {
  console.log(`[data-collector] cycle @ ${new Date().toISOString()}`);
  await Promise.all([
    fetchKalshi(),
    fetchPolymarket(),
    fetchManifold(),
    fetchMetaculus(),
    fetchPredictit(),
    fetchBetfair(),
    fetchFutuur(),
    fetchGoodJudgment(),
  ]);
  console.log(`[data-collector] cycle complete`);
}

async function tick() {
  try { await run(); } catch (e) { console.error('[data-collector] error:', e.message); }
  setTimeout(tick, INTERVAL_MS);
}

tick();
