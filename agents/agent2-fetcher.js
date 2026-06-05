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

async function fetchAll() {
  console.log('[fetcher] fetching all platforms...');
  const [piRaw, mfRaw, kaRaw, pmRaw] = await Promise.all([
    fetchJson('https://www.predictit.org/api/marketdata/all/'),
    fetchJson('https://api.manifold.markets/v0/markets?limit=100&sort=liquidity&order=desc'),
    fetchJson('https://api.elections.kalshi.com/trade-api/v2/markets?limit=200&status=open'),
    fetchJson('https://gamma-api.polymarket.com/markets?active=true&limit=200'),
  ]);

  const result = {
    fetchedAt: Date.now(),
    predictit:  piRaw?.markets  ?? [],
    manifold:   Array.isArray(mfRaw) ? mfRaw : [],
    kalshi:     kaRaw?.markets  ?? [],
    polymarket: Array.isArray(pmRaw) ? pmRaw : [],
  };

  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  beat('fetcher');

  console.log(`[fetcher] saved — PI:${result.predictit.length} MF:${result.manifold.length} KA:${result.kalshi.length} PM:${result.polymarket.length}`);
}

fetchAll();
fetchOddsApi();
setInterval(fetchAll, INTERVAL);
setInterval(fetchOddsApi, ODDS_INTERVAL);
