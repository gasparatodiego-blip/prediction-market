#!/usr/bin/env node
'use strict';

const fs    = require('fs');
const https = require('https');

const OUT_FILE    = '/tmp/manifold-raw.json';
const HB_FILE     = '/tmp/agent-heartbeats.json';
const INTERVAL_MS = 5 * 60 * 1000;

// Fetch 3 pages sorted by last bet activity to get the most liquid/active markets
const PAGES     = 3;
const PAGE_SIZE = 100;
const BASE_URL  = 'https://api.manifold.markets/v0/markets';

function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb['agent-manifold'] = Date.now();
  try { fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2)); } catch {}
}

function get(url) {
  return new Promise(resolve => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'prediction-arb-scanner/1.0', Accept: 'application/json' },
      timeout: 15000,
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', function () { this.destroy(); resolve(null); });
  });
}

async function fetchAll() {
  const all = [];
  for (let page = 0; page < PAGES; page++) {
    // Manifold uses cursor-based pagination via 'before' param (last id of previous page)
    let url = `${BASE_URL}?limit=${PAGE_SIZE}&sort=last-bet-time`;
    if (all.length > 0) url += `&before=${all[all.length - 1].id}`;

    const data = await get(url);
    if (!Array.isArray(data) || !data.length) break;
    all.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return all;
}

async function run() {
  const ts = new Date().toISOString();
  beat();
  console.log(`[manifold] fetching @ ${ts}`);

  const markets = await fetchAll();
  if (!markets.length) {
    console.error('[manifold] no data returned');
    return;
  }

  // Keep only binary markets with a valid probability
  const binary = markets.filter(m =>
    m.outcomeType === 'BINARY' &&
    m.probability != null &&
    m.probability > 0.02 && m.probability < 0.98 &&
    !m.isResolved
  );

  try {
    fs.writeFileSync(OUT_FILE, JSON.stringify({
      fetchedAt: Date.now(),
      total:     markets.length,
      binary:    binary.length,
      markets:   markets,
    }, null, 2));
    console.log(`[manifold] saved ${markets.length} markets (${binary.length} binary) → ${OUT_FILE}`);
  } catch (e) {
    console.error('[manifold] write failed:', e.message);
  }
}

async function tick() {
  try { await run(); } catch (e) { console.error('[manifold] error:', e.message); }
  setTimeout(tick, INTERVAL_MS);
}

tick();
