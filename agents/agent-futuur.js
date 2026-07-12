#!/usr/bin/env node
'use strict';

const fs    = require('fs');
const { atomicWriteJson } = require('../lib/atomicJsonWrite');
const https = require('https');

const OUT_FILE    = '/tmp/futuur-raw.json';
const HB_FILE     = '/tmp/agent-heartbeats.json';
const INTERVAL_MS = 5 * 60 * 1000;

const BASE_URL  = 'https://futuur.com/api/v1/questions/';
const PAGE_SIZE = 100;
const MAX_PAGES = 3;

function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb['agent-futuur'] = Date.now();
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
        if (res.statusCode === 401 || res.statusCode === 403) {
          console.warn(`[futuur] auth required (${res.statusCode})`);
          resolve({ authRequired: true, status: res.statusCode });
          return;
        }
        if (res.statusCode === 404) {
          resolve({ notFound: true });
          return;
        }
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', function () { this.destroy(); resolve(null); });
  });
}

async function fetchAll() {
  const results = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url  = `${BASE_URL}?status=open&limit=${PAGE_SIZE}&page=${page}`;
    const data = await get(url);

    if (!data || data.authRequired || data.notFound) {
      if (data?.authRequired) console.warn('[futuur] requires auth — skipping');
      break;
    }

    const items = Array.isArray(data) ? data : (data.results ?? data.questions ?? data.data ?? []);
    if (!items.length) break;
    results.push(...items);
    if (items.length < PAGE_SIZE) break;
  }
  return results;
}

async function run() {
  beat();
  console.log('[futuur] fetching @', new Date().toISOString());

  const markets = await fetchAll();

  const normalized = markets.map(m => ({
    id:          m.id ?? m.slug,
    title:       m.title ?? m.question ?? m.name ?? 'Unknown',
    description: m.description ?? '',
    category:    m.category ?? m.topic ?? '',
    outcomes:    (m.outcomes ?? m.answers ?? []).map((o, i) => ({
      id:    o.id ?? i,
      label: o.name ?? o.label ?? o.title ?? String(o),
      prob:  typeof o.probability === 'number' ? o.probability : null,
    })),
    volume:      m.volume ?? m.total_volume ?? 0,
    endsAt:      m.close_time ?? m.end_time ?? m.resolution_date ?? null,
    url:         m.url ?? (m.slug ? `https://futuur.com/q/${m.slug}` : null),
  }));

  const out = {
    fetchedAt: Date.now(),
    total:     normalized.length,
    markets:   normalized,
  };

  try {
    fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
    console.log(`[futuur] saved ${normalized.length} markets → ${OUT_FILE}`);
  } catch (e) {
    console.error('[futuur] write failed:', e.message);
  }
}

async function tick() {
  try { await run(); } catch (e) { console.error('[futuur] error:', e.message); }
  setTimeout(tick, INTERVAL_MS);
}

tick();
