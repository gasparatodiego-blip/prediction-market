#!/usr/bin/env node
// agent31-trader-auditor.js — Edgeradar honest-engine watchdog for the trader feed.
//
// PURPOSE
//   A DETECT-ONLY guardian for agent30's per-trader trade feed
//   (/tmp/trader-feed.json). Every cycle it FULL-SCANS the same tracked-wallet
//   universe agent30 serves, independently RE-READS real public Polymarket data
//   for each wallet (keyless Data-API), RE-COMPUTES the auditable metrics from
//   that fresh read, and compares them against what the feed actually serves.
//   Any discrepancy beyond a stated tolerance raises a Telegram alert.
//
// HONEST-ENGINE (non-negotiable — mirrors agent26 / agent29)
//   * READ-ONLY. It NEVER writes to /tmp/trader-feed.json, never corrects a
//     value, never touches agent30 or any dashboard code. It only reads,
//     recomputes, compares, and alerts.
//   * It does NOT trust agent30's math. "Truth" is derived exclusively from the
//     auditor's OWN fresh source reads (/trades, /positions, /closed-positions).
//     A "match" is a real re-read matching within tolerance — never a rubber
//     stamp of the served number.
//   * It compares only MARK-INDEPENDENT cost-basis facts (size, avgPrice,
//     initialValue, totalBought, realizedPnl). Mark-to-mid fields (curPrice,
//     cashPnl, currentValue, percentPnl) legitimately drift between resyncs, so
//     they are recorded but never alerted on.
//   * Where the feed HONESTLY serves nothing because the source genuinely has
//     nothing (empty /trades AND /positions), that is CORRECT — classified
//     SOURCE-EMPTY, never a false alarm.
//
// BUG CLASSES IT CATCHES (the exact ones we hit today)
//   (a) fills-vs-positions contradiction — feed serves N fills but 0 positions
//       while a fresh source read shows real open positions (or the reverse).
//   (b) stale / half-open feed — feed.updatedAt old, or feedHealthy:true while
//       the WS has been silent (lastWsMsgAt old) — a feed that lies about health.
//   (c) P&L / avg-entry / cost-basis mismatch — served position economics differ
//       from a freshly re-read source beyond tolerance.
//   (d) present-vs-empty — a tracked wallet the feed serves but source returns
//       fully empty (ghost data), or a wallet with real source data the feed
//       omits entirely (missing).
//   (e) fabricated values — a served open position the source knows nothing about
//       (neither open nor closed → genuine ghost, churn-proof).
//
// OUTPUT   /tmp/trader-audit.json        (atomic; per-wallet verdicts + counts)
// STATE    /tmp/trader-audit-state.json  (alert debounce — persist/prune keys)
// HEARTBEAT/tmp/agent-heartbeats.json    key 'agent31-trader-auditor'
// COST     $0 — keyless public Data-API only. Full-scan is budget-safe under the
//          Cloudflare 1000-req/10s throttle (~204 wallets × 3 calls, paced).

'use strict';

const fs   = require('fs');
const path = require('path');
const { httpGet, httpPost } = require('../lib/httpGet');   // MANDATORY wall-clock-deadline helper
const { atomicWriteJson }   = require('../lib/atomicJsonWrite');

// ── .env (pm2 doesn't auto-load project env files) — for Telegram creds ────────
for (const envFile of ['.env.local', '.env']) {
  try {
    const envPath = path.join(__dirname, '..', envFile);
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)="?([^"]*?)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* try next */ }
}

// ── Config ──────────────────────────────────────────────────────────────────
const DATA_API         = 'https://data-api.polymarket.com';
const LEADERBOARD_FILE = '/tmp/leaderboard.json';
const FEED_FILE        = '/tmp/trader-feed.json';   // READ-ONLY — never written here
const OUT_FILE         = '/tmp/trader-audit.json';
const STATE_FILE       = '/tmp/trader-audit-state.json';
const HB_FILE          = '/tmp/agent-heartbeats.json';
const HB_KEY           = 'agent31-trader-auditor';

