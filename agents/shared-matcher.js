#!/usr/bin/env node
'use strict';

/**
 * Shared semantic matching utilities used by all matcher agents.
 * Uses `claude -p --model claude-sonnet-4-6` for meaning-based matching.
 */

const fs    = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const MODEL         = 'claude-haiku-4-5-20251001';
const BATCH_SIZE    = 20;

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
    markets.push({
      id:          `pi-${m.id}`,
      platform:    'predictit',
      question:    title,
      probability: Math.round(top.lastTradePrice * 100),
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
    markets.push({
      id:          `ka-${m.ticker}`,
      platform:    'kalshi',
      question:    title,
      probability: prob,
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
    markets.push({
      id:          `pm-${m.id}`,
      platform:    'polymarket',
      question:    q,
      probability: prob,
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

// ── Claude semantic matching ───────────────────────

async function matchBatch(batch, categoryLabel) {
  const list = batch
    .map((m, i) => `${i}. [${m.platform}] ${m.question} (${m.probability}%)`)
    .join('\n');

  const prompt =
`You are a prediction market arbitrage analyst. Given these ${batch.length} markets from different platforms, find all pairs that refer to the EXACT SAME real-world event or question. Focus on ${categoryLabel} markets.

${list}

Rules:
- Only match markets from DIFFERENT platforms
- Only match when you are highly confident (≥0.65) the markets resolve on the same outcome
- Compare the MEANING, not just keywords — "Will X happen by 2025?" and "X by end of 2025?" are the same
- Ignore markets that are clearly about different things

Respond with ONLY a JSON array (no other text):
[{"indices":[i,j],"confidence":0.0-1.0,"event":"one-sentence description of the shared event"}]

If no matches, return [].`;

  try {
    const { stdout, stderr } = await execFileAsync(
      'claude',
      ['-p', prompt, '--model', MODEL],
      { timeout: 90_000, env: { ...process.env, HOME: '/root' } }
    );

    if (stderr && stderr.includes('Error')) {
      console.error(`[matcher] claude stderr: ${stderr.slice(0, 200)}`);
    }

    const text  = stdout.trim();
    // Find the outermost JSON array — match from first '[' to matching ']'
    const start = text.indexOf('[');
    const end   = text.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) return [];
    const match = [text.slice(start, end + 1)];

    const raw = JSON.parse(match[0]);
    const result = [];
    for (const m of Array.isArray(raw) ? raw : []) {
      const a = batch[m.indices?.[0]];
      const b = batch[m.indices?.[1]];
      if (!a || !b) continue;
      if (a.platform === b.platform) continue;
      if ((m.confidence || 0) < 0.65) continue;
      result.push({
        marketA:    a,
        marketB:    b,
        confidence: m.confidence,
        event:      m.event || '',
      });
    }
    return result;
  } catch (err) {
    console.error(`[matcher] batch call failed: ${err.message?.slice(0, 120)}`);
    return [];
  }
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

    const allMarkets = extractAllMarkets(raw);
    const sampled    = sampleByCategory(allMarkets, keywords, boostKeywords, 30, 1);
    const batches    = createBatches(sampled);

    console.log(`[${agentName}] ${sampled.length} markets in ${batches.length} batches for "${categoryLabel}"`);

    const allMatches = [];
    for (let i = 0; i < batches.length; i++) {
      const matches = await matchBatch(batches[i], categoryLabel);
      allMatches.push(...matches);
      if (i < batches.length - 1) await sleep(2000); // brief pause between calls
    }

    const unique = deduplicateMatches(allMatches);
    console.log(`[${agentName}] ${allMatches.length} raw → ${unique.length} unique matches`);

    fs.writeFileSync(outFile, JSON.stringify({ updatedAt: Date.now(), matches: unique }, null, 2));
    beat(agentName);
  }

  run();
  setInterval(run, interval);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { buildRunner, extractAllMarkets, sampleByCategory, createBatches, matchBatch, deduplicateMatches, beat };
