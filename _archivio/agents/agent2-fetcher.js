#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const { atomicWriteJson } = require('../lib/atomicJsonWrite');
const https = require('https');
const http  = require('http');
const { httpGet } = require('../lib/httpGet');

const OUT          = '/tmp/markets-raw.json';
const ODDS_OUT     = '/tmp/odds-api-raw.json';
const HB_FILE      = '/tmp/agent-heartbeats.json';
const INTERVAL     = 60_000;
const ODDS_INTERVAL = 6 * 60 * 60 * 1000; // 6 h — ~4×/day, preserves monthly quota

// ── OddsAPI quota safety ──────────────────────────────────────────────────────
// Live fetch is DISABLED by default — set ODDS_API_LIVE=1 to enable.
// The free tier (500 req/month) burns out in <9h at the old 5-min cadence.
// When enabled, fetch at most 4× per day (every 6 h).
const ODDS_API_LIVE  = process.env.ODDS_API_LIVE === '1';
const ODDS_API_KEY   = process.env.ODDS_API_KEY || '';
const ODDS_SNAPSHOT  = '/tmp/odds-snapshot.json'; // offline cache; calculator prefers this
const ODDS_LOW_QUOTA = 20; // stop live fetching when fewer than this many requests remain
const ODDS_SPORTS    = [
  'soccer_fifa_world_cup',
  'americanfootball_nfl',
  'baseball_mlb',
  'basketball_nba',
  'tennis_atp_french_open',
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function beat(name) {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb[name] = Date.now();
  atomicWriteJson(HB_FILE, hb, { pretty: true });
}

// Resolve parsed JSON, or null on ANY failure (network error, non-JSON body,
// or wall-clock timeout). Uses the shared lib/httpGet.js hard wall-clock
// deadline instead of the old { timeout } + req.on('timeout') pattern, which
// only fires on socket INACTIVITY and can hang forever when a server trickles
// slow keep-alive chunks. The null-on-failure contract is preserved so callers
// and the produced data shape are unchanged — httpGet rejects, we swallow it.
function fetchJson(url) {
  return httpGet(url, { timeoutMs: 15000, headers: { 'User-Agent': 'prediction-arb-scanner/1.0' } })
    .then(r => r.data)
    .catch(() => null);
}

// Fetch one OddsAPI URL and return { data, remaining, used, status }
function fetchOddsRaw(url) {
  return new Promise(resolve => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'prediction-arb-scanner/1.0' }, timeout: 15000 }, res => {
      const remaining = parseInt(res.headers['x-requests-remaining'] ?? '-1', 10);
      const used      = parseInt(res.headers['x-requests-used']      ?? '-1', 10);
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ data: JSON.parse(body), remaining, used, status: res.statusCode }); }
        catch { resolve({ data: null, remaining, used, status: res.statusCode }); }
      });
    });
    req.on('error', () => resolve({ data: null, remaining: -1, used: -1, status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ data: null, remaining: -1, used: -1, status: 0 }); });
  });
}

