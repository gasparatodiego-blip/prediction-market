#!/usr/bin/env node
'use strict';

/**
 * agent33-sport-recorder
 *
 * A RECORDER first, an arb-detector second.
 *
 * Every cycle it captures the FULL raw price book of every LIVE sports event from
 * every source we can reach — all odds-api.net bookmakers AND exchanges, Kalshi,
 * Polymarket — and appends them to data/sport-raw/<UTCdate>.jsonl. That raw record
 * is the deliverable: days later `scripts/sport-arb-replay.js` can replay any event
 * and answer "if I'd taken this arb at time X, what would it have paid net of fees,
 * and what was the max stake?".
 *
 * The derived arb layer is computed from the SAME cycle's rows and logged separately.
 * It never blocks, filters, or drops raw capture — if arb math throws, raw still lands.
 *
 * WHY THE STALENESS GUARD IS LOAD-BEARING
 * ---------------------------------------
 * odds-api.net stops re-capturing fixed-odds bookmakers at kickoff: measured 4.3–5.1 h
 * old lines served in-play, still flagged is_available:true. Pairing one of those against
 * a genuinely live leg manufactures enormous fake edge (measured: a frozen NPB book vs a
 * live Kalshi book showed net arbSum 0.81975 — an apparent 18% "arb" that was pure
 * staleness). So every row carries source_ts + age_sec + is_live, and any crossing with a
 * leg older than MAX_AGE_SEC is written to the PHANTOM stream, never the arb stream.
 * This is the only hard exclusion. Jurisdiction and short duration are TAGS, not filters.
 *
 * Zero Anthropic/paid-AI calls. Read-only against every venue. No orders, ever.
 */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const { atomicWriteJson } = require('../lib/atomicJsonWrite');
const { httpGet }         = require('../lib/httpGet');
// Fee model, staleness rule and crossing detection live in ONE place so the recorder and
// the dashboard API can never disagree about what a number means.
const {
  EXCHANGES, EXCHANGE_COMMISSION, POLY_TAKER, POLY_FEE_NOTE,
  MAX_AGE_SEC, SHORT_LIVED_SEC, netCost, legCapacity, detectArbs, isDrawName,
} = require('../lib/sport-arb-math');

// ── paths ─────────────────────────────────────────────────────────────────────
const ROOT          = path.join(__dirname, '..');
const RAW_DIR       = path.join(ROOT, 'data', 'sport-raw');
const ARB_FILE      = path.join(ROOT, 'data', 'sport-arb-history.jsonl');
const PHANTOM_FILE  = path.join(ROOT, 'data', 'sport-arb-phantoms.jsonl');
const STATE_FILE    = path.join(ROOT, 'data', 'sport-recorder-state.json');
const HB_FILE       = '/tmp/agent-heartbeats.json';
const HB_KEY        = 'agent33-sport-recorder';

// ── tunables ──────────────────────────────────────────────────────────────────
const CYCLE_MS        = 45_000;    // free sources (Kalshi/Polymarket) every cycle
const DISCOVERY_MS    = 180_000;   // odds-api catalog: 1 credit/pass, all sports in one call
const SNAPSHOT_MS     = 120_000;   // per-event odds-api book snapshot cadence
const DISK_CEILING_MB = 2048;      // gzip old days above this
const GZIP_AFTER_DAYS = 2;
// MAX_AGE_SEC / SHORT_LIVED_SEC / EXCHANGES / fee model all come from lib/sport-arb-math.

// Kalshi single-game series we know carry moneyline markets, keyed by odds-api sport.
const KALSHI_SERIES = {
  baseball:            ['KXMLBGAME', 'KXNPBGAME', 'KXKBOGAME'],
  basketball:          ['KXNBAGAME', 'KXWNBAGAME'],
  'american football': ['KXNFLGAME', 'KXUFLGAME'],
  'aussie rules':      ['KXAFLGAME'],
  'ice hockey':        ['KXNHLGAME'],
  'rugby league':      ['KXNRLGAME'],
  soccer:              ['KXEPLGAME', 'KXMLSGAME', 'KXUCLGAME'],
};

