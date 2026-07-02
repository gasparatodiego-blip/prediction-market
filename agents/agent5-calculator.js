#!/usr/bin/env node
'use strict';

const fs       = require('fs');
const path     = require('path');

// Fee rates mirror lib/fees.ts — update both if rates change
const PLATFORM_FEES = {
  kalshi:     0.07,
  polymarket: 0.02,
  predictit:  0.10 + 0.05, // win fee + withdrawal fee
  manifold:   0.00,
  oddsapi:    0.00,
};

// Canonical executable-price arb check + executable-platform set — same source
// matcher-v2.js and agent23-prediction-repricer.js already use, so the
// cashable determination here can never diverge from the live re-pricer's math.
const { computeArbROI: computeExecutableArbROI, EXECUTABLE_PLATFORMS } = require('../lib/arb-math');
// Event-level comparator buckets (additive to the pairwise arb output below) —
// same entity/proposition/office/year signals the same-event gate already
// computes, reused as a grouping key. See shared-matcher.js for the full
// rationale and the honest-engine guards (tiering, referenceOnly median, no
// fabricated quotes for platforms that don't list the event).
const { extractAllMarkets, buildEventBuckets } = require('./shared-matcher');

// Same-event legs should carry the same/similar resolution date; when the platforms'
// native fields disagree by more than a day (e.g. Kalshi keeps an umbrella market open
// through the following cycle while Polymarket closes at the named election date), the
// binding constraint for a hedged position is the EARLIER date — that leg forces
// settlement/close first — so the pair is flagged rather than silently averaged.
const RESOLUTION_MISMATCH_MS = 24 * 60 * 60 * 1000; // 1 day

function resolutionInfo(a, b) {
  const da = a.resolutionDate ? new Date(a.resolutionDate) : null;
  const db = b.resolutionDate ? new Date(b.resolutionDate) : null;
  const valid = [da, db].filter(d => d && !isNaN(d.getTime()));
  if (valid.length === 0) return { resolutionDate: null, daysToResolution: null, resolutionMismatch: false };

  const earliest = new Date(Math.min(...valid.map(d => d.getTime())));
  const resolutionMismatch = da && db && Math.abs(da.getTime() - db.getTime()) > RESOLUTION_MISMATCH_MS;
  const daysToResolution = Math.max(0, Math.ceil((earliest.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));

  return { resolutionDate: earliest.toISOString(), daysToResolution, resolutionMismatch };
}

const MATCH_FILES = [
  { path: '/tmp/matches-politics.json', category: 'politics'    },
  { path: '/tmp/matches-other.json',    category: 'sports/tech/econ' },
  { path: '/tmp/matches-crypto.json',   category: 'crypto/finance'   },
];
const ODDS_API_FILE = '/tmp/odds-api-raw.json';
const RAW_MARKETS_FILE = '/tmp/markets-raw.json';
const OUT_FILE  = '/tmp/arbitrage-opportunities.json';
const HB_FILE   = '/tmp/agent-heartbeats.json';
const INTERVAL  = 45_000;
const DB_PATH   = path.join(__dirname, '..', 'data', 'opportunities.db');
const EVENTS_MAX_AGE_MS = 5 * 60_000; // matches the matchers' own staleness bar on markets-raw.json

// Attaches the caller's already-computed pairwise opportunity (roi/cashable/
// capacity/settlement fields) to a bucket's lockableEdge, when one exists for
// the exact same two leg ids — never recomputes arb math independently of
// calcArb() above, so the two code paths can never disagree.
function attachMatchedOpportunity(edge, predMarketOpps) {
  if (!edge) return edge;
  const wanted = new Set([edge.yesLegId, edge.noLegId]);
  const match = predMarketOpps.find(o => {
    const ids = new Set([o.lowMarket?.id, o.highMarket?.id]);
    return ids.size === 2 && [...wanted].every(id => ids.has(id));
  });
  if (!match) return edge;
  return {
    ...edge,
    matchedOpportunity: {
      cashable:           match.cashable,
      roi:                match.roi,
      spread:             match.spread,
      earnPer100:         match.earnPer100,
      resolutionDate:     match.resolutionDate,
      daysToResolution:   match.daysToResolution,
      resolutionMismatch: match.resolutionMismatch,
      settlementType:     match.settlementType,
    },
  };
}

// Builds the additive event-comparator buckets over the FULL market universe
// (not just legs that cleared the pairwise IDF gate) so a platform phrased too
// differently to pair still shows up side by side. Returns [] (never throws,
// never blocks the pairwise output above) when markets-raw.json is missing or
// stale — same 5-min staleness bar the matcher agents apply to the same file.
function buildEvents(predMarketOpps) {
  try {
    const raw = JSON.parse(fs.readFileSync(RAW_MARKETS_FILE, 'utf8'));
    const age = Date.now() - (raw.fetchedAt || 0);
    if (age > EVENTS_MAX_AGE_MS) return [];
    const allMarkets = extractAllMarkets(raw);
    return buildEventBuckets(allMarkets).map(bucket => ({
      ...bucket,
      lockableEdge: attachMatchedOpportunity(bucket.lockableEdge, predMarketOpps),
    }));
  } catch (e) {
    console.error('[calculator] event bucketing error:', e.message);
    return [];
  }
}

function beat(name) {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb[name] = Date.now();
  fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2));
}

