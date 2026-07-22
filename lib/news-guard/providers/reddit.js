'use strict';
// lib/news-guard/providers/reddit.js — Reddit new/rising, category-mapped (free, DEFAULT OFF).
//
// WHY DEFAULT OFF (measured, honest): Reddit's proper free tier is OAuth app-only (100 req/min per
// registered client, reddit.com/prefs/apps). We hold no app credentials and cannot mint them for €0
// autonomously, so this provider falls back to the PUBLIC syndication feed (old.reddit.com/r/*/.rss).
// That endpoint resolves 200 but, from a datacenter IP without OAuth, Reddit rate-limits it HARD —
// probed live, it returned 429 after a few rapid requests. So left on, it would trip its own breaker
// and add instability, not signal. It is therefore registered but DISABLED by default; enable it only
// with real OAuth creds (set REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET) or accept the 429-prone public path
// explicitly via NG_PROVIDER_REDDIT=true.
//
// CORROBORATION IDENTITY: publisher is always 'reddit' — all subreddits are ONE social source, so
// Reddit chatter can contribute at most one of the N distinct sources needed to lift severity. It can
// never, alone, corroborate a book move to HIGH.
//
// User-Agent: Reddit requires a descriptive UA; we send the guard's identifying UA (names tool + contact).

const { fetchText, fetchJson, makeItem } = require('./base');
const { parseFeed } = require('./parse-feed');

// category → subreddits. Kept small: the point is corroboration, not coverage.
const SUBS = {
  politics: ['politics', 'PoliticalDiscussion'],
  sport:    ['sports', 'nba', 'soccer'],
  crypto:   ['CryptoCurrency', 'Bitcoin'],
};
const ALL_SUBS = [...new Set(Object.values(SUBS).flat())];
const SORTS = ['new', 'rising'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function appToken(ua, timeoutMs) {
  const id = process.env.REDDIT_CLIENT_ID, secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return null;
  // client_credentials (app-only) — the free tier. httpPost isn't used (needs Basic auth + form body).
  const https = require('https');
  const auth = Buffer.from(`${id}:${secret}`).toString('base64');
  const body = 'grant_type=client_credentials';
  return await new Promise((resolve) => {
    let settled = false, req, timer;
    const done = v => { if (!settled) { settled = true; clearTimeout(timer); try { req.destroy(); } catch {} resolve(v); } };
    req = https.request('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'User-Agent': ua },
    }, r => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => { try { done(JSON.parse(Buffer.concat(c).toString()).access_token || null); } catch { done(null); } }); r.on('error', () => done(null)); });
    timer = setTimeout(() => done(null), timeoutMs);
    req.on('error', () => done(null));
    req.write(body); req.end();
  });
}

module.exports = {
  id: 'reddit',
  kind: 'firehose',
  family: 'reddit',
  defaultEnabled: false,               // see header — 429-prone without OAuth creds
  envFlag: 'NG_PROVIDER_REDDIT',
  rateLimit: { minIntervalMs: 2000 },  // conservative: ≥2 s between requests (public feed is IP-rate-limited)
  timeoutMs: 10_000,
  subs: ALL_SUBS,

  async fetch({ sinceTs = 0, ua, now = Date.now() } = {}) {
    const out = [];
    const token = await appToken(ua, this.timeoutMs);          // null → public .rss fallback
    const targets = [];
    for (const sub of ALL_SUBS) for (const sort of SORTS) targets.push({ sub, sort });
    for (let i = 0; i < targets.length; i++) {
      const { sub, sort } = targets[i];
      try {
        if (token) {
          const j = await fetchJson(`https://oauth.reddit.com/r/${sub}/${sort}.json?limit=25`, { timeoutMs: this.timeoutMs, ua, headers: { Authorization: `Bearer ${token}` } });
          for (const c of (j.data?.children || [])) {
            const d = c.data || {};
            const ts = d.created_utc ? d.created_utc * 1000 : null;
            if (ts != null && ts < sinceTs) continue;
            out.push(makeItem({ source: 'reddit', publisher: 'reddit', publishedTs: ts, fetchedTs: now, title: d.title, summary: d.selftext || '', url: `https://www.reddit.com${d.permalink || ''}`, lang: 'en' }));
          }
        } else {
          const r = await fetchText(`https://old.reddit.com/r/${sub}/${sort}/.rss?limit=25`, { timeoutMs: this.timeoutMs, ua });
          if (r && r.status === 200 && r.body) {
            for (const e of parseFeed(r.body)) {
              if (e.publishedTs != null && e.publishedTs < sinceTs) continue;
              if (!e.url) continue;
              out.push(makeItem({ source: 'reddit', publisher: 'reddit', publishedTs: e.publishedTs, fetchedTs: now, title: e.title, summary: e.summary, url: e.url, lang: 'en' }));
            }
          } else if (r && (r.status === 429 || r.status === 403)) {
            throw new Error(`reddit ${r.status} (rate-limited/blocked without OAuth)`);   // trip the breaker honestly
          }
        }
      } catch (e) {
        // Surface a rate-limit as a provider failure so the breaker disables it, rather than silently
        // returning partial data that looks like coverage. Re-throw so the registry records it.
        if (/429|403/.test(e.message)) throw e;
        // other per-target errors are isolated (skip this subreddit, keep going)
      }
      if (i < targets.length - 1) await sleep(this.rateLimit.minIntervalMs);
    }
    return out;
  },
};
