#!/usr/bin/env node
// agent26-landing-auditor.js — read-only honest-engine GUARDIAN.
//
// NOTE ON THE NAME: this agent no longer audits the landing page. The rule that
// did was removed on 2026-07-17 — every landing check compared a displayed value
// against a recompute from source, and the marketing landing that now serves /
// is a static page of hand-written literals with no source to recompute against.
// The check was undefined, not failing, so it was deleted rather than repaired.
// What remains audits the SERVED FEEDS and the fleet, not any one page. The
// filename is kept so the pm2 process id and its history stay stable.
//
// READ-ONLY on SOURCE · Zero Claude API · never edits producer code, never
// restarts anything, never rewrites/fabricates a value. Every 30 min it:
//   1. Verifies no expired/dead/cap-pinned instrument reached a served feed, and
//      re-derives reward APRs from /tmp + data/*.json to catch sane-but-too-good
//      rows — using the same gating rules the producers exclude by (reused where
//      require()-able, mirrored with a source-of-truth comment where TypeScript).
//   2. Watches the free-tier tab APIs for paid/derived values leaking unredacted,
//      and the fleet for producer-down / pipeline-stale / build-held-back.
//   3. Flags honest-engine invariant violations and sends ONE deduped
//      Telegram alert. Silent when clean (no news = good). Logs every cycle.
//   4. GUARDIAN (rules A–E, lib/guardian-suppress): the DISPLAY-layer
//      suppression is applied by the serve path (every tab route runs
//      applyGuardian). This agent (a) OBSERVES that suppression by watching
//      the dashboard log for `guardian-suppress`/`guardian-CRITICAL` lines —
//      alerting on the >30% mass-suppression guardrail and on suppression
//      spikes — and (b) EMITS the cross-cycle / cross-surface directives the
//      serve path cannot compute alone (rule 5 cashable-swing, rule 6 landing-
//      vs-tab), writing them to /tmp/guardian-directives.json.
//
// The ONLY file the dashboard reads that this agent writes is that directives
// file: a REVERSIBLE, TTL-bounded, display-only channel. It carries no values —
// only {section,rowId,action,rule,reason} suppression requests the shared
// suppressor honors. Deleting it (or a stale/empty write) fully clears any
// directive-driven suppression. It NEVER rewrites or fabricates a number.
'use strict';

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');
const crypto = require('crypto');
const { httpPost: _sharedPost } = require('../lib/httpGet');
const { annualize, roundTripFeeByVenue, netApy30d } = require('../lib/funding-math');
// Shared canonical detectors — the auditor verifies the invariant "no dead/expired
// instrument reaches a served feed" using the SAME definition the producers exclude by.
const { isDeadContract, buildPeerMarks } = require('../lib/contract-liveness');
const { isExpired, parseInstrumentExpiryMs } = require('../lib/instrument-expiry');
// The ONE shared honest-engine suppressor (rules A–E). The serve path applies it to
// every tab; this agent runs the SAME module so what it observes/directs matches
// exactly what the site suppresses. Display-only, never rewrites source.
const { CASHABLE_SWING, SPIKE_MULT, UNIT_SUSPECT_LO, UNIT_SUSPECT_HI, LABELS } = require('../lib/guardian-suppress');
const { atomicWriteJson } = require('../lib/atomicJsonWrite');

// ── Load .env for Telegram creds (pm2 doesn't auto-load project env files) ───
// Same pattern as agents/agent21-copy-watcher.js — do NOT hardcode or commit
// the token; this only reads whatever's already in the gitignored .env files.
// Read every candidate file (don't stop at the first one that merely exists —
// .env.local exists but only carries ODDS_API_KEY; TELEGRAM_* live in .env).
for (const envFile of ['.env.local', '.env']) {
  try {
    const envPath = path.join(__dirname, '..', envFile);
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)="?([^"]*?)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* try next */ }
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';

// ── Config ────────────────────────────────────────────────────────────────
const SCAN_INTERVAL_MS  = 30 * 60_000;
const STARTUP_DELAY_MS  = 10_000;
const FETCH_TIMEOUT_MS  = 15_000;
const ALERT_COOLDOWN_MS = 6 * 3_600_000; // dedupe: same violation set at most once per 6h
const HB_FILE           = '/tmp/agent-heartbeats.json';
const STATE_FILE        = '/tmp/landing-auditor-state.json'; // this agent's own bookkeeping only

const EXCHANGE_FILE       = '/tmp/exchange-prices.json';
const UNI_FILE            = '/tmp/unified-opportunities.json';
const BASIS_FILE          = '/tmp/basis-opportunities.json';
const HISTORY_CACHE_FILE  = '/tmp/funding-history-cache.json';   // agent15 settled ring buffer (rule d input)
const PERP_SPOT_FILE      = '/tmp/perp-spot.json';               // agent28 served perp-spot feed
const DASHBOARD_LOG       = '/root/.pm2/logs/dashboard-out.log'; // where filterSane() writes sanity-reject lines
const SANITY_SPIKE_DELTA  = 25;   // new sanity-reject lines since last cycle beyond this ⇒ producer regression
const SPORTS_FILE         = '/tmp/sports-odds.json';
const ARB_FILE            = '/tmp/arbitrage-opportunities.json';
const POLY_REWARDS_FILE   = '/root/prediction-market/data/liquidity-rewards.json';
// The NORMALIZED feed the rewards board actually serves — the only file carrying rewardScore (refShare,
// refCapital, competitorQ). data/liquidity-rewards.json is agent24's watchlist and has no scores, so a
// share-coherence check pointed at it would silently pass on zero rows.
const POLY_NORMALIZED_FILE = '/tmp/liquidity-rewards.json';
const KALSHI_REWARDS_FILE = '/root/prediction-market/data/kalshi-rewards.json';

// Guardian channel: the serve path logs every suppression here; this agent watches it.
const GUARDIAN_DIRECTIVES_FILE = '/tmp/guardian-directives.json'; // agent26 → serve path (reversible)
const GUARDIAN_DIRECTIVE_TTL_MS = 60 * 60_000; // a cashable-swing/cross-surface directive self-expires after 1h
const API_BASE            = 'http://localhost:3000';