// Lazy-load better-sqlite3 so the agent still runs if the package is missing
let Database = null;
function getDb() {
  if (!Database) {
    try { Database = require('better-sqlite3'); } catch { return null; }
  }
  try {
    const dataDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS opportunities (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp    TEXT    NOT NULL,
        event_name   TEXT    NOT NULL,
        platform_low  TEXT   NOT NULL,
        platform_high TEXT   NOT NULL,
        prob_low     REAL    NOT NULL,
        prob_high    REAL    NOT NULL,
        roi          REAL    NOT NULL,
        spread       REAL    NOT NULL
      )
    `);
    return db;
  } catch (e) {
    console.error('[calculator] sqlite error:', e.message);
    return null;
  }
}

function saveToDb(opportunities) {
  const db = getDb();
  if (!db) return;
  try {
    const insert = db.prepare(`
      INSERT INTO opportunities (timestamp, event_name, platform_low, platform_high, prob_low, prob_high, roi, spread)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const ts = new Date().toISOString();
    const insertMany = db.transaction((opps) => {
      for (const o of opps) {
        insert.run(ts, o.question, o.lowMarket.platform, o.highMarket.platform,
          o.lowMarket.probability, o.highMarket.probability, o.roi, o.spread);
      }
    });
    insertMany(opportunities);
    // Keep only last 10000 rows
    db.prepare('DELETE FROM opportunities WHERE id NOT IN (SELECT id FROM opportunities ORDER BY id DESC LIMIT 10000)').run();
  } catch (e) {
    console.error('[calculator] db write error:', e.message);
  } finally {
    db.close();
  }
}

// ── OddsAPI arb constants ─────────────────────────────────────────────────────
const ODDS_MIN_MARGIN    = 0;              // % — include all positive margins
const ODDS_STALE_MARGIN  = 5;             // % — flag as likely stale / limit-only
const ODDS_STAKE_SAMPLE  = 1_000;         // $ — reference stake for stake-split output
const ODDS_MAX_AGE_MS    = 8 * 3_600_000; // 8 h — matches the 6 h live-fetch cadence
const ODDS_SNAPSHOT_FILE = '/tmp/odds-snapshot.json'; // offline cache takes priority

// Per-event arb check.
// For each outcome find the BEST decimal odds across all bookmakers, then
// test whether Σ(1/bestOdds_i) < 1 — the only correct arb condition.
// Requires legs from ≥ 2 different bookmakers (single-book "arb" isn't executable).
// Works for both 2-way (h2h without draw) and 3-way (h2h with draw).
// Ported from MIT reference: github.com/carterlasalle/SportsArbFinder
function findEventArb(ev, marketKey) {
  const best = {}; // outcome name → { odds, bookmaker }
  for (const bm of (ev.bookmakers || [])) {
    const market = (bm.markets || []).find(m => m.key === marketKey);
    if (!market) continue;
    for (const o of (market.outcomes || [])) {
      if (!o.price || o.price <= 1) continue;
      if (!best[o.name] || o.price > best[o.name].odds)
        best[o.name] = { odds: o.price, bookmaker: bm.title || bm.key };
    }
  }
  const names = Object.keys(best);
  if (names.length < 2) return null;
  if (new Set(names.map(n => best[n].bookmaker)).size < 2) return null; // single-book guard
  const legs = names.map(n => ({
    outcome: n, bookmaker: best[n].bookmaker,
    odds: best[n].odds, impliedProb: 1 / best[n].odds,
  }));
  const impliedSum = legs.reduce((s, l) => s + l.impliedProb, 0);
  if (impliedSum >= 1) return null;
  return { margin: (1 / impliedSum - 1) * 100, legs, impliedSum };
}

