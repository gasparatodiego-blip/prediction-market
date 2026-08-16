#!/usr/bin/env node
'use strict';

/**
 * sport-arb-reclassify-dates — the cross-game pass over the already-reclassified history.
 *
 * scripts/sport-arb-reclassify.js quarantined the 3-way and frozen-leg artifacts. This adds
 * the date dimension: the surviving REAL rows still paired legs from DIFFERENT games because
 * event_key collapsed a matchup's multiple dates. History leg records do not store the
 * venue_ticker, so we recover each leg's native game date by cross-referencing data/sport-raw
 * (matching event_key + ts + source + outcome + price to the exact recorded row) and reading
 * its ticker via the SSOT resolvers. Verdicts, additive (prior fields preserved):
 *   REAL               — both legs resolve to the SAME game date.
 *   ARTIFACT_CROSS_GAME — legs resolve to DIFFERENT dates (fabricated cross-game pairing).
 *   UNVERIFIED_DATE    — a leg's native date is unresolvable (e.g. exchange with no ticker).
 * Non-REAL rows keep their prior verdict. Read-only against the sources; writes a v2 sibling.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { dateFromKalshiTicker, dateFromPolySlug } = require('../lib/sport-arb-math');

const ROOT = path.join(__dirname, '..');
const IN   = path.join(ROOT, 'data', 'sport-arb-history.reclassified.jsonl');
const OUT  = path.join(ROOT, 'data', 'sport-arb-history.reclassified.v2.jsonl');
const RAW  = path.join(ROOT, 'data', 'sport-raw');

const round6 = (n) => (typeof n === 'number' ? Math.round(n * 1e6) / 1e6 : n);

// Build an index: `${event_key}|${ts}|${source}|${outcome}|${price6}` → venue_ticker, from raw.
function buildRawIndex() {
  const idx = new Map();
  for (const f of fs.readdirSync(RAW).sort()) {
    if (!f.endsWith('.jsonl') && !f.endsWith('.jsonl.gz')) continue;
    const buf = fs.readFileSync(path.join(RAW, f));
    const text = (f.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString('utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.source !== 'kalshi' && r.source !== 'polymarket') continue;
      const k = `${r.event_key}|${r.ts}|${r.source}|${r.outcome}|${round6(r.price)}`;
      if (!idx.has(k)) idx.set(k, r.venue_ticker);
    }
  }
  return idx;
}

function legDate(idx, rec, leg) {
  const tk = idx.get(`${rec.event_key}|${rec.ts}|${leg.source}|${leg.outcome}|${round6(leg.price)}`);
  if (tk == null) return null;
  if (leg.source === 'kalshi')     return dateFromKalshiTicker(tk);
  if (leg.source === 'polymarket') return dateFromPolySlug(tk);
  return null;
}

function main() {
  if (!fs.existsSync(IN)) { console.error(`no input: ${IN} (run sport-arb-reclassify.js first)`); process.exit(1); }
  const idx = buildRawIndex();
  const lines = fs.readFileSync(IN, 'utf8').split('\n').filter((l) => l.trim());
  const before = {}; const after = {}; const survivingReal = [];
  const out = [];
  for (const line of lines) {
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const prior = rec.reclassVerdict;
    before[prior] = (before[prior] || 0) + 1;
    let verdict = prior, reason = rec.reclassReason;
    if (prior === 'REAL') {
      const dh = legDate(idx, rec, rec.legs[0]);
      const da = legDate(idx, rec, rec.legs[1]);
      if (dh == null || da == null) { verdict = 'UNVERIFIED_DATE'; reason = `unresolvable native date (${rec.legs[0].source}=${dh}, ${rec.legs[1].source}=${da})`; }
      else if (dh !== da)          { verdict = 'ARTIFACT_CROSS_GAME'; reason = `legs from different games (${dh} vs ${da})`; }
      else                         { verdict = 'REAL'; reason = `two-way, both legs live, same game date ${dh}`; if (typeof rec.netProfitPct === 'number') survivingReal.push(rec.netProfitPct); }
    }
    after[verdict] = (after[verdict] || 0) + 1;
    out.push(JSON.stringify({ ...rec, reclassVerdictV2: verdict, reclassReasonV2: reason }));
  }
  fs.writeFileSync(OUT, out.join('\n') + '\n');

  const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  console.log('=== before (post 3-way/frozen pass) ===');
  for (const k of Object.keys(before)) console.log(`  ${k.padEnd(20)} ${before[k]}`);
  console.log('=== after (adding cross-game/date pass) ===');
  for (const k of ['REAL', 'UNVERIFIED', 'UNVERIFIED_DATE', 'ARTIFACT_3WAY', 'ARTIFACT_FROZEN_LEG', 'ARTIFACT_CROSS_GAME']) {
    if (after[k]) console.log(`  ${k.padEnd(20)} ${after[k]}`);
  }
  console.log('of the 79 prior-REAL rows → survive REAL: ' + (after['REAL'] || 0) +
    ' | ARTIFACT_CROSS_GAME: ' + (after['ARTIFACT_CROSS_GAME'] || 0) +
    ' | UNVERIFIED_DATE: ' + (after['UNVERIFIED_DATE'] || 0));
  console.log('surviving REAL margins: n=' + survivingReal.length +
    (survivingReal.length ? `  median=${med(survivingReal).toFixed(2)}%  max=${Math.max(...survivingReal).toFixed(2)}%` : '  (none)'));
  console.log('written:', path.relative(ROOT, OUT));
}

main();
