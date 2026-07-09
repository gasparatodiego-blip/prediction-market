#!/usr/bin/env node
// agent26-landing-auditor.js — read-only honest-engine GUARDIAN.
//
// READ-ONLY on SOURCE · Zero Claude API · never edits producer code, never
// restarts anything, never rewrites/fabricates a value. Every 30 min it:
//   1. Fetches http://localhost:3000 and extracts the "live inside" rows
//      that app/page.tsx's buildLiveRows()/readLandingStats() produced.
//   2. Independently recomputes each row's expected value straight from the
//      same /tmp + data/*.json source files, using the same gating rules
//      and formulas app/page.tsx uses (reused where require()-able, mirrored
//      with a source-of-truth comment where the original is TypeScript).
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
const { CASHABLE_SWING } = require('../lib/guardian-suppress');
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
const LANDING_URL       = 'http://localhost:3000/';
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
const KALSHI_REWARDS_FILE = '/root/prediction-market/data/kalshi-rewards.json';

// Guardian channel: the serve path logs every suppression here; this agent watches it.
const GUARDIAN_DIRECTIVES_FILE = '/tmp/guardian-directives.json'; // agent26 → serve path (reversible)
const GUARDIAN_DIRECTIVE_TTL_MS = 60 * 60_000; // a cashable-swing/cross-surface directive self-expires after 1h
const API_BASE            = 'http://localhost:3000';

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
const APY_CAP_LABEL = '>200%/yr · run-rate, not guaranteed'; // lib/honest-display.ts APY_CAP_LABEL
const LANDING_CAPITAL_BASIS = 1000; // lib/honest-display.ts LANDING_CAPITAL_BASIS

function scaleToCapitalBasis(amountAtCapital, fromCapital, toCapital = LANDING_CAPITAL_BASIS) { // lib/honest-display.ts scaleToCapitalBasis
  if (fromCapital <= 0) return 0;
  return amountAtCapital * (toCapital / fromCapital);
}

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
  try { fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2)); } catch {}
}

function loadState() {
  return readJsonSafe(STATE_FILE) || { lastAlertHash: null, lastAlertAt: 0, firstCheckDone: false };
}
function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) { log('saveState error:', e.message); }
}

// ── Parse the landing page's "live inside" rows out of the rendered HTML ────
// No data-testid/data-attributes exist on BlipRow (app/components/ui/BlipRow.tsx),
// so this anchors on the row UNIT strings, which are a small fixed vocabulary
// hardcoded in app/page.tsx's buildLiveRows() (one of: 'net/day per $1k',
// 'confirmed margin', 'basis · coin-margined', 'executable basis',
// 'cashable right now'). The value div always immediately precedes its unit
// div in BlipRow's markup, and the chip (CASHABLE/SIGNAL) always immediately
// precedes the row's sub-text — so anchoring on (value, unit) pairs and
// walking backward to the nearest chip is robust to className/markup churn.
const UNIT_VOCAB = [
  'net/day per $1k',
  'confirmed margin',
  'basis · coin-margined',
  'executable basis',
  'cashable right now',
];

