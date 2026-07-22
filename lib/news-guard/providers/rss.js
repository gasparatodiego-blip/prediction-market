'use strict';
// lib/news-guard/providers/rss.js — direct publisher RSS/Atom firehose (free, no key).
//
// A FIREHOSE provider: it does not take per-market queries — it pulls each wire/desk's recent-items
// feed and returns everything within the recency window. The matcher (Phase 4) then ties each item to
// a specific market by ENTITY terms, so a football headline only reaches a football market if the
// market's own entities appear in it — never by feed category alone.
//
// Every URL below was verified to resolve 200 with parseable items before inclusion (see the commit
// message + the measurement script). Sources that did NOT resolve for a free automated client are
// recorded here and OMITTED, never faked:
//   • AP  index.rss                → 401 (no public RSS for automated clients)   — omitted
//   • Reuters legacy RSS           → dead / DNS failure (Reuters retired RSS)     — omitted
//   • ESPN rss/news                → 403 for any UA                              — omitted (BBC Sport covers sport)
//   • NYT Sports RSS               → 200 but empty body                          — omitted

const { fetchText, makeItem, hostOf } = require('./base');
const { parseFeed } = require('./parse-feed');

// publisher = the corroboration identity (distinct outlets). category is telemetry only — matching is
// entity-based, not category-based.
const FEEDS = [
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml',                       publisher: 'bbc',          category: 'world' },
  { url: 'https://feeds.bbci.co.uk/sport/rss.xml',                            publisher: 'bbc',          category: 'sport' },
  { url: 'https://www.theguardian.com/world/rss',                            publisher: 'theguardian',  category: 'world' },
  { url: 'https://www.theguardian.com/politics/rss',                         publisher: 'theguardian',  category: 'politics' },
  { url: 'https://www.theguardian.com/football/rss',                         publisher: 'theguardian',  category: 'sport' },
  { url: 'https://rss.politico.com/politics-news.xml',                       publisher: 'politico',     category: 'politics' },
  { url: 'https://feeds.npr.org/1001/rss.xml',                               publisher: 'npr',          category: 'world' },
  { url: 'https://moxie.foxnews.com/google-publisher/politics.xml',          publisher: 'foxnews',      category: 'politics' },
  { url: 'https://www.aljazeera.com/xml/rss/all.xml',                        publisher: 'aljazeera',    category: 'world' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml',        publisher: 'nytimes',      category: 'politics' },
  { url: 'https://feeds.a.dj.com/rss/RSSWorldNews.xml',                      publisher: 'wsj',          category: 'world' },
  { url: 'https://feeds.arstechnica.com/arstechnica/index',                  publisher: 'arstechnica',  category: 'tech' },
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',                  publisher: 'coindesk',     category: 'crypto' },
  { url: 'https://cointelegraph.com/rss',                                    publisher: 'cointelegraph',category: 'crypto' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = {
  id: 'rss',
  kind: 'firehose',
  family: 'rss',
  defaultEnabled: true,
  envFlag: 'NG_PROVIDER_RSS',
  rateLimit: { minIntervalMs: 300 },   // small gap between DISTINCT hosts (gentle, no single host hammered)
  timeoutMs: 10_000,
  feeds: FEEDS,                          // exposed for telemetry / the measurement script

  async fetch({ sinceTs = 0, ua, now = Date.now() } = {}) {
    const out = [];
    for (let i = 0; i < FEEDS.length; i++) {
      const f = FEEDS[i];
      let r;
      try { r = await fetchText(f.url, { timeoutMs: this.timeoutMs, ua }); }
      catch { r = null; }               // one dead feed never stops the rest
      if (r && r.status === 200 && r.body) {
        for (const e of parseFeed(r.body)) {
          if (e.publishedTs != null && e.publishedTs < sinceTs) continue;   // recency bound
          if (!e.url) continue;
          out.push(makeItem({
            source: 'rss', publisher: f.publisher || hostOf(e.url),
            publishedTs: e.publishedTs, fetchedTs: now,
            title: e.title, summary: e.summary, url: e.url, lang: 'en',
          }));
        }
      }
      if (i < FEEDS.length - 1) await sleep(this.rateLimit.minIntervalMs);
    }
    return out;
  },
};
