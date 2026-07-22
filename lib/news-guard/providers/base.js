'use strict';
// lib/news-guard/providers/base.js — shared plumbing for every NewsProvider.
//
// A NewsProvider is a small object:
//   { id, kind, enabled(env), rateLimit:{minIntervalMs}, timeoutMs, fetch({sinceTs, queries, ua}) → NewsItem[] }
//
// This module gives every provider:
//   • fetchText / fetchJson — hardened HTTP (wall-clock timeout, redirect follow, gzip/deflate decode,
//                             identifying User-Agent). No provider talks to the network any other way.
//   • makeItem            — the ONE NewsItem factory, so every provider emits the identical shape:
//                             { id, source, publisher, publishedTs, fetchedTs, title, summary, url, lang, rawTerms }
//   • ProviderBreaker     — per-provider circuit breaker + health telemetry (last success, consecutive
//                             failures, items returned, open/closed). One dead source can never stall the
//                             others: the registry runs providers independently and a tripped breaker
//                             short-circuits to [] with a recorded reason, never a throw into the loop.
//
// HONEST-ENGINE: a provider that fails, times out, or is breaker-disabled returns ZERO items and its
// health telemetry says so. It NEVER returns a fabricated or stale item to look "covered". Missing = —.
//
// This module is pure Node (https/http/zlib) + no project deps, so the measurement script and the agent
// import the exact same fetch + breaker logic.

const https = require('https');
const http  = require('http');
const zlib  = require('zlib');

// One identifying UA for the whole guard. Providers may override, but this is the honest default:
// names the tool + a contact, per every source's stated etiquette for automated clients.
const DEFAULT_UA = 'EdgeradarNewsGuard/1.0 (+https://edgeradar.app; prediction-market news-guard; contact gasparatodiego@gmail.com)';

// ── hardened HTTP text fetch: wall-clock deadline, redirect follow, gzip/deflate decode ──────────
function fetchText(url, { timeoutMs = 12_000, headers = {}, ua = DEFAULT_UA, maxRedirects = 4 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false, res, req, deadline;
    const settle = (fn, v) => { if (settled) return; settled = true; clearTimeout(deadline); try { req && req.destroy(); } catch {} try { res && res.destroy(); } catch {} fn(v); };
    const lib = url.startsWith('http:') ? http : https;
    const reqHeaders = {
      'User-Agent': ua,
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, text/html;q=0.8, */*;q=0.5',
      'Accept-Encoding': 'gzip, deflate',
      ...headers,
    };
    try {
      req = lib.get(url, { headers: reqHeaders }, r => {
        res = r;
        // follow one hop of 3xx (bounded by maxRedirects) — CoinDesk etc. 301/308 to their real feed.
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && maxRedirects > 0) {
          const next = new URL(r.headers.location, url).toString();
          settle(resolve, null);   // release this socket, then chase the redirect fresh
          return fetchText(next, { timeoutMs, headers, ua, maxRedirects: maxRedirects - 1 }).then(resolve, reject);
        }
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => {
          let buf = Buffer.concat(chunks);
          const enc = (r.headers['content-encoding'] || '').toLowerCase();
          try {
            if (enc === 'gzip') buf = zlib.gunzipSync(buf);
            else if (enc === 'deflate') buf = zlib.inflateSync(buf);
          } catch { /* fall through with raw buffer — parser will simply find nothing */ }
          settle(resolve, { status: r.statusCode, headers: r.headers, body: buf.toString('utf8'), finalUrl: url });
        });
        r.on('error', e => settle(reject, e));
      });
      deadline = setTimeout(() => settle(reject, new Error('wall-clock timeout')), timeoutMs);
      req.on('error', e => settle(reject, e));
    } catch (e) { settle(reject, e); }
  });
}

async function fetchJson(url, opts = {}) {
  const r = await fetchText(url, opts);
  if (!r) throw new Error('empty response');
  if (r.status !== 200) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
  return JSON.parse(r.body);
}