// ── Phase 3 (rules L–N / M / robustness) — the guardian's robustness/uptime report.
// M47/M48/M49 defer to it (and to agent-monitor's real-fleet view) rather than
// re-scanning raw heartbeats — that avoids flagging stale beats from long-dead agents.
const { getGuardianHealth } = require('../lib/guardian-health');

const UNI_STALE_MS    = 10 * 60_000; // matches lib/spread-compute.ts UNI_STALE_MS
const SPORTS_STALE_MS = 7_200_000;   // matches app/page.tsx readLandingStats()

function log(...a) { console.log('[A26]', new Date().toISOString(), ...a); }

// ── Replicated honest-engine helpers ─────────────────────────────────────────
// lib/reward-gating.ts, lib/honest-display.ts and lib/spread-types.ts are
// TypeScript — this repo has no ts-node, and every other agent only
// require()s plain .js lib files (see agents/agent10-binance.js etc.), so
// these can't be imported directly from a plain Node script. Mirrored
// verbatim below; if the source file changes, this block must change too.

const APY_CAP       = 200; // lib/honest-display.ts APY_CAP
// Above this pool share the number stops being a forecast and starts being a statement about how empty
// the book is, so it may only be published WITH its depth qualification.
const SHARE_QUALIFY_THRESHOLD = 0.5;
function kIsWarn(m) { // lib/reward-gating.ts kIsWarn
  if (m.flags.TRAP) return false;
  const p = m.last_price;
  return (p >= 0.80 && p <= 0.90) || (p >= 0.10 && p <= 0.20);
}
function isSaneKalshiMarket(m, capitalKey) { // lib/reward-gating.ts isSaneKalshiMarket
  return (
    !m.flags.TRAP && !kIsWarn(m) &&
    !m.flags.SHORT_BURST && !m.flags.THIN_CAP && !m.flags.BELOW_FLOOR && !m.flags.ONE_SIDED &&
    !!m.levels[capitalKey]?.aboveMin
  );
}
function isSanePolymarketLevel(lv) { // lib/reward-gating.ts isSanePolymarketLevel
  return lv.flags.length === 0;
}

function calcSpreadSizing(s, capital, leverage) { // lib/spread-types.ts calcSpreadSizing
  const N         = capital * leverage / 2;
  const feesUsd   = N * s.totalFeesPct / 100;
  const net30dUsd = N * s.grossApy / 100 * 30 / 365 - feesUsd;
  const netYrUsd  = N * s.netApy30d / 100;
  const dayUsd    = netYrUsd / 365;
  const roc       = capital > 0 ? netYrUsd / capital * 100 : 0;
  return { N, feesUsd, net30dUsd, netYrUsd, dayUsd, roc };
}

function isDex(exchange) { return exchange === 'hyperliquid' || exchange === 'dydx'; } // lib/spread-compute.ts isDex
function liqUsd(data) { return Math.max(data?.openInterestUsd ?? 0, data?.vol24hUsd ?? 0); } // lib/spread-compute.ts liqUsd
function liqTier(usd) { // lib/spread-compute.ts liqTier
  if (usd >= 50_000_000) return 'DEEP';
  if (usd >= 10_000_000) return 'OK';
  if (usd >= 1_000_000)  return 'THIN';
  return 'VERY THIN';
}

// ── Wall-clock-deadline text fetch ───────────────────────────────────────────
// lib/httpGet.js's httpGet() always JSON.parse()s the body, which the HTML
// landing page response is not. This mirrors its settle-once / hard
// wall-clock-deadline fix (see lib/httpGet.js) but resolves raw text.
function fetchText(url, timeoutMs = FETCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let res;
    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req.destroy();
      if (res) res.destroy();
      fn(val);
    };
    let deadline;
    const req = (url.startsWith('http:') ? http : https).get(url, r => {
      res = r;
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => settle(resolve, Buffer.concat(chunks).toString()));
      res.on('error', e => settle(reject, e));
    });
    deadline = setTimeout(() => settle(reject, new Error('wall-clock timeout: ' + url)), timeoutMs);
    req.on('error', e => settle(reject, e));
  });
}

function httpPost(url, body) { return _sharedPost(url, body, { timeoutMs: 15_000 }).then(r => r.data); }

async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    log('Telegram not configured — alert logged only:', text.slice(0, 200));
    return;
  }
  try {
    await httpPost(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID, text, parse_mode: 'HTML',
    });
  } catch (e) {
    log('sendTelegram error:', e.message);
  }
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb['agent26-landing-auditor'] = Date.now();
  try { atomicWriteJson(HB_FILE, hb, { pretty: true }); } catch {}
}

function loadState() {
  return readJsonSafe(STATE_FILE) || { lastAlertHash: null, lastAlertAt: 0, firstCheckDone: false };
}
function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) { log('saveState error:', e.message); }
}

