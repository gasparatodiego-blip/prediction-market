#!/usr/bin/env node
'use strict';

const fs    = require('fs');
const { atomicWriteJson } = require('../lib/atomicJsonWrite');
const https = require('https');
const http  = require('http');

const OUT_FILE    = '/tmp/metaculus-raw.json';
const HB_FILE     = '/tmp/agent-heartbeats.json';
const INTERVAL_MS = 5 * 60 * 1000;

// Metaculus v3 API — unauthenticated access is limited but try it
// Falls back gracefully to empty result set if blocked
const ENDPOINTS = [
  'https://api.metaculus.com/api/posts/?limit=100&has_group=false',
  'https://www.metaculus.com/api2/questions/?status=open&limit=100&has_group=false',
];

function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb['agent-metaculus'] = Date.now();
  try { atomicWriteJson(HB_FILE, hb, { pretty: true }); } catch {}
}

function get(url) {
  return new Promise(resolve => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'prediction-arb-scanner/1.0', Accept: 'application/json' },
      timeout: 12000,
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          resolve({ _blocked: true, status: res.statusCode });
          return;
        }
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', function () { this.destroy(); resolve(null); });
  });
}

function normalise(raw) {
  if (!raw) return [];
  // v3 API format: { results: [...] }
  if (Array.isArray(raw.results)) {
    return raw.results.map(q => ({
      id:          q.id,
      question:    q.title ?? q.question ?? '',
      probability: q.community_prediction?.full?.q2 ?? null,
      url:         q.page_url ? `https://www.metaculus.com${q.page_url}` : null,
      closeTime:   q.close_time ?? q.scheduled_resolve_time ?? null,
      numForecasts: q.forecasts_count ?? 0,
    })).filter(q => q.question);
  }
  // v2 API format: { results: [...] } with different field names
  if (Array.isArray(raw.results)) {
    return raw.results.map(q => ({
      id:          q.id,
      question:    q.title ?? '',
      probability: q.community_prediction ?? null,
      url:         q.url ?? null,
      closeTime:   q.close_time ?? null,
      numForecasts: q.number_of_predictions ?? 0,
    })).filter(q => q.question);
  }
  return [];
}

async function run() {
  const ts = new Date().toISOString();
  beat();
  console.log(`[metaculus] fetching @ ${ts}`);

  let questions = [];
  let source = 'none';

  for (const url of ENDPOINTS) {
    const data = await get(url);
    if (!data || data._blocked) {
      console.warn(`[metaculus] ${url} → ${data?._blocked ? `blocked (${data.status})` : 'null'}`);
      continue;
    }
    questions = normalise(data);
    if (questions.length) { source = url; break; }
  }

  const out = {
    fetchedAt: Date.now(),
    total:     questions.length,
    source,
    questions,
  };

  try {
    fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
    console.log(`[metaculus] saved ${questions.length} questions (source: ${source}) → ${OUT_FILE}`);
  } catch (e) {
    console.error('[metaculus] write failed:', e.message);
  }
}

async function tick() {
  try { await run(); } catch (e) { console.error('[metaculus] error:', e.message); }
  setTimeout(tick, INTERVAL_MS);
}

tick();
