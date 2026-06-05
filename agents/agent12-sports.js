#!/usr/bin/env node
'use strict';

const fs    = require('fs');
const https = require('https');

const OUT      = '/tmp/sports-odds.json';
const HB_FILE  = '/tmp/agent-heartbeats.json';
const INTERVAL = 300_000;  // 5 min (OddsAPI free tier quota)

const API_KEY = 'aff711ab10f3f1fba585e30405329c7c';

const SPORTS = [
  { key: 'soccer_italy_serie_a',        label: 'Serie A',          emoji: '⚽', region: 'eu' },
  { key: 'soccer_uefa_champs_league',   label: 'Champions League', emoji: '🏆', region: 'eu' },
  { key: 'basketball_nba',              label: 'NBA',              emoji: '🏀', region: 'us' },
  { key: 'americanfootball_nfl',        label: 'NFL',              emoji: '🏈', region: 'us' },
  { key: 'tennis_atp_french_open',      label: 'Tennis ATP',       emoji: '🎾', region: 'eu' },
];

function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb['agent12-sports'] = Date.now();
  try { fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2)); } catch {}
}

function get(url) {
  return new Promise(resolve => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'prediction-arb-scanner/1.0', 'Accept': 'application/json' },
      timeout: 15000,
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.on('error', () => resolve({ status: 0, data: null }));
    req.on('timeout', function () { this.destroy(); resolve({ status: 0, data: null }); });
  });
}

async function fetchSportOdds(sport) {
  const url = `https://api.the-odds-api.com/v4/sports/${sport.key}/odds/?apiKey=${API_KEY}&regions=${sport.region}&markets=h2h&oddsFormat=decimal`;
  const { status, data } = await get(url);
  if (status !== 200 || !Array.isArray(data)) {
    console.log(`[sports] ${sport.label}: HTTP ${status} — no data`);
    return [];
  }
  console.log(`[sports] ${sport.label}: ${data.length} events`);
  return data;
}

// ── Arbitrage detection ───────────────────────────
// For each event, find the best price for each outcome across all bookmakers.
// If sum(1/bestOdds) < 1 → guaranteed profit.

function detectArb(events, sport) {
  const results = [];

  for (const ev of events) {
    if (!ev.bookmakers?.length) continue;

    // Gather all outcomes and best odds per outcome
    const bestOdds = {};   // outcomeName → { price, bookmaker }
    for (const bk of ev.bookmakers) {
      for (const mkt of (bk.markets ?? [])) {
        if (mkt.key !== 'h2h') continue;
        for (const oc of (mkt.outcomes ?? [])) {
          const prev = bestOdds[oc.name];
          if (!prev || oc.price > prev.price) {
            bestOdds[oc.name] = { price: oc.price, bookmaker: bk.title, key: bk.key };
          }
        }
      }
    }

    const outcomes = Object.keys(bestOdds);
    if (outcomes.length < 2) continue;

    const impliedSum = outcomes.reduce((s, n) => s + 1 / bestOdds[n].price, 0);
    const arbPct     = (1 - impliedSum) * 100;  // positive = profit %
    const isArb      = impliedSum < 1.0;

    // Optimal stakes for $100 bankroll
    const stakes = isArb
      ? outcomes.map(n => ({
          outcome:    n,
          bookmaker:  bestOdds[n].bookmaker,
          bookmakerId: bestOdds[n].key,
          odds:       bestOdds[n].price,
          stake:      Math.round((1 / bestOdds[n].price / impliedSum) * 100 * 100) / 100,
        }))
      : [];

    // Flatten bookmakers list for display (deduplicate)
    const bookmakerList = [...new Set(ev.bookmakers.map(b => b.title))];

    results.push({
      id:           ev.id,
      sport:        sport.key,
      sportLabel:   sport.label,
      sportEmoji:   sport.emoji,
      homeTeam:     ev.home_team,
      awayTeam:     ev.away_team,
      commenceTime: ev.commence_time,
      bookmakers:   bookmakerList,
      bestOdds:     outcomes.map(n => ({ name: n, price: bestOdds[n].price, bookmaker: bestOdds[n].bookmaker })),
      impliedSum:   Math.round(impliedSum * 10000) / 10000,
      arbOpportunity: isArb,
      arbPct:       isArb ? Math.round(arbPct * 100) / 100 : 0,
      arbBets:      stakes,
    });
  }

  // Sort: arb opportunities first, then by commence time
  results.sort((a, b) => {
    if (a.arbOpportunity !== b.arbOpportunity) return a.arbOpportunity ? -1 : 1;
    return new Date(a.commenceTime) - new Date(b.commenceTime);
  });
  return results;
}

async function poll() {
  console.log('[sports] Fetching odds from The Odds API…');
  const allMarkets = [];
  let totalArb = 0;

  for (const sport of SPORTS) {
    try {
      const events  = await fetchSportOdds(sport);
      const markets = detectArb(events, sport);
      allMarkets.push(...markets);
      const arbCount = markets.filter(m => m.arbOpportunity).length;
      totalArb += arbCount;
      if (arbCount > 0) console.log(`[sports] *** ${sport.label}: ${arbCount} ARB opportunities ***`);
    } catch (err) {
      console.error(`[sports] ${sport.label} error:`, err.message);
    }
  }

  const arbOpportunities = allMarkets.filter(m => m.arbOpportunity);
  const output = {
    fetchedAt:        Date.now(),
    sports:           SPORTS.map(s => s.key),
    sportsMeta:       SPORTS,
    markets:          allMarkets,
    arbOpportunities,
    totalEvents:      allMarkets.length,
    totalArb,
  };

  try {
    fs.writeFileSync(OUT, JSON.stringify(output, null, 2));
    console.log(`[sports] Wrote ${allMarkets.length} events, ${totalArb} arb opportunities → ${OUT}`);
  } catch (err) {
    console.error('[sports] write error:', err.message);
  }

  beat();
}

// Run immediately then on interval
poll();
setInterval(poll, INTERVAL);
