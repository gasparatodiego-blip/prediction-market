#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const https = require('https');
const http  = require('http');

const OUT      = '/tmp/markets-raw.json';
const HB_FILE  = '/tmp/agent-heartbeats.json';
const INTERVAL = 60_000;

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
setInterval(fetchAll, INTERVAL);
