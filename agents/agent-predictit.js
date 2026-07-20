#!/usr/bin/env node
'use strict';

const fs    = require('fs');
const { atomicWriteJson } = require('../lib/atomicJsonWrite');
const https = require('https');
const http  = require('http');

const OUT_FILE    = '/tmp/predictit-raw.json';
const HB_FILE     = '/tmp/agent-heartbeats.json';
const INTERVAL_MS = 5 * 60 * 1000;

// Direct PredictIt public API — the only endpoint.
//
// A US path-gateway used to sit behind this as a geo-blocked fallback, but that gateway
// stopped serving /predictit/markets (404) and is being decommissioned, so it could not
// have rescued a single fetch. Rather than keep a fallback that silently fails, the agent
// now depends on the direct endpoint alone and says so loudly when it fails.
const ENDPOINTS = [
  'https://www.predictit.org/api/marketdata/all/',
];

function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb['agent-predictit'] = Date.now();
  try { atomicWriteJson(HB_FILE, hb, { pretty: true }); } catch {}
}

function get(url) {
  return new Promise(resolve => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
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

async function run() {
  const ts = new Date().toISOString();
  beat();
  console.log(`[predictit] fetching @ ${ts}`);

  let markets = [];
  let source  = 'none';

  for (const url of ENDPOINTS) {
    const data = await get(url);
    if (!data) { console.warn(`[predictit] ${url} → null`); continue; }

    // Direct API returns { markets: [...] }; the bare-array branch is kept as cheap
    // tolerance in case the upstream shape ever changes.
    const raw = Array.isArray(data) ? data : (data.markets ?? []);
    if (raw.length) { markets = raw; source = url; break; }
  }

  if (!markets.length) {
    // No fallback exists by design — say plainly that the single direct source failed,
    // so an outage reads as an outage instead of a quiet empty file.
    console.error(`[predictit] DIRECT endpoint failed (${ENDPOINTS[0]}) — no fallback configured; writing empty file`);
    // Write empty but valid file so route.ts doesn't break
    fs.writeFileSync(OUT_FILE, JSON.stringify({ fetchedAt: Date.now(), total: 0, markets: [], source: 'none' }, null, 2));
    return;
  }

  // Enrich: flatten each market's contracts into a normalised shape
  const normalised = markets.map(m => ({
    id:           m.id,
    name:         m.name,
    url:          m.url ?? `https://www.predictit.org/markets/detail/${m.id}`,
    status:       m.status,
    tradedVolume: m.tradedVolume ?? null,
    end:          m.end ?? null,
    contracts:    (m.contracts ?? []).map(c => ({
      id:             c.id,
      name:           c.name,
      status:         c.status,
      lastTradePrice: c.lastTradePrice ?? null,
      bestBuyYesCost: c.bestBuyYesCost ?? null,
      bestBuyNoCost:  c.bestBuyNoCost  ?? null,
    })),
  }));

  const priced = normalised.filter(m =>
    m.contracts.some(c => c.lastTradePrice != null && c.lastTradePrice > 0)
  );

  try {
    fs.writeFileSync(OUT_FILE, JSON.stringify({
      fetchedAt: Date.now(),
      total:     markets.length,
      priced:    priced.length,
      source,
      markets:   normalised,
    }, null, 2));
    console.log(`[predictit] saved ${markets.length} markets (${priced.length} priced) source=${source} → ${OUT_FILE}`);
  } catch (e) {
    console.error('[predictit] write failed:', e.message);
  }
}

async function tick() {
  try { await run(); } catch (e) { console.error('[predictit] error:', e.message); }
  setTimeout(tick, INTERVAL_MS);
}

tick();