async function fetchOddsApi() {
  if (!ODDS_API_LIVE) {
    console.log('[fetcher] odds-api: ODDS_API_LIVE not set — skipping live fetch (quota guard)');
    return;
  }

  // Serve offline snapshot if it exists and is fresh enough
  if (fs.existsSync(ODDS_SNAPSHOT)) {
    try {
      const snap    = JSON.parse(fs.readFileSync(ODDS_SNAPSHOT, 'utf8'));
      const snapAge = Date.now() - (snap.fetchedAt || 0);
      if (snapAge < ODDS_INTERVAL && Array.isArray(snap.events) && snap.events.length > 0) {
        console.log(`[fetcher] odds-api: using snapshot (${Math.round(snapAge / 60000)}m old, ${snap.events.length} events)`);
        fs.writeFileSync(ODDS_OUT, JSON.stringify(snap, null, 2));
        return;
      }
    } catch {}
  }

  console.log('[fetcher] odds-api: fetching live...');
  const results = [];
  let quotaOk = true;

  for (const sport of ODDS_SPORTS) {
    const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`;
    const { data, remaining, used, status } = await fetchOddsRaw(url);

    if (status === 429) {
      console.log('[fetcher] odds-api: 429 rate-limited — stopping, not overwriting file');
      quotaOk = false;
      break;
    }
    if (status === 401) {
      console.log('[fetcher] odds-api: 401 unauthorized — check API key');
      quotaOk = false;
      break;
    }
    if (remaining >= 0) {
      console.log(`[fetcher] odds-api [${sport}]: remaining=${remaining} used=${used}`);
      if (remaining <= ODDS_LOW_QUOTA) {
        console.log(`[fetcher] odds-api: quota low (${remaining} left) — stopping to preserve reserve`);
        quotaOk = false;
        break;
      }
    }
    if (Array.isArray(data)) results.push(...data);
    await sleep(500);
  }

  if (!results.length) {
    console.log('[fetcher] odds-api: 0 events returned — not overwriting existing file');
    return;
  }

  const out = { fetchedAt: Date.now(), events: results };
  fs.writeFileSync(ODDS_OUT,      JSON.stringify(out, null, 2));
  fs.writeFileSync(ODDS_SNAPSHOT, JSON.stringify(out, null, 2)); // update offline cache
  console.log(`[fetcher] odds-api saved — ${results.length} events (quotaOk=${quotaOk})`);
}

function kalshiPageToMarkets(eventsData) {
  const markets = [];
  for (const ev of (eventsData?.events || [])) {
    for (const m of (ev.markets || [])) {
      const bid = parseFloat(m.yes_bid_dollars || '0');
      const ask = parseFloat(m.yes_ask_dollars || '0');
      if (bid <= 0 && ask <= 0) continue;
      markets.push({
        ticker:          m.ticker,
        title:           ev.title || '',
        yes_bid_dollars: m.yes_bid_dollars,
        yes_ask_dollars: m.yes_ask_dollars,
        // Kalshi's own human-readable outcome name (e.g. "Mark Cuban" for ticker
        // suffix "MC") — lets the matcher's same-event gate resolve real identity
        // instead of pattern-matching the short ticker code. See shared-matcher.js.
        yes_sub_title:   m.yes_sub_title || '',
        // When this market resolves — semantically the same as Polymarket's endDate
        // (matches the "before <date>" wording in the question). expiration_time is
        // a settlement-buffer fallback for the rare market missing close_time.
        close_time:      m.close_time || m.expiration_time || m.latest_expiration_time || null,
        // Total traded volume in CONTRACTS (Kalshi exposes no dollar_volume field) —
        // never converted to a dollar figure here since each contract's price varies
        // trade to trade; see shared-matcher.js's volumeNative handling.
        volume:          m.volume_fp ?? null,
      });
    }
  }
  return markets;
}

async function fetchKalshiPaginated() {
  const all = [];
  let cursor = null;
  let page   = 0;
  const MAX_PAGES = 60;

  while (page < MAX_PAGES) {
    let url = 'https://api.elections.kalshi.com/trade-api/v2/events?limit=200&status=open&with_nested_markets=true';
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
    const data = await fetchJson(url);
    if (!data || !Array.isArray(data.events) || !data.events.length) break;
    all.push(...kalshiPageToMarkets(data));
    cursor = data.cursor || '';
    page++;
    if (!cursor || !data.events.length) break;
    await sleep(150);
  }

  console.log(`[fetcher] kalshi: ${page} pages, ${all.length} priced markets`);
  return all;
}

// ── Polymarket tag-based sport event discovery ────────────────────────────

const SPORT_TAG_KW = [
  'world-cup','nfl','nba','nhl','mlb','soccer','football','basketball',
  'baseball','hockey','tennis','boxing','ufc','mma','golf','cricket',
  'rugby','olympics','formula-one','motorsports','cycling','swimming',
  'athletics','volleyball','esport','chess',
];

// Slugs known to exist but not reliably returned by the /tags paginator
const MUST_INCLUDE_SLUGS = ['world-cup'];

async function discoverSportTagSlugs() {
  const slugs = [...MUST_INCLUDE_SLUGS];
  for (let offset = 0; offset < 600; offset += 100) {
    const data = await fetchJson(`https://gamma-api.polymarket.com/tags?limit=100&offset=${offset}`);
    if (!Array.isArray(data) || !data.length) break;
    for (const t of data) {
      const slug = (t.slug || t.id || '').toLowerCase();
      if (SPORT_TAG_KW.some(k => slug.includes(k))) slugs.push(t.slug || t.id);
    }
    if (data.length < 100) break;
    await sleep(100);
  }
  return [...new Set(slugs)];
}

async function fetchPolymarketTagEvents(sportSlugs) {
  const byId = new Map();
  for (const slug of sportSlugs) {
    let offset = 0;
    while (true) {
      const data = await fetchJson(
        `https://gamma-api.polymarket.com/events?active=true&limit=50&offset=${offset}&tag_slug=${slug}`
      );
      const events = Array.isArray(data) ? data : [];
      if (!events.length) break;
      for (const ev of events) {
        for (const m of (ev.markets || [])) {
          const id = String(m.id || m.conditionId || m.questionID || '');
          if (id) byId.set(id, m);
        }
      }
      if (events.length < 50) break;
      offset += 50;
      await sleep(100);
    }
  }
  return [...byId.values()];
}

// Last-good value per source. When a source fails a cycle we reuse the previous
// cycle's REAL value rather than fabricating or blanking it. Seeded from the
// existing output file so a process restart mid-outage doesn't wipe good data.
const lastGood = { kalshi: [], predictit: [], manifold: [], pmBase: [], polymarket: [] };
try {
  const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  if (Array.isArray(prev.kalshi)    && prev.kalshi.length)    lastGood.kalshi    = prev.kalshi;
  if (Array.isArray(prev.predictit) && prev.predictit.length) lastGood.predictit = prev.predictit;
  if (Array.isArray(prev.manifold)  && prev.manifold.length)  lastGood.manifold  = prev.manifold;
  if (Array.isArray(prev.polymarket) && prev.polymarket.length) {
    lastGood.polymarket = prev.polymarket;
    lastGood.pmBase     = prev.polymarket;
  }
} catch {}

