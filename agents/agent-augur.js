#!/usr/bin/env node
'use strict';

const fs    = require('fs');
const https = require('https');

const OUT_FILE    = '/tmp/augur-raw.json';
const HB_FILE     = '/tmp/agent-heartbeats.json';
const INTERVAL_MS = 10 * 60 * 1000;

// Augur v2 via TheGraph — multiple endpoint attempts for reliability
const GRAPH_ENDPOINTS = [
  'https://api.thegraph.com/subgraphs/name/augurproject/augur-v2-staging',
  'https://api.thegraph.com/subgraphs/name/augurproject/augur-v2',
];

const QUERY = JSON.stringify({
  query: `{
    markets(first: 50, where: {status: "TRADING"}, orderBy: volume, orderDirection: desc) {
      id
      description
      status
      volume
      numTicks
      outcomes {
        id
        description
        price
        volume
      }
      endTime
      creationTime
    }
  }`,
});

function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb['agent-augur'] = Date.now();
  try { fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2)); } catch {}
}

function postGraph(url, body) {
  return new Promise(resolve => {
    const [, hostname, path] = url.match(/https?:\/\/([^\/]+)(\/.*)/);
    const req = https.request({
      hostname,
      path,
      method:  'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':     'Mozilla/5.0 prediction-arb-scanner/1.0',
        'Accept':         'application/json',
      },
      timeout: 20000,
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          console.warn(`[augur] auth required at ${url} (${res.statusCode})`);
          resolve(null);
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

async function fetchAugur() {
  for (const endpoint of GRAPH_ENDPOINTS) {
    const result = await postGraph(endpoint, QUERY);
    if (result?.data?.markets?.length) {
      console.log(`[augur] fetched ${result.data.markets.length} markets from ${endpoint}`);
      return result.data.markets;
    }
    if (result?.errors) {
      console.warn('[augur] GraphQL errors:', JSON.stringify(result.errors).slice(0, 200));
    }
  }
  return [];
}

async function run() {
  beat();
  console.log('[augur] fetching @', new Date().toISOString());

  const markets = await fetchAugur();

  const out = {
    fetchedAt: Date.now(),
    total:     markets.length,
    markets,
  };

  try {
    fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
    console.log(`[augur] saved ${markets.length} markets → ${OUT_FILE}`);
  } catch (e) {
    console.error('[augur] write failed:', e.message);
  }
}

async function tick() {
  try { await run(); } catch (e) { console.error('[augur] error:', e.message); }
  setTimeout(tick, INTERVAL_MS);
}

tick();
