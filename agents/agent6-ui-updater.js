#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const { atomicWriteJson } = require('../lib/atomicJsonWrite');
const http = require('http');

const ARB_FILE = '/tmp/arbitrage-opportunities.json';
const UI_FILE  = '/tmp/ui-data.json';
const HB_FILE  = '/tmp/agent-heartbeats.json';
const INTERVAL = 30_000;

function beat(name) {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb[name] = Date.now();
  atomicWriteJson(HB_FILE, hb, { pretty: true });
}

function pingDashboard() {
  return new Promise(resolve => {
    const req = http.get('http://localhost:3000/api/markets?refresh=1', { timeout: 5000 }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function run() {
  if (!fs.existsSync(ARB_FILE)) {
    console.log('[ui-updater] waiting for arbitrage-opportunities.json...');
    return;
  }

  let arb;
  try { arb = JSON.parse(fs.readFileSync(ARB_FILE, 'utf8')); } catch { return; }

  const age = Date.now() - (arb.updatedAt || 0);
  if (age > 300_000) {
    console.log('[ui-updater] arbitrage data stale (>5m), skipping UI update');
    return;
  }

  // Write confirmed-fresh snapshot for the API to pick up
  fs.writeFileSync(UI_FILE, JSON.stringify({
    refreshedAt:   Date.now(),
    opportunities: arb.opportunities || [],
    stats:         arb.stats || {},
  }, null, 2));

  const status = await pingDashboard();
  console.log(`[ui-updater] dashboard ping → ${status ?? 'no response'} | ${arb.opportunities?.length ?? 0} opps`);

  beat('ui-updater');
}

run();
setInterval(run, INTERVAL);