// Cross-bookmaker arb from The Odds API events.
// Correct formula: pick best odds per outcome across bookmakers, sum implied probs.
// If Σ(1/bestOdds_i) < 1 → guaranteed profit regardless of outcome.
function calcOddsApiArb() {
  const actionable = [], stale = [];
  try {
    // Prefer offline snapshot; fall back to live-fetched file
    const filePath = [ODDS_SNAPSHOT_FILE, ODDS_API_FILE].find(f => fs.existsSync(f));
    if (!filePath) return [];
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (filePath === ODDS_API_FILE) {
      const age = Date.now() - (raw.fetchedAt || 0);
      if (age > ODDS_MAX_AGE_MS) {
        console.log('[calculator] odds-api data too old, skipping');
        return [];
      }
    }
    const events = raw.events || [];
    if (!events.length) {
      console.log('[calculator] odds-api: 0 events (quota exhausted or no snapshot)');
      return [];
    }

    for (const ev of events) {
      const result = findEventArb(ev, 'h2h');
      if (!result || result.margin < ODDS_MIN_MARGIN) continue;
      const { margin, legs, impliedSum } = result;

      // Optimal stake split: stake_i = S × (1/odds_i) / Σ(1/odds_j)
      // guarantees equal payout = S / impliedSum regardless of outcome
      const withStakes = legs.map(leg => ({
        ...leg,
        stake:  +(ODDS_STAKE_SAMPLE * leg.impliedProb / impliedSum).toFixed(2),
        payout: +(ODDS_STAKE_SAMPLE * leg.impliedProb / impliedSum * leg.odds).toFixed(2),
      }));

      const sorted   = [...withStakes].sort((a, b) => b.impliedProb - a.impliedProb);
      const expiry   = ev.commence_time ? new Date(ev.commence_time).getTime() : null;
      const mkMarket = (leg, role) => ({
        id: `odds-${ev.id}-${role}`, platform: 'oddsapi', bookmaker: leg.bookmaker,
        probability: Math.round(leg.impliedProb * 100), url: null, volume: null, expiresAt: expiry,
      });

      const opp = {
        question:      `[${ev.sport_title}] ${ev.home_team} vs ${ev.away_team}`,
        sport:         ev.sport_title,
        market:        'h2h',
        commence_time: ev.commence_time,
        legs:          withStakes,
        impliedSum:    +impliedSum.toFixed(6),
        margin:        +margin.toFixed(4),
        roi:           +margin.toFixed(2),
        spread:        +((sorted[0].impliedProb - sorted.at(-1).impliedProb) * 100).toFixed(2),
        stale:         margin > ODDS_STALE_MARGIN,
        earnPer100:    +margin.toFixed(2),
        confidence:    margin > ODDS_STALE_MARGIN ? 0.3 : 0.9,
        category:      'sports/bookmaker',
        lowMarket:     mkMarket(sorted.at(-1), 'high'),
        highMarket:    mkMarket(sorted[0],     'low'),
      };
      (margin > ODDS_STALE_MARGIN ? stale : actionable).push(opp);
    }
  } catch (e) {
    console.error('[calculator] odds-api arb error:', e.message);
  }
  console.log(`[calculator] odds-api: ${actionable.length} actionable, ${stale.length} stale-flagged`);
  return [
    ...actionable.sort((a, b) => b.margin - a.margin),
    ...stale.sort((a, b) => b.margin - a.margin),
  ];
}