function parseLandingRows(html) {
  // Only look at the actual rendered DOM, not the RSC flight-data <script>
  // blob Next.js appends after it (which re-serializes the same row text as
  // escaped JSON strings and would otherwise double-match every anchor).
  const scriptIdx = html.indexOf('<script>self.__next_f.push');
  const domOnly   = scriptIdx > -1 ? html.slice(0, scriptIdx) : html;

  const headerMarker = 'live inside';
  const footerMarker = 'More than arbitrage';
  const startIdx = domOnly.indexOf(headerMarker);
  const endIdx   = domOnly.indexOf(footerMarker);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error('landing page structure not found (header/footer markers missing) — page markup may have changed');
  }
  const segment = domOnly.slice(startIdx + headerMarker.length, endIdx);

  if (segment.includes('no edge confirmed yet')) return []; // empty-state placeholder, not a violation

  const tokens = segment
    .replace(/<[^>]+>/g, '\n')
    .replace(/&#x27;/g, "'")
    .split('\n')
    .map(t => t.trim())
    .filter(Boolean);

  const rows = [];
  let searchFrom = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (!UNIT_VOCAB.includes(tokens[i])) continue;
    const unitIdx  = i;
    const valueIdx = unitIdx - 1;
    if (valueIdx < searchFrom) continue;
    const value = tokens[valueIdx];

    let chipIdx = -1;
    for (let j = valueIdx - 1; j >= searchFrom; j--) {
      if (tokens[j] === 'CASHABLE' || tokens[j] === 'SIGNAL') { chipIdx = j; break; }
    }
    if (chipIdx === -1) { searchFrom = unitIdx + 1; continue; } // malformed row, skip rather than misattribute

    const nameRaw = tokens.slice(searchFrom, chipIdx).join(' ');
    const subRaw  = tokens.slice(chipIdx + 1, valueIdx).join(' ');
    const chip    = tokens[chipIdx] === 'CASHABLE' ? 'cashable' : 'signal';

    rows.push({ nameRaw, subRaw, chip, value, unit: tokens[unitIdx] });
    searchFrom = unitIdx + 1;
  }
  return rows;
}

function classifyRow(row) {
  if (/funding spread/.test(row.nameRaw)) {
    const m = /(\S+)\s+funding spread/.exec(row.nameRaw);
    return { key: 'funding', coin: m ? m[1] : null };
  }
  if (/maker rewards/.test(row.nameRaw)) {
    const platform = /Polymarket/.test(row.nameRaw) ? 'Polymarket' : /Kalshi/.test(row.nameRaw) ? 'Kalshi' : null;
    return { key: 'rewards', platform };
  }
  if (/carry/.test(row.nameRaw)) {
    const m = /(\S+)\s+carry/.exec(row.nameRaw);
    return { key: 'carry', asset: m ? m[1] : null };
  }
  if (/Cross-book arb/.test(row.nameRaw)) return { key: 'sports' };
  if (/Prediction arb/.test(row.nameRaw)) return { key: 'prediction' };
  return { key: 'unknown' };
}