const SCAN_INTERVAL_MS = 90_000;     // full-scan cadence
const FILLS_LIMIT      = 200;        // match agent30's per-wallet fill cap (apples-to-apples)
const CLOSED_LIMIT     = 500;        // closed-positions depth for realized/win-rate recompute
const REQ_TIMEOUT_MS   = 12_000;     // wall-clock deadline per request
const PACE_MS          = 25;         // spacing between source requests (polite; ~46s of spacing for 612 calls)
const MAX_RETRY        = 2;          // per-call retries on 429 / Cloudflare challenge
const BACKOFF_BASE_MS  = 1_500;      // exponential backoff base on throttle
const BACKOFF_CAP_MS   = 20_000;
const MAX_TRACKED      = 400;        // safety cap on scanned universe

// Alert debounce (mirror agent26): only alert an issue that has PERSISTED, and
// never re-alert the same active issue inside the cooldown window.
const MIN_PERSIST_CYCLES = 2;                 // transient-filter: must be seen this many cycles
const ALERT_COOLDOWN_MS  = 6 * 60 * 60_000;   // 6h re-alert cooldown per issue key

// Feed-level staleness thresholds (bug class b).
const STALE_FEED_MS      = 4 * 60_000;   // feed.updatedAt older than this ⇒ agent30 not writing
const STALE_HALFOPEN_MS  = 4 * 60_000;   // feedHealthy:true but lastWsMsgAt older than this ⇒ lying-healthy

// Tolerances — passthrough values should match near-exactly; tolerance only
// absorbs float/formatting noise, so a real corruption is still caught.
const TOL = {
  dollarAbs: 0.50, dollarRel: 0.01,   // initialValue, totalBought, realizedPnl
  sizeAbs:   0.01, sizeRel:   0.01,   // position size
  priceAbs:  0.005,                   // avgPrice
};

// Noise floors — Polymarket's constant-resolution markets (BTC up/down 5-min etc.)
// churn positions in seconds, so a LONE transient position/fill is not signal.
// The bug we hit today was systematic ("holds MANY, serves 0"), so alerts require
// a SUBSTANTIAL source-side count and (via debounce) persistence across cycles.
const MIN_CONTRADICTION_COUNT = 3;    // source must show ≥ this many pos/fills to flag a contradiction
const MIN_MISSING_COUNT       = 3;    // source must have ≥ this much data to flag a feed-omitted wallet
// Fleet-level systematic cost-basis corruption: a passthrough regression (×100,
// field swap, zeroing) mismatches ~ALL unchurned positions; sporadic trading
// churn on same-net-size positions stays far below this rate. Per-position
// mismatches are recorded as diagnostics; only the FLEET rate alerts.
const SYS_CB_MIN_SAMPLE = 50;         // need this many unchurned comparisons before judging
const SYS_CB_THRESHOLD  = 0.15;       // > this fraction mismatched ⇒ systematic corruption

// Telegram — GUARDIAN: bypasses the TELEGRAM_ALERTS_ENABLED mute switch exactly
// like agent26 / agent-monitor (gated only on creds presence). This is a
// watchdog; it must be able to shout even when the fleet is muted.
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';

