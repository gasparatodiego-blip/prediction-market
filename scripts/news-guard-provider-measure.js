#!/usr/bin/env node
'use strict';
// scripts/news-guard-provider-measure.js — LIVE per-provider signal-to-noise measurement.
//
// Runs the real provider registry against the live market snapshot for a bounded window and reports,
// per provider: items fetched, items surviving dedup, items that matched a market on entities, and how
// many contributed to a corroborated (news→medium) lift. Computes signal-to-noise per provider and
// prints a keep/drop recommendation. Read-only: touches no venue, sends no order, writes nothing.
//
//   node scripts/news-guard-provider-measure.js [--rounds N] [--gap-seconds S] [--markets M]

const fs = require('fs');
const { collect, providerMeta } = require('../lib/news-guard/providers/registry');
const { DEFAULT_UA } = require('../lib/news-guard/providers/base');
const { entitiesFor, matchItemToMarket } = require('../lib/news-guard/match');
const { dedup } = require('../lib/news-guard/dedup');
const { corroborate, RECENCY_MS } = require('../lib/news-guard/corroborate');

const args = process.argv.slice(2);
const argN = (f, d) => { const i = args.indexOf(f); return i >= 0 ? Number(args[i + 1]) : d; };
const ROUNDS = argN('--rounds', 1);
const GAP_S = argN('--gap-seconds', 0);
const MARKET_CAP = argN('--markets', 320);
const QUERY_TARGET_N = 40;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadMarkets() {
  const snap = JSON.parse(fs.readFileSync('/tmp/liquidity-rewards.json', 'utf8'));
  return (snap.markets || []).slice(0, MARKET_CAP);
}

(async () => {
  const markets = loadMarkets();
  const entByMarket = new Map();
  for (const m of markets) entByMarket.set(m.marketId, entitiesFor({ title: m.title, slug: m.slug, marketSlug: m.marketSlug }));

  // targeted queries (same as the agent)
  const ranked = [...markets].filter(m => m.dailyPool != null).sort((a, b) => (b.dailyPool ?? 0) - (a.dailyPool ?? 0));
  const seen = new Set(); const queries = [];
  for (const m of ranked) { const q = entByMarket.get(m.marketId).query; if (q && !seen.has(q)) { seen.add(q); queries.push(q); } if (queries.length >= QUERY_TARGET_N) break; }

  console.log(`\n=== news-guard provider measurement — ${new Date().toISOString()} ===`);
  console.log(`markets: ${markets.length} | targeted queries: ${queries.length} | rounds: ${ROUNDS} | recency: ${Math.round(RECENCY_MS / 3_600_000)}h\n`);
  console.log('providers:', providerMeta().map(p => `${p.id}[${p.kind}]=${p.enabled ? 'on' : 'off'}`).join('  '));

  const memBefore = process.memoryUsage().rss;
  const t0 = Date.now();

  // Accumulate all items across rounds (dedup handles repeats across rounds too).
  const health = {};
  let allItems = [];
  const perProviderFetched = {};
  for (let r = 0; r < ROUNDS; r++) {
    const now = Date.now();
    const res = await collect({ queries, sinceTs: now - RECENCY_MS, now, healthState: health, ua: DEFAULT_UA });
    for (const [id, s] of Object.entries(res.perProvider)) perProviderFetched[id] = (perProviderFetched[id] || 0) + s.fetched;
    allItems = allItems.concat(res.items);
    if (r < ROUNDS - 1 && GAP_S) { console.log(`  round ${r + 1}/${ROUNDS} done (${res.items.length} items); sleeping ${GAP_S}s`); await sleep(GAP_S * 1000); }
  }
  const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);

  // dedup the pooled items into story clusters
  const { clusters, stats } = dedup(allItems);
  const now = Date.now();

  // per-market corroboration → which clusters contributed to a medium (corroborated) lift
  const liftClusterUrls = new Set();
  let marketsCovered = 0, marketsCorroborated = 0;
  for (const m of markets) {
    const cor = corroborate({ ent: entByMarket.get(m.marketId), clusters, now });
    if (cor.level !== 'unknown') marketsCovered++;
    if (cor.level === 'medium') { marketsCorroborated++; for (const mc of cor.matched) if (mc.url) liftClusterUrls.add(mc.url); }
  }

  // does a cluster match ANY market on entities?
  const clusterMatchesAnyMarket = (c) => {
    for (const it of c.items) for (const m of markets) if (matchItemToMarket(it, entByMarket.get(m.marketId)).matched) return true;
    return false;
  };

  // per-provider attribution over clusters
  const PROV = providerMeta().map(p => p.id);
  const rows = {};
  for (const id of PROV) rows[id] = { fetched: perProviderFetched[id] || 0, clusters: 0, matchedClusters: 0, liftClusters: 0 };
  for (const c of clusters) {
    const matched = clusterMatchesAnyMarket(c);
    const inLift = c.urls.some(u => liftClusterUrls.has(u));
    for (const src of c.sources) { if (!rows[src]) continue; rows[src].clusters++; if (matched) rows[src].matchedClusters++; if (inLift) rows[src].liftClusters++; }
  }

  const memAfter = process.memoryUsage().rss;

  console.log(`\n--- fetched ${allItems.length} raw items in ${elapsedS}s → ${stats.clusters} clusters (dedup rate ${(stats.dedupRate * 100).toFixed(1)}%) ---\n`);
  console.log('provider        fetched  clusters  matched  →lift   S/N(matched/fetched)  recommend');
  const recs = {};
  for (const id of PROV) {
    const x = rows[id];
    const sn = x.fetched ? x.matchedClusters / x.fetched : 0;
    const meta = providerMeta().find(p => p.id === id);
    let rec;
    if (!meta.enabled) rec = 'DISABLED (default/env)';
    else if (x.fetched === 0) rec = 'DROP — 0 items (unreachable/blocked)';
    else if (x.liftClusters > 0) rec = 'KEEP — corroborates real lifts';
    else if (x.matchedClusters > 0) rec = 'KEEP (coverage) — matches, no lift this window';
    else rec = 'DROP-by-default — volume but 0 market matches (noise)';
    recs[id] = rec;
    console.log(`${id.padEnd(14)}  ${String(x.fetched).padStart(6)}  ${String(x.clusters).padStart(8)}  ${String(x.matchedClusters).padStart(7)}  ${String(x.liftClusters).padStart(5)}   ${(sn * 100).toFixed(1).padStart(6)}%              ${rec}`);
  }

  console.log(`\ncoverage: ${marketsCovered}/${markets.length} markets have ≥1 recent matched item (old design: fixed top-30 by pool)`);
  console.log(`corroborated (news→medium): ${marketsCorroborated}/${markets.length} markets had ≥N distinct publishers agree`);
  console.log(`compute: ${elapsedS}s wall for ${ROUNDS} round(s); memory rss ${(memBefore / 1e6).toFixed(1)}MB → ${(memAfter / 1e6).toFixed(1)}MB (Δ ${((memAfter - memBefore) / 1e6).toFixed(1)}MB)`);
  console.log('\nhealth:'); for (const id of PROV) { const h = health[id] || {}; console.log(`  ${id.padEnd(14)} items=${h.itemsLastFetch ?? 0} totalItems=${h.totalItems ?? 0} consecFail=${h.consecutiveFailures ?? 0} breakerOpen=${!!h.breakerOpen} lastErr=${h.lastError || '—'}`); }
  console.log('\nrecommendations:'); for (const id of PROV) console.log(`  ${id.padEnd(14)} → ${recs[id]}`);
  console.log('');
})().catch(e => { console.error('measure failed:', e); process.exit(1); });
