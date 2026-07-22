'use strict';
// lib/news-guard/providers/google-news.js — Google News RSS search (free, no key).
//
// REFACTOR of the original agent27 newsSignal() fetch path into the provider interface. Fetch
// behaviour is unchanged: one RSS search per entity-query, same host/params, same UA discipline.
// What changed lives OUTSIDE this file: it now returns typed NewsItem[] and the volume-spike LEVEL is
// gone — matching + corroboration (Phase 4) decide relevance, not a per-query article count.
//
// Publisher attribution: Google News appends " - <Source>" to every headline and links through a
// news.google.com redirect, so we recover the real outlet from the title suffix — otherwise every
// item would look like the same publisher and corroboration (which counts DISTINCT publishers) would
// be fooled into treating one aggregator as many sources.

const { fetchText, makeItem } = require('./base');
const { parseFeed } = require('./parse-feed');

const HOST = 'https://news.google.com/rss/search';
const MAX_QUERIES_PER_CYCLE = 40;   // bound compute: at most N searches per fetch (1 rps between them)

function splitPublisher(title) {
  // "Some headline about X - Reuters" → { title:'Some headline about X', publisher:'reuters' }
  const i = title.lastIndexOf(' - ');
  if (i > 8 && i > title.length - 40) {
    return { title: title.slice(0, i).trim(), publisher: title.slice(i + 3).trim().toLowerCase() || null };
  }
  return { title, publisher: null };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = {
  id: 'google-news',
  kind: 'query',                       // consumes the matcher's per-market entity queries
  family: 'google-news',
  defaultEnabled: true,                // the original, proven-reachable source
  envFlag: 'NG_PROVIDER_GOOGLE_NEWS',  // set =false to disable
  rateLimit: { minIntervalMs: 1000 },  // ≥1 s between the searches inside one fetch (gentle, matches original NEWS_RPS=1)
  timeoutMs: 12_000,

  // @param queries string[] entity-query strings (from the matcher), already deduped by the caller.
  async fetch({ queries = [], sinceTs = 0, ua, now = Date.now() } = {}) {
    const out = [];
    const qs = queries.slice(0, MAX_QUERIES_PER_CYCLE);
    for (let i = 0; i < qs.length; i++) {
      const q = qs[i];
      if (!q) continue;
      const url = `${HOST}?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
      let r;
      try { r = await fetchText(url, { timeoutMs: this.timeoutMs, ua }); }
      catch { r = null; }              // per-query failure is isolated; other queries still run
      if (r && r.status === 200 && r.body) {
        for (const e of parseFeed(r.body)) {
          if (e.publishedTs != null && e.publishedTs < sinceTs) continue;   // recency bound
          const { title, publisher } = splitPublisher(e.title);
          out.push(makeItem({
            source: 'google-news', publisher: publisher || 'google-news',
            publishedTs: e.publishedTs, fetchedTs: now,
            title, summary: e.summary, url: e.url, lang: 'en',
          }));
        }
      }
      if (i < qs.length - 1) await sleep(this.rateLimit.minIntervalMs);
    }
    return out;
  },
};