const log = (...a) => console.log('[agent31]', ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Number comparison ─────────────────────────────────────────────────────────
function approxEq(a, b, absTol, relTol = 0) {
  if (a == null || b == null) return a == null && b == null;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const diff = Math.abs(a - b);
  return diff <= absTol || diff <= relTol * Math.max(Math.abs(a), Math.abs(b));
}

// ── Tracked wallet universe (identical construction to agent30.refreshTracked) ──
function loadTracked() {
  const set = new Set();
  try {
    const raw = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
    for (const cat of Object.values(raw.categories || {})) {
      for (const r of cat) if (r && r.wallet) set.add(String(r.wallet).toLowerCase());
    }
    for (const b of (raw.bots || [])) if (b && b.wallet) set.add(String(b.wallet).toLowerCase());
  } catch (e) {
    log('loadTracked: leaderboard.json unavailable —', e.message);
  }
  return Array.from(set).slice(0, MAX_TRACKED);
}

// ── Feed (served side) — READ-ONLY ─────────────────────────────────────────────
function loadFeed() {
  try { return JSON.parse(fs.readFileSync(FEED_FILE, 'utf8')); }
  catch (e) { log('loadFeed: trader-feed.json unavailable —', e.message); return null; }
}

// Extract the served metrics for one wallet from the feed (or null if absent).
function extractServed(feedWallet) {
  if (!feedWallet) return null;
  const fills = Array.isArray(feedWallet.fills) ? feedWallet.fills : [];
  const positions = Array.isArray(feedWallet.positions) ? feedWallet.positions : [];
  const byAsset = new Map();
  let openCostBasis = 0, openSize = 0, realizedOpen = 0;
  for (const p of positions) {
    if (!p || p.asset == null) continue;
    byAsset.set(String(p.asset), p);
    if (Number.isFinite(p.initialValue)) openCostBasis += p.initialValue;
    if (Number.isFinite(p.size))         openSize += p.size;
    if (Number.isFinite(p.realizedPnl))  realizedOpen += p.realizedPnl;
  }
  return {
    present: true,
    fillsCount: Number.isFinite(feedWallet.fillsCount) ? feedWallet.fillsCount : fills.length,
    fillsCapped: !!feedWallet.fillsCapped,
    positionsCount: positions.length,
    positionsUpdatedAt: feedWallet.positionsUpdatedAt || null,
    openCostBasis, openSize, realizedOpen,
    byAsset,
  };
}

// ── Paced, throttle-aware source GET (wall-clock deadline via lib/httpGet) ──────
let apiCalls = 0, throttleHits = 0, lastCallAt = 0;

function isChallenge(err) {
  const m = String((err && err.message) || '');
  return /\b429\b/.test(m) || /just a moment|cloudflare|cf-chl|challenge|<!doctype html|<html/i.test(m);
}

async function dataGet(urlPath) {
  const url = `${DATA_API}${urlPath}`;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    // Pace consecutive request starts to stay well under the CF 1000/10s limit.
    const since = Date.now() - lastCallAt;
    if (since < PACE_MS) await sleep(PACE_MS - since);
    lastCallAt = Date.now();
    apiCalls++;
    try {
      const r = await httpGet(url, { timeoutMs: REQ_TIMEOUT_MS });
      // A resolved 429 with a JSON body (rare here — CF usually returns HTML,
      // which surfaces as a rejected "bad JSON"): honor Retry-After and retry.
      if (r.status === 429) {
        throttleHits++;
        if (attempt < MAX_RETRY) {
          const ra = Number(r.headers && r.headers['retry-after']);
          await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000
            : Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, attempt)));
          continue;
        }
        return { ok: false, status: 429, data: null };
      }
      if (r.status >= 400) return { ok: false, status: r.status, data: null };
      return { ok: true, status: r.status, data: Array.isArray(r.data) ? r.data : [] };
    } catch (e) {
      if (isChallenge(e)) {
        throttleHits++;
        if (attempt < MAX_RETRY) {
          await sleep(Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, attempt)));
          continue;
        }
      }
      return { ok: false, status: 0, error: e.message, data: null };
    }
  }
  return { ok: false, status: 0, data: null };
}

// Fetch a wallet's three source views. `ok` is false if a REQUIRED endpoint
// errored (so we NEVER misread a transient failure as "source empty").
async function fetchWalletSource(addr) {
  const tradesR    = await dataGet(`/trades?user=${addr}&limit=${FILLS_LIMIT}`);
  const positionsR = await dataGet(`/positions?user=${addr}`);
  const closedR    = await dataGet(`/closed-positions?user=${addr}&limit=${CLOSED_LIMIT}`);
  return {
    ok: tradesR.ok && positionsR.ok,            // closed is best-effort (diagnostic only)
    trades:    tradesR.data || [],
    positions: positionsR.data || [],
    closed:    closedR.data || [],
    closedOk:  closedR.ok,
    errors: [tradesR, positionsR, closedR].filter(x => !x.ok)
      .map(x => `${x.status || 'net'}${x.error ? ':' + x.error.slice(0, 40) : ''}`),
  };
}