function parseNumber(str) {
  const m = /(-?[\d.]+)/.exec(String(str).replace(/,/g, ''));
  return m ? parseFloat(m[1]) : NaN;
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

// ── Independent recompute: rewards (mirrors readLandingStats()'s Poly+Kalshi loop) ─
function recomputeRewards() {
  const CAPITAL_TIERS = ['500', '5000', '50000'];
  let best = null;

  const polyRaw = readJsonSafe(POLY_REWARDS_FILE);
  for (const m of polyRaw?.markets ?? []) {
    for (const capStr of CAPITAL_TIERS) {
      const lv = m.levels?.[capStr];
      if (!lv || !lv.grossRewardDay) continue;
      if (!isSanePolymarketLevel({ flags: lv.flags ?? [] })) continue;
      const score = (lv.dayYieldPct ?? 0) * 365;
      if (!best || score > best.score) best = { platform: 'Polymarket', grossRewardDay: lv.grossRewardDay, capital: +capStr, dayYieldPct: lv.dayYieldPct ?? 0, score };
      break;
    }
  }

  const kalshiRaw = readJsonSafe(KALSHI_REWARDS_FILE);
  for (const m of kalshiRaw?.markets ?? []) {
    for (const capStr of CAPITAL_TIERS) {
      const lv = m.levels?.[capStr];
      if (!lv || !lv.grossRewardDay) continue;
      if (!isSaneKalshiMarket(m, capStr)) continue;
      const score = (lv.dayYieldPct ?? 0) * 365;
      if (!best || score > best.score) best = { platform: 'Kalshi', grossRewardDay: lv.grossRewardDay, capital: +capStr, dayYieldPct: lv.dayYieldPct ?? 0, score };
      break;
    }
  }
  if (!best) return null;
  return { platform: best.platform, day1k: scaleToCapitalBasis(best.grossRewardDay, best.capital, LANDING_CAPITAL_BASIS), dayYieldPct: best.dayYieldPct };
}

// GATE INTEGRITY (user-scoped to rewards only): does the specific level that
// produces the DISPLAYED $/day figure pass the platform's own sane-market gate?
function findDisplayedRewardGateStatus(platform, displayedDay1k) {
  const CAPITAL_TIERS = ['500', '5000', '50000'];
  if (platform === 'Polymarket') {
    const raw = readJsonSafe(POLY_REWARDS_FILE);
    for (const m of raw?.markets ?? []) {
      for (const capStr of CAPITAL_TIERS) {
        const lv = m.levels?.[capStr];
        if (!lv || !lv.grossRewardDay) continue;
        const day1k = scaleToCapitalBasis(lv.grossRewardDay, +capStr, LANDING_CAPITAL_BASIS);
        if (Math.abs(day1k - displayedDay1k) < Math.max(0.01, displayedDay1k * 0.02)) {
          return { found: true, sane: isSanePolymarketLevel({ flags: lv.flags ?? [] }) };
        }
      }
    }
  } else if (platform === 'Kalshi') {
    const raw = readJsonSafe(KALSHI_REWARDS_FILE);
    for (const m of raw?.markets ?? []) {
      for (const capStr of CAPITAL_TIERS) {
        const lv = m.levels?.[capStr];
        if (!lv || !lv.grossRewardDay) continue;
        const day1k = scaleToCapitalBasis(lv.grossRewardDay, +capStr, LANDING_CAPITAL_BASIS);
        if (Math.abs(day1k - displayedDay1k) < Math.max(0.01, displayedDay1k * 0.02)) {
          return { found: true, sane: isSaneKalshiMarket(m, capStr) };
        }
      }
    }
  }
  return { found: false, sane: null };
}

// ── Independent recompute: basis / sports / prediction ───────────────────────
// These files already carry the final computed number (agent19/agent-fetcher
// own that math); the landing page's job is only selection, so the parallel
// path here re-derives the SAME selection rule from the SAME data.
function recomputeBasis() {
  const raw = readJsonSafe(BASIS_FILE);
  const opps = raw?.opportunities ?? [];
  const sorted = [...opps]
    .filter(o => (o.netAnnualizedExecutable ?? o.netAnnualized ?? 0) > 0)
    .sort((a, b) => (b.netAnnualizedExecutable ?? b.netAnnualized ?? 0) - (a.netAnnualizedExecutable ?? a.netAnnualized ?? 0));
  if (!sorted.length) return null;
  const top = sorted[0];
  // netAnnualizedExecutable/netAnnualized are fractions (0.0363 = 3.63%/yr) —
  // *100 before rounding. Mirrors app/page.tsx's readLandingStats() basis block.
  return { asset: top.asset, netAnnualized: Math.round((top.netAnnualizedExecutable ?? top.netAnnualized ?? 0) * 1000) / 10 };
}

function recomputeSports() {
  const raw = readJsonSafe(SPORTS_FILE);
  if (!raw) return null;
  if (Date.now() - (typeof raw.fetchedAt === 'number' ? raw.fetchedAt : 0) >= SPORTS_STALE_MS) return null;
  const valid = (raw.arbOpportunities ?? [])
    .filter(a => !a.isStale && (a.netMargin ?? a.grossMargin ?? 0) > 0)
    .sort((a, b) => (b.netMargin ?? 0) - (a.netMargin ?? 0));
  if (!valid.length) return null;
  return { netMargin: valid[0].netMargin ?? valid[0].grossMargin };
}

function recomputePrediction() {
  const raw = readJsonSafe(ARB_FILE);
  const s = raw?.stats ?? {};
  const cash = s.confirmedCashable ?? 0;
  const tot  = cash + (s.rejectedNotSameEvent ?? 0) + (s.pendingVerification ?? 0);
  return { cashable: cash, pairsChecked: tot };
}

// ── Evaluate one displayed row against its independent recompute ────────────
const TOL = (a, b, absTol, relTol) => Math.abs(a - b) <= Math.max(absTol, Math.abs(b) * relTol);

function evaluateRow(row, hasApyCapLabel) {
  const violations = [];
  const cls = classifyRow(row);
  const rawVal = row.value;

  if (/NaN|undefined|Infinity/i.test(rawVal) || /NaN|undefined|Infinity/i.test(row.unit)) {
    violations.push(`MISSING/FABRICATED: "${row.nameRaw}" shows "${rawVal}" — non-finite value rendered`);
    return { cls, violations, impliedApy: null };
  }

  const num = parseNumber(rawVal);
  if (Number.isNaN(num)) {
    violations.push(`MISSING/FABRICATED: "${row.nameRaw}" value "${rawVal}" is not parseable as a number`);
    return { cls, violations, impliedApy: null };
  }

  let impliedApy = null; // only rows expressing a $/day-per-$1k or %/yr rate get the daily/annual checks

  if (cls.key === 'funding' && cls.coin) {
    const m = /short (\S+)\s*·\s*long (\S+)/.exec(row.subRaw) || /short (\S+).*long (\S+)/.exec(row.subRaw);
    if (!m) {
      violations.push(`MISSING/FABRICATED: funding row "${row.nameRaw}" — could not parse short/long exchanges from "${row.subRaw}"`);
    } else {
      const expected = recomputeFunding(m[1], m[2], cls.coin);
      if (!expected) {
        violations.push(`MISSING/FABRICATED: funding row shows ${cls.coin} ${m[1]}/${m[2]} at $${num}/day but no matching entry found in ${EXCHANGE_FILE}`);
      } else {
        if (!TOL(num, expected.dayUsd1k, 0.02, 0.02)) {
          violations.push(`DIVERGENCE: funding ${cls.coin} displayed $${num}/day vs recomputed $${expected.dayUsd1k}/day (independent path from ${EXCHANGE_FILE})`);
        }
        // NOTE: the landing intentionally headlines the true net/day max across the
        // FULL shared spreads list — the same rows the funding-arb dashboard ranks —
        // which INCLUDES thin-book / one-leg-unverified pairs. A thin book only limits
        // executable SIZE (surfaced separately on the order page); it does NOT
        // disqualify the opportunity. So thin/unverified is no longer a landing
        // violation. The value-match check above stays the real anti-fabrication guard.
      }
    }
    impliedApy = num * 36.5; // $/day per $1k → %/yr (num/1000 * 365 * 100)
  }

  if (cls.key === 'rewards' && cls.platform) {
    const expected = recomputeRewards();
    if (!expected || expected.platform !== cls.platform) {
      violations.push(`MISSING/FABRICATED: rewards row shows ${cls.platform} $${num}/day but independent recompute found no matching sane candidate`);
    } else if (!TOL(num, expected.day1k, 0.02, 0.02)) {
      violations.push(`DIVERGENCE: ${cls.platform} rewards displayed $${num}/day vs recomputed $${expected.day1k.toFixed(2)}/day`);
    }
    const gate = findDisplayedRewardGateStatus(cls.platform, num);
    if (gate.found && gate.sane === false) {
      violations.push(`GATE INTEGRITY: displayed ${cls.platform} reward $${num}/day matches a market that FAILS the sane-market gate (TRAP/SHORT_BURST/THIN_CAP/BELOW_FLOOR/ONE_SIDED/flags) — should have been excluded`);
    } else if (!gate.found) {
      violations.push(`MISSING/FABRICATED: displayed ${cls.platform} reward $${num}/day has no matching level in the source rewards file`);
    }
    impliedApy = num * 36.5;
  }

  if (cls.key === 'carry' && cls.asset) {
    const expected = recomputeBasis();
    if (!expected || expected.asset !== cls.asset) {
      violations.push(`MISSING/FABRICATED: carry row shows ${cls.asset} +${num}%/yr but independent recompute found no matching top candidate`);
    } else if (!TOL(num, expected.netAnnualized, 0.1, 0.02)) {
      violations.push(`DIVERGENCE: ${cls.asset} carry displayed +${num}%/yr vs recomputed +${expected.netAnnualized}%/yr`);
    }
    // Expired-instrument guard: the carry sub-line renders "{exchange} · {contract}".
    // If any token is a dated future whose expiry is past, the landing is showing a
    // fabricated (expired) instrument — the exact BTC-25JUN class.
    const now = Date.now();
    for (const tok of String(row.subRaw || '').split(/[\s·|]+/)) {
      const expMs = parseInstrumentExpiryMs(tok);
      if (expMs != null && expMs <= now) {
        violations.push(`EXPIRED INSTRUMENT ON LANDING: carry row references ${tok} (expired ${new Date(expMs).toISOString().slice(0, 10)}) — must never be displayed`);
      }
    }
    impliedApy = num;
  }

  if (cls.key === 'sports') {
    const expected = recomputeSports();
    if (!expected) {
      violations.push(`MISSING/FABRICATED: sports row shows +${num}% but independent recompute found no fresh valid arb`);
    } else if (!TOL(num, expected.netMargin, 0.1, 0.02)) {
      violations.push(`DIVERGENCE: sports margin displayed +${num}% vs recomputed +${expected.netMargin}%`);
    }
    // netMargin is a one-time per-event margin, not a daily/annual rate — excluded from impliedApy checks.
  }

  if (cls.key === 'prediction') {
    const expected = recomputePrediction();
    if (!expected || expected.cashable !== num) {
      violations.push(`DIVERGENCE: prediction arb count displayed ${num} vs recomputed ${expected ? expected.cashable : 'null'} from ${ARB_FILE}`);
    }
    // a count, not a rate — excluded from impliedApy checks.
  }

  if (impliedApy != null) {
    const impliedDailyPct = impliedApy / 365;
    if (impliedDailyPct > 10) {
      violations.push(`HARD IMPOSSIBLE: "${row.nameRaw}" implies ${impliedDailyPct.toFixed(1)}%/day (~${impliedApy.toFixed(0)}%/yr) — regardless of chip/label this is not real`);
    }
    if (row.chip === 'cashable' && impliedApy > APY_CAP) {
      violations.push(`CASHABLE-TOO-GOOD: "${row.nameRaw}" is marked cashable but implies ${impliedApy.toFixed(0)}%/yr — too good to be true, verify it's real`);
    }
    if (row.chip !== 'cashable' && impliedApy > APY_CAP && !hasApyCapLabel) {
      violations.push(`LABEL RULE: "${row.nameRaw}" is non-cashable and implies ${impliedApy.toFixed(0)}%/yr without the "${APY_CAP_LABEL}" label`);
    }
  }

  return { cls, violations, impliedApy };
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

// CROSS-CYCLE rule 5: a cashable value that swings > 50% between two consecutive cycles
// is suppressed until it stabilizes. Only the serve-path CAN'T see across cycles, so this
// agent computes it and writes a reversible, TTL-bounded directive the suppressor honors.
// Returns { directives, curNet } — curNet is carried in state for next cycle's compare.
async function buildGuardianDirectives(state) {
  const now = Date.now();
  const prevNet = (state && state.guardianPrevNet) || {};
  const curNet = {};
  const directives = [];

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
    for (const row of rows) {
      const id  = servedRowId(section, row);
      const net = servedNet(section, row);
      if (id == null || typeof net !== 'number' || !isFinite(net)) continue;
      const key = `${section}:${id}`;
      curNet[key] = net;
      const prev = prevNet[key];
      if (typeof prev !== 'number' || !isFinite(prev)) continue;   // need two cycles to judge a swing
      const base = Math.max(Math.abs(prev), 1e-9);
      const swing = Math.abs(net - prev) / base;
      // Only act on a MATERIAL number (avoid noise near zero) that swings past the shared
      // threshold. Suppress the value (display-only) until it stabilizes.
      if ((Math.abs(prev) > 0.05 || Math.abs(net) > 0.05) && swing > CASHABLE_SWING) {
        directives.push({
          section, rowId: id, action: 'suppress-value', rule: 'A5',
          reason: `value swung ${(swing * 100).toFixed(0)}% between cycles (${prev} → ${net}, > ${(CASHABLE_SWING * 100)}%) — suppressed until it stabilizes`,
          expiresAt: now + GUARDIAN_DIRECTIVE_TTL_MS,
        });
      }
    }
  }

  // Always write (even empty) so the file self-heals: once a value stabilizes, its
  // directive is not re-emitted and the suppression clears on the next serve read.
  try {
    atomicWriteJson(GUARDIAN_DIRECTIVES_FILE, { updatedAt: now, directives }, { pretty: true });
  } catch (e) { log('guardian directive write failed:', e.message); }

  return { directives, curNet };
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

// ── One audit cycle ───────────────────────────────────────────────────────
async function runCycle(state) {
  const html = await fetchText(LANDING_URL);
  const hasApyCapLabel = html.includes(APY_CAP_LABEL);
  const rows = parseLandingRows(html);

  const allViolations = [];
  for (const row of rows) {
    const { violations } = evaluateRow(row, hasApyCapLabel);
    allViolations.push(...violations);
  }

  // Phase 4: phantom-instrument class checks on the served feeds + sanity-reject spike.
  allViolations.push(...auditServedFeeds());
  allViolations.push(...auditRewardsTooGood());
  const spike = auditSanityRejectSpike(state && state.sanityRejectSeen);
  allViolations.push(...spike.violations);

  // GUARDIAN observe: watch the serve-path guardian log for the CRITICAL guardrail.
  const gLog = auditGuardianLog(state && state.guardianCriticalSeen);
  allViolations.push(...gLog.violations);

  // GUARDIAN rule H (31–33): fetch the tab APIs with NO session (free tier) and assert every
  // redacted derived-edge field is null — any survivor is a paid value leaking to free.
  try { allViolations.push(...await auditPaidGatingLeaks()); }
  catch (e) { log('auditPaidGatingLeaks error:', e.message); }

  // GUARDIAN direct: emit cross-cycle (rule 5 cashable-swing) directives the serve path
  // cannot compute alone. Reversible + TTL-bounded; self-heals when values stabilize.
  let guardianPrevNet = state && state.guardianPrevNet;
  try {
    const gd = await buildGuardianDirectives(state);
    guardianPrevNet = gd.curNet;
    if (gd.directives.length) {
      log(`guardian directives written: ${gd.directives.length} cashable-swing suppression(s)`);
    }
  } catch (e) { log('buildGuardianDirectives error:', e.message); }

  log(`cycle ok — ${rows.length} live row(s), ${allViolations.length} violation(s), sanity-rejects=${spike.total}, guardian-critical=${gLog.criticalCount}`);
  return {
    violations: allViolations,
    sanityRejectSeen: spike.total,
    guardianCriticalSeen: gLog.criticalCount,
    guardianPrevNet,
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
  log(`  Landing URL: ${LANDING_URL}`);
  log(`  Interval: ${SCAN_INTERVAL_MS / 60_000} min · alert dedupe window: ${ALERT_COOLDOWN_MS / 3_600_000}h`);

  await new Promise(r => setTimeout(r, STARTUP_DELAY_MS));

  let state = loadState();
  let first = !state.firstCheckDone;

  while (true) {
    try {
      const { violations, sanityRejectSeen, guardianCriticalSeen, guardianPrevNet } = await runCycle(state);
      // carry the delta-detection high-water marks + cross-cycle net snapshot forward
      state = { ...state, sanityRejectSeen, guardianCriticalSeen, guardianPrevNet };
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
module.exports = { auditServedFeeds, auditSanityRejectSpike, auditGuardianLog, servedNet, servedRowId, auditPaidGatingLeaks };

if (require.main === module) {
  main().catch(e => { console.error('[A26] Fatal:', e); process.exit(1); });
}