const ODDS_API = 'https://api.odds-api.net/v1';
const KALSHI   = 'https://api.elections.kalshi.com/trade-api/v2';
const GAMMA    = 'https://gamma-api.polymarket.com';
const CLOB     = 'https://clob.polymarket.com';

const ODDS_KEY = readOddsKey();

function readOddsKey() {
  if (process.env.ODDS_API_NET_KEY) return process.env.ODDS_API_NET_KEY;
  for (const f of ['.env.local', '.env']) {
    try {
      const m = fs.readFileSync(path.join(ROOT, f), 'utf8').match(/^ODDS_API_NET_KEY=(.*)$/m);
      if (m) return m[1].trim();
    } catch {}
  }
  return null;
}

// ── tiny fetch helpers (wall-clock deadline via shared httpGet) ────────────────
async function getJson(url, headers = {}, timeoutMs = 20_000) {
  try {
    const r = await httpGet(url, { headers: { Accept: 'application/json', ...headers }, timeoutMs });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, data: r.data };
  } catch (e) {
    return { ok: false, status: null, data: null, err: e.message };
  }
}
const oaGet   = (p, t) => getJson(ODDS_API + p, { 'X-API-Key': ODDS_KEY }, t);
const kalGet  = p      => getJson(KALSHI + p);
const sleep   = ms     => new Promise(r => setTimeout(r, ms));

// ── credit ledger ─────────────────────────────────────────────────────────────
// odds-api.net is the only metered source. agent12-sports already consumes ~63.5% of
// the 50k monthly plan, so the recorder computes its own daily allowance from what is
// actually left, reserving agent12's share plus a margin, and re-derives it each day.
// Kalshi and Polymarket are free and NEVER pause.
const AGENT12_DAILY_RESERVE = 1100;   // agent12 measured ~128 credits x 8 cycles/day
const SAFETY_MARGIN         = 4000;

let state = loadState();

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
  return { day: null, creditsUsedToday: 0, dailyBudget: null, cyclesToday: 0, rawRowsToday: 0,
           arbsToday: 0, phantomsToday: 0, lastDigestDay: null, periodEnd: null };
}
function saveState() { try { atomicWriteJson(STATE_FILE, state, { pretty: true }); } catch {} }

function utcDay(d = new Date()) { return d.toISOString().slice(0, 10); }

async function refreshBudget() {
  const today = utcDay();
  if (state.day === today && state.dailyBudget != null) return;

  const u = await getJson(`${ODDS_API}/usage`, { 'X-API-Key': ODDS_KEY });
  state.day = today;
  state.creditsUsedToday = 0;
  state.cyclesToday = 0; state.rawRowsToday = 0; state.arbsToday = 0; state.phantomsToday = 0;

  if (u.ok && u.data) {
    const remaining = (u.data.api_credits_limit ?? 50_000) - (u.data.api_credits_used ?? 0);
    const periodEnd = u.data.period_end_utc ? new Date(u.data.period_end_utc) : null;
    state.periodEnd = u.data.period_end_utc ?? null;
    const daysLeft = periodEnd ? Math.max(1, Math.ceil((periodEnd - Date.now()) / 86_400_000)) : 20;
    const forRecorder = remaining - (AGENT12_DAILY_RESERVE * daysLeft) - SAFETY_MARGIN;
    state.dailyBudget = Math.max(0, Math.floor(forRecorder / daysLeft));
    log(`budget: ${remaining} credits left, ${daysLeft}d in period → recorder allowance ${state.dailyBudget}/day`);
  } else {
    // Never guess upward when /usage is unreachable — fall back to a conservative floor.
    state.dailyBudget = state.dailyBudget ?? 300;
    log(`budget: /usage unreachable (${u.err ?? u.status}) → conservative ${state.dailyBudget}/day`);
  }
  saveState();
}

