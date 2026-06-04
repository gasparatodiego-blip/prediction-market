#!/usr/bin/env node
'use strict';

/**
 * Matcher Agent 1 — Politics, Geopolitics, Science & Health
 *
 * Categories covered:
 *   - Politics: US elections, primaries, Congress, White House, referendums
 *   - International elections: UK, France, Germany, Israel, India, etc.
 *   - Government policy: legislation, SCOTUS, executive orders
 *   - Geopolitics: wars, treaties, NATO, sanctions, alliances
 *   - Science / Health: FDA approvals, drug trials, climate records, space missions
 */

const { buildRunner } = require('./shared-matcher');

const KEYWORDS = [
  // US politics
  'election', 'president', 'congress', 'senate', 'house', 'vote', 'voting',
  'democrat', 'republican', 'governor', 'primary', 'ballot', 'candidate',
  'trump', 'biden', 'harris', 'white house', 'cabinet', 'speaker',
  'majority', 'minority', 'filibuster', 'impeach', 'veto', 'legislation',
  'supreme court', 'scotus', 'justice', 'amendment', 'constitution',
  // International elections & government
  'referendum', 'parliament', 'prime minister', 'chancellor', 'coalition',
  'macron', 'uk election', 'labour', 'tory', 'conservative', 'liberal',
  'modi', 'netanyahu', 'zelensky', 'scholz', 'meloni',
  // Geopolitics
  'war', 'ceasefire', 'peace deal', 'treaty', 'nato', 'sanction',
  'ukraine', 'russia', 'china', 'taiwan', 'iran', 'north korea',
  'israel', 'hamas', 'hezbollah', 'middle east', 'invasion', 'military',
  'diplomat', 'alliance', 'summit', 'g7', 'g20', 'un ', 'united nations',
  // Science / Health
  'fda', 'drug', 'vaccine', 'clinical trial', 'approval', 'treatment',
  'cancer', 'pandemic', 'virus', 'covid', 'climate', 'temperature record',
  'nasa', 'spacex', 'rocket', 'moon', 'mars', 'asteroid', 'launch',
  'Nobel', 'breakthrough', 'discovery',
];

const BOOST = [
  'election', 'president', 'senate', 'congress', 'war', 'ceasefire',
  'fda', 'nasa', 'spacex', 'ukraine', 'taiwan', 'trump', 'harris',
];

buildRunner({
  agentName:     'matcher-politics',
  outFile:       '/tmp/matches-politics.json',
  categoryLabel: 'Politics, Geopolitics, Science & Health',
  keywords:      KEYWORDS,
  boostKeywords: BOOST,
  interval:      90_000,
});