// ── Independent recompute: funding ───────────────────────────────────────────
function recomputeFunding(shortExchangeGuess, longExchangeGuess, coin) {
  const raw = readJsonSafe(EXCHANGE_FILE);
  if (!raw || !raw.futures) return null;
  const shortEx = shortExchangeGuess.toLowerCase();
  const longEx  = longExchangeGuess.toLowerCase();
  const A = raw.futures[shortEx]?.[coin];
  const B = raw.futures[longEx]?.[coin];
  if (!A || !B || typeof A.fundingRate !== 'number' || typeof B.fundingRate !== 'number') return null;

  const annA = annualize(A.fundingRate, A.fundingIntervalHours ?? 8);
  const annB = annualize(B.fundingRate, B.fundingIntervalHours ?? 8);
  // computeSpreads() picks whichever side has the higher annualized rate as short.
  const actualShort = annA >= annB ? shortEx : longEx;
  const actualLong  = annA >= annB ? longEx  : shortEx;

  const grossApy = +(Math.abs(annA - annB)).toFixed(2);
  const totalFeesPct = roundTripFeeByVenue(actualShort, actualLong);
  const net30d = netApy30d(grossApy, totalFeesPct);
  const sizing = calcSpreadSizing({ totalFeesPct, grossApy, netApy30d: net30d }, 1000, 1);
  const dayUsd1k = Math.round(sizing.dayUsd * 100) / 100;

  const shortLiq = liqUsd(A);
  const longLiq  = liqUsd(B);
  const minLiq   = shortLiq > 0 && longLiq > 0 ? Math.min(shortLiq, longLiq) : Math.max(shortLiq, longLiq);
  const tier     = minLiq > 0 ? liqTier(minLiq) : null;
  const thinFlag = tier === 'THIN' || tier === 'VERY THIN';

  let oneLegUnverified = true;
  let depthThin = false;
  const uni = readJsonSafe(UNI_FILE);
  if (uni && Date.now() - (uni.sources?.funding?.updatedAt ?? 0) < UNI_STALE_MS) {
    const key = `${coin}|${[shortEx, longEx].sort().join('|')}`;
    for (const opp of uni.opportunities ?? []) {
      if (opp.type !== 'FUNDING') continue;
      const parts = (opp.id ?? '').split('-');
      if (parts.length !== 4 || parts[0] !== 'funding') continue;
      const [, oCoin, ex1, ex2] = parts;
      if (`${oCoin}|${[ex1, ex2].sort().join('|')}` === key) {
        oneLegUnverified = opp.oneLegUnverified === true;
        depthThin        = opp.depthThin === true;
        break;
      }
    }
  }

  return { dayUsd1k, netApy30d: net30d, expectedSane: !oneLegUnverified && !thinFlag && !depthThin };
}

// ── Phantom-instrument class checks (Phase 4) ──────────────────────────────
// These verify the invariant that NO expired/dead/cap-pinned instrument reaches a
// SERVED feed (not just the landing HTML) — the last backstop if a producer guard
// regresses. Read-only; uses the canonical shared detectors so "dead"/"expired" mean
// exactly what the producers exclude by.
function auditServedFeeds(opts = {}) {
  const violations = [];
  const now = Date.now();
  const basisFile = opts.basisFile || BASIS_FILE;
  const exFile    = opts.exchangeFile || EXCHANGE_FILE;
  const ringFile  = opts.historyFile || HISTORY_CACHE_FILE;
  const uniFile   = opts.uniFile || UNI_FILE;
  const psFile    = opts.perpSpotFile || PERP_SPOT_FILE;

  // (A) expired dated futures in the served basis feed
  const basis = readJsonSafe(basisFile);
  if (basis) {
    for (const o of [...(basis.opportunities || []), ...(basis.backwardation || [])]) {
      if (isExpired(o, now)) {
        violations.push(`EXPIRED INSTRUMENT in served basis feed: ${o.contract || o.instrument || '?'} (expiry ${o.expiry || '?'}) — should be excluded before render`);
      }
    }
  }

  // Which (venue,coin) are dead RIGHT NOW, by the canonical definition.
  const ex      = readJsonSafe(exFile);
  const futures = (ex && ex.futures) || {};
  const ring    = (readJsonSafe(ringFile) || {}).data || {};
  const peer    = buildPeerMarks(futures);
  const deadSet = new Set();
  for (const [v, coins] of Object.entries(futures)) {
    for (const [coin, d] of Object.entries(coins || {})) {
      const res = isDeadContract(v, coin, d, ((ring[v] || {})[coin]) || [], { now, peerMarks: peer[coin] });
      if (res.dead) deadSet.add(`${v}:${coin}`);
    }
  }

  // (B) dead contracts leaking into the served funding feed (unified-opportunities FUNDING).
  //     id shape: funding-<coin>-<shortEx>-<longEx> (coins/venues carry no dashes).
  const uni = readJsonSafe(uniFile);
  if (uni && Array.isArray(uni.opportunities)) {
    for (const o of uni.opportunities) {
      if (o.type !== 'FUNDING') continue;
      const p = String(o.id || '').split('-');
      if (p.length !== 4) continue;
      const [, coin, shortEx, longEx] = p;
      if (deadSet.has(`${shortEx}:${coin}`) || deadSet.has(`${longEx}:${coin}`)) {
        violations.push(`DEAD CONTRACT in served funding feed: ${o.id} references a contract flagged dead/cap-pinned — should be excluded`);
      }
    }
  }

  // (B) dead contracts leaking into the served perp-spot feed.
  const ps = readJsonSafe(psFile);
  if (ps && Array.isArray(ps.rows)) {
    for (const rrow of ps.rows) {
      if (deadSet.has(`${rrow.shortVenue}:${rrow.coin}`)) {
        violations.push(`DEAD CONTRACT in served perp-spot feed: ${rrow.shortVenue}:${rrow.coin} — should be excluded`);
      }
    }
  }

  return violations;
}

// Count sanity-reject lines the dashboard has logged (filterSane emits them). A spike
// SINCE THE LAST CYCLE is a producer-regression signal: many rows suddenly failing the
// render-time net. Returns { total, violations } given the previously-seen total.
function auditSanityRejectSpike(prevSeen, logFile = DASHBOARD_LOG) {
  let total = 0;
  try {
    const buf = fs.readFileSync(logFile, 'utf8');
    total = (buf.match(/sanity-reject /g) || []).length;
  } catch { return { total: prevSeen, violations: [] }; }  // log absent → no signal, don't fabricate
  const violations = [];
  const prev = Number.isFinite(prevSeen) ? prevSeen : total;   // first run: baseline, no alert
  const delta = total - prev;
  if (delta > SANITY_SPIKE_DELTA) {
    violations.push(`SANITY-REJECT SPIKE: ${delta} new render-time rejections since last cycle (>${SANITY_SPIKE_DELTA}) — a producer is emitting phantom rows; check dashboard log`);
  }
  // On log rotation total < prev → treat as reset (baseline re-anchors, no alert).
  return { total, violations };
}

