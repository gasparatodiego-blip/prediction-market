'use strict';
// scripts/rewards-ceiling/lib/fetch.js — minimal public read-only JSON GET with a polite rate limit.
// OFFLINE ANALYSIS: public REST only (Gamma markets, CLOB books). No auth, no key, no writes to any
// venue. Used by the ceiling scripts; touches nothing under agents/ app/ lib/rewardScore.js.

const https = require('https');

const MIN_GAP_MS = 120; // be gentle to the public endpoints
let _last = 0;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function getJson(url, { timeoutMs = 15000, retries = 2 } = {}) {
  const gap = MIN_GAP_MS - (Date.now() - _last);
  if (gap > 0) await sleep(gap);
  _last = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'edgeradar-rewards-ceiling/1.0 (offline analysis, read-only)' } }, (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => {
            try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
            catch (e) { reject(new Error(`bad JSON from ${url}: ${e.message}`)); }
          });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
      });
    } catch (e) {
      if (attempt >= retries) throw e;
      await sleep(400 * (attempt + 1));
    }
  }
}

module.exports = { getJson };
