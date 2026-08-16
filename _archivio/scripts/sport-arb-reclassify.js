#!/usr/bin/env node
'use strict';

/**
 * sport-arb-reclassify — quarantine tool for data/sport-arb-history.jsonl.
 *
 * The history file was written before the honest-engine fixes to detectArbs and contains
 * fabricated arb margins from two defects:
 *   - ARTIFACT_3WAY       — a three-way (soccer) market summed from only two legs, or a
 *                           draw/"Tie" contract mislabeled and paired as home/away.
 *   - ARTIFACT_FROZEN_LEG — a fixed-odds book leg past the tightened per-venue live bound
 *                           (BOOK_MAX_AGE_SEC), i.e. a frozen line the old flat 90s gate let
 *                           through (the 80-88s legs that produced 25-30% phantom "arbs").
 *
 * This does NOT delete or rewrite history. It re-reads every row, classifies it against the
 * CORRECTED shared logic (lib/sport-arb-math), and writes each ORIGINAL row plus a
 * `reclassVerdict` (+ reason) to data/sport-arb-history.reclassified.jsonl. Verdicts:
 *   REAL              — 2-way, no draw leg, both legs live per venue, executable size confirmed.
 *   UNVERIFIED        — 2-way, both legs live, but size unverifiable (honest arb, unconfirmable stake).
 *   ARTIFACT_3WAY     — three-way market / draw leg → fabricated 2-of-3 margin.
 *   ARTIFACT_FROZEN_LEG — a book/exchange leg over the tightened live bound (frozen/stale).
 *
 * Read-only against the source file. Run: node scripts/sport-arb-reclassify.js
 */

const fs = require('fs');
const path = require('path');
const {
  THREE_WAY_SPORTS, BOOK_MAX_AGE_SEC, isDrawLeg, isLegLive,
} = require('../lib/sport-arb-math');

const ROOT = path.join(__dirname, '..');
const SRC  = path.join(ROOT, 'data', 'sport-arb-history.jsonl');
const OUT  = path.join(ROOT, 'data', 'sport-arb-history.reclassified.jsonl');

const isBookLeg = (l) => l.source_type === 'book' || l.source_type === 'exchange';

function classify(rec) {
  const legs = Array.isArray(rec.legs) ? rec.legs : [];
  // 1. three-way / draw — fabricated margin from an incomplete market
  if (THREE_WAY_SPORTS.has(rec.sport) || legs.some(isDrawLeg)) {
    return { verdict: 'ARTIFACT_3WAY', reason: 'three-way market or draw leg summed as two-way' };
  }
  // 2. frozen / over-age book leg — admitted by the old flat 90s gate, rejected by the
  //    tightened per-venue bound (and by the frozen flag when present).
  const badBook = legs.find((l) => isBookLeg(l) && (l.frozen === true ||
    (typeof l.age_sec === 'number' && l.age_sec > BOOK_MAX_AGE_SEC)));
  if (badBook) {
    return { verdict: 'ARTIFACT_FROZEN_LEG',
      reason: `book leg ${badBook.source} age ${badBook.age_sec}s > ${BOOK_MAX_AGE_SEC}s live bound` };
  }
  // 3. all legs live under the corrected per-venue gate?
  if (!legs.length || !legs.every((l) => isLegLive(l))) {
    return { verdict: 'UNVERIFIED', reason: 'a leg is not live under the corrected per-venue gate' };
  }
  // 4. live — REAL if executable size is confirmed, else UNVERIFIED (honest arb, unknown stake)
  return rec.sizeUnverifiable === false
    ? { verdict: 'REAL', reason: 'two-way, both legs live, executable size confirmed' }
    : { verdict: 'UNVERIFIED', reason: 'two-way, both legs live, but max stake unverifiable' };
}

function main() {
  if (!fs.existsSync(SRC)) { console.error(`no source file: ${SRC}`); process.exit(1); }
  const lines = fs.readFileSync(SRC, 'utf8').split('\n').filter((l) => l.trim());
  const counts = {}; const realMargins = [];
  const out = [];
  for (const line of lines) {
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const { verdict, reason } = classify(rec);
    counts[verdict] = (counts[verdict] || 0) + 1;
    if (verdict === 'REAL' && typeof rec.netProfitPct === 'number') realMargins.push(rec.netProfitPct);
    out.push(JSON.stringify({ ...rec, reclassVerdict: verdict, reclassReason: reason }));
  }
  fs.writeFileSync(OUT, out.join('\n') + '\n');

  const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  console.log('=== reclassification of', lines.length, 'rows ===');
  for (const k of ['REAL', 'UNVERIFIED', 'ARTIFACT_3WAY', 'ARTIFACT_FROZEN_LEG']) {
    console.log(`  ${k.padEnd(20)} ${counts[k] || 0}`);
  }
  console.log('surviving REAL margins: n=' + realMargins.length +
    (realMargins.length ? `  median=${med(realMargins).toFixed(2)}%  max=${Math.max(...realMargins).toFixed(2)}%` : '  (none)'));
  console.log('written:', path.relative(ROOT, OUT));
}

main();