// Too-good-to-be-true scan over the SERVED rewards feed (read-only, detect + alert).
// The estimator (lib/rewards-estimate.ts) now withholds unmeasured/absurd nets, but a
// producer regression could still emit a level that PASSES the sane gate yet implies
// an APR beyond the shared cap (e.g. the qualifyingLiquidity===0 → 100%-share class).
// Anything sane-but-too-good is surfaced here so it alerts on Telegram instead of
// reaching users silently. Never mutates data; never fabricates.
function auditRewardsTooGood() {
  const violations = [];
  const scan = (file, venue, isSane) => {
    const raw = readJsonSafe(file);
    for (const m of raw?.markets ?? []) {
      for (const [capStr, lv] of Object.entries(m.levels ?? {})) {
        if (!lv || lv.dayYieldPct == null) continue;
        if (!isSane(m, lv, capStr)) continue;                 // only flag rows that survive the gate
        const impliedApr = lv.dayYieldPct * 365;
        if (impliedApr > APY_CAP) {
          violations.push(`REWARDS TOO-GOOD: ${venue} "${(m.title || m.slug || m.ticker || '?').slice(0, 40)}" @ $${capStr} passes the sane gate but implies ${impliedApr.toFixed(0)}%/yr (dayYield ${lv.dayYieldPct.toFixed(2)}%) — verify it's real, not an unmeasured-competitor 100%-share artifact`);
        }
      }
    }
  };
  scan(POLY_REWARDS_FILE,   'Polymarket', (m, lv)         => isSanePolymarketLevel({ flags: lv.flags ?? [] }));
  scan(KALSHI_REWARDS_FILE, 'Kalshi',     (m, lv, capStr) => isSaneKalshiMarket(m, capStr));
  violations.push(...auditShareRestatementQualified());
  return violations;
}

// ── COHERENCE: the same thinness that caps the annualised figure must qualify the SHARE ─────────────
// dayYieldPct x 365 and "your pool share" are the SAME underlying number in two units. If the annualised
// form is capped or flagged for being too good while the share form is published bare, the figure has
// simply been laundered through a different unit. A share only means something against the depth it was
// scored on: a $1,000 maker "taking 99% of the pot" in a book holding $618 of qualifying in-band depth
// is not a forecast, it is the observation that the book is empty. The serve path now caps the estimate's
// assumed capital at that depth (lib/reward-price-row: estimateCapitalUsd / capitalCapped / capNote); this
// watches the FEED for rows where the raw share is still published without that qualification.
function auditShareRestatementQualified() {
  const violations = [];
  const binding = [];
  const { competitorDepthUsd } = require('../lib/reward-depth-floor');
  const { estimatedOperatorSharePerDay } = require('../lib/reward-operator-estimate');
  const raw = readJsonSafe(POLY_NORMALIZED_FILE);
  for (const m of raw?.markets ?? []) {
    const rs = m.rewardScore;
    if (!rs || typeof rs.refShare !== 'number' || !Number.isFinite(rs.refShare)) continue;
    if (rs.refShare <= SHARE_QUALIFY_THRESHOLD) continue;
    const title = (m.title || m.slug || '?').slice(0, 40);
    const depth = competitorDepthUsd(m);

    // A share with no measured book behind it is not a forecast at all — it must render "—".
    if (depth == null) {
      violations.push(`SHARE UNQUALIFIED: Polymarket "${title}" publishes a ${(rs.refShare * 100).toFixed(0)}% pool share with NO readable in-band depth — a share scored against an unmeasurable book must render "—", not a number`);
      continue;
    }

    // COHERENCE ACROSS UNITS. The shared serve-path module caps the assumed capital at the measured
    // in-band depth. When that cap binds, the $/day the row leads with MUST be the capped figure: the
    // same thinness that limits the share limits the daily number, and publishing the uncapped one is
    // the capped figure laundered into another unit.
    const capped = estimatedOperatorSharePerDay(rs, { inBandDepthUsd: depth });
    const uncapped = estimatedOperatorSharePerDay(rs);
    if (!capped.capitalCapped) continue;
    const served = Number.isFinite(m.estUsdPerDay) ? m.estUsdPerDay : null;
    if (served != null && Number.isFinite(capped.estUsdPerDay) && served > capped.estUsdPerDay * 1.01) {
      violations.push(`SHARE/YIELD INCOHERENT: Polymarket "${title}" serves $${served.toFixed(2)}/day while the depth-capped estimate is $${capped.estUsdPerDay.toFixed(2)}/day ($${Math.round(depth)} of in-band depth vs $${Math.round(capped.assumedOrderSizeUsd)} assumed) — the share is capped but the daily figure is not, which is the same number laundered through a different unit`);
      continue;
    }
    // The cap binds and nothing contradicts it. That is the expected steady state, not a fault, so it is
    // COUNTED and reported once — an alert per thin market every cycle would be noise, and noise is how
    // a guardian gets muted.
    if (uncapped.estUsdPerDay != null && capped.estUsdPerDay != null && uncapped.estUsdPerDay > capped.estUsdPerDay * 1.05) {
      binding.push(`${title} (${Math.round(depth)}$ depth, $${uncapped.estUsdPerDay.toFixed(2)}→$${capped.estUsdPerDay.toFixed(2)}/day)`);
    }
  }
  if (binding.length) {
    violations.push(`SHARE CAP BINDS (advisory, ${binding.length} rows): the in-band depth cap is materially limiting the served estimate — e.g. ${binding.slice(0, 3).join('; ')}. Served figures must carry the capitalCapped qualification wherever the share or the $/day is shown.`);
  }
  return violations;
}


// ── GUARDIAN: observe the serve-path suppressor + emit cross-cycle directives ──

