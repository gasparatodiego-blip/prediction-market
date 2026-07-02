#!/usr/bin/env node
'use strict';

/**
 * Shared deterministic matching utilities used by all matcher agents.
 * deterministic matcher — no external API calls
 */

const fs = require('fs');

const BATCH_SIZE = 20;

// ── Deterministic matching config ──────────────────
// Fees mirror agent5-calculator.js PLATFORM_FEES — keep both in sync if rates change.
const PLATFORM_FEES = {
  kalshi:     0.07,
  polymarket: 0.02,
  predictit:  0.10 + 0.05,
  manifold:   0.00,
  oddsapi:    0.00,
};
const REAL_BOOK          = new Set(['kalshi', 'polymarket']); // platforms with an executable bid/ask book
const MIN_CONFIDENCE     = 0.65;   // same confidence bar the previous matching pipeline used
// IDF must be computed over the FULL market universe (tens of thousands of markets), not a
// small per-category batch — otherwise generic context words (e.g. "world cup", "2026") look
// artificially rare/distinctive in a small sample, producing false matches, while common phrasing
// shared by genuinely-matching pairs looks artificially common, producing false rejections.
const MIN_IDF_SCORE      = 8.0;    // pair must accumulate >= this total IDF from shared tokens
// 4.0 let tournament/umbrella-event words through as "distinctive" (e.g. "fifa"/"world_cup" sit at
// idf~3.7-4.6 in a market universe that's a few % World Cup props) — enough shared umbrella terms
// alone cleared the old bar and matched unrelated props under the same event. 5.0 requires the
// shared vocabulary to include something genuinely entity-specific (a name, a narrow phrase).
const HIGH_IDF_THRESHOLD = 5.0;    // "distinctive" token: rare across the full market universe
const MIN_HIGH_IDF_SHARED = 2;     // must share >=2 distinctive tokens to be considered same event
const SUSPICIOUS_ROI     = 15;     // netROI% above this on a real-book pair → quarantine (unreliable)
const MAX_SPREAD_WIDTH   = 0.10;   // yesAsk-yesBid > 10c on either leg → illiquid, skip arb check

const STOPWORDS = new Set([
  'will','the','a','an','in','by','of','at','to','for','and','or','is','are',
  'be','as','its','it','win','wins','winning','market','prediction','happen',
  'occur','make','have','has','that','this','with','from','on','not','no',
  'yes','next','how','which','who','what','when','where','why','than','their',
  'they','he','she','we','do','did','does','before','after','during','outcome',
  'over','under','more','less','most','least','any','all','each','first','last',
  'new','old','get','got','been','were','was','would','could','should','may',
  'might','can','shall','must','about','between','against','without','within',
  'through','into','onto','upon','around','per','if',
]);

