#!/usr/bin/env node
'use strict';

const fs       = require('fs');
const path     = require('path');

const MATCH_FILES = [
  { path: '/tmp/matches-politics.json', category: 'politics'    },
  { path: '/tmp/matches-other.json',    category: 'sports/tech/econ' },
  { path: '/tmp/matches-crypto.json',   category: 'crypto/finance'   },
];
const ODDS_API_FILE = '/tmp/odds-api-raw.json';
const OUT_FILE  = '/tmp/arbitrage-opportunities.json';
const HB_FILE   = '/tmp/agent-heartbeats.json';
const INTERVAL  = 45_000;
const DB_PATH   = path.join(__dirname, '..', 'data', 'opportunities.db');

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

// Cross-bookmaker arb from The Odds API events
function calcOddsApiArb() {
  const results = [];
  try {
    if (!fs.existsSync(ODDS_API_FILE)) return results;
    const raw  = JSON.parse(fs.readFileSync(ODDS_API_FILE, 'utf8'));
    const age  = Date.now() - (raw.fetchedAt || 0);
    if (age > 600_000) return results; // stale > 10 min
    const events = raw.events || [];

    for (const ev of events) {
      const bookmakers = ev.bookmakers || [];
      // Collect implied probs per outcome across all bookmakers
      const outcomeProbs = {}; // outcome name → [{bm, prob}]
      for (const bm of bookmakers) {
        const h2h = (bm.markets || []).find(m => m.key === 'h2h');
        if (!h2h) continue;
        for (const outcome of h2h.outcomes || []) {
          if (!outcome.price || outcome.price <= 1) continue;
          const prob = (1 / outcome.price) * 100;
          if (!outcomeProbs[outcome.name]) outcomeProbs[outcome.name] = [];
          outcomeProbs[outcome.name].push({ bm: bm.title || bm.key, prob });
        }
      }

      // For each outcome, find spread between highest and lowest bookmaker
      for (const [outcomeName, entries] of Object.entries(outcomeProbs)) {
        if (entries.length < 2) continue;
        entries.sort((a, b) => a.prob - b.prob);
        const low  = entries[0];
        const high = entries[entries.length - 1];
        const spread = high.prob - low.prob;
        if (spread < 3) continue;
        const roi = (spread / low.prob) * 100;
        if (roi > 300 || roi <= 0) continue;

        const question = `[${ev.sport_title}] ${ev.home_team} vs ${ev.away_team} — ${outcomeName}`;
        results.push({
          question,
          lowMarket: {
            id:          `odds-low-${ev.id}-${outcomeName}`,
            platform:    'oddsapi',
            bookmaker:   low.bm,
            probability: Math.round(low.prob * 10) / 10,
            url:         null,
            volume:      null,
            liquidity:   null,
            expiresAt:   ev.commence_time ? new Date(ev.commence_time).getTime() : null,
          },
          highMarket: {
            id:          `odds-high-${ev.id}-${outcomeName}`,
            platform:    'oddsapi',
            bookmaker:   high.bm,
            probability: Math.round(high.prob * 10) / 10,
            url:         null,
            volume:      null,
            liquidity:   null,
            expiresAt:   ev.commence_time ? new Date(ev.commence_time).getTime() : null,
          },
          spread:     Math.round(spread * 10) / 10,
          roi:        Math.round(roi * 10) / 10,
          earnPer100: Math.round((roi / 100) * 100 * 10) / 10,
          confidence: 0.9,
          category:   'sports/bookmaker',
        });
      }
    }
  } catch (e) {
    console.error('[calculator] odds-api arb error:', e.message);
  }
  return results.sort((a, b) => b.roi - a.roi);
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
    const roi  = low.probability > 0 ? (spread / low.probability) * 100 : 0;
    if (roi > 300 || roi <= 0) continue;

    const earnPer100 = Math.round((roi / 100) * 100 * 10) / 10;

    results.push({
      question:   high.question,
      lowMarket:  { ...low,  platform: low.platform  },
      highMarket: { ...high, platform: high.platform },
      spread:     Math.round(spread * 10) / 10,
      roi:        Math.round(roi * 10) / 10,
      earnPer100,
      confidence: m.confidence || 1,
      category:   m.category || 'unknown',
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

  fs.writeFileSync(OUT_FILE, JSON.stringify({
    updatedAt:     Date.now(),
    opportunities,
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