// ── NewsItem factory — the single canonical shape every provider emits ───────────────────────────
// rawTerms is a lowercased token list from title+summary, used by the matcher (never generic keywords
// invented here — just the item's own words). publisher is the outlet/domain, used for corroboration
// so two providers relaying the SAME outlet's story don't count as two independent sources.
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}
function tokenize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
}
function makeItem({ source, publisher, publishedTs, fetchedTs, title, summary, url, lang }) {
  const t = (title || '').trim();
  const sum = (summary || '').trim();
  const pub = publisher || hostOf(url) || source;
  return {
    // stable id for cross-provider dedup: canonical URL if we have one, else source+title hash-ish.
    id: canonicalUrl(url) || `${source}:${t.slice(0, 80)}`,
    source,                         // provider family id: 'google-news' | 'rss' | 'reddit' | 'bluesky'
    publisher: pub,                 // outlet/domain — the unit of "distinct source" for corroboration
    publishedTs: Number.isFinite(publishedTs) ? publishedTs : null,
    fetchedTs: Number.isFinite(fetchedTs) ? fetchedTs : null,
    title: t,
    summary: sum.slice(0, 400),
    url: url || null,
    lang: lang || null,
    rawTerms: tokenize(`${t} ${sum}`),
  };
}

// Canonicalise a URL for dedup: strip protocol variance, trailing slash, tracking params, fragments.
function canonicalUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    u.hash = '';
    // drop tracking / session params that vary the same story across providers
    const drop = [];
    for (const [k] of u.searchParams) if (/^(utm_|ref|ref_src|ref_url|guccounter|cmpid|smid|partner|__twitter|at_)/i.test(k) || k === 'fbclid' || k === 'gclid') drop.push(k);
    for (const k of drop) u.searchParams.delete(k);
    let s = `${u.hostname.replace(/^www\./, '')}${u.pathname}`.replace(/\/+$/, '');
    const q = u.searchParams.toString();
    return (s + (q ? `?${q}` : '')).toLowerCase();
  } catch { return null; }
}

// ── Per-provider circuit breaker + health telemetry ──────────────────────────────────────────────
// Trips OPEN after `failThreshold` consecutive failures; stays open for `cooldownMs`, then half-opens
// (one trial allowed). A success closes it. State is serialisable so it survives a restart via the
// agent state file — a source flapping across restarts stays visibly disabled instead of silently
// retrying every cycle.
const DEFAULT_FAIL_THRESHOLD = 3;
const DEFAULT_BREAKER_COOLDOWN_MS = 30 * 60_000;   // 30 min disabled after tripping

function newHealth() {
  return { lastSuccessTs: null, lastFailureTs: null, lastError: null, consecutiveFailures: 0, itemsLastFetch: 0, totalItems: 0, breakerOpen: false, breakerUntil: 0, calls: 0, failures: 0 };
}

function breakerAllows(health, now) {
  if (!health.breakerOpen) return true;
  if (now >= health.breakerUntil) { health.breakerOpen = false; return true; }   // half-open trial
  return false;
}

function recordSuccess(health, itemCount, now) {
  health.calls++;
  health.lastSuccessTs = now;
  health.consecutiveFailures = 0;
  health.itemsLastFetch = itemCount;
  health.totalItems += itemCount;
  health.breakerOpen = false;
  health.breakerUntil = 0;
  health.lastError = null;
}

function recordFailure(health, err, now, { failThreshold = DEFAULT_FAIL_THRESHOLD, cooldownMs = DEFAULT_BREAKER_COOLDOWN_MS } = {}) {
  health.calls++;
  health.failures++;
  health.lastFailureTs = now;
  health.consecutiveFailures++;
  health.itemsLastFetch = 0;
  health.lastError = (err && err.message ? err.message : String(err)).slice(0, 160);
  if (health.consecutiveFailures >= failThreshold) {
    health.breakerOpen = true;
    health.breakerUntil = now + cooldownMs;
  }
}

module.exports = {
  DEFAULT_UA, fetchText, fetchJson, makeItem, canonicalUrl, hostOf, tokenize,
  newHealth, breakerAllows, recordSuccess, recordFailure,
  DEFAULT_FAIL_THRESHOLD, DEFAULT_BREAKER_COOLDOWN_MS,
};
