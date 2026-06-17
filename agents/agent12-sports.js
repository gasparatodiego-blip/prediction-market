#!/usr/bin/env node
'use strict';

// Sports arbitrage agent — credit-safe polling via OddsAPI.
// Calls /sports (0 credits) each cycle to filter active sports before
// spending any credits on /odds. Stops polling if credits < CREDIT_FLOOR.

const fs   = require('fs');
const path = require('path');
const { OddsApiRetriever } = require(path.join(__dirname, '../lib/odds-retriever'));
const { detectArbs }       = require(path.join(__dirname, '../lib/sports-arb'));

// ── Config ────────────────────────────────────────────────────────────────────
const API_KEY       = process.env.ODDS_API_KEY      || 'aff711ab10f3f1fba585e30405329c7c';
const POLL_MS       = parseInt(process.env.SPORTS_POLL_INTERVAL_MS || '') || 45 * 60_000;  // 45 min
const CREDIT_FLOOR  = parseInt(process.env.ODDS_CREDIT_FLOOR       || '') || 50;
const MARKETS       = ['h2h'];
const REGIONS       = ['eu', 'us'];
const MAX_SPORTS    = 3;   // never fetch more than 3 sport/odds endpoints per cycle

// Ordered by expected in-season relevance — filtered against /sports active list.
// /sports (0 credits) confirms which are actually active before we spend any quota.
const WANTED_SPORTS = [
  'soccer_fifa_world_cup',            // FIFA World Cup 2026 — best liquidity
  'tennis_atp_halle_open',            // pre-Wimbledon grass (June)
  'tennis_atp_queens_club_champ',     // pre-Wimbledon grass (June)
  'baseball_mlb',                     // MLB in season
  'mma_mixed_martial_arts',           // UFC/Bellator year-round
  'basketball_wnba',                  // WNBA in season
  'soccer_conmebol_copa_libertadores',// Copa Libertadores
  'americanfootball_nfl',             // NFL preseason starts August
  'soccer_epl',                       // EPL resumes August
];

// ── Files ─────────────────────────────────────────────────────────────────────
const OUT_FILE = '/tmp/sports-odds.json';
const HB_FILE  = '/tmp/agent-heartbeats.json';

// ── Telegram ──────────────────────────────────────────────────────────────────
const https     = require('https');
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';

function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) { console.warn('[sports] Telegram not configured'); return Promise.resolve(); }
  return new Promise(resolve => {
    const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' });
    const req  = https.request(
      { hostname: 'api.telegram.org', path: `/bot${BOT_TOKEN}/sendMessage`,
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      () => resolve()
    );
    req.on('error', () => resolve());
    req.write(body);
    req.end();
  });
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────
function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb['agent12-sports'] = Date.now();
  try { fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2)); } catch {}
}

// ── State ─────────────────────────────────────────────────────────────────────
const retriever = new OddsApiRetriever(API_KEY);
let paused = false;

// ── Poll ──────────────────────────────────────────────────────────────────────
async function poll() {
  if (paused) {
    console.log('[sports] PAUSED — credit floor reached; skipping cycle');
    beat();
    return;
  }

  console.log(`[sports] poll start — interval ${POLL_MS / 60_000} min, floor ${CREDIT_FLOOR} credits`);

  // Step 1: discover active sports (costs 0 credits)
  let activeKeys = new Set();
  try {
    const activeSports = await retriever.getActiveSports();
    activeKeys = new Set(activeSports.map(s => s.key));
    console.log(`[sports] /sports returned ${activeSports.length} active leagues`);
  } catch (err) {
    console.error('[sports] /sports fetch failed:', err.message);
  }

  const toFetch = WANTED_SPORTS.filter(k => activeKeys.has(k)).slice(0, MAX_SPORTS);
  if (toFetch.length === 0) {
    console.log('[sports] no wanted sports are currently active — writing empty result');
    writeOutput([], [], null, []);
    beat();
    return;
  }
  console.log(`[sports] fetching odds for: ${toFetch.join(', ')}`);

  // Step 2: fetch odds, tracking credits after each call
  const allEvents      = [];
  let   creditsLeft    = null;
  let   creditsPaused  = false;

  for (const sportKey of toFetch) {
    try {
      const { events, creditsRemaining, creditsUsed } = await retriever.getOdds(sportKey, MARKETS, REGIONS);
      console.log(`[sports] ${sportKey}: ${events.length} events | remaining: ${creditsRemaining ?? '?'} | used: ${creditsUsed ?? '?'}`);
      allEvents.push(...events);

      if (creditsRemaining != null) {
        creditsLeft = creditsRemaining;
        if (creditsRemaining < CREDIT_FLOOR) {
          console.warn(`[sports] ⚠ credit floor hit: ${creditsRemaining} remaining — PAUSING`);
          await sendTelegram(
            `⚠️ <b>Sports arb agent paused</b>\n` +
            `OddsAPI credits remaining: <b>${creditsRemaining}</b> (floor: ${CREDIT_FLOOR}).\n` +
            `Polling suspended — resume next billing cycle or raise ODDS_CREDIT_FLOOR env var.`
          );
          paused         = true;
          creditsPaused  = true;
          break;
        }
      }
    } catch (err) {
      console.error(`[sports] ${sportKey} error:`, err.message);
    }
  }

  const arbOpportunities = detectArbs(allEvents);
  writeOutput(allEvents, arbOpportunities, creditsLeft, toFetch);
  if (arbOpportunities.length > 0 && !creditsPaused) {
    console.log(`[sports] *** ${arbOpportunities.length} ARB opportunities ***`);
    for (const a of arbOpportunities.slice(0, 3)) {
      console.log(`  ${a.homeTeam} vs ${a.awayTeam} — ${a.netMargin.toFixed(2)}% net margin`);
    }
  }
  beat();
}

function writeOutput(allEvents, arbOpportunities, creditsLeft, sportsChecked) {
  const out = {
    updatedAt:        new Date().toISOString(),
    fetchedAt:        Date.now(),
    creditsRemaining: creditsLeft,
    paused,
    sportsChecked,
    totalEvents:      allEvents.length,
    totalArb:         arbOpportunities.length,
    arbOpportunities,
    allEvents,
  };
  try {
    fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
    console.log(`[sports] wrote ${allEvents.length} events, ${arbOpportunities.length} arbs → ${OUT_FILE}`);
  } catch (err) {
    console.error('[sports] write error:', err.message);
  }
}

poll();
setInterval(poll, POLL_MS);
