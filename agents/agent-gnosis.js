#!/usr/bin/env node
'use strict';

const fs    = require('fs');
const https = require('https');

const OUT_FILE    = '/tmp/gnosis-raw.json';
const HB_FILE     = '/tmp/agent-heartbeats.json';
const INTERVAL_MS = 10 * 60 * 1000;

// Gnosis/Omen prediction markets via TheGraph (xDai/Gnosis chain)
const GRAPH_ENDPOINTS = [
  'https://api.thegraph.com/subgraphs/name/protofire/omen-xdai',
  'https://api.thegraph.com/subgraphs/name/protofire/omen',
];

const QUERY = JSON.stringify({
  query: `{
    fixedProductMarketMakers(
      first: 50,
      where: { collateralVolume_gt: "0", resolutionTimestamp: null },
      orderBy: collateralVolume,
      orderDirection: desc
    ) {
      id
      question {
        id
        title
        outcomes
        currentAnswer
        arbitrationOccurred
        isPendingArbitration
      }
      outcomeTokenMarginalPrices
      outcomeTokenAmounts
      collateralVolume
      runningDailyVolume
      resolutionTimestamp
      creationTimestamp
    }
  }`,
});

function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb['agent-gnosis'] = Date.now();
  try { fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2)); } catch {}
}

function postGraph(url, body) {
  return new Promise(resolve => {
    const match = url.match(/https?:\/\/([^\/]+)(\/.*)/);
    if (!match) return resolve(null);
    const [, hostname, path] = match;
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
          console.warn(`[gnosis] auth required at ${url} (${res.statusCode})`);
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

async function fetchGnosis() {
  for (const endpoint of GRAPH_ENDPOINTS) {
    const result = await postGraph(endpoint, QUERY);
    const items  = result?.data?.fixedProductMarketMakers;
    if (items?.length) {
      console.log(`[gnosis] fetched ${items.length} markets from ${endpoint}`);
      return items;
    }
    if (result?.errors) {
      console.warn('[gnosis] GraphQL errors:', JSON.stringify(result.errors).slice(0, 200));
    }
  }
  return [];
}

async function run() {
  beat();
  console.log('[gnosis] fetching @', new Date().toISOString());

  const markets = await fetchGnosis();

  const normalized = markets.map(m => {
    const prices = (m.outcomeTokenMarginalPrices ?? []).map((p, i) => ({
      outcome: (m.question?.outcomes ?? [])[i] ?? `Outcome ${i}`,
      price:   parseFloat(p),
    }));
    return {
      id:          m.id,
      title:       m.question?.title ?? 'Unknown',
      outcomes:    m.question?.outcomes ?? [],
      prices,
      volume:      parseFloat(m.collateralVolume || '0'),
      dailyVolume: parseFloat(m.runningDailyVolume || '0'),
      resolvesAt:  m.resolutionTimestamp ? new Date(parseInt(m.resolutionTimestamp) * 1000).toISOString() : null,
      createdAt:   m.creationTimestamp   ? new Date(parseInt(m.creationTimestamp) * 1000).toISOString() : null,
      url:         `https://omen.eth.limo/#/${m.id}`,
    };
  });

  const out = {
    fetchedAt: Date.now(),
    total:     normalized.length,
    markets:   normalized,
  };

  try {
    fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
    console.log(`[gnosis] saved ${normalized.length} markets → ${OUT_FILE}`);
  } catch (e) {
    console.error('[gnosis] write failed:', e.message);
  }
}

async function tick() {
  try { await run(); } catch (e) { console.error('[gnosis] error:', e.message); }
  setTimeout(tick, INTERVAL_MS);
}

tick();
