#!/usr/bin/env node
'use strict';

// agent12-sports.js — Sports Arbitrage Snapshot Scanner  (Phase A: read-only)
//
// ONE snapshot scan per invocation, then exits.  Run manually:
//   node agents/agent12-sports.js
//
// DO NOT add to PM2 autostart — each run costs credits from the 500/month budget.
// ODDS_API_KEY must be set in .env.local — never hardcoded here.

const fs    = require('fs');
const path  = require('path');
const https = require('https');

// ── Load .env.local (pm2 / shell doesn't source it automatically) ─────────────
const _envLocal = path.join(__dirname, '../.env.local');
if (fs.existsSync(_envLocal)) {
  for (const line of fs.readFileSync(_envLocal, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] == null)
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ── Config ────────────────────────────────────────────────────────────────────
const REGIONS          = ['eu'];
const MARKETS          = ['h2h'];
const ODDS_FORMAT      = 'decimal';
const SPORTS_ALLOWLIST = [
  'soccer_epl', 'soccer_uefa_champs_league', 'soccer_italy_serie_a',
  'soccer_spain_la_liga', 'basketball_nba', 'americanfootball_nfl',
  'icehockey_nhl', 'baseball_mlb', 'tennis_atp', 'tennis_wta',
];
const MIN_BOOKMAKERS      = 4;     // event ignored if fewer books quote it
const OUTLIER_PCT         = 0.25;  // book's implied prob deviating > this from median → outlier
const MAX_PLAUSIBLE_ROI   = 0.06;  // h2h arb > 6% net → almost certainly a data error → quarantine
const CREDIT_SAFETY_FLOOR = 30;    // stop scanning if remaining credits would drop to this

// ── Files ─────────────────────────────────────────────────────────────────────
const DATA_DIR     = path.join(__dirname, '../data/sports');
const OUTPUT_FILE  = path.join(DATA_DIR, 'opportunities.json');
const CREDITS_FILE = path.join(DATA_DIR, 'credits.json');

// ── Validate API key ──────────────────────────────────────────────────────────
const ODDS_API_KEY = process.env.ODDS_API_KEY;
if (!ODDS_API_KEY) {
  console.error('[sports] FATAL: ODDS_API_KEY not set — add it to .env.local and re-run');
  process.exit(1);
}
const BASE_URL = 'https://api.the-odds-api.com/v4';

// ── Utilities ─────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function atomicWrite(file, obj) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// ── Credit state (persisted between manual runs) ──────────────────────────────
let credits = { remaining: null, used: null, lastChecked: null, lastScan: null };
try { credits = JSON.parse(fs.readFileSync(CREDITS_FILE, 'utf8')); } catch {}

function persistCredits() { atomicWrite(CREDITS_FILE, credits); }

function updateCreditsFromHeaders(headers) {
  const r = headers['x-requests-remaining'];
  const u = headers['x-requests-used'];
  const l = headers['x-requests-last'];
  if (r != null) credits.remaining  = parseInt(r, 10);
  if (u != null) credits.used       = parseInt(u, 10);
  if (l != null) credits.lastHeader = l;
  credits.lastChecked = new Date().toISOString();
  persistCredits();
}

function floorReached() {
  return credits.remaining != null && credits.remaining <= CREDIT_SAFETY_FLOOR;
}

// ── HTTP (captures headers for credit tracking) ───────────────────────────────
function httpGet(url, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };
    const timer  = setTimeout(() => { req.destroy(); settle(reject, new Error('timeout')); }, timeoutMs);
    const req    = https.get(url, {
      headers: { 'User-Agent': 'arb-scanner/1.0', 'Accept': 'application/json' },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        const body = Buffer.concat(chunks).toString();
        try {
          settle(resolve, { status: res.statusCode, headers: res.headers, data: JSON.parse(body) });
        } catch (e) {
          settle(reject, new Error(`HTTP ${res.statusCode} bad JSON: ${body.slice(0, 120)}`));
        }
      });
    });
    req.on('error', e => { clearTimeout(timer); settle(reject, e); });
  });
}

// ── Arb computation (one event) ───────────────────────────────────────────────
// Returns one of:
//   { type: 'no_arb' }
//   { type: 'too_few_books' }
//   { type: 'false_positive', reason }      — arb existed only because of outlier
//   { type: 'quarantine', record, reason }  — implausibly high ROI
//   { type: 'real', record }