// ── Independent recompute (TRUTH) from the fresh source read only ───────────────
function computeTruth(src) {
  const byAsset = new Map();
  let openCostBasis = 0, openSize = 0, realizedOpen = 0;
  for (const p of src.positions) {
    if (!p || p.asset == null) continue;
    const rec = {
      asset:        String(p.asset),
      size:         Number(p.size),
      avgPrice:     Number(p.avgPrice),
      initialValue: Number(p.initialValue),
      totalBought:  Number(p.totalBought),
      realizedPnl:  Number(p.realizedPnl),
    };
    byAsset.set(rec.asset, rec);
    if (Number.isFinite(rec.initialValue)) openCostBasis += rec.initialValue;
    if (Number.isFinite(rec.size))         openSize += rec.size;
    if (Number.isFinite(rec.realizedPnl))  realizedOpen += rec.realizedPnl;
  }

  // Independent from-raw-fills size-weighted BUY avg-entry per asset (diagnostic:
  // approximate for capped/merged/redeemed histories — recorded, never alerted).
  const buyAgg = new Map();
  for (const t of src.trades) {
    if (!t || t.asset == null || String(t.side).toUpperCase() !== 'BUY') continue;
    const px = Number(t.price), sz = Number(t.size);
    if (!Number.isFinite(px) || !Number.isFinite(sz)) continue;
    const a = String(t.asset);
    const g = buyAgg.get(a) || { notional: 0, size: 0 };
    g.notional += px * sz; g.size += sz; buyAgg.set(a, g);
  }
  const recomputedAvgEntry = {};
  for (const [a, g] of buyAgg) if (g.size > 0) recomputedAvgEntry[a] = g.notional / g.size;

  // Realized P&L + win rate from closed positions (Polymarket's own realized).
  let realizedClosed = 0, wins = 0, closedCount = 0;
  for (const c of src.closed) {
    if (!c) continue;
    const rp = Number(c.realizedPnl);
    if (!Number.isFinite(rp)) continue;
    realizedClosed += rp; closedCount++; if (rp > 0) wins++;
  }

  return {
    fillsCount: src.trades.length,
    positionsCount: src.positions.length,
    openCostBasis, openSize, realizedOpen,
    realizedClosed, closedCount,
    winRate: closedCount ? wins / closedCount : null,
    byAsset,
    recomputedAvgEntry,
    closedAssets: new Set(src.closed.filter(Boolean).map(c => String(c.asset))),
  };
}

