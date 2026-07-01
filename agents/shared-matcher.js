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

function outcomesCompatible(a, b) {
  const oa = extractOutcomeLabel(a.question);
  const ob = extractOutcomeLabel(b.question);
  if (oa && ob) {
    if (oa === ob) return true;
    if (oa === 'yes' || oa === 'no' || ob === 'yes' || ob === 'no') return true;
    return false;
  }
  if (oa && !ob) return questionMentions(b.question, oa);
  if (ob && !oa) return questionMentions(a.question, ob);
  return true; // neither leg carries an explicit outcome label — nothing to cross-check
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
    const tickerSuffix = m.ticker ? m.ticker.split('-').pop() : '';
    const kaQuestion = tickerSuffix ? `${title} [outcome: ${tickerSuffix}]` : title;
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

function sampleByCategory(markets, keywords, boostKeywords, perPlatform = 30, minScore = 1) {
  const byPlatform = {};
  for (const m of markets) {
    const s = scoreMarket(m.question, keywords, boostKeywords);
    if (s < minScore) continue;
    if (!byPlatform[m.platform]) byPlatform[m.platform] = [];
    byPlatform[m.platform].push({ ...m, _score: s });
  }
  const result = [];
  for (const list of Object.values(byPlatform)) {
    list.sort((a, b) => b._score - a._score);
    result.push(...list.slice(0, perPlatform));
  }
  return result;
}

// ── Batch creation ─────────────────────────────────
// Interleave platforms so each batch has a mix, maximising cross-platform pair opportunities.

function createBatches(markets) {
  // Group by platform and interleave
  const byPlatform = {};
  for (const m of markets) {
    if (!byPlatform[m.platform]) byPlatform[m.platform] = [];
    byPlatform[m.platform].push(m);
  }

  const interleaved = [];
  const queues = Object.values(byPlatform);
  let i = 0;
  while (queues.some(q => q.length > 0)) {
    const q = queues[i % queues.length];
    if (q.length > 0) interleaved.push(q.shift());
    i++;
  }

  const batches = [];
  for (let start = 0; start < interleaved.length; start += BATCH_SIZE) {
    batches.push(interleaved.slice(start, start + BATCH_SIZE));
  }
  return batches;
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

module.exports = { buildRunner, extractAllMarkets, sampleByCategory, createBatches, buildIdfIndex, matchBatch, deduplicateMatches, beat };
