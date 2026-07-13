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
const REGIONS          = ['eu', 'uk', 'us'];
const MARKETS          = ['h2h'];
const ODDS_FORMAT      = 'decimal';
// Season-dependent — revisit when seasons change (EPL/Serie A/La Liga return ~Aug;
// NFL/NHL/NBA return Sep–Oct; Champions League returns Sep).
const SPORTS_ALLOWLIST = [
  'soccer_fifa_world_cup',  // LIVE Jun–Jul 2026: group stage + knockouts, many books per match
  'baseball_mlb',           // in season
  'basketball_wnba',        // in season
  'tennis_atp',             // grass/Wimbledon window — kept so active weeks are not missed
  'tennis_wta',             // same
  'soccer_usa_mls',         // in season — kept; intersection skips if not yet active
];
const MIN_BOOKMAKERS      = 4;     // event ignored if fewer books quote it
const OUTLIER_PCT         = 0.25;  // book's implied prob deviating > this from median → outlier
const MAX_PLAUSIBLE_ROI   = 0.06;  // h2h arb > 6% net → almost certainly a data error → quarantine
const CREDIT_SAFETY_FLOOR = 30;    // stop scanning if remaining credits would drop to this

// ── Sharp-reference edge guards ───────────────────────────────────────────────
// Pinnacle is the only sharp/verified book (EXEC_SHARP_BOOKS). These thresholds
// gate the Signal-only "edge vs sharp no-vig fair" metric so no absurd number
// ships. Approved by Diego for this task; not tunable magic — each has a stated
// honest-engine rationale below.
const SHARP_EDGE_MAX_PLAUSIBLE = 0.10; // best-soft leg beating Pinnacle no-vig fair by >10% is a stale/erroneous line, not real value → suppress
const SHARP_NEAR_CERTAIN_HI    = 0.97; // no-vig fair prob above this → near-certain favorite; edge% is numerically unstable → exclude outcome
const SHARP_NEAR_CERTAIN_LO    = 0.03; // no-vig fair prob below this → longshot; same instability → exclude outcome

// Each /odds call costs 1 credit PER region requested. With 3 regions, cost = 3 per sport.
const CREDITS_PER_SPORT = REGIONS.length;

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

// Sport labels used in scannedEvents summary (matches SPORTS_ALLOWLIST keys)
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

function deriveSettlement(sport, type, commenceTime) {
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
const ODDS_API_KEY = process.env.ODDS_API_KEY;
if (!ODDS_API_KEY) {
  console.error('[sports] FATAL: ODDS_API_KEY not set — add it to .env.local and re-run');
  process.exit(1);
}
const BASE_URL = 'https://api.the-odds-api.com/v4';

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

  // Build scan entry for browsable list (every event passing the books gate)
  const eventType  = names.length === 2 ? '2way' : '3way';
  const settlement = deriveSettlement(sportKey, eventType, ev.commence_time);
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

  // crossJurisdiction: true when any leg is US-only and another is EU/UK
  const hasUs     = legs.some(l => l.region === 'us');
  const hasEuOrUk = legs.some(l => l.region === 'eu' || l.region === 'uk');
  const crossJurisdiction = hasUs && hasEuOrUk;

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
  console.log(`[sports] === snapshot scan start | credits before: ${creditsBefore ?? 'unknown'} | regions: ${REGIONS.join(',')} | cost per sport: ${CREDITS_PER_SPORT} ===`);

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

  // Step 2: GET /odds per sport (each call costs CREDITS_PER_SPORT credits = 1 per region requested)
  const opportunities      = [];   // genuinely cashable: every leg on the sharp allowlist
  const flaggedArbs        = [];   // real arb but not cashable (unverified/exchange/cross-juris leg)
  const quarantine         = [];
  const sportsScanned      = [];
  const scannedEvents      = [];
  const observedBookmakerIds = new Set();  // every bookmakerId seen this run, for the classification printout
  let   tooFewBooks        = 0;
  let   noArbCount         = 0;
  let   falsePositives     = 0;

  for (const sportKey of targetSports) {
    // Credit guard: check BEFORE spending — account for full multi-region cost
    if (credits.remaining != null && (credits.remaining - CREDITS_PER_SPORT) <= CREDIT_SAFETY_FLOOR) {
      console.warn(
        `[sports] CREDIT FLOOR — stopping before next request would breach floor` +
        ` (remaining: ${credits.remaining}, cost: ${CREDITS_PER_SPORT}, floor: ${CREDIT_SAFETY_FLOOR})`
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

    await sleep(300);  // small pause between sport requests
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

  // Write output atomically
  const output = {
    lastUpdated:      new Date().toISOString(),
    creditsRemaining: credits.remaining,
    creditsUsed:      credits.used,
    scanMode:         'snapshot',
    regions:          REGIONS,
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

  // Console summary (honest)
  const creditsSpent = creditsBefore != null && credits.remaining != null
    ? creditsBefore - credits.remaining : null;

  console.log('\n[sports] === SCAN COMPLETE ===');
  console.log(`  Sports scanned:          ${sportsScanned.length}  (${sportsScanned.join(', ') || 'none'})`);
  console.log(`  Credits before scan:     ${creditsBefore ?? 'unknown'}`);
  console.log(`  Credits remaining:       ${credits.remaining ?? 'unknown'}`);
  console.log(`  Credits spent this run:  ${creditsSpent ?? 'unknown'}`);
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