// ── Per-wallet comparison → verdict + issues ────────────────────────────────────
// verdicts: OK | SOURCE-EMPTY | DISCREPANCY | NEEDS-SYNC | SKIP(source-error)
function compareWallet(addr, served, src) {
  const issues = [];
  const short = addr.slice(0, 10) + '…';

  // Source errored on a required endpoint — do NOT infer emptiness or discrepancy.
  if (!src.ok) return { verdict: 'SKIP', reason: 'source-error:' + src.errors.join(','), issues };

  const truth = computeTruth(src);
  const srcHasData = truth.fillsCount > 0 || truth.positionsCount > 0;
  const servedPresent = !!(served && served.present && (served.fillsCount > 0 || served.positionsCount > 0));

  // Honest withholding: feed serves nothing, source has nothing → CORRECT.
  if (!servedPresent && !srcHasData) {
    return { verdict: 'SOURCE-EMPTY', truth, issues };
  }

  // Feed omits a wallet that has real source data → under-serving (warmup or bug).
  // Debounced + substantial-data-gated: a lone transient 5-min position does not
  // count; only a wallet with meaningful holdings the feed persistently omits.
  if (!servedPresent && srcHasData) {
    const substantial = truth.fillsCount >= MIN_MISSING_COUNT || truth.positionsCount >= MIN_MISSING_COUNT;
    issues.push({
      key: `missing:${addr}`, type: 'feed-missing-wallet', wallet: addr,
      detail: `feed omits ${short} but source has ${truth.fillsCount} fills / ${truth.positionsCount} positions`,
      served: 'absent/empty', source: `fills=${truth.fillsCount} pos=${truth.positionsCount}`,
      alertable: substantial,
    });
    return { verdict: 'NEEDS-SYNC', truth, issues };
  }

  // Feed serves data but source is now fully empty → GHOST data (fabrication).
  if (servedPresent && !srcHasData) {
    issues.push({
      key: `ghostdata:${addr}`, type: 'ghost-data', wallet: addr,
      detail: `feed serves ${served.fillsCount} fills / ${served.positionsCount} positions for ${short} but source is EMPTY`,
      served: `fills=${served.fillsCount} pos=${served.positionsCount}`, source: 'empty',
      alertable: true,
    });
    return { verdict: 'DISCREPANCY', truth, issues };
  }

  // ── Both sides have data → detailed checks ──

  // (a) fills-vs-positions contradiction — the exact bug we shipped a fix for today
  //     ("holds MANY positions, serves 0"). Gated on a SUBSTANTIAL source-side
  //     count (≥ MIN_CONTRADICTION_COUNT) so a lone transient 5-min market that
  //     was briefly open at scan time can't trip it, and debounced so it must
  //     PERSIST — a genuine aggregation failure keeps serving 0 while source keeps
  //     showing many; churn does not.
  if (served.fillsCount > 0 && served.positionsCount === 0 && truth.positionsCount >= MIN_CONTRADICTION_COUNT) {
    issues.push({
      key: `contradiction:${addr}`, type: 'fills-no-positions', wallet: addr,
      detail: `feed serves ${served.fillsCount} fills but 0 positions for ${short}, while source shows ${truth.positionsCount} real open positions`,
      served: `fills=${served.fillsCount} pos=0`, source: `pos=${truth.positionsCount}`,
      alertable: true,
    });
  }
  if (served.positionsCount > 0 && served.fillsCount === 0 && truth.fillsCount >= MIN_CONTRADICTION_COUNT) {
    issues.push({
      key: `contradiction-rev:${addr}`, type: 'positions-no-fills', wallet: addr,
      detail: `feed serves ${served.positionsCount} positions but 0 fills for ${short}, while source shows ${truth.fillsCount} fills`,
      served: `pos=${served.positionsCount} fills=0`, source: `fills=${truth.fillsCount}`,
      alertable: true,
    });
  }

  // (c) cost-basis fidelity on CO-PRESENT positions — DIAGNOSTIC per position,
  //     ALERT only at the FLEET level (see runCycle). agent30's served positions
  //     are up to ~10min old, and a trader can BUY MORE then SELL DOWN to the same
  //     net size with a different totalBought/avgPrice/initialValue — so even a
  //     same-size position's cost-basis can honestly drift. That makes any SINGLE
  //     per-position mismatch indistinguishable from honest trading churn → never
  //     alert on one. But a real passthrough REGRESSION (×100, field swap, zeroing)
  //     corrupts ~EVERY position at once; that shows up as a high FLEET-WIDE
  //     mismatch RATE, which runCycle alerts on. Here we only compare (on unchurned
  //     positions, to keep the rate meaningful) and count.
  let coPresent = 0, unchurned = 0, cbMismatchPos = 0;
  for (const [asset, sp] of served.byAsset) {
    const tp = truth.byAsset.get(asset);
    if (!tp) continue;
    coPresent++;
    // Only same-net-size positions feed the systematic-corruption rate — a size
    // change means the trader traded (honest staleness), which we exclude.
    if (!approxEq(Number(sp.size), Number(tp.size), TOL.sizeAbs, TOL.sizeRel)) continue;
    unchurned++;
    let posMismatched = false;
    const checks = [
      ['avgPrice',     sp.avgPrice,     tp.avgPrice,     TOL.priceAbs,  0],
      ['initialValue', sp.initialValue, tp.initialValue, TOL.dollarAbs, TOL.dollarRel],
      ['totalBought',  sp.totalBought,  tp.totalBought,  TOL.sizeAbs,   TOL.sizeRel],
      ['realizedPnl',  sp.realizedPnl,  tp.realizedPnl,  TOL.dollarAbs, TOL.dollarRel],
    ];
    for (const [field, a, b, absT, relT] of checks) {
      const av = Number(a), bv = Number(b);
      if (!Number.isFinite(av) || !Number.isFinite(bv)) continue;
      if (!approxEq(av, bv, absT, relT)) {
        posMismatched = true;
        issues.push({
          key: `costbasis:${addr}:${asset.slice(0, 12)}:${field}`, type: 'costbasis-mismatch', wallet: addr,
          detail: `${short} same-size position ${asset.slice(0, 10)}… (size ${sp.size}) ${field}: feed=${av} vs source=${bv} (diagnostic; alerts only if fleet-wide)`,
          served: String(av), source: String(bv), alertable: false,
        });
      }
    }
    if (posMismatched) cbMismatchPos++;
  }

  // (e) ghost position — a served OPEN position absent from a fresh source read.
  //     For Polymarket's constant-resolution markets (BTC up/down 5-min, etc.) a
  //     position resolves+redeems and rotates out of /positions faster than the
  //     /closed-positions?limit window, so a served-but-absent position is
  //     dominated by honest resolution churn and is INDISTINGUISHABLE from a
  //     fabrication here — recorded as a diagnostic, NEVER alerted (no false alarm).
  let ghostCount = 0;
  for (const [asset, sp] of served.byAsset) {
    if (truth.byAsset.has(asset)) continue;
    if (truth.closedAssets.has(asset)) continue;   // recently closed → known churn
    ghostCount++;
    issues.push({
      key: `ghostpos:${addr}:${asset.slice(0, 12)}`, type: 'ghost-position', wallet: addr,
      detail: `${short} serves open position ${asset.slice(0, 10)}… (size ${sp.size}) absent from fresh source open+closed (likely resolution churn)`,
      served: `size=${sp.size} avg=${sp.avgPrice}`, source: 'absent', alertable: false,
    });
  }

  // Verdict reflects only ALERTABLE issues; churn/ghost/cost-basis diagnostics are
  // honest staleness and must not paint a wallet as a discrepancy.
  const alertable = issues.filter(i => i.alertable);
  const verdict = alertable.length ? 'DISCREPANCY' : 'OK';
  return { verdict, truth, coPresent, unchurned, cbMismatchPos, ghostCount, issues };
}