const budgetLeft = () => (state.dailyBudget ?? 0) - state.creditsUsedToday;
function spend(n = 1) { state.creditsUsedToday += n; }

// ── raw dump ──────────────────────────────────────────────────────────────────
// One JSONL line per (event, source, outcome, poll). Appended in a single write per
// batch: O_APPEND writes are atomic, so concurrent readers never see a torn line.
function appendRaw(rows) {
  if (!rows.length) return 0;
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const file = path.join(RAW_DIR, `${utcDay()}.jsonl`);
  fs.appendFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  state.rawRowsToday += rows.length;
  return rows.length;
}
function appendJsonl(file, rows) {
  if (!rows.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

function diskGuard() {
  try {
    const files = fs.readdirSync(RAW_DIR).filter(f => f.endsWith('.jsonl'));
    let totalMb = 0;
    const today = utcDay();
    for (const f of files) {
      const p = path.join(RAW_DIR, f);
      totalMb += fs.statSync(p).size / 1e6;
      const ageDays = (Date.now() - Date.parse(f.replace('.jsonl', '') + 'T00:00:00Z')) / 86_400_000;
      if (ageDays > GZIP_AFTER_DAYS && f.replace('.jsonl', '') !== today) {
        const gz = zlib.gzipSync(fs.readFileSync(p));
        fs.writeFileSync(p + '.gz', gz);
        fs.unlinkSync(p);
        log(`disk: gzipped ${f} (${(gz.length / 1e6).toFixed(1)}MB)`);
      }
    }
    if (totalMb > DISK_CEILING_MB) log(`disk: WARNING sport-raw at ${totalMb.toFixed(0)}MB (ceiling ${DISK_CEILING_MB}MB)`);
  } catch {}
}

// ── name normalisation for cross-venue linking ────────────────────────────────
const STOP = new Set(['fc','sc','cf','afc','the','club','de','city','state']);
function normTeam(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/).filter(w => w && !STOP.has(w))
    .join(' ').trim();
}
function teamTokens(s) { return new Set(normTeam(s).split(' ').filter(Boolean)); }
function teamMatch(a, b) {
  const A = teamTokens(a), B = teamTokens(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / Math.min(A.size, B.size);
}

// ── SOURCE 1: odds-api.net ────────────────────────────────────────────────────
// Discovery is one un-filtered /events call covering every sport (verified: omitting
// `sport` returns all of them), so a pass costs 1 credit instead of 10.
// The window deliberately reaches FORWARD as well as back. odds-api re-keys some events
// at kickoff: the id that appears in the in-play listing can be an empty duplicate with
// zero odds rows, while the odds stay under the id the event carried before it started
// (measured on NPB 2026-07-20: in-play id 2319125716 → 0 rows, pre-kickoff id 3226740555
// → 78 rows). Discovering pre-kickoff and RETAINING the id through kickoff is the only
// way to keep a book on an event once it goes live.
const TRACK_AHEAD_SEC  = 3 * 3600;
const TRACK_BEHIND_SEC = 5 * 3600;
const tracked = new Map();   // event_id → ev, survives across cycles

async function discoverOddsApi() {
  const now = Math.floor(Date.now() / 1000);
  const r = await oaGet(`/events?start_from=${now - TRACK_BEHIND_SEC}&start_to=${now + TRACK_AHEAD_SEC}&limit=1000`);
  spend(1);
  if (!r.ok || !r.data) { log(`discovery failed: ${r.err ?? r.status}`); return liveOf(now); }

  for (const e of (r.data.items || [])) {
    const ev = {
      event_id: String(e.event_id), sport: e.sport, league: e.league,
      home: e.home_team, away: e.away_team, start_time: e.start_time,
      bookmaker_count: e.bookmaker_count, bookmakers: e.bookmakers || [],
    };
    const prev = tracked.get(ev.event_id);
    // Keep the richer record: a re-keyed in-play stub reports fewer books than the
    // pre-kickoff entry, and we never want the stub to overwrite real coverage.
    if (!prev || (ev.bookmaker_count ?? 0) >= (prev.bookmaker_count ?? 0)) tracked.set(ev.event_id, ev);
  }
  // Prune well after final whistle so a long game is never dropped mid-play.
  for (const [id, ev] of tracked) if (now - ev.start_time > TRACK_BEHIND_SEC) tracked.delete(id);
  return liveOf(now);
}

// Live universe = everything already started and not yet pruned, keyed by team pair so
// a re-keyed duplicate collapses onto the entry that actually carries books.
function liveOf(now) {
  const best = new Map();
  for (const ev of tracked.values()) {
    if (ev.start_time > now) continue;
    const k = eventKey(ev);
    const prev = best.get(k);
    if (!prev || (ev.bookmaker_count ?? 0) > (prev.bookmaker_count ?? 0)) best.set(k, ev);
  }
  return [...best.values()].map(ev => ({ ...ev, startedMinAgo: Math.round((now - ev.start_time) / 60) }));
}

async function captureOddsApiBooks(ev, ts) {
  const r = await oaGet(`/events/${ev.event_id}/odds/snapshot?types=moneyline&limit=1000&include_source=true`);
  spend(1);
  if (!r.ok || !r.data) return { rows: [], err: r.err ?? r.status };
  const rows = [];
  for (const o of (r.data.items || [])) {
    if (!String(o.market_key || '').includes('(full time)')) continue;
    const srcTs = o.source_ts ?? null;
    const age   = srcTs ? Math.round((Date.now() - Date.parse(srcTs)) / 1000) : null;
    rows.push({
      ts, event_key: eventKey(ev), event_id: ev.event_id, sport: ev.sport, league: ev.league,
      home: ev.home, away: ev.away,
      source: o.bookmaker,
      source_type: EXCHANGES.has(o.bookmaker) ? 'exchange' : 'book',
      market: 'moneyline',
      outcome: o.side, team: o.selection_name ?? null,
      odds: typeof o.odds === 'number' ? o.odds : null,
      price: typeof o.odds === 'number' && o.odds > 0 ? 1 / o.odds : null,
      best_bid: o.best_back_price ?? null,
      best_ask: o.best_lay_price ?? null,
      // Only exchanges publish size here; fixed-odds books do not — leave null, never guess.
      depth_levels: (o.best_back_size != null || o.best_lay_size != null)
        ? { back: o.best_back_price != null ? [[o.best_back_price, o.best_back_size]] : null,
            lay:  o.best_lay_price  != null ? [[o.best_lay_price,  o.best_lay_size ]] : null }
        : null,
      is_available: o.is_available !== false,
      source_ts: srcTs, age_sec: age,
      is_live: age != null && age < MAX_AGE_SEC,
    });
  }
  return { rows, err: null };
}

// ── SOURCE 2: Kalshi (free) ───────────────────────────────────────────────────
// Field names MUST be the *_dollars / *_fp family. The legacy yes_bid/yes_ask fields
// return null on every market now, which reads as "no liquidity" and is simply wrong.
// Transport is DIRECT for both halves of the Kalshi read. The former US path-gateway
// only ever exposed /kalshi/markets — it had no orderbook route at all, so the depth
// ladders that max-stake is computed from could never have come through it. Direct
// access is verified working from this host, so there is nothing to fall back to and
// nothing to probe.
function logKalshiTransport() {
  log('kalshi: direct transport (list + orderbook)');
}

function parseKalshiBook(fp) {
  if (!fp) return null;                       // caller treats null as parse failure, not "empty"
  const yes = (fp.yes_dollars || []).map(([p, s]) => [Number(p), Number(s)]);
  const no  = (fp.no_dollars  || []).map(([p, s]) => [Number(p), Number(s)]);
  const bestYesBid = yes.length ? Math.max(...yes.map(x => x[0])) : null;
  const bestNoBid  = no.length  ? Math.max(...no.map(x => x[0]))  : null;
  // A YES ask is the mirror of the best NO bid; its size is that NO level's size.
  const yesAsk     = bestNoBid != null ? +(1 - bestNoBid).toFixed(4) : null;
  const yesAskSize = bestNoBid != null ? (no.find(x => x[0] === bestNoBid) || [0, null])[1] : null;
  const yesBidSize = bestYesBid != null ? (yes.find(x => x[0] === bestYesBid) || [0, null])[1] : null;
  return { bestYesBid, yesBidSize, yesAsk, yesAskSize, yesLadder: yes, noLadder: no };
}

async function kalshiMarketsForSport(sport) {
  const series = KALSHI_SERIES[sport] || [];
  const out = [];
  for (const s of series) {
    const r = await kalGet(`/markets?series_ticker=${s}&status=open&limit=200`);
    if (!r.ok || !r.data) continue;
    for (const m of (r.data.markets || [])) out.push(m);
    await sleep(120);
  }
  return out;
}

async function captureKalshi(ev, ts, marketPool) {
  // Match the odds-api event to Kalshi markets by team-token overlap on the market title.
  const cands = marketPool.filter(m => {
    const t = m.title || '';
    return teamMatch(t, ev.home) >= 0.5 && teamMatch(t, ev.away) >= 0.5;
  });
  const rows = [];
  for (const m of cands) {
    const r = await kalGet(`/markets/${m.ticker}/orderbook?depth=10`);
    const book = parseKalshiBook(r.ok && r.data ? r.data.orderbook_fp : null);
    if (!book) {
      log(`kalshi: PARSE-FAIL orderbook_fp missing for ${m.ticker}`);
      continue;
    }
    // Which side of the game is this ticker? Kalshi runs one market per outcome. On a
    // three-way sport the draw contract ("Tie") matches NEITHER team, so the old
    // `teamMatch(sub,home) >= teamMatch(sub,away)` (0 >= 0) mislabeled it 'home' and it
    // then paired against a real away leg to fabricate a ~40% "arb". Label draws honestly.
    const sub  = m.yes_sub_title || m.title || '';
    const draw = isDrawName(sub);
    const isHome = !draw && teamMatch(sub, ev.home) >= teamMatch(sub, ev.away);
    rows.push({
      ts, event_key: eventKey(ev), event_id: ev.event_id, sport: ev.sport, league: ev.league,
      home: ev.home, away: ev.away,
      source: 'kalshi', source_type: 'prediction', market: 'moneyline', venue_ticker: m.ticker,
      outcome: draw ? 'draw' : (isHome ? 'home' : 'away'), team: sub || null,
      odds: book.yesAsk ? +(1 / book.yesAsk).toFixed(4) : null,
      price: book.yesAsk,                       // cost per $1 payout = implied probability
      best_bid: book.bestYesBid, best_ask: book.yesAsk,
      best_bid_size: book.yesBidSize, best_ask_size: book.yesAskSize,
      depth_levels: { yes: book.yesLadder, no: book.noLadder },
      open_interest: m.open_interest_fp ?? null,
      // A live CLOB pull is fresh by construction: the response IS the book right now.
      source_ts: new Date(ts).toISOString(), age_sec: 0, is_live: true,
      access: 'direct',
    });
    await sleep(120);
  }
  return rows;
}

// ── SOURCE 3: Polymarket (free) ───────────────────────────────────────────────
// Per-game sports events are ONLY reachable via a league tag ordered by start date.
// A plain /events?closed=false pull is capped at 100 rows and saturated by 5-minute
// crypto markets, so no sports game ever appears in it — measured, not assumed.
const POLY_TAGS = {
  baseball:            ['mlb'],
  basketball:          ['nba', 'wnba'],
  'american football': ['nfl'],
  'ice hockey':        ['nhl'],
  soccer:              ['mls', 'epl', 'champions-league'],
};

// "Minnesota Lynx vs. Seattle Storm"      → moneyline  (keep)
// "Spread: Minnesota Lynx (-10.5)"        → not moneyline
// "Minnesota Lynx vs. Seattle Storm: O/U" → not moneyline
// "Kayla McBride: Points O/U 18.5"        → not moneyline
function isMoneylineQuestion(q) {
  const s = String(q || '');
  if (!s) return false;
  if (s.includes(':')) return false;                       // spread / totals / props all use a colon
  if (/\b(spread|o\/u|over|under|total|handicap)\b/i.test(s)) return false;
  return /\svs\.?\s/i.test(s);
}

async function polymarketMarketsForSport(sport) {
  const out = [];
  for (const tag of (POLY_TAGS[sport] || [])) {
    const r = await getJson(`${GAMMA}/events?tag_slug=${tag}&closed=false&limit=100&order=startDate&ascending=false`);
    if (r.ok && Array.isArray(r.data)) out.push(...r.data);
    await sleep(150);
  }
  return out;
}

async function capturePolymarket(ev, ts, index) {
  const hit = index.find(e => {
    const t = e.title || '';
    return teamMatch(t, ev.home) >= 0.5 && teamMatch(t, ev.away) >= 0.5;
  });
  if (!hit) return [];
  const rows = [];
  for (const m of (hit.markets || [])) {
    // Moneyline ONLY. A Polymarket game event also carries spread, totals and player-prop
    // markets whose outcomes are ALSO the two team names — pairing one of those against a
    // moneyline leg on another venue manufactures enormous fake edge (measured: Kalshi
    // moneyline vs Polymarket "Spread: Minnesota Lynx (-10.5)" produced a bogus 34% arb).
    // Spread/total/prop questions all carry a ':'; the moneyline is bare "A vs. B".
    let outcomes; try { outcomes = JSON.parse(m.outcomes || '[]'); } catch { outcomes = []; }
    if (outcomes.length !== 2) continue;
    if (!isMoneylineQuestion(m.question)) continue;
    if (teamMatch(outcomes[0], ev.home) < 0.5 && teamMatch(outcomes[0], ev.away) < 0.5) continue;
    let tokens; try { tokens = JSON.parse(m.clobTokenIds || '[]'); } catch { tokens = []; }
    for (let i = 0; i < tokens.length && i < outcomes.length; i++) {
      const b = await getJson(`${CLOB}/book?token_id=${tokens[i]}`);
      if (!b.ok || !b.data) continue;
      const bids = (b.data.bids || []).map(x => [Number(x.price), Number(x.size)]);
      const asks = (b.data.asks || []).map(x => [Number(x.price), Number(x.size)]);
      const bestBid = bids.length ? Math.max(...bids.map(x => x[0])) : null;
      const bestAsk = asks.length ? Math.min(...asks.map(x => x[0])) : null;
      const isHome  = teamMatch(outcomes[i], ev.home) >= teamMatch(outcomes[i], ev.away);
      rows.push({
        ts, event_key: eventKey(ev), event_id: ev.event_id, sport: ev.sport, league: ev.league,
        home: ev.home, away: ev.away,
        source: 'polymarket', source_type: 'prediction', market: 'moneyline', venue_ticker: hit.slug ?? null,
        outcome: isHome ? 'home' : 'away', team: outcomes[i],
        odds: bestAsk ? +(1 / bestAsk).toFixed(4) : null,
        price: bestAsk,
        best_bid: bestBid, best_ask: bestAsk,
        best_bid_size: bestBid != null ? bids.filter(x => x[0] === bestBid).reduce((a, x) => a + x[1], 0) : null,
        best_ask_size: bestAsk != null ? asks.filter(x => x[0] === bestAsk).reduce((a, x) => a + x[1], 0) : null,
        depth_levels: { bids, asks },
        accepting_orders: m.acceptingOrders === true,   // openable vs close-only
        source_ts: new Date(ts).toISOString(), age_sec: 0, is_live: true,
      });
      await sleep(120);
    }
  }
  return rows;
}

const eventKey = ev => `${ev.sport}|${normTeam(ev.away)}@${normTeam(ev.home)}`;

// ── DERIVED LAYER ─────────────────────────────────────────────────────────────
// netCost / legCapacity / detectArbs are imported from lib/sport-arb-math (the SSOT
// shared with app/api/sport-arb/live/route.ts) — see the require at the top of this file.

// ── crossing persistence tracking ─────────────────────────────────────────────
// A crossing that exists for one poll is not the same object as one that holds. We key
// by (event, leg sources, direction) and carry first-seen forward so the arb record
// carries how long it actually survived.
const openCrossings = new Map();
function trackPersistence(real, ts) {
  const seen = new Set();
  for (const r of real) {
    const k = `${r.event_key}|${r.legs[0].source}|${r.legs[1].source}`;
    seen.add(k);
    const prev = openCrossings.get(k);
    if (prev) { r.firstSeen = prev.firstSeen; r.persistedSec = Math.round((ts - prev.firstSeen) / 1000); }
    else      { r.firstSeen = ts; r.persistedSec = 0; }
    openCrossings.set(k, { firstSeen: r.firstSeen, last: ts });
    if (r.persistedSec < SHORT_LIVED_SEC) r.executionTag = 'execution-speed-critical';
  }
  for (const [k, v] of openCrossings) if (!seen.has(k) && ts - v.last > 5 * 60_000) openCrossings.delete(k);
}

// ── logging / heartbeat ───────────────────────────────────────────────────────
function log(msg) { console.log(`[agent33] ${new Date().toISOString()} ${msg}`); }
function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb[HB_KEY] = Date.now();
  try { atomicWriteJson(HB_FILE, hb, { pretty: true }); } catch {}
}

// ── daily digest ──────────────────────────────────────────────────────────────
// File-first. Telegram only if the global switch is on; this adds no new always-on sender.
async function maybeDigest() {
  const today = utcDay();
  if (state.lastDigestDay === today) return;
  if (state.lastDigestDay == null) { state.lastDigestDay = today; saveState(); return; }

  const lines = [
    `agent33-sport-recorder digest ${state.lastDigestDay}`,
    `cycles=${state.cyclesToday} rawRows=${state.rawRowsToday}`,
    `realCrossings=${state.arbsToday} phantoms=${state.phantomsToday}`,
    `oddsApiCredits=${state.creditsUsedToday}/${state.dailyBudget}`,
  ];
  log('DIGEST ' + lines.join(' | '));
  if (process.env.TELEGRAM_ALERTS_ENABLED === 'true' && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    try {
      const { httpPost } = require('../lib/httpGet');
      await httpPost(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        { chat_id: process.env.TELEGRAM_CHAT_ID, text: lines.join('\n') },
        { headers: { 'Content-Type': 'application/json' } });
    } catch (e) { log(`digest telegram failed (file log stands): ${e.message}`); }
  }
  state.lastDigestDay = today;
  saveState();
}

// ── main cycle ────────────────────────────────────────────────────────────────
let liveUniverse = [];
let lastDiscovery = 0;
let lastSnapshot  = new Map();
let kalshiPool    = new Map();
let polyPool      = new Map();
let cycleN        = 0;

async function cycle() {
  const ts = Date.now();
  cycleN++;
  await refreshBudget();

  // 1. discovery (metered, throttled)
  if (ts - lastDiscovery >= DISCOVERY_MS) {
    if (budgetLeft() > 0) {
      liveUniverse = await discoverOddsApi();
      lastDiscovery = ts;
      log(`discovery: ${liveUniverse.length} live event(s) | credits ${state.creditsUsedToday}/${state.dailyBudget}`);
    } else {
      log('discovery skipped — odds-api credit cap reached (free sources continue)');
    }
  }


  const allRows = [];

  for (const ev of liveUniverse) {
    // 2a. odds-api books — metered, so cadence-limited and hard-capped
    const lastSnap = lastSnapshot.get(ev.event_id) ?? 0;
    if (ts - lastSnap >= SNAPSHOT_MS) {
      if (budgetLeft() > 0) {
        const { rows, err } = await captureOddsApiBooks(ev, ts);
        lastSnapshot.set(ev.event_id, ts);
        if (err) log(`snapshot ${ev.event_id} failed: ${err}`);
        allRows.push(...rows);
      } else if (cycleN % 20 === 0) {
        log('book snapshots paused — credit cap; free sources still recording');
      }
    }

    // 2b. Kalshi — free, every cycle
    const sportSeries = KALSHI_SERIES[ev.sport];
    if (sportSeries) {
      if (!kalshiPool.has(ev.sport) || ts - (kalshiPool.get(ev.sport).t) > DISCOVERY_MS) {
        kalshiPool.set(ev.sport, { t: ts, markets: await kalshiMarketsForSport(ev.sport) });
      }
      allRows.push(...await captureKalshi(ev, ts, kalshiPool.get(ev.sport).markets));
    }

    // 2c. Polymarket — free, every cycle (per-league pool, refreshed on the discovery beat)
    if (POLY_TAGS[ev.sport]) {
      if (!polyPool.has(ev.sport) || ts - polyPool.get(ev.sport).t > DISCOVERY_MS) {
        polyPool.set(ev.sport, { t: ts, events: await polymarketMarketsForSport(ev.sport) });
      }
      allRows.push(...await capturePolymarket(ev, ts, polyPool.get(ev.sport).events));
    }
  }

  // 3. RAW DUMP FIRST — this must land even if the derived layer throws.
  const wrote = appendRaw(allRows);

  // 4. derived arb layer
  let real = [], phantom = [];
  try {
    const out = detectArbs(allRows, ts);
    real = out.real; phantom = out.phantom;
    trackPersistence(real, ts);
    if (real.length)    { appendJsonl(ARB_FILE, real);        state.arbsToday += real.length; }
    if (phantom.length) { appendJsonl(PHANTOM_FILE, phantom); state.phantomsToday += phantom.length; }
  } catch (e) {
    log(`derived arb layer failed (raw capture unaffected): ${e.message}`);
  }

  state.cyclesToday++;
  saveState();
  beat();
  diskGuard();
  await maybeDigest();

  log(`cycle ${cycleN}: events=${liveUniverse.length} rawRows=${wrote} real=${real.length} phantom=${phantom.length} credits=${state.creditsUsedToday}/${state.dailyBudget}`);
}

async function main() {
  if (!ODDS_KEY) { console.error('[agent33] FATAL: ODDS_API_NET_KEY not found'); process.exit(1); }
  log(`starting — cycle ${CYCLE_MS / 1000}s, discovery ${DISCOVERY_MS / 1000}s, snapshot ${SNAPSHOT_MS / 1000}s, maxAge ${MAX_AGE_SEC}s`);
  logKalshiTransport();
  fs.mkdirSync(RAW_DIR, { recursive: true });

  // AGENT33_CYCLES=n runs a bounded number of cycles and exits — used by the verify
  // pass so a test run cannot become an orphan daemon.
  const bounded = Number(process.env.AGENT33_CYCLES || 0);
  if (bounded > 0) {
    for (let i = 0; i < bounded; i++) {
      try { await cycle(); } catch (e) { log(`cycle error: ${e.message}`); }
      if (i < bounded - 1) await sleep(CYCLE_MS);
    }
    log(`bounded run complete (${bounded} cycles)`);
    return;
  }

  for (;;) {
    const t0 = Date.now();
    try { await cycle(); }
    catch (e) { log(`cycle error: ${e.message}`); }
    await sleep(Math.max(2000, CYCLE_MS - (Date.now() - t0)));
  }
}

if (require.main === module) main();

module.exports = {
  netCost, detectArbs, parseKalshiBook, legCapacity, normTeam, teamMatch, MAX_AGE_SEC,
  // exported for the verify pass so the venue paths can be exercised without a daemon
  capturePolymarket, captureKalshi, polymarketMarketsForSport, kalshiMarketsForSport,
  captureOddsApiBooks, discoverOddsApi,
};