function calcArb(matches) {
  const results = [];
  for (const m of matches) {
    const a = m.marketA;
    const b = m.marketB;
    if (!a || !b) continue;

    const spread = Math.abs(a.probability - b.probability);
    if (spread < 3) continue;

    const low  = a.probability <= b.probability ? a : b;
    const high = a.probability >  b.probability ? a : b;
    const roi  = spread > 0 && spread < 100 ? (spread / (100 - spread)) * 100 : 0;
    if (roi > 80 || roi <= 0) continue;

    const feeA   = PLATFORM_FEES[low.platform]  || 0;
    const feeB   = PLATFORM_FEES[high.platform] || 0;
    const netRoi = roi * (1 - feeA - feeB);
    if (netRoi <= 0) continue;

    const earnPer100 = Math.round((netRoi / 100) * 100 * 10) / 10;

    // Canonical cashable determination — NEVER the midpoint `roi` above (that's
    // derived from `.probability`, a last-trade/AMM value on some platforms).
    // Cashable requires: both legs on a real executable-book platform (Kalshi,
    // Polymarket — never Manifold/PredictIt/OddsAPI regardless of spread size),
    // AND a positive net-of-fees edge on the legs' actual yesBid/yesAsk quotes.
    // This only certifies the Tier-1 snapshot is a genuine candidate; agent23
    // re-verifies against live order books before anything reaches the API as
    // truly live-cashable.
    const bothExecutable = EXECUTABLE_PLATFORMS.has(a.platform) && EXECUTABLE_PLATFORMS.has(b.platform);
    const executableArb  = bothExecutable
      ? computeExecutableArbROI({
          yesAsk_A: a.yesAsk, yesBid_A: a.yesBid,
          yesAsk_B: b.yesAsk, yesBid_B: b.yesBid,
          platformA: a.platform, platformB: b.platform,
        })
      : null;
    const cashable = bothExecutable && executableArb !== null;

    // Prediction-market pairs pay out ONCE at resolution — there is no recurring
    // yield to annualize, so settlementType is always "one_time" and no $/day or
    // annualized figure is ever derived here, regardless of how far out the
    // resolution date sits (honest-engine: fabricating a rate from a one-time
    // payout is the failure mode this exists to prevent).
    const { resolutionDate, daysToResolution, resolutionMismatch } = resolutionInfo(low, high);

    results.push({
      question:   high.question,
      cashable,
      lowMarket:  { ...low,  platform: low.platform  },
      highMarket: { ...high, platform: high.platform },
      spread:     Math.round(spread * 10) / 10,
      roi:        Math.round(netRoi * 10) / 10,
      earnPer100,
      confidence: m.confidence || 1,
      category:   m.category || 'unknown',
      resolutionDate,
      daysToResolution,
      resolutionMismatch,
      settlementType: 'one_time',
    });
  }
  return results.sort((a, b) => b.roi - a.roi);
}

function run() {
  let allMatches = [];

  for (const { path: p, category } of MATCH_FILES) {
    if (!fs.existsSync(p)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      const age  = Date.now() - (data.updatedAt || 0);
      if (age < 600_000) {
        allMatches = allMatches.concat((data.matches || []).map(m => ({ ...m, category })));
      }
    } catch {}
  }

  const predMarketOpps = calcArb(allMatches);
  const oddsApiOpps    = calcOddsApiArb();
  // Merge: prediction market opps first (AI-matched), then cross-bookmaker sports arb
  const opportunities  = [...predMarketOpps, ...oddsApiOpps].slice(0, 30);
  console.log(`[calculator] ${allMatches.length} matches → ${predMarketOpps.length} pred-market opps + ${oddsApiOpps.length} bookmaker opps = ${opportunities.length} total`);

  // Additive event-comparator buckets — built from the FULL pairwise list
  // (predMarketOpps, before the slice(0,30) cap above) so a lockable edge can
  // still find its matching opportunity even if that opportunity didn't make
  // the top-30 cut. Never alters `opportunities` itself.
  const events = buildEvents(predMarketOpps);
  console.log(`[calculator] ${events.length} event buckets (${events.filter(e => e.lockableEdge).length} with a lockable edge)`);

  fs.writeFileSync(OUT_FILE, JSON.stringify({
    updatedAt:     Date.now(),
    opportunities,
    events,
    stats: {
      total:       opportunities.length,
      bestRoi:     opportunities[0]?.roi ?? 0,
      totalSpread: opportunities.reduce((s, o) => s + o.spread, 0),
    },
  }, null, 2));

  if (opportunities.length > 0) saveToDb(opportunities);
  beat('calculator');
}

run();
setInterval(run, INTERVAL);