// The serve path (every tab route) runs lib/guardian-suppress applyGuardian(). It logs
// a "guardian-CRITICAL <section>: …" line ONLY when the >30% mass-suppression guardrail
// fires (rare, meaningful) and per-row "guardian-suppress …" lines only for info-removing
// actions. This agent watches the CRITICAL line — a new one means a tab would have been
// >30% gutted (the serve path KEPT the values and raised it; this surfaces it loudly).
//
// We deliberately do NOT alert on the raw guardian-suppress COUNT: routine relabels
// (e.g. D19 speculative) log per-request, so that count tracks traffic, not violation
// novelty — a delta threshold on it would false-alarm constantly. The CRITICAL line is
// the honest, traffic-independent regression signal. Returns { criticalCount, violations }.
function auditGuardianLog(prevCritical, logFile = DASHBOARD_LOG) {
  let criticalLines = [];
  try {
    criticalLines = fs.readFileSync(logFile, 'utf8').split('\n').filter(l => l.includes('guardian-CRITICAL'));
  } catch { return { criticalCount: prevCritical, violations: [] }; }
  const violations = [];
  const criticalCount = criticalLines.length;
  const prevCrit = Number.isFinite(prevCritical) ? prevCritical : criticalCount;   // first run: baseline, no alert
  if (criticalCount > prevCrit) {
    const latest = criticalLines[criticalLines.length - 1] || '';
    violations.push(`GUARDIAN CRITICAL (mass-suppression guardrail fired): ${latest.replace(/^.*guardian-CRITICAL /, '').slice(0, 300)} — a tab would have been >30% gutted; the serve path KEPT the values (calm) and flagged it. Investigate the producer.`);
  }
  // On log rotation criticalCount < prevCrit → re-anchor, no alert.
  return { criticalCount, violations };
}

// Wall-clock-deadline JSON fetch of a served tab (reuses fetchText's settle-once fix).
async function fetchJson(path) {
  const txt = await fetchText(API_BASE + path);
  return JSON.parse(txt);
}

// The primary headline net per section on a SERVED row. Prefers the guardian's
// snapshotted original (so a value the guardian already suppressed this cycle is still
// compared honestly), else the live served value. Never fabricates.
function servedNet(section, row) {
  const orig = row && row.__guardian && row.__guardian.original;
  const pick = (live, key) => (orig && key in orig ? orig[key] : live);
  switch (section) {
    case 'funding':   return pick(row.netApy30d, 'netApy30d');
    case 'perp-spot': return pick(row.edge ? row.edge.netPerDay1k : null, 'edge.netPerDay1k');
    case 'basis':     return pick(row.netAnnualizedExecutable ?? row.netAnnualized, 'netAnnualizedExecutable');
    default:          return null;
  }
}
function servedRowId(section, row) {
  switch (section) {
    case 'funding':   return `funding-${row.coin}-${row.shortExchange}-${row.longExchange}`;
    case 'perp-spot': return `perp-spot-${row.coin}-${row.shortVenue}`;
    case 'basis':     return `basis-${row.asset}-${row.exchange}-${row.contract}`;
    default:          return null;
  }
}

// ── L44: funding-rate spike. Either leg's CURRENT funding > SPIKE_MULT× its own trailing
// median AND not yet confirmed by >=2 recent settled history points ⇒ a brand-new,
// unverified spike. Reads raw legs from exchange-prices + the agent15 settled ring buffer
// (the SAME sources recomputeFunding uses). Read-only; returns a reason string or null.
function fundingLegSpike(coin, shortEx, longEx) {
  const ex   = readJsonSafe(EXCHANGE_FILE);
  const ring = (readJsonSafe(HISTORY_CACHE_FILE) || {}).data || {};
  const futures = (ex && ex.futures) || {};
  for (const legRaw of [shortEx, longEx]) {
    const leg = String(legRaw || '').toLowerCase();
    const cur = futures[leg]?.[coin]?.fundingRate;
    if (typeof cur !== 'number' || !isFinite(cur)) continue;
    const rates = (((ring[leg] || {})[coin]) || [])
      .map(p => (p && typeof p.rate === 'number' ? Math.abs(p.rate) : null))
      .filter(r => r != null);
    if (rates.length < 3) continue;                       // need a trailing baseline
    const sorted = [...rates].sort((a, b) => a - b);
    const trail  = sorted[Math.floor(sorted.length / 2)]; // median |rate|
    if (!(trail > 1e-9)) continue;
    if (Math.abs(cur) > SPIKE_MULT * trail) {
      const confirmations = rates.filter(r => r > SPIKE_MULT * trail).length;
      if (confirmations < 2) {
        return `${leg} funding ${(cur * 100).toFixed(4)}% is > ${SPIKE_MULT}× its trailing median ${(trail * 100).toFixed(4)}% and unconfirmed (<2 settlements) — held until it stabilizes`;
      }
    }
  }
  return null;
}

// ── L46: suspect UNITS. Compare the served net APY to an independent recompute; a ratio
// in [90,110] is the ×100 unit-error smell (%/8h shown as %/yr, wrong ×100). Suppress +
// alert — never rewrite toward the "corrected" number. Returns a reason string or null.
function fundingUnitSuspect(row, coin) {
  const served = row && row.netApy30d;
  if (typeof served !== 'number' || !isFinite(served)) return null;
  const rec = recomputeFunding(String(row.shortExchange || ''), String(row.longExchange || ''), coin);
  if (!rec || typeof rec.netApy30d !== 'number' || Math.abs(rec.netApy30d) < 1e-6) return null;
  const ratio = Math.abs(served / rec.netApy30d);
  if (ratio >= UNIT_SUSPECT_LO && ratio <= UNIT_SUSPECT_HI) {
    return `served net ${served}%/yr is ~${ratio.toFixed(0)}× the independent recompute ${rec.netApy30d}%/yr — a ×100 unit error smell; suppressing units pending review`;
  }
  return null;
}

