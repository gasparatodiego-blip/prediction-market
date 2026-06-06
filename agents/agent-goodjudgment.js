#!/usr/bin/env node
'use strict';

const fs    = require('fs');
const https = require('https');

const OUT_FILE    = '/tmp/goodjudgment-raw.json';
const HB_FILE     = '/tmp/agent-heartbeats.json';
const INTERVAL_MS = 10 * 60 * 1000;

// Good Judgment Open — public question list (no auth required for basic list)
const ENDPOINTS = [
  'https://www.gjopen.com/api/v1/questions?status=active&per_page=100',
  'https://www.gjopen.com/challenges/questions?status=active&per_page=100',
];

function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb['agent-goodjudgment'] = Date.now();
  try { fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2)); } catch {}
}

function get(url) {
  return new Promise(resolve => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 prediction-arb-scanner/1.0',
        'Accept':     'application/json',
      },
      timeout: 20000,
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          console.warn(`[goodjudgment] auth required (${res.statusCode}) at ${url}`);
          resolve({ authRequired: true });
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

async function fetchQuestions() {
  for (const url of ENDPOINTS) {
    const data = await get(url);
    if (!data || data.authRequired || data.notFound) continue;

    const items = Array.isArray(data) ? data : (data.questions ?? data.data ?? data.results ?? []);
    if (items.length) {
      console.log(`[goodjudgment] fetched ${items.length} questions from ${url}`);
      return items;
    }
  }
  return [];
}

async function run() {
  beat();
  console.log('[goodjudgment] fetching @', new Date().toISOString());

  const questions = await fetchQuestions();

  const normalized = questions.map(q => ({
    id:           q.id,
    title:        q.name ?? q.title ?? q.question ?? 'Unknown',
    description:  q.description ?? q.body ?? '',
    probability:  q.probability ?? q.community_prediction ?? null,
    status:       q.status ?? 'active',
    resolution:   q.resolution_criteria ?? '',
    closesAt:     q.close_time ?? q.closes_at ?? q.end_date ?? null,
    forecasters:  q.forecasters_count ?? q.num_forecasters ?? 0,
    url:          q.url ?? (q.id ? `https://www.gjopen.com/questions/${q.id}` : null),
  }));

  const out = {
    fetchedAt:  Date.now(),
    total:      normalized.length,
    questions:  normalized,
    note:       normalized.length === 0 ? 'API may require authentication or URL changed' : undefined,
  };

  try {
    fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
    console.log(`[goodjudgment] saved ${normalized.length} questions → ${OUT_FILE}`);
  } catch (e) {
    console.error('[goodjudgment] write failed:', e.message);
  }
}

async function tick() {
  try { await run(); } catch (e) { console.error('[goodjudgment] error:', e.message); }
  setTimeout(tick, INTERVAL_MS);
}

tick();