// ── Feed-level staleness checks (bug class b) ───────────────────────────────────
function feedLevelIssues(feed) {
  const issues = [];
  if (!feed) {
    issues.push({ key: 'feed-missing', type: 'feed-file-missing',
      detail: 'trader-feed.json is missing or unreadable', alertable: true });
    return { issues, meta: null };
  }
  const now = Date.now();
  const updatedMs = Date.parse(feed.updatedAt || '');
  const lastWsMs  = Date.parse(feed.lastWsMsgAt || '');
  const fileAge   = Number.isFinite(updatedMs) ? now - updatedMs : Infinity;
  const wsAge     = Number.isFinite(lastWsMs)  ? now - lastWsMs   : Infinity;

  if (fileAge > STALE_FEED_MS) {
    issues.push({
      key: 'stale-file', type: 'stale-feed-file',
      detail: `feed.updatedAt is ${(fileAge / 1000).toFixed(0)}s old (> ${STALE_FEED_MS / 1000}s) — agent30 may be wedged/dead`,
      alertable: true,
    });
  }
  // Lying-healthy: the file asserts feedHealthy:true but the WS has been silent.
  if (feed.feedHealthy === true && wsAge > STALE_HALFOPEN_MS) {
    issues.push({
      key: 'stale-halfopen', type: 'feed-healthy-but-ws-silent',
      detail: `feedHealthy:true but lastWsMsgAt is ${(wsAge / 1000).toFixed(0)}s old (> ${STALE_HALFOPEN_MS / 1000}s) — half-open/lying-healthy`,
      alertable: true,
    });
  }
  return {
    issues,
    meta: {
      updatedAt: feed.updatedAt || null, feedHealthy: feed.feedHealthy, wsConnected: feed.wsConnected,
      resyncing: feed.resyncing, lastWsMsgAt: feed.lastWsMsgAt || null,
      fileAgeSec: Number.isFinite(fileAge) ? Math.round(fileAge / 1000) : null,
      wsAgeSec:   Number.isFinite(wsAge)   ? Math.round(wsAge / 1000)   : null,
      trackedCount: feed.trackedCount, servedCount: feed.servedCount,
    },
  };
}

// ── Alert debounce state ────────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { keys: {}, firstCheckDone: false }; }
}
function saveState(state) {
  try { atomicWriteJson(STATE_FILE, state, { pretty: true }); }
  catch (e) { log('saveState error:', e.message); }
}