// ── M (rules 47–49) + robustness roll-up: system integrity via the guardian health
// report. PM2/agent-monitor already RESTART producers, the dashboard, etc. — this only
// OBSERVES the report and surfaces conditions a human should know about, deferring to
// agent-monitor's REAL-fleet view (health.watchdog.unhealthyAgents) so it never flags
// stale heartbeats from long-dead agents. Deduped by the existing 6h violation cooldown.
function auditSystemIntegrity() {
  const violations = [];
  let health;
  try { health = getGuardianHealth(); }
  catch (e) { log('getGuardianHealth error:', e.message); return violations; }

  // M47 — producers the agent-monitor (real fleet) currently marks unhealthy.
  if (health.watchdog.monitorFresh && Array.isArray(health.watchdog.unhealthyAgents) && health.watchdog.unhealthyAgents.length) {
    violations.push(`PRODUCER(S) DOWN: agent-monitor reports ${health.watchdog.unhealthyAgents.join(', ')} unhealthy — PM2/agent-monitor auto-restarts; verify recovery`);
  }
  // rule 58/59 — dashboard not serving / build gone.
  const dh = health.watchdog.dashboardHttp;
  if (dh && dh.healthy === false) {
    violations.push(`DASHBOARD NOT SERVING: ${dh.detail}${dh.restarted ? ' (auto-restart triggered)' : ''} — site liveness probe failed`);
  }
  if (health.build.buildIdPresent === false) {
    violations.push('DASHBOARD BUILD MISSING: .next/BUILD_ID absent/empty — run scripts/guarded-build.sh (last working build should still serve)');
  }
  // M48 — pipeline stale ⇒ global "dati non aggiornati" banner expected.
  if (health.pipeline.stale) {
    violations.push(`PIPELINE STALE: freshest core feed ${health.pipeline.ageMin == null ? 'missing' : health.pipeline.ageMin + ' min old'} — global "dati non aggiornati" banner + downgrade expected`);
  }
  // rule 68 — a failed build held the deploy back (previous working build still serving).
  if (health.build.deployHeldBack) {
    violations.push('DEPLOY HELD BACK: last build FAILED — dashboard kept the previous working build (rule 68). Fix the build and re-run scripts/guarded-build.sh.');
  }
  return violations;
}

// CROSS-CYCLE rule 5: a cashable value that swings > 50% between two consecutive cycles
// is suppressed until it stabilizes. Only the serve-path CAN'T see across cycles, so this
// agent computes it and writes a reversible, TTL-bounded directive the suppressor honors.
// Returns { directives, curNet } — curNet is carried in state for next cycle's compare.
async function buildGuardianDirectives(state) {
  const now = Date.now();
  const prevNet = (state && state.guardianPrevNet) || {};
  const prevIds = (state && state.guardianPrevIds) || {};
  const curNet = {};
  const curIds = {};
  // One directive per section:rowId (readDirectives keeps the last write per key). Build a
  // map so the strongest rule wins deterministically: L46 units > L44 spike > L45 quarantine
  // > A5 swing (a unit error is the most misleading; a swing is the softest).
  const byKey = new Map();
  const RANK = { L46: 4, L44: 3, L45: 2, A5: 1 };
  const put = (d) => {
    const key = `${d.section}:${d.rowId}`;
    const cur = byKey.get(key);
    if (!cur || (RANK[d.rule] || 0) > (RANK[cur.rule] || 0)) byKey.set(key, d);
  };

  const sections = [];
  try {
    const crypto = await fetchJson('/api/crypto');
    sections.push(['funding',   crypto.spreads || []]);
    sections.push(['perp-spot', crypto.perpSpot || []]);
  } catch (e) { log('guardian directive fetch /api/crypto failed:', e.message); }
  try {
    const carry = await fetchJson('/api/carry');
    sections.push(['basis', [...(carry.opportunities || []), ...(carry.backwardation || [])]]);
  } catch (e) { log('guardian directive fetch /api/carry failed:', e.message); }

  for (const [section, rows] of sections) {
    let top = { id: null, net: -Infinity };            // L45 — the section's current top opportunity
    const seenIds = [];
    for (const row of rows) {
      const id  = servedRowId(section, row);
      const net = servedNet(section, row);
      if (id == null || typeof net !== 'number' || !isFinite(net)) continue;
      const key = `${section}:${id}`;
      curNet[key] = net;
      seenIds.push(id);
      if (net > top.net) top = { id, net };

      // ── L44/L46 (funding only — raw legs + independent recompute available) ──
      if (section === 'funding' && row.coin) {
        const unit = fundingUnitSuspect(row, row.coin);
        if (unit) {
          put({ section, rowId: id, action: 'suppress-value', rule: 'L46',
            label: LABELS.SUSPECT_UNIT, reason: unit, expiresAt: now + GUARDIAN_DIRECTIVE_TTL_MS });
        }
        const spike = fundingLegSpike(row.coin, row.shortExchange, row.longExchange);
        if (spike) {
          put({ section, rowId: id, action: 'suppress-value', rule: 'L44',
            label: LABELS.QUARANTINE, reason: spike, expiresAt: now + GUARDIAN_DIRECTIVE_TTL_MS });
        }
      }

      // ── A5 (cross-cycle swing) ──
      const prev = prevNet[key];
      if (typeof prev === 'number' && isFinite(prev)) {
        const base = Math.max(Math.abs(prev), 1e-9);
        const swing = Math.abs(net - prev) / base;
        if ((Math.abs(prev) > 0.05 || Math.abs(net) > 0.05) && swing > CASHABLE_SWING) {
          put({ section, rowId: id, action: 'suppress-value', rule: 'A5',
            reason: `value swung ${(swing * 100).toFixed(0)}% between cycles (${prev} → ${net}, > ${(CASHABLE_SWING * 100)}%) — suppressed until it stabilizes`,
            expiresAt: now + GUARDIAN_DIRECTIVE_TTL_MS });
        }
      }
    }
    curIds[section] = seenIds;

    // ── L45: the current TOP opportunity was ABSENT last cycle → quarantine until it
    // stabilizes (it appeared from nowhere at #1 — the exact excluded→top-in-one-cycle
    // smell). Only when we HAVE a previous cycle for this section (else every first cycle
    // would quarantine its top). Self-heals: once it persists, it is no longer "new".
    const prevSet = prevIds[section];
    if (top.id != null && Array.isArray(prevSet) && prevSet.length && !prevSet.includes(top.id)) {
      put({ section, rowId: top.id, action: 'suppress-value', rule: 'L45',
        label: LABELS.QUARANTINE,
        reason: `row jumped to the section's top opportunity in one cycle after being absent last cycle — quarantined until it stabilizes`,
        expiresAt: now + GUARDIAN_DIRECTIVE_TTL_MS });
    }
  }

  const directives = Array.from(byKey.values());

  // Always write (even empty) so the file self-heals: once a value stabilizes, its
  // directive is not re-emitted and the suppression clears on the next serve read.
  try {
    atomicWriteJson(GUARDIAN_DIRECTIVES_FILE, { updatedAt: now, directives }, { pretty: true });
  } catch (e) { log('guardian directive write failed:', e.message); }

  return { directives, curNet, curIds };
}

