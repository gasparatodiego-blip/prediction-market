#!/usr/bin/env node
'use strict';

// agent12-sports.js — Sports Arbitrage Snapshot Scanner  (Phase A: read-only)
//
// ONE snapshot scan per invocation, then exits.  Run manually:
//   node agents/agent12-sports.js
//
// VENDOR: odds-api.net (Starter, 50,000 credits/month, HARD CAP — cannot overspend).
// Auth is the X-API-Key HEADER; the ?apiKey= query param returns "Missing credentials".
// ODDS_API_NET_KEY must be set in .env.local — never hardcoded here.
// NOTE: ODDS_API_KEY is a DIFFERENT vendor (the-odds-api.com) and is no longer read here.
//
// Cost shape differs fundamentally from the-odds-api: that vendor returned every event
// for a sport in ONE call; odds-api.net has no bulk-per-sport odds endpoint, so odds are
// fetched PER EVENT. Cycle cost is therefore ~(1 per sport + 1 per eligible event), which
// is what SCAN_INTERVAL_MIN below is sized against. Read-only: no bet is ever placed.

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
// ALL sports offered by /sports are scanned — no allowlist. The vendor's sport
// vocabulary is coarse ('soccer', 'baseball', …), so the previous league-level
// allowlist has no equivalent and is intentionally gone: wide coverage by design.
const MARKET_TYPES     = ['moneyline', 'moneyline 3w'];  // `types` filter values (verified against the live API)
const PERIOD_MATCH     = '(full time)';  // `periods` filter is NOT accepted by the API (returns 0 rows) → filtered client-side off market_key
const ODDS_SNAPSHOT_LIMIT = 10_000;      // = /limits odds_snapshot_limit_max → one page per event, no cursor paging (verified)
// EEA/EU licensing codes as returned by /coverage country_codes — used to classify a
// bookmaker's jurisdiction for the cross-jurisdiction executability gate.
const EU_CODES = new Set([
  'AT','BE','BG','CY','CZ','DE','DK','EE','ES','FI','FR','GR','HR','HU','IE','IT',
  'LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK','NO','IS','CH',
]);
const MIN_BOOKMAKERS      = 4;     // event ignored if fewer books quote it
const OUTLIER_PCT         = 0.25;  // book's implied prob deviating > this from median → outlier
const MAX_PLAUSIBLE_ROI   = 0.06;  // h2h arb > 6% net → almost certainly a data error → quarantine
const CREDIT_SAFETY_FLOOR = 2000;  // reserve on the 50,000/mo plan (~4%) — stop scanning before breaching it

// ── Sharp-reference edge guards ───────────────────────────────────────────────
// Pinnacle is the only sharp/verified book (EXEC_SHARP_BOOKS). These thresholds
// gate the Signal-only "edge vs sharp no-vig fair" metric so no absurd number
// ships. Approved by Diego for this task; not tunable magic — each has a stated
// honest-engine rationale below.
const SHARP_EDGE_MAX_PLAUSIBLE = 0.10; // best-soft leg beating Pinnacle no-vig fair by >10% is a stale/erroneous line, not real value → suppress
const SHARP_NEAR_CERTAIN_HI    = 0.97; // no-vig fair prob above this → near-certain favorite; edge% is numerically unstable → exclude outcome
const SHARP_NEAR_CERTAIN_LO    = 0.03; // no-vig fair prob below this → longshot; same instability → exclude outcome

// ── True-arbitrage guards ─────────────────────────────────────────────────────
// A CASHABLE arb = best odds per outcome across DIFFERENT books such that
// Σ(1/bestOdds) < 1 − buffer → guaranteed profit regardless of result. Approved
// by Diego for this task. Honest by construction: buffer absorbs fee/slippage/
// odds-move, implausible profit is suppressed, single-book "arbs" rejected.
const ARB_SAFETY_BUFFER        = 0.01; // require arbSum < 0.99, not just <1 — fee/slippage/odds-move headroom
const ARB_MAX_PLAUSIBLE_PROFIT = 0.05; // guaranteed profit (1−arbSum) > 5% on a liquid market → stale/erroneous line → downgrade to signal

// Rate limit: plan allows 60 req/min. Space calls ≥1100ms so a full cycle can never
// trip 429 even with zero jitter (54 req/min worst case).
const RATE_LIMIT_MS = 1100;

// Fixed scan interval, sized against a MEASURED full cycle — not an estimate.
//
// Measured 2026-07-19: one full scan of all 10 sports / 115 events cost 128 credits
// (/usage delta 115 -> 243; local call count 129, agreeing within the 1 credit the
// /usage read itself costs). Cost shape = 1 (/sports) + 1 (/coverage) + 1 per sport
// event list + 1 per eligible event.
//
//   128 credits/cycle over a 31-day period (44,640 min):
//     120 min -> 47,616/mo = 95.2% of cap   (no headroom — rejected)
//     180 min -> 31,744/mo = 63.5% of cap   (chosen)
//     240 min -> 23,808/mo = 47.6% of cap
//
// 180 min is chosen over the 143-min arithmetic floor for two reasons: it divides 24h
// so it expresses cleanly in cron, and the event census is seasonal — soccer alone is
// 56 events now and roughly triples when the European leagues return in August. The
// adaptive per-cycle budget above absorbs that surge; this interval keeps it from
// being needed in the first place.
const SCAN_INTERVAL_MIN = Number(process.env.SPORTS_SCAN_INTERVAL_MIN || 180);

