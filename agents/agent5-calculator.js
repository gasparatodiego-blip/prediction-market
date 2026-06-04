#!/usr/bin/env node
'use strict';

const fs       = require('fs');

const MATCH_FILES = [
  { path: '/tmp/matches-politics.json', category: 'politics'    },
  { path: '/tmp/matches-other.json',    category: 'sports/tech/econ' },
  { path: '/tmp/matches-crypto.json',   category: 'crypto/finance'   },
];
const OUT_FILE = '/tmp/arbitrage-opportunities.json';
const HB_FILE       = '/tmp/agent-heartbeats.json';
const INTERVAL      = 45_000;

function beat(name) {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb[name] = Date.now();
  fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2));
}

function calcArb(matches) {
  const results = [];
  for (const m of matches) {
    const a = m.marketA;
    const b = m.marketB;
    if (!a || !b) continue;

    const spread = Math.abs(a.probability - b.probability);
    if (spread < 3) continue;

    const low  = a.probability <= b.probability ? a : b;
    const high = a.probability >  b.probability ? a : b;
    const roi  = low.probability > 0 ? (spread / low.probability) * 100 : 0;
    if (roi > 300 || roi <= 0) continue;

    const earnPer100 = Math.round((roi / 100) * 100 * 10) / 10;

    results.push({
      question:   high.question,
      lowMarket:  { ...low,  platform: low.platform  },
      highMarket: { ...high, platform: high.platform },
      spread:     Math.round(spread * 10) / 10,
      roi:        Math.round(roi * 10) / 10,
      earnPer100,
      confidence: m.confidence || 1,
      category:   m.category || 'unknown',
    });
  }
  return results.sort((a, b) => b.roi - a.roi);
}

function run() {
  let allMatches = [];

  for (const { path, category } of MATCH_FILES) {
    if (!fs.existsSync(path)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path, 'utf8'));
      const age  = Date.now() - (data.updatedAt || 0);
      if (age < 600_000) {
        allMatches = allMatches.concat((data.matches || []).map(m => ({ ...m, category })));
      }
    } catch {}
  }

  const opportunities = calcArb(allMatches).slice(0, 20);
  console.log(`[calculator] ${allMatches.length} matches → ${opportunities.length} arbitrage opportunities`);

  fs.writeFileSync(OUT_FILE, JSON.stringify({
    updatedAt:     Date.now(),
    opportunities,
    stats: {
      total:     opportunities.length,
      bestRoi:   opportunities[0]?.roi ?? 0,
      totalSpread: opportunities.reduce((s, o) => s + o.spread, 0),
    },
  }, null, 2));

  beat('calculator');
}

run();
setInterval(run, INTERVAL);
