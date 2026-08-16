#!/usr/bin/env node
'use strict';

const fs    = require('fs');
const { atomicWriteJson } = require('../lib/atomicJsonWrite');
const https = require('https');

const OUT_FILE    = '/tmp/polymarket-raw.json';
const HB_FILE     = '/tmp/agent-heartbeats.json';
const INTERVAL_MS = 5 * 60 * 1000;   // 5 minutes

// Multiple pages: fetch 3 pages of 100 for broader coverage
const PAGES       = 3;
const PAGE_SIZE   = 100;
const PM_BASE     = 'https://gamma-api.polymarket.com/markets';

// ── Utilities ─────────────────────────────────────

function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb['agent-polymarket'] = Date.now();
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

async function fetchAll() {
  const results = [];

  for (let page = 0; page < PAGES; page++) {
    const offset = page * PAGE_SIZE;
    const url    = `${PM_BASE}?limit=${PAGE_SIZE}&offset=${offset}&active=true&closed=false`;
    const data   = await get(url);

    if (!data) {
      console.warn(`[polymarket] page ${page} returned null`);
      break;
    }

    const items = Array.isArray(data) ? data : (data.markets ?? data.data ?? []);
    if (!items.length) break;  // no more pages

    results.push(...items);

    // If we got fewer than PAGE_SIZE items, we've hit the last page
    if (items.length < PAGE_SIZE) break;
  }

  return results;
}

// ── Main ──────────────────────────────────────────

async function run() {
  const ts = new Date().toISOString();
  beat();
  console.log(`[polymarket] fetching @ ${ts}`);

  const markets = await fetchAll();
  if (!markets.length) {
    console.error('[polymarket] no markets returned');
    return;
  }

  // Filter to markets with valid prices
  const active = markets.filter(m => {
    if (!m.active) return false;
    try {
      const prices = typeof m.outcomePrices === 'string'
        ? JSON.parse(m.outcomePrices)
        : m.outcomePrices;
      if (Array.isArray(prices) && prices[0]) {
        const p = parseFloat(prices[0]);
        return p > 0.03 && p < 0.97;  // between 3% and 97%
      }
    } catch {}
    return false;
  });

  const out = {
    fetchedAt: Date.now(),
    total:     markets.length,
    active:    active.length,
    markets:   markets,   // full set; route will filter
  };

  try {
    fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
    console.log(`[polymarket] saved ${markets.length} markets (${active.length} active with prices) → ${OUT_FILE}`);
  } catch (e) {
    console.error('[polymarket] write failed:', e.message);
  }
}

async function tick() {
  try {
    await run();
  } catch (err) {
    console.error('[polymarket] uncaught error:', err.message);
  }
  setTimeout(tick, INTERVAL_MS);
}

tick();