function computeArb(ev, sportKey) {
  const bookmakers = ev.bookmakers ?? [];

  // (a) Minimum bookmaker gate
  if (bookmakers.length < MIN_BOOKMAKERS) return { type: 'too_few_books' };

  // Collect all (bookmaker, price) pairs per outcome
  const outcomeMap = {};  // outcomeName → [{bookmakerId, bookmaker, price}]
  for (const bk of bookmakers) {
    for (const oc of bk.outcomes ?? []) {
      if (!oc.name || !(oc.price > 1)) continue;
      if (!outcomeMap[oc.name]) outcomeMap[oc.name] = [];
      outcomeMap[oc.name].push({ bookmakerId: bk.key, bookmaker: bk.title, price: oc.price });
    }
  }
  const names = Object.keys(outcomeMap);
  if (names.length < 2) return { type: 'no_arb' };

  function bestFrom(name, excludeIds) {
    const cands = outcomeMap[name].filter(e => !excludeIds.has(e.bookmakerId));
    return cands.length ? cands.reduce((b, e) => e.price > b.price ? e : b) : null;
  }

  // Check whether any arb exists at all (with ALL books, including outliers)
  const legsAll = names.map(n => bestFrom(n, new Set()));
  if (legsAll.some(l => !l)) return { type: 'no_arb' };
  const impliedAll = legsAll.reduce((s, l) => s + 1 / l.price, 0);
  if (impliedAll >= 1) return { type: 'no_arb' };

  // (b) Outlier detection: flag books whose implied prob is >OUTLIER_PCT below median per outcome
  const outlierIds = new Set();
  for (const name of names) {
    const entries = outcomeMap[name];
    const probs   = entries.map(e => 1 / e.price).sort((a, b) => a - b);
    const mid     = Math.floor(probs.length / 2);
    const median  = probs.length % 2 === 0
      ? (probs[mid - 1] + probs[mid]) / 2
      : probs[mid];
    for (const e of entries) {
      if (median - (1 / e.price) > OUTLIER_PCT) outlierIds.add(e.bookmakerId);
    }
  }

  // (c) Recompute without outliers — if arb vanishes it was a false positive
  const outliersRemoved = outlierIds.size > 0;
  const legsClean = names.map(n => bestFrom(n, outlierIds));
  if (legsClean.some(l => !l)) return { type: 'false_positive', reason: 'no_clean_price_after_outlier_removal' };

  const impliedClean = legsClean.reduce((s, l) => s + 1 / l.price, 0);
  if (impliedClean >= 1) return { type: 'false_positive', reason: 'outlier_was_only_arb_leg' };

  const roi = (1 / impliedClean) - 1;

  const record = {
    sport:           sportKey,
    eventName:       `${ev.home_team} vs ${ev.away_team}`,
    commenceTime:    ev.commence_time,
    type:            names.length === 2 ? '2way' : '3way',
    legs: legsClean.map(l => ({
      outcome:   l.outcome ?? names[legsClean.indexOf(l)],
      bookmaker: l.bookmaker,
      odd:       l.price,
      stakePct:  Math.round(((1 / l.price) / impliedClean) * 10000) / 100,
    })),
    roiPct:          Math.round(roi * 10000) / 100,
    impliedSum:      Math.round(impliedClean * 10000) / 10000,
    outliersRemoved,
    numBookmakers:   bookmakers.length,
    lastUpdated:     new Date().toISOString(),
  };

  // Fix outcome names in legs (map through original names array)
  for (let i = 0; i < names.length; i++) {
    record.legs[i].outcome = names[i];
  }

  // (d) Quarantine implausibly high ROI
  if (roi > MAX_PLAUSIBLE_ROI) {
    return { type: 'quarantine', record: { ...record, reason: 'roi_above_plausible' } };
  }

  return { type: 'real', record };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function scan() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Monthly budget floor guard — exits before ANY HTTP call (including free /sports)
  if (floorReached()) {
    console.log(
      `[sports] MONTHLY FLOOR — scan skipped` +
      ` (remaining: ${credits.remaining} <= ${CREDIT_SAFETY_FLOOR})` +
      ` — credits reset at start of next billing cycle`
    );
    process.exit(0);
  }

  const creditsBefore = credits.remaining;
  console.log(`[sports] === snapshot scan start | credits before: ${creditsBefore ?? 'unknown'} ===`);

  // Step 1: GET /sports — FREE (0 credits consumed)
  let activeSportKeys = new Set();
  try {
    const r = await httpGet(`${BASE_URL}/sports?apiKey=${ODDS_API_KEY}&all=false`);
    if (r.status === 200 && Array.isArray(r.data)) {
      for (const s of r.data) if (s.active) activeSportKeys.add(s.key);
      console.log(`[sports] /sports: ${activeSportKeys.size} active sports (0 credits consumed)`);
    } else {
      console.error(`[sports] /sports HTTP ${r.status}:`, JSON.stringify(r.data).slice(0, 200));
    }
  } catch (e) {
    console.error('[sports] /sports error:', e.message);
  }

  const targetSports = SPORTS_ALLOWLIST.filter(k => activeSportKeys.has(k));
  if (targetSports.length === 0) {
    console.log('[sports] no allowlisted sports are currently active — exiting with empty result');
  } else {
    console.log(`[sports] target: ${targetSports.join(', ')}`);
  }

  // Step 2: GET /odds per sport (each call costs 1 credit)
  const opportunities      = [];
  const quarantine         = [];
  const sportsScanned      = [];
  let   tooFewBooks        = 0;
  let   noArbCount         = 0;
  let   falsePositives     = 0;

  for (const sportKey of targetSports) {
    // Credit guard: check BEFORE spending
    if (floorReached()) {
      console.warn(
        `[sports] CREDIT FLOOR REACHED (${credits.remaining} <= ${CREDIT_SAFETY_FLOOR})` +
        ` — scan stopped to protect monthly budget`
      );
      break;
    }

    const url = [
      `${BASE_URL}/sports/${sportKey}/odds/`,
      `?apiKey=${ODDS_API_KEY}`,
      `&regions=${REGIONS.join(',')}`,
      `&markets=${MARKETS.join(',')}`,
      `&oddsFormat=${ODDS_FORMAT}`,
    ].join('');

    let events = [];
    try {
      const r = await httpGet(url);
      updateCreditsFromHeaders(r.headers);  // always update from headers

      if (r.status === 200 && Array.isArray(r.data)) {
        events = r.data;
        sportsScanned.push(sportKey);
        console.log(
          `[sports] ${sportKey}: ${events.length} events` +
          ` | remaining: ${credits.remaining ?? '?'}` +
          ` | used: ${credits.used ?? '?'}`
        );
      } else {
        console.error(`[sports] ${sportKey} HTTP ${r.status}:`, JSON.stringify(r.data).slice(0, 200));
      }
    } catch (e) {
      console.error(`[sports] ${sportKey} error:`, e.message);
    }

    for (const ev of events) {
      const res = computeArb(ev, sportKey);
      switch (res.type) {
        case 'real':          opportunities.push(res.record);  break;
        case 'quarantine':    quarantine.push(res.record);     break;
        case 'false_positive': falsePositives++;               break;
        case 'too_few_books': tooFewBooks++;                   break;
        case 'no_arb':        noArbCount++;                    break;
      }
    }

    await sleep(300);  // small pause between sport requests
  }

  opportunities.sort((a, b) => b.roiPct - a.roiPct);

  // Write output atomically
  const output = {
    lastUpdated:      new Date().toISOString(),
    creditsRemaining: credits.remaining,
    creditsUsed:      credits.used,
    scanMode:         'snapshot',
    regions:          REGIONS,
    sportsScanned,
    opportunities,
    quarantine,
  };
  atomicWrite(OUTPUT_FILE, output);

  credits.lastScan = new Date().toISOString();
  persistCredits();

  // Console summary (honest)
  const creditsSpent = creditsBefore != null && credits.remaining != null
    ? creditsBefore - credits.remaining : null;

  console.log('\n[sports] === SCAN COMPLETE ===');
  console.log(`  Sports scanned:          ${sportsScanned.length}  (${sportsScanned.join(', ') || 'none'})`);
  console.log(`  Credits before scan:     ${creditsBefore ?? 'unknown'}`);
  console.log(`  Credits remaining:       ${credits.remaining ?? 'unknown'}`);
  console.log(`  Credits spent this run:  ${creditsSpent ?? 'unknown'}`);
  console.log(`  Real arb opportunities:  ${opportunities.length}`);
  console.log(`  Quarantined (bad data):  ${quarantine.length}`);
  console.log(`  False positives removed: ${falsePositives}  (outlier was the only arb leg)`);
  console.log(`  Skipped (< ${MIN_BOOKMAKERS} books):   ${tooFewBooks}`);
  console.log(`  No arb at all:           ${noArbCount}`);

  if (opportunities.length === 0) {
    console.log('\n  [honest] 0 real arb opportunities — this is the expected result most of the time.');
    console.log('  Sports books are efficient; genuine arb windows are rare and close in seconds.');
  } else {
    console.log('\n  Top real opportunities:');
    for (const op of opportunities.slice(0, 5)) {
      console.log(`    [${op.type}] ${op.eventName} (${op.sport}) — ROI: +${op.roiPct}%`);
      for (const leg of op.legs) {
        console.log(`      ${leg.outcome}: ${leg.bookmaker} @ ${leg.odd}  (${leg.stakePct}% of bankroll)`);
      }
    }
  }

  if (quarantine.length > 0) {
    console.log('\n  Quarantined (ROI > 6% → likely data error, do NOT act on these):');
    for (const q of quarantine.slice(0, 5)) {
      console.log(`    ${q.eventName} — +${q.roiPct}% (${q.reason})`);
    }
  }

  console.log(`\n  Output  : ${OUTPUT_FILE}`);
  console.log(`  Credits : ${CREDITS_FILE}`);
}

scan().catch(err => {
  console.error('[sports] fatal:', err.stack || err.message);
  process.exit(1);
});
