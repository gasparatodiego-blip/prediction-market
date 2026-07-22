'use strict';
// lib/news-guard/corroborate.js — turn matched story clusters into a SECONDARY news level for a market.
//
// The rule that makes widened intake safe: a single item from a single source can NEVER lift severity.
// News is elevated to 'medium' only when ≥ N DISTINCT PUBLISHERS carry the story within the recency
// window; otherwise it stays 'low' (covered but uncorroborated) or 'unknown' (—, no recent matched item).
// News NEVER reaches 'high' here — that escalation is reserved for book+news in signal.js — so the
// contract "news alone caps at low; only book + corroborated news reaches high" is preserved.
//
// CHOICE OF N (reported with evidence): N = 2 DISTINCT PUBLISHERS.
//   Evidence — every one of the 5 'medium' readings in the live cache at diagnosis time came from ≤2
//   articles from a SINGLE aggregator (Google News). Requiring 2 distinct PUBLISHERS (not merely 2
//   items, which the same aggregator trivially supplies) removes exactly that failure mode while still
//   firing when an actual event breaks across two independent outlets. We deliberately take the
//   STRICTER of the two options the brief offered ("N distinct sources" vs "N distinct URLs") because
//   the measured failure was many-items-one-source; counting distinct URLs from one outlet would
//   reopen it.
//
// Pure: caller passes `now`. No IO.

const RECENCY_MS = 6 * 3_600_000;      // an item older than 6h cannot contribute (recency bound)
const MIN_DISTINCT_SOURCES = 2;        // N — see header

const { matchItemToMarket } = require('./match');

/**
 * @param {object} args
 *   ent      — entitiesFor(market) result
 *   clusters — dedup() story clusters
 *   now      — epoch ms
 *   params   — optional { recencyMs, minSources }
 * @returns {{ level:'unknown'|'low'|'medium', distinctPublishers:number, distinctClusters:number,
 *             publishers:string[], recencyMs:number, minSources:number, matched:Array, note:string,
 *             recent:number, recentH:number, source:'multi-source-corroboration' }}
 */
function corroborate({ ent, clusters, now, params = {} }) {
  const recencyMs = Number.isFinite(params.recencyMs) ? params.recencyMs : RECENCY_MS;
  const N = Number.isFinite(params.minSources) ? params.minSources : MIN_DISTINCT_SOURCES;

  const matched = [];
  const pubSet = new Set();
  for (const c of (clusters || [])) {
    // recency: the cluster must have a REAL recent timestamp to contribute (null ts ⇒ can't confirm — excluded)
    if (c.latestTs == null || (now - c.latestTs) > recencyMs) continue;
    // cluster matches the market if ANY of its items hits the market's entities
    let hit = null;
    for (const it of c.items) { const m = matchItemToMarket(it, ent); if (m.matched) { hit = m; break; } }
    if (!hit) continue;
    matched.push({ title: c.title, publishers: c.publishers, url: c.urls[0] || null, latestTs: c.latestTs, hits: hit.hits, rule: hit.rule });
    for (const p of c.publishers) pubSet.add(p);
  }

  const distinctPublishers = pubSet.size;
  const distinctClusters = matched.length;
  const recentH = Math.round(recencyMs / 3_600_000);

  let level;
  if (distinctPublishers >= N) level = 'medium';         // corroborated across ≥N outlets → secondary elevated
  else if (distinctClusters >= 1) level = 'low';          // covered but uncorroborated → cannot lift
  else level = 'unknown';                                 // no recent matched item → uncovered ("—"), never "calm"

  const note = level === 'unknown'
    ? 'no recent matched news item — uncovered'
    : `${distinctClusters} matched stor${distinctClusters === 1 ? 'y' : 'ies'} from ${distinctPublishers} distinct publisher${distinctPublishers === 1 ? '' : 's'} in last ${recentH}h (need ${N} to corroborate)`;

  return {
    level,
    distinctPublishers, distinctClusters,
    publishers: [...pubSet],
    recencyMs, minSources: N,
    recent: distinctClusters, recentH,
    matched: matched.slice(0, 6),
    source: 'multi-source-corroboration',
    note,
  };
}

module.exports = { corroborate, RECENCY_MS, MIN_DISTINCT_SOURCES };
