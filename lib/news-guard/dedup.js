'use strict';
// lib/news-guard/dedup.js — cross-provider deduplication into STORY CLUSTERS.
//
// The same wire story reappears via Google News, the publisher's own RSS, Reddit, and Bluesky. If we
// counted those as four "sources", corroboration would be trivially fooled. Dedup collapses them into
// one story cluster whose DISTINCT-PUBLISHER count is what corroboration actually uses.
//
// Two passes:
//   1. canonical-URL: items whose normalized URL is identical are the same item (their canonical id,
//      set by base.makeItem, already encodes this) → merged, publisher/source sets unioned.
//   2. title-similarity: URL-unique items whose normalized, generic-stripped title token sets have
//      Jaccard ≥ threshold are the same story told by different outlets → one cluster.
//
// Pure: no IO, no clock (caller passes `now` only for the returned span fields). Reports real stats.

const { GENERIC, _norm: norm } = require('./match');

function titleTokens(t) {
  return new Set(norm(t).split(' ').filter(w => w.length > 2 && !GENERIC.has(w)));
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * @param {NewsItem[]} items
 * @param {{ simThreshold?:number }} opts
 * @returns {{ clusters:Array, stats:{ input, urlUnique, clusters, dedupRate } }}
 *   cluster = { items, publishers:string[], sources:string[], urls:string[], title, earliestTs, latestTs, size }
 */
function dedup(items, { simThreshold = 0.6 } = {}) {
  const input = items.length;

  // ── pass 1: canonical-URL / id merge ──
  const byId = new Map();
  for (const it of items) {
    const k = it.id;
    const g = byId.get(k);
    if (!g) byId.set(k, { title: it.title, items: [it], publishers: new Set([it.publisher]), sources: new Set([it.source]), urls: new Set(it.url ? [it.url] : []), earliestTs: it.publishedTs ?? Infinity, latestTs: it.publishedTs ?? -Infinity });
    else { g.items.push(it); g.publishers.add(it.publisher); g.sources.add(it.source); if (it.url) g.urls.add(it.url); if (it.publishedTs != null) { g.earliestTs = Math.min(g.earliestTs, it.publishedTs); g.latestTs = Math.max(g.latestTs, it.publishedTs); } }
  }
  const urlUnique = [...byId.values()].map(g => ({ ...g, toks: titleTokens(g.title) }));

  // ── pass 2: greedy title-similarity clustering ──
  const clusters = [];
  for (const p of urlUnique) {
    let joined = null;
    for (const c of clusters) { if (jaccard(p.toks, c.toks) >= simThreshold) { joined = c; break; } }
    if (joined) {
      joined.items.push(...p.items);
      for (const x of p.publishers) joined.publishers.add(x);
      for (const x of p.sources) joined.sources.add(x);
      for (const x of p.urls) joined.urls.add(x);
      joined.earliestTs = Math.min(joined.earliestTs, p.earliestTs);
      joined.latestTs = Math.max(joined.latestTs, p.latestTs);
    } else {
      clusters.push({ toks: new Set(p.toks), title: p.title, items: [...p.items], publishers: new Set(p.publishers), sources: new Set(p.sources), urls: new Set(p.urls), earliestTs: p.earliestTs, latestTs: p.latestTs });
    }
  }

  const out = clusters.map(c => ({
    items: c.items,
    publishers: [...c.publishers],
    sources: [...c.sources],
    urls: [...c.urls],
    title: c.title,
    earliestTs: Number.isFinite(c.earliestTs) ? c.earliestTs : null,
    latestTs: Number.isFinite(c.latestTs) ? c.latestTs : null,
    size: c.items.length,
  }));

  return {
    clusters: out,
    stats: { input, urlUnique: urlUnique.length, clusters: out.length, dedupRate: input ? Math.round((1 - out.length / input) * 1000) / 1000 : 0 },
  };
}

module.exports = { dedup, _titleTokens: titleTokens, _jaccard: jaccard };
