'use strict';
// lib/news-guard/providers/bluesky.js — Bluesky public AT Protocol search (free, no key).
//
// Uses the PUBLIC AppView searchPosts XRPC. Probed live: public.api.bsky.app/searchPosts → 403, but
// api.bsky.app/searchPosts → 200 with real posts. We use the host that actually serves it, and record
// that fact rather than assuming the "documented" host. No auth, no key, no cost.
//
// CORROBORATION IDENTITY: publisher is always 'bluesky' — social chatter is ONE source. It can be at
// most one of the N distinct sources needed to lift severity, and never corroborates to HIGH alone.
//
// DEFAULT OFF (measured, honest): in the Phase-5 live window Bluesky fetched 111 items and matched 65
// markets on entities, but contributed to only 1 corroborated lift — because as a single 'bluesky'
// publisher it can never corroborate alone, so its matches mostly produce uncorroborated 'low' noise
// rather than signal. Per the brief ("volume but never corroborates → disable by default"), it ships
// disabled. Re-enable with NG_PROVIDER_BLUESKY=true for a social/breaking cross-check.
//
// Rate limit: Bluesky's unauthenticated public AppView allows ~3000 req / 5 min per IP; we run one
// search per entity-query with a 500 ms gap and a small query cap, far under that.

const { fetchJson, makeItem } = require('./base');

const HOST = 'https://api.bsky.app/xrpc/app.bsky.feed.searchPosts';
const MAX_QUERIES_PER_CYCLE = 30;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function webUrl(post) {
  // at://did/app.bsky.feed.post/<rkey> → https://bsky.app/profile/<handle>/post/<rkey>
  const rkey = (post.uri || '').split('/').pop();
  const handle = post.author?.handle;
  return (rkey && handle) ? `https://bsky.app/profile/${handle}/post/${rkey}` : (post.uri || null);
}

module.exports = {
  id: 'bluesky',
  kind: 'query',
  family: 'bluesky',
  defaultEnabled: false,               // measured: 65 matches / 1 lift → volume without corroboration (see header)
  envFlag: 'NG_PROVIDER_BLUESKY',
  rateLimit: { minIntervalMs: 500 },
  timeoutMs: 10_000,

  async fetch({ queries = [], sinceTs = 0, ua, now = Date.now() } = {}) {
    const out = [];
    const qs = queries.slice(0, MAX_QUERIES_PER_CYCLE);
    for (let i = 0; i < qs.length; i++) {
      const q = qs[i];
      if (!q) continue;
      const url = `${HOST}?q=${encodeURIComponent(q)}&limit=25&sort=latest`;
      let j;
      try { j = await fetchJson(url, { timeoutMs: this.timeoutMs, ua }); }
      catch { j = null; }              // per-query failure isolated
      for (const p of (j?.posts || [])) {
        const rec = p.record || {};
        const ts = rec.createdAt ? Date.parse(rec.createdAt) : NaN;
        if (Number.isFinite(ts) && ts < sinceTs) continue;   // recency bound
        const text = rec.text || '';
        if (!text) continue;
        out.push(makeItem({
          source: 'bluesky', publisher: 'bluesky',
          publishedTs: Number.isFinite(ts) ? ts : null, fetchedTs: now,
          title: text, summary: '', url: webUrl(p),
          lang: Array.isArray(rec.langs) ? rec.langs[0] : null,
        }));
      }
      if (i < qs.length - 1) await sleep(this.rateLimit.minIntervalMs);
    }
    return out;
  },
};
