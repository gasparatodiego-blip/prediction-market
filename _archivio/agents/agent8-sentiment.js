#!/usr/bin/env node
'use strict';

const fs    = require('fs');
const { atomicWriteJson } = require('../lib/atomicJsonWrite');
const https = require('https');

const OUT_FILE  = '/tmp/sentiment-data.json';
const HB_FILE   = '/tmp/agent-heartbeats.json';
const INTERVAL  = 5 * 60 * 1000; // 5 minutes

const SUBREDDITS = ['PredictionMarkets', 'Polymarket', 'Kalshi'];

const POSITIVE_WORDS = new Set([
  'bullish', 'buy', 'moon', 'up', 'gain', 'profit', 'win', 'yes', 'likely',
  'surge', 'pump', 'long', 'high', 'rise', 'strong', 'good', 'great', 'confident',
  'definitely', 'certain', 'almost', 'expect', 'probable', 'happening', 'agree',
]);

const NEGATIVE_WORDS = new Set([
  'bearish', 'sell', 'down', 'loss', 'lose', 'no', 'unlikely', 'crash', 'dump',
  'short', 'low', 'fall', 'weak', 'bad', 'doubt', 'uncertain', 'never', 'doubt',
  'disagree', 'wrong', 'risky', 'scam', 'avoid', 'not', 'fail', 'fraud',
]);

function beat(name) {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb[name] = Date.now();
  atomicWriteJson(HB_FILE, hb, { pretty: true });
}

function fetchJson(url) {
  return new Promise(resolve => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'prediction-arb-scanner/1.0 (sentiment agent)' },
      timeout: 15000,
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function scoreText(text) {
  const words = text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/);
  let score = 0;
  for (const w of words) {
    if (POSITIVE_WORDS.has(w)) score++;
    if (NEGATIVE_WORDS.has(w)) score--;
  }
  return score;
}

// Extract significant words from post titles to use as market keywords
function extractKeywords(title) {
  const stopwords = new Set([
    'the','and','for','are','but','not','you','all','can','her','was','one',
    'our','out','had','has','his','him','its','into','over','will','with',
    'from','have','been','that','this','than','when','what','where','who',
    'how','about','after','before','between','during','through','should',
    'would','could','their','there','these','those','which','also','just',
    'does','did','get','got','any','some','more','most','much','even','than',
  ]);
  return title.toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopwords.has(w));
}

async function run() {
  console.log('[sentiment] fetching Reddit posts...');
  const keywordScores = new Map(); // keyword → { score, mentions }

  for (const sub of SUBREDDITS) {
    const data = await fetchJson(`https://www.reddit.com/r/${sub}/hot.json?limit=25`);
    if (!data?.data?.children) {
      console.log(`[sentiment] no data from r/${sub}`);
      continue;
    }

    for (const post of data.data.children) {
      const p     = post.data;
      const title = p.title ?? '';
      const body  = p.selftext ?? '';
      const full  = `${title} ${body}`;

      const score    = scoreText(full);
      const kws      = extractKeywords(title);

      for (const kw of kws) {
        const cur = keywordScores.get(kw) ?? { score: 0, mentions: 0 };
        cur.score    += score;
        cur.mentions += 1;
        keywordScores.set(kw, cur);
      }
    }

    console.log(`[sentiment] r/${sub}: processed ${data.data.children.length} posts`);
    // Polite delay between subreddit fetches
    await new Promise(r => setTimeout(r, 1000));
  }

  // Build entries sorted by abs(score) × mentions
  const entries = Array.from(keywordScores.entries())
    .filter(([, v]) => v.mentions >= 2)
    .map(([keyword, v]) => ({
      keyword,
      score:    Math.round(v.score * 10) / 10,
      mentions: v.mentions,
    }))
    .sort((a, b) => Math.abs(b.score) * b.mentions - Math.abs(a.score) * a.mentions)
    .slice(0, 50);

  const output = { updatedAt: Date.now(), entries };
  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  console.log(`[sentiment] saved ${entries.length} keyword sentiments`);
  beat('sentiment');
}

run().catch(console.error);
setInterval(() => run().catch(console.error), INTERVAL);