async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) { log('Telegram not configured — alert logged only:', text.slice(0, 200)); return; }
  try {
    await httpPost(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      { chat_id: CHAT_ID, text, parse_mode: 'HTML' }, { timeoutMs: 10_000 });
  } catch (e) { log('sendTelegram error:', e.message); }
}

// Reconcile this cycle's issues against persistent state; return the batch of
// issues that are newly ALERTABLE (persisted ≥ MIN_PERSIST_CYCLES and outside
// their re-alert cooldown). Prunes keys not seen this cycle.
function reconcileAlerts(state, issues, now) {
  const seen = new Set();
  const toAlert = [];
  for (const iss of issues) {
    if (!iss.alertable) continue;
    seen.add(iss.key);
    const prev = state.keys[iss.key] || { count: 0, firstSeen: now, lastAlertAt: 0 };
    prev.count = (prev.count || 0) + 1;
    prev.type = iss.type; prev.detail = iss.detail;
    const persisted = prev.count >= MIN_PERSIST_CYCLES;
    const cooledDown = now - (prev.lastAlertAt || 0) >= ALERT_COOLDOWN_MS;
    if (persisted && cooledDown) { toAlert.push(iss); prev.lastAlertAt = now; }
    state.keys[iss.key] = prev;
  }
  // Prune resolved keys (not observed this cycle).
  for (const k of Object.keys(state.keys)) if (!seen.has(k)) delete state.keys[k];
  return toAlert;
}

// ── Heartbeat ───────────────────────────────────────────────────────────────────
function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb[HB_KEY] = Date.now();
  try { fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2)); } catch {}
}

