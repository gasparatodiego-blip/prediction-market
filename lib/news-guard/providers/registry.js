'use strict';
// lib/news-guard/providers/registry.js — the provider registry + isolated multi-source collect.
//
// Holds the list of NewsProviders, resolves each one's enabled/disabled state from env, and runs them
// all with FULL FAILURE ISOLATION: every provider runs concurrently under a hard wall-clock cap; a
// throw, timeout, or tripped breaker in one provider returns [] for that provider and NEVER rejects the
// collect() call or stalls the others. Per-provider health (last success, consecutive failures, items,
// breaker state) is threaded through a caller-persisted bag so a dead source stays visibly disabled
// across restarts instead of silently retrying every cycle.
//
// Adding/removing/swapping a source is a one-line edit to PROVIDERS here — the signal logic (matching,
// dedup, corroboration, severity) never changes.

const { newHealth, breakerAllows, recordSuccess, recordFailure, DEFAULT_UA } = require('./base');

const PROVIDERS = [
  require('./google-news'),
  require('./rss'),
  require('./reddit'),
  require('./bluesky'),
];

// Env resolution: explicit 'true'/'false' on the provider's envFlag wins; otherwise its defaultEnabled.
function providerEnabled(p, env = process.env) {
  const v = env[p.envFlag];
  if (v === 'true') return true;
  if (v === 'false') return false;
  return !!p.defaultEnabled;
}

// Race a provider's fetch against a hard cap so a hung/blocked source can never stall the agent loop.
function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`provider cap ${ms}ms exceeded (${label})`)), ms); });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// Overall per-provider cap: generous enough for the provider's own internal rate-limited loop
// (google-news ≤40 queries × 1 s, bluesky ≤30 × 0.5 s), but bounded so nothing runs unbounded.
const OVERALL_CAP_MS = 90_000;

/**
 * Fetch from every enabled provider concurrently and pool the raw NewsItems.
 * @param {object} args
 *   queries     string[]  entity queries for query-kind providers (google-news, bluesky)
 *   sinceTs     number    recency floor — providers drop items older than this
 *   now         number    caller clock
 *   healthState object    persisted { providerId: health } bag (mutated in place)
 *   ua          string    identifying User-Agent
 *   env         object    defaults to process.env
 * @returns {Promise<{ items, health, perProvider }>}
 */
async function collect({ queries = [], sinceTs = 0, now = Date.now(), healthState = {}, ua = DEFAULT_UA, env = process.env } = {}) {
  const settled = await Promise.allSettled(PROVIDERS.map(async (p) => {
    const h = healthState[p.id] || (healthState[p.id] = newHealth());
    h.id = p.id; h.kind = p.kind; h.family = p.family;
    if (!providerEnabled(p, env)) { h.disabledByEnv = true; h.itemsLastFetch = 0; return { id: p.id, items: [] }; }
    h.disabledByEnv = false;
    if (!breakerAllows(h, now)) { h.itemsLastFetch = 0; return { id: p.id, items: [], skipped: 'breaker-open' }; }
    try {
      const qForKind = p.kind === 'query' ? queries : [];
      const items = await withTimeout(p.fetch({ queries: qForKind, sinceTs, now, ua }), OVERALL_CAP_MS, p.id);
      recordSuccess(h, items.length, now);
      return { id: p.id, items };
    } catch (e) {
      recordFailure(h, e, now);
      return { id: p.id, items: [], error: h.lastError };
    }
  }));

  const items = [];
  const perProvider = {};
  for (const r of settled) {
    const v = r.status === 'fulfilled' ? r.value : { id: 'unknown', items: [] };
    perProvider[v.id] = { fetched: v.items.length, skipped: v.skipped || null, error: v.error || null };
    for (const it of v.items) items.push(it);
  }
  return { items, health: healthState, perProvider };
}

// Public metadata (for the UI/telemetry + measurement script): what sources exist and their posture.
function providerMeta(env = process.env) {
  return PROVIDERS.map(p => ({
    id: p.id, kind: p.kind, family: p.family,
    enabled: providerEnabled(p, env), defaultEnabled: !!p.defaultEnabled,
    envFlag: p.envFlag, minIntervalMs: p.rateLimit?.minIntervalMs ?? null, timeoutMs: p.timeoutMs ?? null,
  }));
}

module.exports = { PROVIDERS, providerEnabled, providerMeta, collect, withTimeout, OVERALL_CAP_MS };