// ── Bookmaker → jurisdiction lookup (best-effort static map from OddsAPI docs) ─
// 'us' = US-licensed books; 'eu' = EU-licensed; 'uk' = UK-licensed (UKGC)
// EU and UK are treated as mutually accessible for a European bettor.
// US books are a separate jurisdiction that most non-US bettors cannot access.
const BOOKMAKER_REGION = {
  // US
  draftkings:        'us',
  fanduel:           'us',
  betmgm:            'us',
  caesars:           'us',
  betrivers:         'us',
  unibet_us:         'us',
  williamhill_us:    'us',
  pointsbet_us:      'us',
  bovada:            'us',
  mybookieag:        'us',
  betonlineag:       'us',
  betus:             'us',
  lowvig:            'us',
  superbook:         'us',
  wynnbet:           'us',
  hard_rock_bet:     'us',
  espnbet:           'us',
  fliff:             'us',
  bet365_us:         'us',
  betparx:           'us',
  fanatics:          'us',
  // UK
  bet365:            'uk',
  williamhill:       'uk',
  betfair_ex_uk:     'uk',
  betfair_sb_uk:     'uk',
  paddypower:        'uk',
  skybet:            'uk',
  ladbrokes_uk:      'uk',
  coral:             'uk',
  unibet_gb:         'uk',
  unibet_uk:         'uk',
  betway:            'uk',
  boylesports:       'uk',
  betvictor:         'uk',
  spreadex:          'uk',
  smarkets:          'uk',
  betfred_uk:        'uk',
  // US
  gtbets:            'us',
  // EU
  pinnacle:          'eu',
  onexbet:           'eu',
  betclic:           'eu',
  unibet_eu:         'eu',
  marathonbet:       'eu',
  nordicbet:         'eu',
  coolbet:           'eu',
  betsson:           'eu',
  stoiximan:         'eu',
  bwin:              'eu',
  livescore_bets:    'eu',
  matchbook:         'eu',
  tonybet:           'eu',
  betano:            'eu',
  '10bet':           'eu',
  tipwin:            'eu',
  bethard:           'eu',
  everygame:         'eu',
  betfair_ex_eu:     'eu',
  unibet_fr:         'eu',
  unibet_nl:         'eu',
  unibet_se:         'eu',
  leovegas:          'eu',
  leovegas_se:       'eu',
  winamax_fr:        'eu',
  winamax_de:        'eu',
  // Newly observed (2026-07) — region-only additions. None of these are on
  // EXEC_SHARP_BOOKS, so they remain 'unverified' for cashable purposes;
  // this block only improves crossJurisdiction detection.
  betanysports:      'us',  // offshore US-facing book (OddsAPI us2 bucket)
  casumo:            'uk',
  grosvenor:         'uk',
  livescorebet:      'uk',  // UKGC-licensed; distinct key from livescore_bets above
  pmu_fr:            'eu',  // Pari Mutuel Urbain (France)
  sport888:          'eu',  // 888sport
  tipico_de:         'eu',  // Tipico Germany
  virginbet:         'uk',
  betclic_fr:        'eu',  // France-specific key, distinct from betclic above
  codere_it:         'eu',  // Codere Italy
  // betfair_sb: no bare "betfair_sb" bookmakerId has ever been observed —
  // the only Betfair sportsbook key we get from OddsAPI is betfair_sb_uk
  // (already mapped 'uk' above). Not adding a duplicate/guessed entry.
};

// ── Executability classifier ──────────────────────────────────────────────────
// A 'real' arb is only CASHABLE if every leg is at a book on the sharp allowlist
// below. Safer-by-default: this is an ALLOWLIST, not a blocklist — a book that's
// unrecognized, soft, promo-driven, or newly added to the OddsAPI roster is NOT
// cashable until someone explicitly vets it and adds it here. A blocklist (the
// previous approach) silently defaults NEW books to "cashable", which is exactly
// backwards for a tool that must never overstate what's actually takeable.
//
// Pinnacle is the only book on our current roster with no track record of
// voiding/limiting arb-sized winning bets. Every other retail sportsbook —
// including large regulated brands (bet365, DraftKings, Unibet, William Hill,
// etc.) — is well documented to limit or restrict consistent winners, so it
// does not qualify as "verified takeable" for a guaranteed-hedge claim.
const EXEC_SHARP_BOOKS = new Set(['pinnacle']);

function execIsExchange(bid) {
  return bid === 'matchbook' || bid === 'smarkets' || bid.startsWith('betfair_ex_');
}

function classifyBookmaker(bid) {
  if (EXEC_SHARP_BOOKS.has(bid)) return 'sharp';
  if (execIsExchange(bid))       return 'exchange';
  return 'unverified';
}

function getExecReasons(record) {
  const reasons = [];
  if (record.crossJurisdiction) reasons.push('crossJurisdiction');
  for (const leg of record.legs ?? []) {
    const bid = leg.bookmakerId ?? '';
    if (execIsExchange(bid)) {
      reasons.push(`exchange:${bid}`);
    } else if (!EXEC_SHARP_BOOKS.has(bid)) {
      reasons.push(`unverified:${bid}`);
    }
  }
  return reasons;
}

// Sport labels used in scannedEvents summary (odds-api.net coarse sport vocabulary)
const SPORT_LABEL_MAP = {
  soccer_fifa_world_cup: 'World Cup',
  baseball_mlb:          'MLB',
  basketball_wnba:       'WNBA',
  tennis_atp:            'ATP',
  tennis_wta:            'WTA',
  soccer_usa_mls:        'MLS',
};