function tokenize(text) {
  const clean = (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const words = clean.split(/\s+/).filter(t => t.length >= 3 && !STOPWORDS.has(t));
  const toks  = new Set(words);
  for (let i = 0; i < words.length - 1; i++) toks.add(`${words[i]}_${words[i + 1]}`);
  return toks;
}

// Document-frequency/IDF index built once per run over the FULL extracted market universe
// (all platforms, all categories) — see MIN_IDF_SCORE comment above for why this must not be
// scoped to a single category's small sample.
function buildIdfIndex(allMarkets) {
  const N = allMarkets.length;
  const tokensById = new Map();
  const df = new Map();
  for (const m of allMarkets) {
    const toks = tokenize(m.question);
    tokensById.set(m.id, toks);
    for (const t of toks) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = new Map();
  for (const [t, freq] of df) idf.set(t, Math.log(N / freq));
  return { idf, tokensById };
}

// Markets built by extractAllMarkets() embed the outcome label as "[outcome: X]"
// in the question string (see predictit/kalshi below) — use it as a deterministic
// same-event gate without any external call.
function extractOutcomeLabel(question) {
  const m = /\[outcome:\s*([^\]]+)\]/i.exec(question || '');
  return m ? m[1].trim().toLowerCase() : '';
}

// If a market's raw text mentions a specific outcome word (e.g. an opponent candidate's
// surname), it must show up in the other leg's text too — otherwise the two legs are pricing
// different specific outcomes of the same umbrella event (e.g. "Trump wins" vs "[outcome: Vance]").
function questionMentions(question, label) {
  if (label === 'yes' || label === 'no') return true;
  const q = (question || '').toLowerCase();
  const words = label.split(/\s+/).filter(w => w.length >= 3);
  if (words.length === 0) return true;
  return words.some(w => q.includes(w));
}

// ── Bracket-independent same-event checks ──────────────────────────────────
// The [outcome: X] bracket convention (Kalshi/PredictIt) was the only same-event
// signal outcomesCompatible() had. Polymarket/Manifold titles never carry that
// bracket, so two unrelated events that merely share a name/keyword could clear
// the IDF token-overlap gate and get paired as if they were the same market —
// e.g. "Will Donald Trump win the 2028 Election?" (Polymarket) matched against
// "Will Donald Trump be impeached during his second term?" (Manifold): same
// person, completely different proposition.
//
// These checks run for EVERY pair (bracketed or not), in addition to the
// bracket logic above — never in place of it. Conservative by design: each
// only ever REJECTS on a positive, specific conflict signal; when a signal
// can't be determined on either side it stays neutral rather than guess,
// since here a missed match is far cheaper than a fabricated spread.

const GENERATIONAL_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

// Proper-noun phrases: 2+ consecutive Title-Case words (original casing, not
// the lowercased tokenizer output) — a crude but deterministic person-name
// detector. No NER available; this only ever feeds a same-base-name +
// suffix-conflict check below, so an imprecise extraction just falls through
// neutral rather than causing a false reject.
function extractNamePhrases(question) {
  const clean = stripOutcome(question || '');
  const matches = clean.match(/\b(?:[A-Z][a-zA-Z'’-]*\s+){1,4}[A-Z][a-zA-Z'’-]*\b/g) || [];
  return matches
    .map(phrase => phrase.trim().split(/\s+/).map(w => w.toLowerCase().replace(/[.'’]/g, '')))
    .filter(words => words.length >= 2);
}

// True when both titles reference the SAME base name but exactly one phrase
// carries a generational suffix ("Trump" vs "Trump Jr.") — different people,
// a shared surname/substring alone is never enough to call this a match.
function hasEntitySuffixConflict(qa, qb) {
  const namesA = extractNamePhrases(qa);
  const namesB = extractNamePhrases(qb);
  for (const wa of namesA) {
    const suffixA = GENERATIONAL_SUFFIXES.has(wa.at(-1)) ? wa.at(-1) : null;
    const baseA   = (suffixA ? wa.slice(0, -1) : wa).join(' ');
    for (const wb of namesB) {
      const suffixB = GENERATIONAL_SUFFIXES.has(wb.at(-1)) ? wb.at(-1) : null;
      const baseB   = (suffixB ? wb.slice(0, -1) : wb).join(' ');
      if (baseA && baseA === baseB && suffixA !== suffixB) return true;
    }
  }
  return false;
}

// Proposition-type signatures — ordered, first match wins. Deliberately narrow
// and specific (not a general topic classifier) so unrelated markets stay
// unclassified (null) rather than forced into a wrong bucket.
const PROPOSITION_SIGNATURES = [
  ['impeachment',     /\bimpeach/i],
  ['resign_removal',  /\bresign|\bremoved?\s+from\s+office|\bstep(s)?\s+down|\bousted?\b/i],
  ['election_win',    /\bwin(s)?\b[^.?]{0,40}\b(election|president|presidency|primary|race|seat)\b|\b(election|president|presidency|primary|race)\b[^.?]{0,40}\bwin(s)?\b/i],
  ['nomination',      /\bnominee|\bnomination|\bnominate/i],
  // Announcing/entering a race is a different proposition from winning it — a
  // candidate can announce and still lose, or win without being "first to
  // announce". Checked after election_win/nomination (first-match-wins) so a
  // title that already signals win/nominate keeps that classification; this
  // only catches the "will they run" phrasing common on both platforms
  // (verified against live titles: "announce a presidential run", "announce
  // his presidential candidacy", "run for President in 2028", etc — and does
  // NOT fire on unrelated "announced" usage like "departure announced" or
  // "announcers say during [game]", which lack a run/bid/campaign/candidacy
  // object within range).
  ['announce_candidacy', /\b(announc|declar)(e|es|ed|ing)\b[^.?]{0,40}\b(run|bid|campaign|candidacy)\b|\benter(s|ed|ing)?\b[^.?]{0,40}\b(race|campaign)\b|\blaunch(es|ed|ing)?\b[^.?]{0,40}\b(campaign|bid)\b|\bfile(s|d)?\s+to\s+run\b|\bexploratory\s+committee\b|\brun(s)?\s+for\s+(president|office|senate|governor|mayor)\b/i],
  ['holds_office',    /\bstill\s+(be\s+)?president|\bin\s+office|\bserving\s+as|\bremain(s)?\s+in\s+office|\bout\s+as\s+president/i],
  ['price_threshold', /\breach(es)?\s*\$|\babove\s*\$|\bbelow\s*\$|\$[\d,.]+[kmb]?\b/i],
];

function classifyProposition(question) {
  const clean = stripOutcome(question || '');
  for (const [label, re] of PROPOSITION_SIGNATURES) {
    if (re.test(clean)) return label;
  }
  return null; // no confident signature match — stays neutral, never blocks on its own
}

// Reject only when BOTH legs classify to a known, DIFFERENT proposition type.
// An unclassified leg on either side means we don't know enough to compare —
// that must not force a reject (it would wreck recall on ordinary markets
// that don't match any signature), so this stays neutral in that case.
function hasPropositionTypeMismatch(qa, qb) {
  const pa = classifyProposition(qa);
  const pb = classifyProposition(qb);
  return pa !== null && pb !== null && pa !== pb;
}

// Resolution-window years — if both titles name a year and the sets share
// none, they resolve on different timelines and can't be the same market.
function extractYears(question) {
  const clean = stripOutcome(question || '');
  const years = (clean.match(/\b(20[2-3]\d)\b/g) || []).map(Number);
  return new Set(years);
}

function hasDateWindowMismatch(qa, qb) {
  const ya = extractYears(qa);
  const yb = extractYears(qb);
  if (ya.size === 0 || yb.size === 0) return false; // can't compare — stay neutral
  for (const y of ya) if (yb.has(y)) return false;   // any shared year → compatible
  return true;
}

function outcomesCompatible(a, b) {
  const oa = extractOutcomeLabel(a.question);
  const ob = extractOutcomeLabel(b.question);
  let bracketOk;
  if (oa && ob) {
    if (oa === ob) bracketOk = true;
    else if (oa === 'yes' || oa === 'no' || ob === 'yes' || ob === 'no') bracketOk = true;
    else return false; // explicit different outcomes — reject immediately, unchanged behavior
  } else if (oa && !ob) {
    bracketOk = questionMentions(b.question, oa);
  } else if (ob && !oa) {
    bracketOk = questionMentions(a.question, ob);
  } else {
    bracketOk = true; // neither leg carries an explicit outcome label — nothing to cross-check from brackets
  }
  if (!bracketOk) return false;

  // Bracket-independent checks — run for ALL pairs, bracketed or not. This is
  // the layer that catches Polymarket/Manifold false pairs the bracket logic
  // above can never see (those platforms never emit an [outcome: X] bracket).
  if (hasEntitySuffixConflict(a.question, b.question)) return false;
  if (hasPropositionTypeMismatch(a.question, b.question)) return false;
  if (hasDateWindowMismatch(a.question, b.question)) return false;

  return true;
}

function stripOutcome(q) {
  return (q || '').replace(/\s*\[outcome:[^\]]*\]/i, '').trim();
}

function describeEvent(a, b) {
  const qa = stripOutcome(a.question), qb = stripOutcome(b.question);
  return qa.length >= qb.length ? qa : qb;
}

// Executable bid/ask arb — NEVER probability/midpoint. Only meaningful when both
// legs expose a real order book (kalshi, polymarket); returns null otherwise.
function bestNetRoi(a, b) {
  if (a.yesBid <= 0 || a.yesAsk >= 1 || b.yesBid <= 0 || b.yesAsk >= 1) return null;
  if ((a.yesAsk - a.yesBid) > MAX_SPREAD_WIDTH) return null;
  if ((b.yesAsk - b.yesBid) > MAX_SPREAD_WIDTH) return null;
  const dir1 = a.yesAsk + (1 - b.yesBid); // buy YES on A, buy NO on B
  const dir2 = b.yesAsk + (1 - a.yesBid); // buy YES on B, buy NO on A
  const bestCost = Math.min(dir1, dir2);
  const grossProfit = 1 - bestCost;
  if (grossProfit <= 0) return null;
  const grossROI = (grossProfit / bestCost) * 100;
  const feeA = PLATFORM_FEES[a.platform] || 0;
  const feeB = PLATFORM_FEES[b.platform] || 0;
  return grossROI * (1 - feeA - feeB);
}

// ── Heartbeat ─────────────────────────────────────

function beat(name) {
  const HB_FILE = '/tmp/agent-heartbeats.json';
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb[name] = Date.now();
  fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2));
}

// ── OddsAPI market extraction ──────────────────────

function extractOddsApiMarkets() {
  const ODDS_FILE = '/tmp/odds-api-raw.json';
  const markets = [];
  try {
    const raw  = JSON.parse(fs.readFileSync(ODDS_FILE, 'utf8'));
    const age  = Date.now() - (raw.fetchedAt || 0);
    if (age > 600_000) return markets; // stale > 10 min
    for (const ev of (raw.events || [])) {
      const bookmakers = ev.bookmakers || [];
      if (bookmakers.length === 0) continue;
      // Average implied probability for home team across bookmakers
      const homeProbs = [];
      for (const bm of bookmakers) {
        const h2h = (bm.markets || []).find(m => m.key === 'h2h');
        const outcome = (h2h?.outcomes || []).find(o => o.name === ev.home_team);
        if (outcome?.price > 1) homeProbs.push((1 / outcome.price) * 100);
      }
      if (homeProbs.length === 0) continue;
      const avgProb = Math.round(homeProbs.reduce((a, b) => a + b, 0) / homeProbs.length);
      markets.push({
        id:          `odds-${ev.id}`,
        platform:    'oddsapi',
        question:    `Will ${ev.home_team} win against ${ev.away_team}?`,
        probability: avgProb,
        yesBid:      avgProb / 100,
        yesAsk:      avgProb / 100,
        realBook:    false,
        url:         null,
        _sport:      ev.sport_title || '',
        _homeTeam:   ev.home_team   || '',
        _awayTeam:   ev.away_team   || '',
      });
    }
  } catch {}
  return markets;
}

// ── Market extraction ──────────────────────────────

function extractAllMarkets(raw) {
  const markets = [];

  for (const m of (raw.predictit || [])) {
    const title = m.shortName || m.name || '';
    if (!title) continue;
    const top = (m.contracts || []).find(c => c.lastTradePrice != null);
    if (!top) continue;
    const contractLabel = top.shortName || top.name || '';
    const piQuestion = contractLabel ? `${title} [outcome: ${contractLabel}]` : title;
    const piYesAsk = top.bestBuyYesCost != null ? top.bestBuyYesCost : top.lastTradePrice;
    const piYesBid = top.bestBuyNoCost  != null ? (1 - top.bestBuyNoCost) : top.lastTradePrice;
    markets.push({
      id:          `pi-${m.id}`,
      platform:    'predictit',
      question:    piQuestion,
      probability: Math.round(top.lastTradePrice * 100),
      yesBid:      +piYesBid.toFixed(4),
      yesAsk:      +piYesAsk.toFixed(4),
      realBook:    false, // 10% profit fee + 5% withdrawal fee makes spreads unreliable — signal only
      url:         `https://www.predictit.org/markets/detail/${m.id}`,
    });
  }

  for (const m of (raw.manifold || [])) {
    if (m.outcomeType !== 'BINARY' || m.probability == null) continue;
    const q = m.question || '';
    if (!q) continue;
    markets.push({
      id:          `mf-${m.id}`,
      platform:    'manifold',
      question:    q,
      probability: Math.round(m.probability * 100),
      yesBid:      m.probability,
      yesAsk:      m.probability,
      realBook:    false, // play money, no real order book — signal only
      url:         m.url || `https://manifold.markets/${m.slug || ''}`,
    });
  }

  for (const m of (raw.kalshi || [])) {
    const bid = parseFloat(m.yes_bid_dollars || '0');
    const ask = parseFloat(m.yes_ask_dollars || '0');
    if (bid <= 0 && ask <= 0) continue;
    const title = m.title || '';
    if (!title) continue;
    const prob = bid > 0 && ask > 0
      ? Math.round(((bid + ask) / 2) * 100)
      : Math.round((ask || bid) * 100);
    // Use Kalshi's own human-readable outcome name (yes_sub_title, e.g. "Mark Cuban"),
    // never the raw 3-6 letter ticker code (e.g. "MC"). The ticker is an id, not text
    // to match on — questionMentions() below treats bracket content as words that must
    // literally appear on the other leg, and a short opaque code either never matches a
    // real title (blocking genuine pairs) or slips under the length>=3 word filter and
    // auto-passes with no verification at all (the false Kalshi[MC]<->Poly "Kamala
    // Harris" pairing this replaces). If Kalshi ever fails to supply a name, omit the
    // bracket entirely — stay neutral rather than fall back to the ticker as text.
    const outcomeName = (m.yes_sub_title || '').trim();
    const kaQuestion = outcomeName ? `${title} [outcome: ${outcomeName}]` : title;
    markets.push({
      id:          `ka-${m.ticker}`,
      platform:    'kalshi',
      question:    kaQuestion,
      probability: prob,
      yesBid:      bid,
      yesAsk:      ask,
      realBook:    true,
      url:         `https://kalshi.com/markets/${m.ticker}`,
    });
  }

  for (const m of (raw.polymarket || [])) {
    const q = m.question || '';
    if (!q) continue;
    let prob = null;
    try {
      const prices = typeof m.outcomePrices === 'string'
        ? JSON.parse(m.outcomePrices)
        : m.outcomePrices;
      if (Array.isArray(prices) && prices[0]) prob = Math.round(parseFloat(prices[0]) * 100);
    } catch {}
    if (prob == null) {
      const ltp = parseFloat(m.lastTradePrice || '0');
      if (ltp > 0) prob = Math.round(ltp * 100);
    }
    if (prob == null || prob < 1 || prob > 99) continue;
    const pmBid    = parseFloat(m.bestBid || '0');
    const pmAsk    = parseFloat(m.bestAsk || '0');
    const pmSingle = prob / 100;
    const yB = pmBid > 0 ? pmBid : pmSingle;
    const yA = (pmAsk > 0 && pmAsk < 1) ? pmAsk : pmSingle;
    markets.push({
      id:          `pm-${m.id}`,
      platform:    'polymarket',
      question:    q,
      probability: prob,
      yesBid:      yB,
      yesAsk:      yA,
      realBook:    true,
      url:         m.slug ? `https://polymarket.com/event/${m.slug}` : 'https://polymarket.com',
    });
  }

  // Add OddsAPI sports markets (up to 30) for cross-platform matching
  const oddsMarkets = extractOddsApiMarkets();
  markets.push(...oddsMarkets.slice(0, 30));

  return markets;
}

// ── Category sampling ──────────────────────────────
// Broad keyword hints for routing markets to the right agent.
// Claude does the real semantic matching; these just limit the search space.

function scoreMarket(question, keywords, boostKeywords = []) {
  const q = question.toLowerCase();
  let score = keywords.filter(k => q.includes(k)).length;
  score    += boostKeywords.filter(k => q.includes(k)).length * 2;
  return score;
}

// Kalshi tickers follow "{series}-{outcome}" (e.g. "KXPRESNOMD-28-GN"; also the
// convention extractOutcomeLabel's bracket already relies on for the trailing
// segment). The part before the last "-" is Kalshi's own event/series id, shared
// by every outcome-row of one umbrella market — recoverable from data already in
// markets-raw.json, no fetcher change needed. Verified against a live snapshot:
// 62,473 Kalshi rows collapse to 7,641 umbrellas this way with only a handful of
// coincidental ticker-prefix reuse across unrelated sibling markets.
function kalshiUmbrellaKey(marketId) {
  const ticker = marketId.startsWith('ka-') ? marketId.slice(3) : marketId;
  const i = ticker.lastIndexOf('-');
  return i === -1 ? ticker : ticker.slice(0, i);
}

function sampleByCategory(markets, keywords, boostKeywords, perPlatform = 30, minScore = 1) {
  const byPlatform = {};
  for (const m of markets) {
    const s = scoreMarket(m.question, keywords, boostKeywords);
    if (s < minScore) continue;
    if (!byPlatform[m.platform]) byPlatform[m.platform] = [];
    byPlatform[m.platform].push({ ...m, _score: s });
  }
  const result = [];
  for (const [platform, list] of Object.entries(byPlatform)) {
    if (platform !== 'kalshi') {
      list.sort((a, b) => b._score - a._score);
      result.push(...list.slice(0, perPlatform));
      continue;
    }

    // Kalshi explodes one umbrella event (e.g. a multi-candidate election) into many
    // per-outcome rows. Capping that flat row list lets a single umbrella's outcome-rows
    // crowd out every other distinct Kalshi event before matching ever runs. Group by
    // umbrella first, cap over umbrellas (using each umbrella's best real per-row score,
    // never an invented blended one), then expand the selected umbrellas back to their
    // full outcome-row list so downstream pairing still sees every individual candidate.
    const byUmbrella = new Map();
    for (const m of list) {
      const key = kalshiUmbrellaKey(m.id);
      if (!byUmbrella.has(key)) byUmbrella.set(key, []);
      byUmbrella.get(key).push(m);
    }
    const umbrellas = [...byUmbrella.values()];
    umbrellas.sort((a, b) => Math.max(...b.map(m => m._score)) - Math.max(...a.map(m => m._score)));
    for (const rows of umbrellas.slice(0, perPlatform)) result.push(...rows);
  }
  return result;
}

// ── Batch creation ─────────────────────────────────
// Interleave platforms so each batch has a mix, maximising cross-platform pair opportunities.

function createBatches(markets) {
  // Group by platform
  const byPlatform = {};
  for (const m of markets) {
    if (!byPlatform[m.platform]) byPlatform[m.platform] = [];
    byPlatform[m.platform].push(m);
  }

  // Distribute each platform's queue round-robin across every batch slot (not a
  // sequential dequeue-then-chunk pass) so a platform with far more sampled rows
  // than another — e.g. Kalshi after umbrella expansion in sampleByCategory —
  // still lands alongside the smaller platforms' rows in the SAME batches instead
  // of piling into platform-only tail batches once the smaller queues run dry.
  // Those tail batches can never produce a cross-platform pair (matchBatch only
  // compares markets on different platforms), which would silently undo the
  // sampling fix that lets Kalshi keep a full umbrella's outcome-rows.
  const numBatches = Math.max(1, Math.ceil(markets.length / BATCH_SIZE));
  const batches = Array.from({ length: numBatches }, () => []);
  for (const queue of Object.values(byPlatform)) {
    queue.forEach((m, i) => batches[i % numBatches].push(m));
  }
  return batches.filter(b => b.length > 0);
}

// ── Deterministic IDF-weighted matching ────────────
// Same-event pairing via token-overlap scoring, executable bid/ask arb math,
// and a >15% netROI quarantine — no external API calls.

async function matchBatch(batch, categoryLabel, corpusIndex) {
  // corpusIndex should be built once per run over the full market universe (buildIdfIndex(allMarkets))
  // and passed in by buildRunner. Falls back to a batch-local index only for standalone/direct calls.
  const { idf, tokensById } = corpusIndex || buildIdfIndex(batch);

  const result = [];
  let rejectedNotSameEvent = 0;
  let quarantined = 0;

  for (let i = 0; i < batch.length; i++) {
    for (let j = i + 1; j < batch.length; j++) {
      const a = batch[i], b = batch[j];
      if (a.platform === b.platform) continue;

      const tokA = tokensById.get(a.id) || tokenize(a.question);
      const tokB = tokensById.get(b.id) || tokenize(b.question);
      let score = 0, distinctiveShared = 0;
      for (const t of tokA) {
        if (!tokB.has(t)) continue;
        const v = idf.get(t) || 0;
        score += v;
        if (v >= HIGH_IDF_THRESHOLD) distinctiveShared++;
      }
      if (score < MIN_IDF_SCORE) continue;
      if (distinctiveShared < MIN_HIGH_IDF_SHARED) continue;

      const confidence = +Math.min(1, score / 20).toFixed(3);
      if (confidence < MIN_CONFIDENCE) continue;

      // Same-event gate — reject when both legs carry an explicit, different outcome label
      if (!outcomesCompatible(a, b)) { rejectedNotSameEvent++; continue; }

      // Executable bid/ask arb quarantine (only meaningful when both legs have a real book;
      // predictit/manifold/futuur/oddsapi legs are unconfirmed/mid-price → signal, never cashable,
      // so they skip this check and are never quarantined for implausible ROI).
      if (REAL_BOOK.has(a.platform) && REAL_BOOK.has(b.platform)) {
        const netRoi = bestNetRoi(a, b);
        if (netRoi != null && netRoi > SUSPICIOUS_ROI) { quarantined++; continue; }
      }

      result.push({
        marketA:    a,
        marketB:    b,
        confidence,
        event:      describeEvent(a, b),
      });
    }
  }

  if (rejectedNotSameEvent > 0 || quarantined > 0) {
    console.log(`[matcher] ${categoryLabel}: ${rejectedNotSameEvent} rejected (not same event), ${quarantined} quarantined (netROI>${SUSPICIOUS_ROI}%)`);
  }

  return result;
}

// ── Deduplication ──────────────────────────────────

function deduplicateMatches(matches) {
  const seen = new Set();
  return matches.filter(m => {
    const ids = [m.marketA.id, m.marketB.id].sort().join('::');
    if (seen.has(ids)) return false;
    seen.add(ids);
    return true;
  });
}

// ── Main run loop factory ──────────────────────────

function buildRunner({ agentName, outFile, categoryLabel, keywords, boostKeywords, interval }) {
  const RAW_FILE = '/tmp/markets-raw.json';

  async function run() {
    if (!fs.existsSync(RAW_FILE)) {
      console.log(`[${agentName}] waiting for markets-raw.json...`);
      return;
    }

    let raw;
    try { raw = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8')); } catch {
      console.error(`[${agentName}] failed to parse markets-raw.json`);
      return;
    }

    const age = Date.now() - (raw.fetchedAt || 0);
    if (age > 300_000) {
      console.log(`[${agentName}] raw data stale (${Math.round(age / 60000)}m), skipping`);
      return;
    }

    const allMarkets  = extractAllMarkets(raw);
    const sampled     = sampleByCategory(allMarkets, keywords, boostKeywords, 30, 1);
    const batches     = createBatches(sampled);
    // Built once over the FULL market universe so IDF reflects true corpus-wide rarity —
    // see MIN_IDF_SCORE comment near the config constants.
    const corpusIndex = buildIdfIndex(allMarkets);

    console.log(`[${agentName}] ${sampled.length} markets in ${batches.length} batches for "${categoryLabel}"`);

    const allMatches = [];
    for (let i = 0; i < batches.length; i++) {
      const matches = await matchBatch(batches[i], categoryLabel, corpusIndex);
      allMatches.push(...matches);
    }

    const unique = deduplicateMatches(allMatches);
    console.log(`[${agentName}] ${allMatches.length} raw → ${unique.length} unique matches`);

    fs.writeFileSync(outFile, JSON.stringify({ updatedAt: Date.now(), matches: unique }, null, 2));
    beat(agentName);
  }

  run();
  setInterval(run, interval);
}

module.exports = { buildRunner, extractAllMarkets, sampleByCategory, createBatches, buildIdfIndex, matchBatch, deduplicateMatches, beat, kalshiUmbrellaKey };
