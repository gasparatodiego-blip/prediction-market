#!/usr/bin/env node
'use strict';

const fs    = require('fs');
const { atomicWriteJson } = require('../lib/atomicJsonWrite');
const https = require('https');

const OUT_FILE    = '/tmp/betfair-raw.json';
const HB_FILE     = '/tmp/agent-heartbeats.json';
const INTERVAL_MS = 5 * 60 * 1000;

// Betfair Exchange prices via public listing API (no auth required for market catalogue)
// Falls back to filtering odds-api-raw for betfair_ex data
const BETFAIR_EVENT_TYPES = [
  { id: '1', name: 'Soccer' },
  { id: '2', name: 'Tennis' },
  { id: '4', name: 'Cricket' },
  { id: '6', name: 'Boxing' },
  { id: '7', name: 'Horse Racing' },
  { id: '21', name: 'Politics' },
];

function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb['agent-betfair'] = Date.now();
  try { atomicWriteJson(HB_FILE, hb, { pretty: true }); } catch {}
}

function post(hostname, path, payload) {
  return new Promise(resolve => {
    const body = JSON.stringify(payload);
    const req  = https.request({
      hostname,
      path,
      method:  'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':     'Mozilla/5.0 prediction-arb-scanner/1.0',
        'Accept':         'application/json',
      },
      timeout: 15000,
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          console.warn(`[betfair] auth required (${res.statusCode}) — using odds-api fallback`);
          resolve({ authRequired: true });
          return;
        }
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', function () { this.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

function get(url) {
  return new Promise(resolve => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 prediction-arb-scanner/1.0', 'Accept': 'application/json' },
      timeout: 15000,
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', function () { this.destroy(); resolve(null); });
  });
}

// Derive betfair markets from the existing odds-api-raw.json (agent12-sports writes this)
function loadFromOddsApi() {
  try {
    const raw = JSON.parse(fs.readFileSync('/tmp/odds-api-raw.json', 'utf8'));
    const events = raw?.events ?? [];
    const markets = [];
    for (const ev of events) {
      for (const bm of ev.bookmakers ?? []) {
        if (!bm.key.startsWith('betfair')) continue;
        const h2h = (bm.markets ?? []).find(m => m.key === 'h2h');
        if (!h2h) continue;
        markets.push({
          id:          ev.id,
          sport:       ev.sport_key,
          event:       `${ev.home_team} vs ${ev.away_team}`,
          commenceTime: ev.commence_time,
          bookmaker:   bm.title,
          outcomes:    h2h.outcomes.map(o => ({ name: o.name, price: o.price })),
          source:      'odds-api',
        });
      }
    }
    return markets;
  } catch { return []; }
}

// Try to fetch Betfair Exchange market catalogue (no auth = politics markets may be public)
async function fetchBetfairPublic() {
  const markets = [];
  try {
    // Betfair Next Generation API — some endpoints allow app key without session
    const appKey = process.env.BETFAIR_APP_KEY || '';
    if (!appKey) return null; // no key available, skip

    const result = await post('api.betfair.com', '/exchange/betting/json-rpc/v1', {
      jsonrpc: '2.0',
      method:  'SportsAPING/v1.0/listMarketCatalogue',
      params:  {
        filter:          { eventTypeIds: ['21'] }, // Politics only (public)
        marketProjection: ['EVENT', 'RUNNER_DESCRIPTION', 'RUNNER_METADATA'],
        sort:            'FIRST_TO_START',
        maxResults:      '100',
      },
      id: 1,
    });

    if (result?.authRequired) return null;
    if (result?.result) {
      for (const m of result.result) {
        markets.push({
          id:       m.marketId,
          name:     m.marketName,
          event:    m.event?.name ?? m.marketName,
          sport:    'politics',
          runners:  (m.runners ?? []).map(r => ({ id: r.selectionId, name: r.runnerName })),
          source:   'betfair-exchange',
        });
      }
    }
  } catch (e) {
    console.warn('[betfair] public fetch error:', e.message);
  }
  return markets.length ? markets : null;
}

async function run() {
  beat();
  console.log('[betfair] fetching @', new Date().toISOString());

  const exchangeMarkets = await fetchBetfairPublic();
  const oddsApiMarkets  = loadFromOddsApi();

  const markets = [
    ...(exchangeMarkets ?? []),
    ...oddsApiMarkets,
  ];

  const out = {
    fetchedAt:      Date.now(),
    total:          markets.length,
    exchangeCount:  (exchangeMarkets ?? []).length,
    oddsApiCount:   oddsApiMarkets.length,
    markets,
  };

  try {
    fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
    console.log(`[betfair] saved ${markets.length} markets (${out.exchangeCount} exchange, ${out.oddsApiCount} odds-api) → ${OUT_FILE}`);
  } catch (e) {
    console.error('[betfair] write failed:', e.message);
  }
}

async function tick() {
  try { await run(); } catch (e) { console.error('[betfair] error:', e.message); }
  setTimeout(tick, INTERVAL_MS);
}

tick();