function sportLabelFor(key) {
  return SPORT_LABEL_MAP[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ── Settlement-basis derivation ───────────────────────────────────────────────
// WC 2026: group stage ends Jun 26; Round of 32 (first knockout) starts Jun 27.
// Use Jun 28 as conservative cutoff to catch any late group games and all knockouts.
const WC_KNOCKOUT_START = new Date('2026-06-28T00:00:00Z');

function deriveSettlement(sport, type, commenceTime, league) {
  // odds-api.net's sport vocabulary is coarse ('soccer'), so the league string from the
  // event list is what distinguishes a World Cup knockout from a league fixture. Without
  // this the knockout cross-settlement warning would silently disappear on the new vendor.
  const lg = (league || '').toLowerCase();
  if (sport === 'soccer' && lg.includes('world cup')) {
    return deriveSettlement('soccer_fifa_world_cup', type, commenceTime);
  }
  if (sport === 'soccer')            return deriveSettlement('soccer_generic_league', type, commenceTime);
  if (sport === 'baseball')          return deriveSettlement('baseball_mlb', type, commenceTime);
  if (sport === 'basketball')        return deriveSettlement('basketball_wnba', type, commenceTime);
  if (sport === 'tennis')            return deriveSettlement('tennis_atp', type, commenceTime);

  if (sport === 'soccer_generic_league') {
    return {
      basis: 'Regulation 90 min (incl. injury time). Draw is a separate outcome. Extra time / penalties do NOT count.',
      isKnockout: false, basisAmbiguous: false, crossSettlementRisk: false,
    };
  }
  if (sport === 'soccer_fifa_world_cup') {
    const isKnockout = new Date(commenceTime) >= WC_KNOCKOUT_START;
    if (isKnockout) {
      return {
        basis: 'Knockout match: books may settle h2h on 90-min result, full result incl. extra time, OR to-advance. These are NOT equivalent — legs from different books may settle on different bases.',
        isKnockout: true,
        basisAmbiguous: true,
        crossSettlementRisk: true,
      };
    }
    return {
      basis: 'Regulation 90 min (incl. injury time). Draw is a separate outcome. Extra time / penalties do NOT count.',
      isKnockout: false,
      basisAmbiguous: false,
      crossSettlementRisk: false,
    };
  }
  if (sport === 'baseball_mlb') {
    return {
      basis: 'Moneyline, full game incl. extra innings.',
      isKnockout: false, basisAmbiguous: false, crossSettlementRisk: false,
    };
  }
  if (sport === 'basketball_wnba') {
    return {
      basis: 'Moneyline, incl. overtime.',
      isKnockout: false, basisAmbiguous: false, crossSettlementRisk: false,
    };
  }
  if (sport === 'tennis_atp' || sport === 'tennis_wta') {
    return {
      basis: 'Match winner; retirement/walkover rules vary by book.',
      isKnockout: false, basisAmbiguous: false, crossSettlementRisk: false,
    };
  }
  return {
    basis: 'Settlement rules vary by bookmaker — verify before placing.',
    isKnockout: false, basisAmbiguous: false, crossSettlementRisk: false,
  };
}

// ── Files ─────────────────────────────────────────────────────────────────────
const DATA_DIR     = path.join(__dirname, '../data/sports');
const OUTPUT_FILE  = path.join(DATA_DIR, 'opportunities.json');
const CREDITS_FILE = path.join(DATA_DIR, 'credits.json');

// ── Validate API key ──────────────────────────────────────────────────────────
const ODDS_API_NET_KEY = process.env.ODDS_API_NET_KEY;
if (!ODDS_API_NET_KEY) {
  console.error('[sports] FATAL: ODDS_API_NET_KEY not set — add it to .env.local and re-run');
  console.error('[sports]        (ODDS_API_KEY is the-odds-api.com — a different vendor — and will not work here)');
  process.exit(1);
}
const BASE_URL = 'https://api.odds-api.net/v1';

// ── Utilities ─────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const round4 = x => Math.round(x * 10000) / 10000;
const round2 = x => Math.round(x * 100) / 100;

function atomicWrite(file, obj) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// ── Credit state (persisted between manual runs) ──────────────────────────────
let credits = { remaining: null, used: null, lastChecked: null, lastScan: null };
try { credits = JSON.parse(fs.readFileSync(CREDITS_FILE, 'utf8')); } catch {}

function persistCredits() { atomicWrite(CREDITS_FILE, credits); }

// odds-api.net sends NO per-response credit headers (verified: no x-credits-*/x-requests-*
// on any 200). The only source of truth is the /usage endpoint, which itself costs 1 credit.
// It is also LAGGED — the counter settles in batches, so a single before/after delta around
// one call is meaningless. Only whole-cycle deltas (many calls) are trustworthy, which is
// exactly how SCAN_INTERVAL_MIN was derived.
async function refreshCreditsFromUsage() {
  try {
    const r = await apiGet('/usage');
    if (r.status === 200 && r.data && r.data.api_credits_limit != null) {
      credits.used        = r.data.api_credits_used;
      credits.limit       = r.data.api_credits_limit;
      credits.remaining   = r.data.api_credits_limit - r.data.api_credits_used;
      credits.periodEnd   = r.data.period_end_utc;
      credits.lastChecked = new Date().toISOString();
      delete credits.lastHeader;  // vestigial the-odds-api response-header field; this vendor sends none
      persistCredits();
      return credits.remaining;
    }
    console.error(`[sports] /usage HTTP ${r.status}:`, JSON.stringify(r.data).slice(0, 160));
  } catch (e) {
    console.error('[sports] /usage error:', e.message);
  }
  return null;
}

function floorReached() {
  return credits.remaining != null && credits.remaining <= CREDIT_SAFETY_FLOOR;
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
function httpGet(url, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };
    const timer  = setTimeout(() => { req.destroy(); settle(reject, new Error('timeout')); }, timeoutMs);
    const req    = https.get(url, {
      headers: {
        'User-Agent': 'arb-scanner/1.0',
        'Accept':     'application/json',
        'X-API-Key':  ODDS_API_NET_KEY,   // odds-api.net auth — header only, NOT ?apiKey=
      },
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

// ── Rate-limited API GET (plan cap: 60 req/min) ───────────────────────────────
let _lastCallAt = 0;
let _creditsSpentThisRun = 0;   // every billable call this process made — counted locally,
                                // independent of the lagged /usage counter
async function apiGet(pathAndQuery, params) {
  const wait = RATE_LIMIT_MS - (Date.now() - _lastCallAt);
  if (wait > 0) await sleep(wait);
  _lastCallAt = Date.now();

  let url = `${BASE_URL}${pathAndQuery}`;
  if (params) {
    const qs = new URLSearchParams(params).toString();
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  _creditsSpentThisRun++;
  return httpGet(url);
}

// ── odds-api.net → legacy shape adapter ───────────────────────────────────────
// odds-api.net returns a FLAT row per (bookmaker × market_key), e.g.
//   { bookmaker:'pinnacle', bet_type:'moneyline 3w',
//     market_key:'moneyline 3w/home (full time)', odds:2.3, is_available:true }
// the-odds-api returned NESTED bookmakers[].markets[].outcomes[]. Rather than rewrite
// the arb/tiering logic against a new shape (and risk the honest-engine), we rebuild the
// legacy nested shape here so computeArb() and every downstream guard run UNCHANGED.
//
// Two correctness rules, both load-bearing:
//  1. A 2-way 'moneyline' and a 3-way 'moneyline 3w' are DIFFERENT markets (the 2-way on a
//     draw-capable sport is draw-no-bet). Mixing them fabricates arbs. We pick exactly one
//     market type per event — 3w when present, else 2-way — and never merge.
//  2. Only '(full time)' rows are used. Period variants ('1st half', …) are separate markets
//     and mixing them would also fabricate arbs.
function netRowsToLegacyEvent(rows, meta) {
  const ft = rows.filter(r =>
    r && r.is_available && typeof r.odds === 'number' && r.odds > 1 &&
    typeof r.market_key === 'string' && r.market_key.includes(PERIOD_MATCH)
  );
  if (ft.length === 0) return null;

  // Rule 1 — exclusive market type
  const has3w = ft.some(r => r.bet_type === 'moneyline 3w');
  const chosenType = has3w ? 'moneyline 3w' : 'moneyline';
  const chosen = ft.filter(r => r.bet_type === chosenType);
  if (chosen.length === 0) return null;

  // 'moneyline 3w/home (full time)' → 'home'
  const sideOf = mk => {
    const m = /\/([a-z0-9 ]+?)\s*\(/i.exec(mk);
    return m ? m[1].trim().toLowerCase() : null;
  };
  // Outcome NAMES must be the real team names so the UI and eventName stay honest.
  const nameFor = side =>
    side === 'home' ? meta.home_team :
    side === 'away' ? meta.away_team :
    side === 'draw' ? 'Draw' : null;

  const byBook = new Map();
  for (const r of chosen) {
    const name = nameFor(sideOf(r.market_key));
    if (!name) continue;                       // unknown side → dropped, never guessed
    if (!byBook.has(r.bookmaker)) byBook.set(r.bookmaker, new Map());
    const m = byBook.get(r.bookmaker);
    // Same book quoting the same side twice → keep the best (highest) price.
    if (!m.has(name) || r.odds > m.get(name)) m.set(name, r.odds);
  }

  const bookmakers = [];
  for (const [bid, outcomes] of byBook) {
    bookmakers.push({
      key:   bid,
      title: bid,   // vendor exposes no display title; id is shown verbatim rather than invented
      markets: [{
        key: 'h2h',
        outcomes: [...outcomes].map(([name, price]) => ({ name, price })),
      }],
    });
  }

  return {
    home_team:     meta.home_team,
    away_team:     meta.away_team,
    commence_time: meta.commence_time,
    league:        meta.league,
    bookmakers,
  };
}

// ── Arb computation (one event) ───────────────────────────────────────────────
// Returns one of:
//   { type: 'no_arb' }
//   { type: 'too_few_books' }
//   { type: 'false_positive', reason }      — arb existed only because of outlier
//   { type: 'quarantine', record, reason }  — implausibly high ROI
//   { type: 'real', record }

// ── Sharp reference (Pinnacle) — de-vig + persist ─────────────────────────────
// Proportional (multiplicative) de-vig: strip Pinnacle's overround so each
// outcome's implied prob sums to 1, giving a no-vig "fair" line. This is the
// sharp anchor used to judge whether a soft-book price is genuine value. Never
// fabricated: if Pinnacle does not quote EVERY outcome, sharpReference is null.
function buildSharpReference(outcomeMap, names) {
  const rawByOutcome = {};
  for (const name of names) {
    const pin = (outcomeMap[name] ?? []).find(e => EXEC_SHARP_BOOKS.has(e.bookmakerId));
    if (!pin || !(pin.price > 1)) {
      return { present: false, reason: 'pinnacle_not_quoted', book: 'pinnacle', raw: null, noVig: null };
    }
    rawByOutcome[name] = pin.price;
  }
  const impl = {};
  let overround = 0;
  for (const name of names) { impl[name] = 1 / rawByOutcome[name]; overround += impl[name]; }
  if (!(overround > 0)) {
    return { present: false, reason: 'devig_failed', book: 'pinnacle', raw: null, noVig: null };
  }
  return {
    present:   true,
    book:      'pinnacle',
    raw:       names.map(n => ({ outcome: n, odd: rawByOutcome[n] })),
    overround: round4(overround),
    marginPct: round2((overround - 1) * 100),
    noVig:     names.map(n => ({
      outcome:  n,
      fairProb: round4(impl[n] / overround),
      fairOdds: round4(overround / impl[n]),
    })),
  };
}

// ── Edge vs sharp — best soft-book leg vs Pinnacle no-vig fair (Signal-only) ────
// Soft/exchange books are NEVER cashable (honest-engine): this quantifies how far
// the best non-sharp price beats the sharp fair line. Guards: near-certain lines
// excluded (unstable edge); implausible edges suppressed as stale/erroneous.
function buildEdgeVsSharp(outcomeMap, names, sharpRef, outlierIds) {
  if (!sharpRef.present) return { status: 'no_sharp_reference', edgePct: null };

  const fairByName = {};
  for (const f of sharpRef.noVig) fairByName[f.outcome] = f;

  let best = null;             // {outcome, softBook, softBookId, softClass, softOdd, fairOdds, edge}
  let excludedNearCertain = 0;
  for (const name of names) {
    const fair = fairByName[name];
    if (!fair) continue;
    if (fair.fairProb > SHARP_NEAR_CERTAIN_HI || fair.fairProb < SHARP_NEAR_CERTAIN_LO) {
      excludedNearCertain++;
      continue;
    }
    // Best soft (non-sharp) leg for this outcome, outliers removed.
    const soft = (outcomeMap[name] ?? [])
      .filter(e => !EXEC_SHARP_BOOKS.has(e.bookmakerId) && !outlierIds.has(e.bookmakerId));
    if (!soft.length) continue;
    const bestSoft = soft.reduce((b, e) => e.price > b.price ? e : b);
    const edge = bestSoft.price / fair.fairOdds - 1;
    if (!best || edge > best.edge) {
      best = {
        outcome:    name,
        softBook:   bestSoft.bookmaker,
        softBookId: bestSoft.bookmakerId,
        softClass:  classifyBookmaker(bestSoft.bookmakerId),  // 'exchange' | 'unverified'
        softOdd:    bestSoft.price,
        fairOdds:   fair.fairOdds,
        edge,
      };
    }
  }

  if (!best) return { status: 'no_comparable_outcome', edgePct: null, excludedNearCertain };

  // Guardian: a soft book beating the sharp fair line by an implausible margin is
  // a stale/erroneous quote, not real value → suppress the number, keep the audit.
  if (best.edge > SHARP_EDGE_MAX_PLAUSIBLE) {
    return {
      status:     'suppressed_outlier',
      reason:     `edge_${round2(best.edge * 100)}pct_exceeds_${round2(SHARP_EDGE_MAX_PLAUSIBLE * 100)}pct_sane_max`,
      edgePct:    null,                        // suppressed — never surfaced as a real edge
      rawEdgePct: round2(best.edge * 100),     // retained for audit, explicitly labeled raw
      outcome:    best.outcome,
      softBook:   best.softBook,
      cashable:   false,
      excludedNearCertain,
    };
  }

  // Within sane range. Positive → a real Signal edge (soft leg NOT cashable);
  // non-positive → calm "no edge" state.
  return {
    status:     best.edge > 0 ? 'signal' : 'none',
    edgePct:    round2(best.edge * 100),
    outcome:    best.outcome,
    softBook:   best.softBook,
    softBookId: best.softBookId,
    softClass:  best.softClass,
    softOdd:    best.softOdd,
    fairOdds:   best.fairOdds,
    cashable:   false,                         // soft/exchange leg — Signal only
    excludedNearCertain,
  };
}

// ── True arbitrage (arbSum < 1) — cashable / arb_soft / signal ───────────────
// A REAL locked-in arb: best odds per outcome (outlier-cleaned) across DIFFERENT
// books with Σ(1/bestOdds) < 1 − ARB_SAFETY_BUFFER → guaranteed profit whatever
// the result. Real arbs split by reliability: a Pinnacle covering leg → 'cashable'
// (sharp, high limits); all-soft covering legs → 'arb_soft' (real but fragile).
// Everything else stays 'signal' (the value/+EV-vs-Pinnacle signal).
// Honest gates: implausible profit → downgrade; near-certain leg → downgrade;
// single-book combination is impossible (a book's own vig makes Σ1/odds ≥ 1) →
// reject; incomplete coverage → signal. arbLegs only populated when cashable.
// arbSum is the raw impliedClean (already the outlier-cleaned Σ1/bestOdds).
function buildArb(names, legsClean, arbSum) {
  const NONE = (reason) => ({ kind: 'signal', arbProfitPct: null, arbLegs: null, arbReason: reason });

  if (!legsClean || legsClean.some(l => !l) || !(arbSum > 0)) return NONE('incomplete_coverage');
  // Not an arb (the overwhelmingly common case, incl. razor-thin within-buffer).
  if (arbSum >= 1 - ARB_SAFETY_BUFFER) return NONE(null);

  const profit = 1 - arbSum;                       // guaranteed profit fraction (task convention)
  if (profit > ARB_MAX_PLAUSIBLE_PROFIT) return NONE('suppressed_implausible_arb');
  // Same-book "arb" is impossible — a single book's overround makes Σ1/odds ≥ 1.
  if (new Set(legsClean.map(l => l.bookmakerId)).size < 2) return NONE('single_book_not_arb');
  // A near-certain leg (implied prob > 0.97) makes the "arb" fragile (void/push) — exclude.
  if (legsClean.some(l => (1 / l.price) > SHARP_NEAR_CERTAIN_HI)) return NONE('near_certain_leg');

  const arbLegs = names.map((n, i) => ({
    outcome:     n,
    bookmaker:   legsClean[i].bookmaker,
    bookmakerId: legsClean[i].bookmakerId,
    region:      BOOKMAKER_REGION[legsClean[i].bookmakerId] ?? 'unknown',
    odd:         legsClean[i].price,
    stakePct:    round2(((1 / legsClean[i].price) / arbSum) * 100),  // equal-payout stake split
  }));
  // Tier split (same arb math): a covering leg on the sharp book (Pinnacle) makes
  // it 'cashable' (high limits, no arb-winner bans); an all-soft-book arb is real
  // but fragile (limits/bans/line-moves) → 'arb_soft'. Never fabricated.
  const hasSharpLeg = legsClean.some(l => EXEC_SHARP_BOOKS.has(l.bookmakerId));
  return {
    kind:         hasSharpLeg ? 'cashable' : 'arb_soft',
    arbProfitPct: round4(profit),
    arbLegs,
    arbReason:    null,
  };
}

function computeArb(ev, sportKey) {
  const bookmakers = ev.bookmakers ?? [];

  // (a) Minimum bookmaker gate
  if (bookmakers.length < MIN_BOOKMAKERS) return { type: 'too_few_books' };

  // Collect all (bookmaker, price) pairs per outcome.
  // OddsAPI response: bk.markets[{key,outcomes}], not bk.outcomes directly.
  const outcomeMap = {};  // outcomeName → [{bookmakerId, bookmaker, price}]
  for (const bk of bookmakers) {
    for (const market of bk.markets ?? []) {
      if (market.key !== 'h2h') continue;
      for (const oc of market.outcomes ?? []) {
        if (!oc.name || !(oc.price > 1)) continue;
        if (!outcomeMap[oc.name]) outcomeMap[oc.name] = [];
        outcomeMap[oc.name].push({ bookmakerId: bk.key, bookmaker: bk.title, price: oc.price });
      }
    }
  }
  const names = Object.keys(outcomeMap);
  if (names.length < 2) return { type: 'no_arb' };

  function bestFrom(name, excludeIds) {
    const cands = outcomeMap[name].filter(e => !excludeIds.has(e.bookmakerId));
    return cands.length ? cands.reduce((b, e) => e.price > b.price ? e : b) : null;
  }

  // (b) Outlier detection: flag books whose implied prob is >OUTLIER_PCT below median per outcome
  // Always computed so scannedEvents has clean bestLegs for every passing event.
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
  const outliersRemoved = outlierIds.size > 0;

  // Sharp reference (Pinnacle) + edge-vs-sharp — persisted for EVERY event, even
  // when Pinnacle is never the best (highest) leg. Sharp = the validity anchor;
  // soft edges are Signal-only. Both are ADDED alongside bestLegs, never replace it.
  const sharpReference = buildSharpReference(outcomeMap, names);
  const edgeVsSharp    = buildEdgeVsSharp(outcomeMap, names, sharpReference, outlierIds);

  // Best legs with outliers removed — used for both scan entry and clean arb check
  const legsClean = names.map(n => bestFrom(n, outlierIds));
  const hasAllClean = !legsClean.some(l => !l);
  const impliedClean = hasAllClean ? legsClean.reduce((s, l) => s + 1 / l.price, 0) : null;

  // True arbitrage: cashable iff Σ(1/bestOdds) < 1 − buffer across ≥2 books (guarded).
  const arb = hasAllClean
    ? buildArb(names, legsClean, impliedClean)
    : { kind: 'signal', arbProfitPct: null, arbLegs: null, arbReason: 'incomplete_coverage' };

  // Build scan entry for browsable list (every event passing the books gate)
  const eventType  = names.length === 2 ? '2way' : '3way';
  const settlement = deriveSettlement(sportKey, eventType, ev.commence_time, ev.league);
  const scanEntry  = hasAllClean ? {
    sport:        sportKey,
    sportLabel:   sportLabelFor(sportKey),
    eventName:    `${ev.home_team} vs ${ev.away_team}`,
    commenceTime: ev.commence_time,
    type:         eventType,
    booksCount:   bookmakers.length,
    bestLegs:     legsClean.map((l, i) => ({
      outcome:     names[i],
      bookmaker:   l.bookmaker,
      bookmakerId: l.bookmakerId,
      region:      BOOKMAKER_REGION[l.bookmakerId] ?? 'unknown',
      odd:         l.price,
    })),
    impliedSum:      Math.round(impliedClean * 10000) / 10000,
    marginPct:       Math.round((impliedClean - 1) * 10000) / 100,
    outliersRemoved,
    sharpReference,   // Pinnacle raw + no-vig fair line (null if Pinnacle not quoted)
    edgeVsSharp,      // best soft leg vs sharp fair (Signal-only; guarded/suppressed)
    kind:         arb.kind,          // 'cashable' (real arbSum<1 arb) | 'signal' (value vs sharp)
    arbProfitPct: arb.arbProfitPct,  // guaranteed profit fraction (1−arbSum) — cashable only, else null
    arbLegs:      arb.arbLegs,        // covering legs (book+odds+stake per outcome) — cashable only
    arbReason:    arb.arbReason,      // why a would-be arb is not cashable (enum, no numbers)
    settlement,
    cashable:    false,
    execReasons: [],
  } : null;

  // (c) Check whether any arb exists with ALL books (including outliers)
  const legsAll = names.map(n => bestFrom(n, new Set()));
  if (legsAll.some(l => !l)) return { type: 'no_arb', scanEntry };
  const impliedAll = legsAll.reduce((s, l) => s + 1 / l.price, 0);
  if (impliedAll >= 1) return { type: 'no_arb', scanEntry };

  // Arb exists with all books — check if it survives outlier removal
  if (!hasAllClean) return { type: 'false_positive', reason: 'no_clean_price_after_outlier_removal', scanEntry };
  if (impliedClean >= 1) return { type: 'false_positive', reason: 'outlier_was_only_arb_leg', scanEntry };

  const roi = (1 / impliedClean) - 1;

  const legs = legsClean.map((l, i) => ({
    outcome:     names[i],
    bookmaker:   l.bookmaker,
    bookmakerId: l.bookmakerId,
    odd:         l.price,
    stakePct:    Math.round(((1 / l.price) / impliedClean) * 10000) / 100,
    region:      BOOKMAKER_REGION[l.bookmakerId] ?? 'unknown',
  }));

  // crossJurisdiction: legs sit in more than one distinct jurisdiction, so no single
  // bettor can realistically hold all of them.
  //
  // The old rule was `hasUs && hasEuOrUk`, which only knew us/eu/uk. On odds-api.net the
  // book population is largely AU/NZ (and /coverage reports pinnacle as US-only), so that
  // rule would pass an AU+US pair as same-jurisdiction and silently drop a real
  // accessibility warning. Generalised to "more than one distinct KNOWN region": strictly
  // more conservative — it can only ever flag more, never invent profit. 'unknown' is
  // excluded from the count so an unmapped book cannot manufacture a false warning.
  const knownRegions = new Set(
    legs.map(l => l.region).filter(r => r && r !== 'unknown')
  );
  const crossJurisdiction = knownRegions.size > 1;

  const record = {
    sport:           sportKey,
    eventName:       `${ev.home_team} vs ${ev.away_team}`,
    commenceTime:    ev.commence_time,
    type:            eventType,
    legs,
    roiPct:          Math.round(roi * 10000) / 100,
    impliedSum:      Math.round(impliedClean * 10000) / 10000,
    outliersRemoved,
    crossJurisdiction,
    numBookmakers:   bookmakers.length,
    sharpReference,   // Pinnacle raw + no-vig fair line (null if Pinnacle not quoted)
    edgeVsSharp,      // best soft leg vs sharp fair (Signal-only; guarded/suppressed)
    kind:            arb.kind,          // 'cashable' (real arbSum<1 arb) | 'signal'
    arbProfitPct:    arb.arbProfitPct,  // guaranteed profit fraction (1−arbSum) — cashable only
    arbLegs:         arb.arbLegs,        // covering legs — cashable only
    arbReason:       arb.arbReason,      // why not cashable (enum, no numbers)
    lastUpdated:     new Date().toISOString(),
    settlement,
  };

  // (d) Quarantine implausibly high ROI
  if (roi > MAX_PLAUSIBLE_ROI) {
    return { type: 'quarantine', record: { ...record, reason: 'roi_above_plausible' }, scanEntry };
  }

  // (e) Executability classifier — real arb, but not cashable if it depends on
  //     soft/restrictive books, betting exchanges, or requires cross-jurisdiction access.
  const execReasons = getExecReasons(record);
  if (execReasons.length > 0) {
    if (scanEntry) scanEntry.execReasons = execReasons;
    return { type: 'flagged', record: { ...record, reasons: execReasons }, scanEntry };
  }

  if (scanEntry) scanEntry.cashable = true;
  return { type: 'real', record, scanEntry };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function scan() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Real credits-before, read from /usage (costs 1 credit). This is the anchor for the
  // whole-cycle delta that sizes SCAN_INTERVAL_MIN.
  //
  // This MUST precede the floor guard: credits.json may hold state from a previous vendor
  // or a previous billing period, and gating on stale numbers would either skip a scan
  // that has budget or run one that does not. /usage is the only source of truth.
  await refreshCreditsFromUsage();

  // Monthly budget floor guard — exits before any further billable call
  if (floorReached()) {
    console.log(
      `[sports] MONTHLY FLOOR — scan skipped` +
      ` (remaining: ${credits.remaining} <= ${CREDIT_SAFETY_FLOOR})` +
      ` — credits reset at start of next billing cycle`
    );
    process.exit(0);
  }
  const creditsBefore = credits.remaining;
  const usedBefore    = credits.used;
  console.log(`[sports] === snapshot scan start | credits used: ${usedBefore ?? '?'} / ${credits.limit ?? '?'} | remaining: ${creditsBefore ?? 'unknown'} | interval: ${SCAN_INTERVAL_MIN}min ===`);

  // ── Adaptive per-cycle budget ───────────────────────────────────────────────
  // A FIXED interval sized against today's event count is not safe on its own: the
  // event census is seasonal (soccer alone triples when the European leagues return in
  // August), so a cycle that costs ~N today can cost ~3N later and breach the hard cap
  // mid-period. Rather than trust a static number, each cycle is allowed at most an even
  // share of what is actually left in the billing period. Truncation is LOGGED, never
  // silent — a partial scan must not read as full coverage.
  let cycleBudget = Infinity;
  if (credits.remaining != null && credits.periodEnd) {
    const msLeft        = new Date(credits.periodEnd).getTime() - Date.now();
    const cyclesLeft    = Math.max(1, Math.ceil(msLeft / (SCAN_INTERVAL_MIN * 60_000)));
    cycleBudget         = Math.floor((credits.remaining - CREDIT_SAFETY_FLOOR) / cyclesLeft);
    console.log(`[sports] budget: ${credits.remaining - CREDIT_SAFETY_FLOOR} spendable / ${cyclesLeft} cycles left in period → ${cycleBudget} credits this cycle`);
  }
  let budgetTruncated = 0;

  // Step 1: GET /sports — ALL sports, no allowlist (1 credit)
  let targetSports = [];
  try {
    const r = await apiGet('/sports');
    if (r.status === 200 && Array.isArray(r.data?.items)) {
      targetSports = r.data.items;
      console.log(`[sports] /sports: ${targetSports.length} sports — ${targetSports.join(', ')}`);
    } else {
      console.error(`[sports] /sports HTTP ${r.status}:`, JSON.stringify(r.data).slice(0, 200));
    }
  } catch (e) {
    console.error('[sports] /sports error:', e.message);
  }
  if (targetSports.length === 0) {
    console.log('[sports] no sports returned — exiting with empty result');
  }

  // Step 1b: GET /coverage (1 credit) — real per-bookmaker jurisdiction, replacing the
  // static the-odds-api map. Books absent from coverage stay 'unknown' (never guessed).
  try {
    const r = await apiGet('/coverage');
    if (r.status === 200 && Array.isArray(r.data?.bookmakers)) {
      for (const b of r.data.bookmakers) {
        const codes = new Set(b.country_codes || []);
        let region = 'unknown';
        if (codes.has('UK') || codes.has('GB'))      region = 'uk';
        else if ([...codes].some(c => EU_CODES.has(c))) region = 'eu';
        else if (codes.has('US'))                    region = 'us';
        else if (codes.has('AU') || codes.has('NZ')) region = 'au';
        BOOKMAKER_REGION[b.bookmaker] = region;
      }
      console.log(`[sports] /coverage: ${r.data.bookmakers.length} bookmakers mapped to jurisdictions`);
    }
  } catch (e) {
    console.error('[sports] /coverage error:', e.message);
  }

  // Step 2: per sport → event list (1 credit), then one odds snapshot per eligible event (1 credit each)
  const opportunities      = [];   // genuinely cashable: every leg on the sharp allowlist
  const flaggedArbs        = [];   // real arb but not cashable (unverified/exchange/cross-juris leg)
  const quarantine         = [];
  const sportsScanned      = [];
  const scannedEvents      = [];
  const observedBookmakerIds = new Set();  // every bookmakerId seen this run, for the classification printout
  let   tooFewBooks        = 0;
  let   noArbCount         = 0;
  let   falsePositives     = 0;

  let creditFloorHit = false;

  for (const sportKey of targetSports) {
    if (creditFloorHit) break;

    // Step 2a: event list for this sport (1 credit)
    let eventList = [];
    try {
      const r = await apiGet('/events', { sport: sportKey, limit: 200 });
      if (r.status === 200 && Array.isArray(r.data?.items)) {
        eventList = r.data.items;
      } else {
        console.error(`[sports] /events ${sportKey} HTTP ${r.status}:`, JSON.stringify(r.data).slice(0, 200));
        continue;
      }
    } catch (e) {
      console.error(`[sports] /events ${sportKey} error:`, e.message);
      continue;
    }

    // Books gate applied BEFORE spending a credit on the event's odds — the vendor
    // publishes bookmaker_count on the event list, so thin events cost nothing.
    const eligible = eventList.filter(e => (e.bookmaker_count ?? 0) >= MIN_BOOKMAKERS);
    tooFewBooks += eventList.length - eligible.length;
    console.log(`[sports] ${sportKey}: ${eventList.length} events, ${eligible.length} with >=${MIN_BOOKMAKERS} books`);
    if (eligible.length > 0) sportsScanned.push(sportKey);

    // Step 2b: one odds snapshot per eligible event (1 credit each)
    for (const meta of eligible) {
      // Credit guard: check BEFORE spending
      if (credits.remaining != null && (credits.remaining - _creditsSpentThisRun - 1) <= CREDIT_SAFETY_FLOOR) {
        console.warn(
          `[sports] CREDIT FLOOR — stopping before next request would breach floor` +
          ` (remaining: ~${credits.remaining - _creditsSpentThisRun}, floor: ${CREDIT_SAFETY_FLOOR})`
        );
        creditFloorHit = true;
        break;
      }
      // Per-cycle budget guard — keeps a seasonal event surge from breaching the cap
      if (_creditsSpentThisRun + 1 > cycleBudget) {
        budgetTruncated++;
        continue;   // counted and reported below, never silently dropped
      }

      let rows = [];
      try {
        const r = await apiGet(`/events/${meta.event_id}/odds/snapshot`, {
          types: MARKET_TYPES.join(','),
          limit: ODDS_SNAPSHOT_LIMIT,
        });
        if (r.status === 200 && Array.isArray(r.data?.items)) {
          rows = r.data.items;
          // limit == odds_snapshot_limit_max, so a non-null cursor means the event genuinely
          // exceeded the cap. Say so rather than silently scanning a partial book.
          if (r.data.next_cursor) {
            console.warn(`[sports]   event ${meta.event_id}: truncated at ${ODDS_SNAPSHOT_LIMIT} rows (next_cursor present) — partial book`);
          }
        } else {
          console.error(`[sports]   event ${meta.event_id} HTTP ${r.status}:`, JSON.stringify(r.data).slice(0, 160));
          continue;
        }
      } catch (e) {
        console.error(`[sports]   event ${meta.event_id} error:`, e.message);
        continue;
      }

      const ev = netRowsToLegacyEvent(rows, {
        home_team:     meta.home_team,
        away_team:     meta.away_team,
        // vendor gives unix seconds; downstream (deriveSettlement, UI) expects ISO
        commence_time: meta.start_time ? new Date(meta.start_time * 1000).toISOString() : null,
        league:        meta.league,
      });
      if (!ev) { noArbCount++; continue; }

      for (const bk of ev.bookmakers ?? []) {
        if (bk.key) observedBookmakerIds.add(bk.key);
      }
      const res = computeArb(ev, sportKey);
      if (res.scanEntry) scannedEvents.push(res.scanEntry);
      switch (res.type) {
        case 'real':           opportunities.push(res.record);  break;
        case 'flagged':        flaggedArbs.push(res.record);    break;
        case 'quarantine':     quarantine.push(res.record);     break;
        case 'false_positive': falsePositives++;                break;
        case 'too_few_books':  tooFewBooks++;                   break;
        case 'no_arb':         noArbCount++;                    break;
      }
    }
  }

  opportunities.sort((a, b) => b.roiPct - a.roiPct);

  // Build summary: per-sport event counts for the browsable list
  const sportCounts = {};
  for (const ev of scannedEvents) {
    sportCounts[ev.sport] = (sportCounts[ev.sport] ?? 0) + 1;
  }
  const summary = {
    sportsScanned: sportsScanned.map(key => ({
      key,
      label:      sportLabelFor(key),
      eventCount: sportCounts[key] ?? 0,
    })),
    totalEvents: scannedEvents.length,
  };

  // Real credits-after, read from /usage. The delta over this WHOLE cycle (many calls) is
  // the trustworthy per-cycle cost — single-call deltas are meaningless (lagged counter).
  await refreshCreditsFromUsage();
  const cycleCostMeasured = (usedBefore != null && credits.used != null)
    ? credits.used - usedBefore : null;

  // Persist the running cost measurement so consumption is observable over time.
  credits.lastCycle = {
    at:               new Date().toISOString(),
    usedBefore,
    usedAfter:        credits.used,
    measuredCost:     cycleCostMeasured,   // whole-cycle delta from /usage (authoritative)
    countedCalls:     _creditsSpentThisRun, // calls this process made (local count, no lag)
    intervalMin:      SCAN_INTERVAL_MIN,
    projectedMonthly: cycleCostMeasured != null
      ? Math.round(cycleCostMeasured * (43200 / SCAN_INTERVAL_MIN)) : null,
  };
  credits.history = [...(credits.history || []), credits.lastCycle].slice(-200);

  // Write output atomically
  const output = {
    lastUpdated:      new Date().toISOString(),
    creditsRemaining: credits.remaining,
    creditsUsed:      credits.used,
    creditsLimit:     credits.limit,
    cycleCost:        cycleCostMeasured,
    scanIntervalMin:  SCAN_INTERVAL_MIN,
    coverageComplete: budgetTruncated === 0,
    eventsSkippedForBudget: budgetTruncated,
    scanMode:         'snapshot',
    vendor:           'odds-api.net',
    marketTypes:      MARKET_TYPES,
    sportsScanned,
    opportunities,    // cashable only: passed executability classifier
    flaggedArbs,      // real arb math but blocked by unverified/exchange/cross-juris legs
    quarantine,
    scannedEvents,
    summary,
  };
  atomicWrite(OUTPUT_FILE, output);

  // Parallel history sink (non-fatal): snapshot cashable sports arbs verbatim. Only fires
  // when agent12 is actually running (not part of the default pm2 fleet at time of writing).
  try {
    require('../lib/history-logger').appendSnapshot('sports', Date.now(), opportunities || []);
  } catch (e) { console.log('[history] sports snapshot skipped:', e.message); }

  credits.lastScan = new Date().toISOString();
  persistCredits();

  console.log('\n[sports] === SCAN COMPLETE ===');
  console.log(`  Sports scanned:          ${sportsScanned.length}  (${sportsScanned.join(', ') || 'none'})`);
  console.log(`  Credits used before:     ${usedBefore ?? 'unknown'}`);
  console.log(`  Credits used after:      ${credits.used ?? 'unknown'}`);
  console.log(`  MEASURED cycle cost:     ${cycleCostMeasured ?? 'unknown'}  (whole-cycle /usage delta)`);
  console.log(`  Calls this process made: ${_creditsSpentThisRun}  (local count)`);
  console.log(`  Credits remaining:       ${credits.remaining ?? 'unknown'} / ${credits.limit ?? '?'}`);
  console.log(`  Interval:                ${SCAN_INTERVAL_MIN} min → projected ${credits.lastCycle.projectedMonthly ?? '?'} credits/month`);
  if (budgetTruncated > 0) {
    console.warn(
      `  [honest] COVERAGE INCOMPLETE: ${budgetTruncated} eligible event(s) skipped by the` +
      ` per-cycle credit budget (${cycleBudget}) — this scan is NOT full coverage.`
    );
  }
  console.log(`  Cashable arb opps:       ${opportunities.length}  (passed executability classifier)`);
  console.log(`  Flagged (not cashable):  ${flaggedArbs.length}  (unverified/exchange/cross-juris legs)`);
  console.log(`  Quarantined (bad data):  ${quarantine.length}`);
  console.log(`  False positives removed: ${falsePositives}  (outlier was the only arb leg)`);
  console.log(`  Skipped (< ${MIN_BOOKMAKERS} books):   ${tooFewBooks}`);
  console.log(`  No arb at all:           ${noArbCount}`);

  // Bookmaker classification table — every bookmakerId observed this run, plus the
  // full known-universe map, classified sharp / exchange / unverified. Printed every
  // run so a NEW book the scanner starts emitting shows up here immediately instead
  // of silently slipping into (or out of) the cashable bucket.
  const allKnownBids = new Set([...observedBookmakerIds, ...Object.keys(BOOKMAKER_REGION)]);
  console.log(`\n[sports] === Bookmaker classification (${allKnownBids.size} known, ${observedBookmakerIds.size} observed this run) ===`);
  for (const bid of [...allKnownBids].sort()) {
    const cls    = classifyBookmaker(bid);
    const seen   = observedBookmakerIds.has(bid) ? '' : '  (not observed this run)';
    console.log(`  ${bid.padEnd(20)} ${cls.padEnd(10)}${seen}`);
  }

  if (opportunities.length === 0) {
    console.log('\n  [honest] 0 cashable arb opportunities — this is the expected result most of the time.');
    console.log(`  ${flaggedArbs.length} arb(s) found but not cashable (unverified/exchange/cross-juris legs).`);
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