// Resolve one settled source: on a fulfilled non-empty array, adopt it as the
// new last-good; on a rejection or empty/soft-failed result, log and reuse the
// last-good value (never fabricated). This keeps every successful source's data
// while ensuring one failing venue can't reject the batch and crash the process.
function resolveSource(settled, key, label, extract) {
  if (settled.status === 'rejected') {
    console.log(`[fetcher] ${label}: fetch rejected (${settled.reason?.message || settled.reason}) — reusing last good (${lastGood[key].length})`);
    return lastGood[key];
  }
  const arr = extract(settled.value);
  if (Array.isArray(arr) && arr.length) { lastGood[key] = arr; return arr; }
  console.log(`[fetcher] ${label}: no fresh data this cycle — reusing last good (${lastGood[key].length})`);
  return lastGood[key];
}

async function fetchAll() {
  console.log('[fetcher] fetching all platforms...');

  // Each source runs concurrently but INDEPENDENTLY. Previously a single venue's
  // rejection inside Promise.all escaped fetchAll(), crashed the process, and
  // made PM2 restart agent2 hundreds of times. allSettled + per-source last-good
  // fallback keeps every good source and never lets one failure kill the batch.
  const [kaS, piS, mfS, pmS] = await Promise.allSettled([
    fetchKalshiPaginated(),
    fetchJson('https://www.predictit.org/api/marketdata/all/'),
    fetchJson('https://api.manifold.markets/v0/markets?limit=100&sort=last-bet-time&order=desc'),
    fetchJson('https://gamma-api.polymarket.com/markets?active=true&limit=200'),
  ]);

  const kalshiMarkets = resolveSource(kaS, 'kalshi',    'kalshi',          v => v);
  const piMarkets     = resolveSource(piS, 'predictit', 'predictit',       v => v?.markets);
  const mfMarkets     = resolveSource(mfS, 'manifold',  'manifold',        v => v);
  const pmBase        = resolveSource(pmS, 'pmBase',    'polymarket-base', v => v);

  // Polymarket: merge volume-sorted base with tag-discovered sport events.
  // Tag discovery is best-effort — a failure here must not reject the cycle.
  const pmById = new Map(pmBase.map(m => [String(m.id || m.conditionId || ''), m]));

  let sportSlugs = [], tagMarkets = [], tagAdded = 0;
  try {
    sportSlugs = await discoverSportTagSlugs();
    tagMarkets = await fetchPolymarketTagEvents(sportSlugs);
  } catch (e) {
    console.log(`[fetcher] polymarket tag discovery failed (${e?.message || e}) — using base only`);
  }
  for (const m of tagMarkets) {
    const id = String(m.id || m.conditionId || m.questionID || '');
    if (id && !pmById.has(id)) { pmById.set(id, m); tagAdded++; }
  }
  let polymarketAll = [...pmById.values()];
  if (polymarketAll.length) {
    lastGood.polymarket = polymarketAll;
  } else {
    polymarketAll = lastGood.polymarket;
    console.log(`[fetcher] polymarket: empty after merge — reusing last good (${polymarketAll.length})`);
  }
  console.log(`[fetcher] polymarket: ${pmBase.length} base + ${tagAdded} tag-added (${sportSlugs.length} slugs) = ${polymarketAll.length} total`);

  const result = {
    fetchedAt: Date.now(),
    predictit:  piMarkets,
    manifold:   mfMarkets,
    kalshi:     kalshiMarkets,
    polymarket: polymarketAll,
  };

  // ATOMIC write (tmp + fsync + rename): markets-raw.json is a 96MB file rewritten every cycle while
  // agent5-calculator, /api/prediction and matcher-v2 read it concurrently. A plain writeFileSync
  // truncates-then-writes, so a reader can catch a half-written file → JSON.parse throws mid-file (seen:
  // "Expected double-quoted property name at position …"). That torn read now also drops the live
  // Polymarket fee-SSOT token lookups, so serialize the write. Same helper already used for HB_FILE.
  atomicWriteJson(OUT, result, { pretty: true });
  beat('fetcher');

  console.log(`[fetcher] saved — PI:${result.predictit.length} MF:${result.manifold.length} KA:${result.kalshi.length} PM:${result.polymarket.length}`);
}

// Guard the whole cycle: any unexpected throw (e.g. a failed disk write) is
// logged and swallowed so the process survives and retries next interval,
// instead of surfacing as an unhandled rejection that crashes agent2.
async function runCycle() {
  try { await fetchAll(); }
  catch (e) { console.error('[fetcher] cycle error (skipped, retry next interval):', e?.message || e); }
}

runCycle();
setInterval(runCycle, INTERVAL);
// OddsAPI: only run when explicitly enabled (ODDS_API_LIVE=1) to protect monthly quota
if (ODDS_API_LIVE) {
  const runOdds = () => fetchOddsApi().catch(e => console.error('[fetcher] odds-api cycle error (skipped):', e?.message || e));
  runOdds();
  setInterval(runOdds, ODDS_INTERVAL);
} else {
  console.log('[fetcher] odds-api live fetch disabled (set ODDS_API_LIVE=1 to enable)');
}
