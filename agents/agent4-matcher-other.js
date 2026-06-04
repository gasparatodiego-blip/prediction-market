#!/usr/bin/env node
'use strict';

/**
 * Matcher Agent 2 — Sports, Technology & Economics (non-crypto)
 *
 * Categories covered:
 *   - Sports: NFL, NBA, MLB, NHL, soccer/football, tennis, F1, Olympics
 *   - Technology: AI model releases, product launches, company earnings
 *   - Economics: interest rates, inflation, GDP, unemployment, stock indices
 */

const { buildRunner } = require('./shared-matcher');

const KEYWORDS = [
  // Sports
  'nfl', 'nba', 'mlb', 'nhl', 'soccer', 'football', 'basketball',
  'baseball', 'hockey', 'tennis', 'formula 1', 'f1', 'olympics',
  'super bowl', 'world cup', 'championship', 'playoffs', 'season',
  'match', 'tournament', 'grand slam', 'wimbledon', 'us open',
  'champions league', 'premier league', 'fifa', 'ufc', 'boxing',
  'lewis hamilton', 'verstappen', 'lebron', 'mahomes', 'messi',
  'ronaldo', 'djokovic', 'federer', 'serena', 'tiger woods',
  // Technology
  'gpt', 'openai', 'anthropic', 'google', 'microsoft', 'apple',
  'meta ', 'amazon', 'tesla', 'nvidia', 'iphone', 'android',
  'ai ', 'artificial intelligence', 'model release', 'chatgpt',
  'gemini', 'llm', 'launch', 'product', 'earnings', 'revenue',
  'acquisition', 'merger', 'ipo', 'ceo', 'layoff',
  // Economics (non-crypto)
  'federal reserve', 'fed rate', 'interest rate', 'inflation', 'cpi',
  'gdp', 'unemployment', 'jobs report', 'recession', 'dow jones',
  'nasdaq', 's&p', 'stock market', 'oil price', 'gold price',
  'treasury', 'yield', 'bond', 'mortgage rate',
];

const BOOST = [
  'super bowl', 'world cup', 'nfl', 'nba', 'champions league',
  'formula 1', 'olympics', 'wimbledon', 'openai', 'apple', 'nvidia',
  'fed rate', 'inflation', 'recession', 'gdp', 'nasdaq',
];

buildRunner({
  agentName:     'matcher-other',
  outFile:       '/tmp/matches-other.json',
  categoryLabel: 'Sports, Technology & Economics',
  keywords:      KEYWORDS,
  boostKeywords: BOOST,
  interval:      95_000,
});
