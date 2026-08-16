#!/usr/bin/env node
'use strict';

const fs    = require('fs');
const { atomicWriteJson } = require('../lib/atomicJsonWrite');
const https = require('https');

const OUT_FILE      = '/tmp/kalshi-raw.json';
const HB_FILE       = '/tmp/agent-heartbeats.json';
const INTERVAL_MS   = 5 * 60 * 1000;   // 5 minutes
const KALSHI_URL    = 'https://api.elections.kalshi.com/trade-api/v2/markets?limit=100&status=open';

// ── Utilities ─────────────────────────────────────

function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb['agent-kalshi'] = Date.now();
  try { atomicWriteJson(HB_FILE, hb, { pretty: true }); } catch {}
}

function get(url) {
  return new Promise(resolve => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 prediction-arb-scanner/1.0',
        'Accept':     'application/json',
      },
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

// ── Fetch ─────────────────────────────────────────

async function fetch() {
  const data = await get(KALSHI_URL);
  if (!data) {
    console.error('[kalshi] fetch failed — no response');
    return null;
  }

  // API returns { markets: [...], cursor: "..." }
  const markets = data.markets ?? data.market_responses ?? [];
  if (!Array.isArray(markets)) {
    console.error('[kalshi] unexpected response shape:', JSON.stringify(data).slice(0, 200));
    return null;
  }

  return markets;
}

// ── Main ──────────────────────────────────────────

async function run() {
  const ts = new Date().toISOString();
  beat();
  console.log(`[kalshi] fetching @ ${ts}`);

  const markets = await fetch();
  if (!markets) return;

  // Filter to markets with valid prices (bid or ask > 0, or last_price > 0)
  const priced = markets.filter(m => {
    const bid  = parseFloat(m.yes_bid_dollars  || '0');
    const ask  = parseFloat(m.yes_ask_dollars  || '0');
    const last = parseFloat(m.last_price_dollars || '0');
    return bid > 0 || ask > 0 || last > 0;
  });

  const out = {
    fetchedAt: Date.now(),
    total:     markets.length,
    priced:    priced.length,
    markets:   markets,   // full set so the API route can pick what it needs
  };

  try {
    fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
    console.log(`[kalshi] saved ${markets.length} markets (${priced.length} with prices) → ${OUT_FILE}`);
  } catch (e) {
    console.error('[kalshi] write failed:', e.message);
  }
}

async function tick() {
  try {
    await run();
  } catch (err) {
    console.error('[kalshi] uncaught error:', err.message);
  }
  setTimeout(tick, INTERVAL_MS);
}

tick();
