#!/usr/bin/env node
'use strict';

// Sports arbitrage agent — credit-safe polling via OddsAPI.
// Calls /sports (0 credits) each cycle to filter active sports before
// spending any credits on /odds. Rotates between two API keys; pauses
// and sends Telegram warning when both keys hit the credit floor.

const fs   = require('fs');
const path = require('path');

// Load .env.local into process.env — pm2 doesn't source it automatically.
// Only sets values not already present (shell exports take precedence).
const _envLocal = path.join(__dirname, '../.env.local');
if (fs.existsSync(_envLocal)) {
  for (const line of fs.readFileSync(_envLocal, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] == null)
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { OddsApiRetriever } = require(path.join(__dirname, '../lib/odds-retriever'));
const { detectArbs }       = require(path.join(__dirname, '../lib/sports-arb'));

// ── Config — ALL credentials come from environment, NEVER hardcoded ───────────
const API_KEYS = [
  process.env.ODDS_API_KEY,    // primary
  process.env.ODDS_API_KEY_2,  // fallback (optional second free-tier account)
].filter(Boolean);

if (API_KEYS.length === 0) {
  console.error('[sports] FATAL: no API keys — set ODDS_API_KEY (and optionally ODDS_API_KEY_2) in .env.local');
  process.exit(1);
}

const POLL_MS      = parseInt(process.env.SPORTS_POLL_INTERVAL_MS || '') || 45 * 60_000;
const CREDIT_FLOOR = parseInt(process.env.ODDS_CREDIT_FLOOR       || '') || 50;
const MARKETS      = ['h2h'];
const REGIONS      = ['eu', 'us'];
const MAX_SPORTS   = 3;  // max /odds endpoints per cycle

// In-season list ordered by priority — /sports (0 credits) confirms which are active
const WANTED_SPORTS = [
  'soccer_fifa_world_cup',             // FIFA World Cup 2026
  'tennis_atp_halle_open',             // pre-Wimbledon grass (June)
  'tennis_atp_queens_club_champ',      // pre-Wimbledon grass (June)
  'baseball_mlb',                      // MLB season
  'mma_mixed_martial_arts',            // UFC/Bellator year-round
  'basketball_wnba',                   // WNBA season
  'soccer_conmebol_copa_libertadores', // Copa Libertadores
  'americanfootball_nfl',              // NFL (preseason Aug)
  'soccer_epl',                        // EPL (resumes Aug)
];

// ── Files ─────────────────────────────────────────────────────────────────────
const OUT_FILE = '/tmp/sports-odds.json';
const HB_FILE  = '/tmp/agent-heartbeats.json';

// ── Telegram ──────────────────────────────────────────────────────────────────
const https     = require('https');
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';

function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) return Promise.resolve();
  return new Promise(resolve => {
    const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' });
    const req  = https.request(
      { hostname: 'api.telegram.org', path: `/bot${BOT_TOKEN}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      () => resolve()
    );
    req.on('error', () => resolve());
    req.write(body);
    req.end();
  });
}

function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb['agent12-sports'] = Date.now();
  try { fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2)); } catch {}
}

// ── Retriever — holds key rotation state across poll cycles ──────────────────
const retriever = new OddsApiRetriever(API_KEYS, CREDIT_FLOOR);
let allExhaustedWarnedAt = 0;  // rate-limit the Telegram warning (1× per hour max)

// ── Poll ──────────────────────────────────────────────────────────────────────
async function poll() {
  if (retriever.allExhausted) {
    const now = Date.now();
    if (now - allExhaustedWarnedAt > 60 * 60_000) {
      allExhaustedWarnedAt = now;
      console.warn('[sports] all API keys exhausted — waiting for credit reset');
      await sendTelegram(
        `⚠️ <b>Sports arb agent paused</b>\n` +
        `Both OddsAPI keys are below the credit floor (${CREDIT_FLOOR} remaining).\n` +
        `Polling suspended until credits reset next billing cycle.`
      );
    }
    beat();
    return;
  }

  console.log(`[sports] poll — ${API_KEYS.length} key(s), active: ${retriever.activeKeyLabel}, floor: ${CREDIT_FLOOR}`);

  // Step 1 — /sports (0 credits): discover what's in season
  let activeKeys = new Set();
  try {
    const sports = await retriever.getActiveSports();
    activeKeys   = new Set(sports.map(s => s.key));
    console.log(`[sports] ${sports.length} active leagues from /sports`);
  } catch (err) {
    console.error('[sports] /sports failed:', err.message);
  }

  const toFetch = WANTED_SPORTS.filter(k => activeKeys.has(k)).slice(0, MAX_SPORTS);
  if (toFetch.length === 0) {
    console.log('[sports] none of WANTED_SPORTS are currently active — skipping /odds calls');
    writeOutput([], [], null, []);
    beat();
    return;
  }
  console.log(`[sports] fetching /odds for: ${toFetch.join(', ')}`);

  // Step 2 — /odds for each active sport
  const allEvents = [];
  let   creditsLeft = null;

  for (const sportKey of toFetch) {
    if (retriever.allExhausted) break;
    try {
      const result = await retriever.getOdds(sportKey, MARKETS, REGIONS);
      console.log(
        `[sports] ${sportKey}: ${result.events.length} events` +
        ` | ${result.activeKeyLabel} remaining: ${result.creditsRemaining ?? '?'}` +
        ` | used: ${result.creditsUsed ?? '?'}`
      );
      allEvents.push(...result.events);
      if (result.creditsRemaining != null) creditsLeft = result.creditsRemaining;
    } catch (err) {
      console.error(`[sports] ${sportKey} error:`, err.message);
    }
  }

  const arbOpportunities = detectArbs(allEvents);
  writeOutput(allEvents, arbOpportunities, creditsLeft, toFetch);

  if (arbOpportunities.length > 0) {
    console.log(`[sports] *** ${arbOpportunities.length} ARB opportunities ***`);
    for (const a of arbOpportunities.slice(0, 3)) {
      console.log(`  ${a.homeTeam} vs ${a.awayTeam} — +${a.netMargin.toFixed(2)}%`);
    }
  }
  beat();
}

function writeOutput(allEvents, arbOpportunities, creditsLeft, sportsChecked) {
  const out = {
    updatedAt:        new Date().toISOString(),
    fetchedAt:        Date.now(),
    creditsRemaining: creditsLeft,
    paused:           retriever.allExhausted,
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