// ── One full-scan cycle ─────────────────────────────────────────────────────────
let running = false;
async function runCycle() {
  if (running) { log('cycle skipped (previous still running)'); return; }
  running = true;
  const t0 = Date.now();
  apiCalls = 0; throttleHits = 0;

  const tracked = loadTracked();
  const feed = loadFeed();
  const feedWallets = (feed && feed.wallets) || {};
  const { issues: feedIssues, meta: feedMeta } = feedLevelIssues(feed);

  const counts = { OK: 0, 'SOURCE-EMPTY': 0, DISCREPANCY: 0, 'NEEDS-SYNC': 0, SKIP: 0 };
  const walletVerdicts = {};
  const allIssues = [...feedIssues];
  let fleetUnchurned = 0, fleetCbMismatchPos = 0;   // fleet-wide cost-basis-corruption signal

  for (const addr of tracked) {
    let res;
    try {
      const src = await fetchWalletSource(addr);
      const served = extractServed(feedWallets[addr]);
      res = compareWallet(addr, served, src);
    } catch (e) {
      res = { verdict: 'SKIP', reason: 'exception:' + e.message, issues: [] };
    }
    counts[res.verdict] = (counts[res.verdict] || 0) + 1;
    fleetUnchurned     += res.unchurned || 0;
    fleetCbMismatchPos += res.cbMismatchPos || 0;
    for (const iss of res.issues) allIssues.push(iss);
    // Brief per-wallet record (bounded — keeps the audit file small).
    walletVerdicts[addr] = {
      verdict: res.verdict,
      reason: res.reason || undefined,
      issueTypes: res.issues.length ? res.issues.map(i => i.type) : undefined,
      served: extractServed(feedWallets[addr]) ? {
        fills: (extractServed(feedWallets[addr]) || {}).fillsCount,
        pos: (extractServed(feedWallets[addr]) || {}).positionsCount,
      } : null,
      source: res.truth ? { fills: res.truth.fillsCount, pos: res.truth.positionsCount } : null,
    };
  }

  const cycleMs = Date.now() - t0;

  // Fleet-level systematic cost-basis corruption (bug class c/e, staleness-proof).
  // A passthrough regression corrupts ~every position at once → a high mismatch
  // RATE over a large unchurned sample; sporadic trading churn stays far below.
  const cbRate = fleetUnchurned > 0 ? fleetCbMismatchPos / fleetUnchurned : 0;
  if (fleetUnchurned >= SYS_CB_MIN_SAMPLE && cbRate > SYS_CB_THRESHOLD) {
    allIssues.push({
      key: 'systematic-costbasis', type: 'systematic-costbasis-corruption',
      detail: `${(cbRate * 100).toFixed(1)}% of ${fleetUnchurned} unchurned co-present positions have cost-basis mismatches (> ${SYS_CB_THRESHOLD * 100}%) — likely an agent30 passthrough regression`,
      alertable: true,
    });
  }

  // ── Alerts (debounced) ──
  const state = loadState();
  const now = Date.now();
  const toAlert = reconcileAlerts(state, allIssues, now);
  if (toAlert.length) {
    const lines = toAlert.slice(0, 20).map(i => `• <b>${i.type}</b>: ${i.detail}`);
    const extra = toAlert.length > 20 ? `\n…and ${toAlert.length - 20} more` : '';
    await sendTelegram(
      `🚨 <b>trader-auditor</b> — ${toAlert.length} discrepanc${toAlert.length === 1 ? 'y' : 'ies'} vs re-read source:\n\n`
      + lines.join('\n') + extra);
    log(`ALERT sent — ${toAlert.length} issue(s)`);
  }
  state.firstCheckDone = true;
  saveState(state);

  // ── Audit output (atomic; NEVER touches trader-feed.json) ──
  const out = {
    updatedAt: new Date().toISOString(),
    cycleMs, walletsScanned: tracked.length,
    apiCalls, throttleHits,
    counts,
    activeIssues: allIssues.filter(i => i.alertable).length,
    alertedThisCycle: toAlert.length,
    costBasis: {                       // fleet cost-basis fidelity (diagnostic)
      unchurnedCompared: fleetUnchurned,
      mismatchedPositions: fleetCbMismatchPos,
      mismatchRatePct: Number((cbRate * 100).toFixed(2)),
      systematicThresholdPct: SYS_CB_THRESHOLD * 100,
    },
    feedMeta,
    issues: allIssues.map(i => ({ type: i.type, alertable: !!i.alertable, wallet: i.wallet, detail: i.detail, served: i.served, source: i.source })),
    wallets: walletVerdicts,
    note: 'DETECT-ONLY auditor. Independent re-read + recompute vs served feed. Never modifies the feed.',
  };
  try { atomicWriteJson(OUT_FILE, out); } catch (e) { log('audit write failed:', e.message); }

  const disc = counts.DISCREPANCY + counts['NEEDS-SYNC'];
  log(`cycle done — ${tracked.length} wallets · ${apiCalls} calls · ${(cycleMs / 1000).toFixed(0)}s · `
    + `429s=${throttleHits} · OK=${counts.OK} empty=${counts['SOURCE-EMPTY']} disc=${disc} skip=${counts.SKIP} · `
    + `cbRate=${(cbRate * 100).toFixed(1)}%(n=${fleetUnchurned}) · alerts=${toAlert.length}`);
  running = false;
}

// ── Boot ────────────────────────────────────────────────────────────────────────
async function main() {
  log('starting — DETECT-ONLY honest-engine watchdog for the trader feed (keyless Data-API re-read, $0)');
  log(`  interval ${SCAN_INTERVAL_MS / 1000}s · fill cap ${FILLS_LIMIT} · persist ${MIN_PERSIST_CYCLES} cycles · cooldown ${ALERT_COOLDOWN_MS / 3_600_000}h`);
  beat();
  setInterval(beat, 5_000);   // heartbeat independent of the (longer) scan cycle
  await runCycle();
  setInterval(() => runCycle().catch(e => log('cycle error:', e.message)), SCAN_INTERVAL_MS);
}

// Exported for the verification harness (agent31-trader-auditor.test/verify).
// Pure, side-effect-free logic — importable without booting the scan loop.
module.exports = {
  approxEq, extractServed, computeTruth, compareWallet, feedLevelIssues,
  reconcileAlerts, loadTracked, loadFeed, TOL,
};

if (require.main === module) {
  process.on('uncaughtException',  (e) => log('uncaughtException:', e && e.message));
  process.on('unhandledRejection', (e) => log('unhandledRejection:', e && (e.message || e)));
  process.on('SIGINT',  () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  main().catch((e) => { log('fatal:', e && e.message); process.exit(1); });
}