// GUARDIAN rule H (31–33): paid-gating leak audit. This agent hits the tab APIs with NO
// session — i.e. exactly as a FREE-tier browser would — so every DERIVED-edge field the
// paid-gating layer redacts (lib/paid-gating REDACTION_MAP) MUST come back null. Any
// non-null derived value is a paid number leaking to free (a product leak). We DETECT +
// alert here; the serve path's assertRedacted() does the actual display suppression. The
// field list below mirrors the sensitive DERIVED fields in REDACTION_MAP (paid-gating.ts
// is TypeScript — can't require() it from plain Node — so this is the same mirrored-with-a-
// source-comment pattern the rest of this file uses; if REDACTION_MAP changes, update here).
const PAID_LEAK_CHECKS = [
  { path: '/api/crypto',          arrays: [
      { at: 'spreads',  fields: ['grossApy', 'netApy30d', 'totalFeesPct', 'breakevenDays', 'capacityUsd'] },
      { at: 'perpSpot', fields: ['edge.grossPerDay1k', 'edge.netPerDay1k', 'edge.annualizedRunRatePct', 'edge.breakevenDays'] },
      { at: 'usdcArb',  fields: ['edge.grossPerDay1k', 'edge.netPerDay1k', 'edge.netApy30dPct'] },
  ] },
  { path: '/api/carry',           arrays: [
      { at: 'opportunities', fields: ['netAnnualized', 'netAnnualizedExecutable', 'grossAnnualized', 'capacityUsd', 'verdict'] },
      { at: 'backwardation', fields: ['netAnnualized', 'annualized', 'basis'] },
  ] },
  { path: '/api/rewards-unified', arrays: [
      { at: 'markets', fields: ['dailyPool', 'qualifyingLiquidity', 'maxSpread', 'minSize'] },
  ] },
  { path: '/api/sports-snapshot', arrays: [
      { at: 'opportunities', fields: ['roiPct', 'impliedSum'] },
  ] },
  { path: '/api/prediction',      arrays: [
      { at: 'valid', fields: ['roi', 'spread', 'earnPer100', 'confidence'] },
  ] },
];
function getDeep(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
async function auditPaidGatingLeaks() {
  const violations = [];
  for (const check of PAID_LEAK_CHECKS) {
    let payload;
    try { payload = await fetchJson(check.path); }
    catch (e) { log(`paid-leak audit skip ${check.path}: ${e.message}`); continue; } // endpoint down ≠ leak
    for (const spec of check.arrays) {
      const rows = payload && Array.isArray(payload[spec.at]) ? payload[spec.at] : [];
      for (const row of rows) {
        for (const f of spec.fields) {
          const v = getDeep(row, f);
          if (v != null && v !== '') {
            violations.push(`PAID-GATING LEAK: ${check.path} ${spec.at}[].${f} = ${JSON.stringify(v).slice(0, 40)} served NON-redacted to the free tier (no session) — a paid/derived value is leaking. Serve-path assertRedacted() should suppress it; fix the redaction map.`);
            break; // one field per row is enough to flag the row
          }
        }
      }
    }
  }
  return violations;
}

// ── Audit isolation ───────────────────────────────────────────────────────
// Every audit runs inside runAudit(). A throw is caught, counted, logged and
// surfaced as a violation — the remaining audits still run. One audit failing
// degrades to "that audit did not run"; it must never again take the cycle
// down with it. On 2026-07-14 a landing-markup change made parseLandingRows()
// throw on the first line of runCycle(), and every other audit — including the
// free-tier paid-leak check — silently stopped running for 2.6 days.
//
// The catch is deliberately NOT silent: a swallowed error would be worse than
// the crash, because the crash was at least visible. Each failure logs a loud
// line carrying its consecutive-failure count and emits a violation, so a
// persistently broken audit reaches Telegram instead of decaying into silence.
async function runAudit(name, streaks, fn) {
  try {
    const value = await fn();
    if (streaks[name]) {
      log(`AUDIT RECOVERED: ${name} — ran clean after ${streaks[name]} failing cycle(s)`);
      delete streaks[name];
    }
    return { name, ok: true, value };
  } catch (e) {
    const n = (streaks[name] = (streaks[name] || 0) + 1);
    log(`AUDIT FAILED: ${name} — ${e.message} (failing for ${n} consecutive cycle(s); the other audits still ran)`);
    return {
      name, ok: false,
      violations: [`AUDIT DID NOT RUN: "${name}" has failed ${n} consecutive cycle(s) — ${e.message}. Its invariants are UNCHECKED until this is fixed.`],
    };
  }
}

// ── One audit cycle ───────────────────────────────────────────────────────
async function runCycle(state) {
  const streaks = { ...((state && state.auditFailStreaks) || {}) };
  const allViolations = [];
  const ran = [], failed = [], counts = {};

  // Each audit fn returns { violations, ...extras }. Returns null when the audit
  // threw — callers then carry the previous cycle's high-water marks forward
  // rather than resetting them (a reset would fake a delta on the next cycle).
  const step = async (name, fn) => {
    const r = await runAudit(name, streaks, fn);
    const v = r.ok ? (r.value.violations || []) : r.violations;
    allViolations.push(...v);
    if (v.length) counts[name] = v.length;
    (r.ok ? ran : failed).push(name);
    return r.ok ? r.value : null;
  };

  // Phase 4: phantom-instrument class checks on the served feeds + sanity-reject spike.
  await step('served-feeds', () => ({ violations: auditServedFeeds() }));
  await step('rewards-too-good', () => ({ violations: auditRewardsTooGood() }));
  const spike = await step('sanity-reject-spike', () => auditSanityRejectSpike(state && state.sanityRejectSeen));

  // Phase 3 rules M47/M48/M49: system integrity — producer-down / pipeline-stale
  // (PM2/agent-monitor RESTARTS; the guardian OBSERVES + surfaces so it reaches alerts).
  await step('system-integrity', () => ({ violations: auditSystemIntegrity() }));

  // GUARDIAN observe: watch the serve-path guardian log for the CRITICAL guardrail.
  const gLog = await step('guardian-log', () => auditGuardianLog(state && state.guardianCriticalSeen));

  // GUARDIAN rule H (31–33): fetch the tab APIs with NO session (free tier) and assert every
  // redacted derived-edge field is null — any survivor is a paid value leaking to free.
  await step('paid-gating-leaks', async () => ({ violations: await auditPaidGatingLeaks() }));

  // GUARDIAN direct: emit cross-cycle (rule 5 cashable-swing) directives the serve path
  // cannot compute alone. Reversible + TTL-bounded; self-heals when values stabilize.
  const gd = await step('guardian-directives', async () => {
    const g = await buildGuardianDirectives(state);
    if (g.directives.length) {
      const byRule = g.directives.reduce((m, d) => { m[d.rule] = (m[d.rule] || 0) + 1; return m; }, {});
      log(`guardian directives written: ${g.directives.length} suppression(s) ${JSON.stringify(byRule)}`);
    }
    return { violations: [], curNet: g.curNet, curIds: g.curIds };
  });

  const sanityRejectSeen     = spike ? spike.total          : (state && state.sanityRejectSeen);
  const guardianCriticalSeen = gLog  ? gLog.criticalCount   : (state && state.guardianCriticalSeen);
  const guardianPrevNet      = gd    ? gd.curNet            : (state && state.guardianPrevNet);
  const guardianPrevIds      = gd    ? gd.curIds            : (state && state.guardianPrevIds);

  const total   = ran.length + failed.length;
  const breakdown = Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ');
  log(`cycle ${failed.length ? 'DEGRADED' : 'ok'} — ${ran.length}/${total} audits ran` +
      `${failed.length ? `, FAILED: ${failed.join(', ')}` : ''}, ${allViolations.length} violation(s)` +
      `${breakdown ? ` [${breakdown}]` : ''}, sanity-rejects=${sanityRejectSeen}, guardian-critical=${guardianCriticalSeen}`);

  return {
    violations: allViolations,
    sanityRejectSeen,
    guardianCriticalSeen,
    guardianPrevNet,
    guardianPrevIds,
    auditFailStreaks: streaks,
  };
}

function hashViolations(violations) {
  return crypto.createHash('sha256').update(JSON.stringify([...violations].sort())).digest('hex').slice(0, 16);
}

async function maybeAlert(violations, state, { forceFirstSend = false } = {}) {
  if (violations.length === 0) {
    if (forceFirstSend) await sendTelegram('landing-auditor online — first check: OK, no honest-engine violations found.');
    return state;
  }
  const hash = hashViolations(violations);
  const now  = Date.now();
  if (!forceFirstSend && hash === state.lastAlertHash && now - state.lastAlertAt < ALERT_COOLDOWN_MS) {
    log('violations unchanged since last alert — staying silent (dedupe window active)');
    return state;
  }
  const text = `⚠️ <b>Landing page honest-engine violation${violations.length > 1 ? 's' : ''}</b>\n\n` +
    violations.map((v, i) => `${i + 1}. ${v}`).join('\n\n');
  await sendTelegram(forceFirstSend ? `landing-auditor online — first check found issues:\n\n${text}` : text);
  return { ...state, lastAlertHash: hash, lastAlertAt: now };
}

async function main() {
  log('agent26-landing-auditor starting — read-only, zero Claude API');
  log(`  Served-feed API base: ${API_BASE}`);
  log(`  Interval: ${SCAN_INTERVAL_MS / 60_000} min · alert dedupe window: ${ALERT_COOLDOWN_MS / 3_600_000}h`);

  await new Promise(r => setTimeout(r, STARTUP_DELAY_MS));

  let state = loadState();
  let first = !state.firstCheckDone;

  while (true) {
    try {
      const { violations, sanityRejectSeen, guardianCriticalSeen, guardianPrevNet, guardianPrevIds, auditFailStreaks } = await runCycle(state);
      // carry the delta-detection high-water marks + cross-cycle net/id snapshots forward
      // (auditFailStreaks too, so "audit X has been failing for N cycles" survives a restart)
      state = { ...state, sanityRejectSeen, guardianCriticalSeen, guardianPrevNet, guardianPrevIds, auditFailStreaks };
      state = await maybeAlert(violations, state, { forceFirstSend: first });
      if (first) { state.firstCheckDone = true; first = false; }
      saveState(state);
      beat();
    } catch (e) {
      log('Cycle error:', e.message);
      const hash = 'ERROR:' + hashViolations([e.message]);
      const now = Date.now();
      if (first || hash !== state.lastAlertHash || now - state.lastAlertAt >= ALERT_COOLDOWN_MS) {
        await sendTelegram(`⚠️ landing-auditor cycle error (fetch/parse failed, not a data violation): ${e.message}`);
        state = { ...state, lastAlertHash: hash, lastAlertAt: now, firstCheckDone: true };
        saveState(state);
      }
      first = false;
      beat();
    }
    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
  }
}

// Exported for unit testing the phantom-instrument + guardian checks in isolation.
module.exports = { auditServedFeeds, auditSanityRejectSpike, auditGuardianLog, servedNet, servedRowId, auditPaidGatingLeaks,
  fundingLegSpike, fundingUnitSuspect, auditSystemIntegrity };

if (require.main === module) {
  main().catch(e => { console.error('[A26] Fatal:', e); process.exit(1); });
}
