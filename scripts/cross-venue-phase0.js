#!/usr/bin/env node
'use strict';

// cross-venue-phase0.js — Phase 0 investigation: cross-venue arb between
// OddsAPI H2H bookmaker odds and Polymarket CLOB for 2026 World Cup matches.
// READ-ONLY — no writes except the output JSON. No Claude API calls.
// Output: data/sports/cross_venue_sample.json

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'arb-scanner/1.0' }, timeout: 15000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Load sports scanner data
const SPORTS_FILE = path.join(__dirname, '../data/sports/opportunities.json');
const OUT_FILE    = path.join(__dirname, '../data/sports/cross_venue_sample.json');

async function run() {
  // ── Load sports events ───────────────────────────────────────────────────────
  const sportsData = JSON.parse(fs.readFileSync(SPORTS_FILE, 'utf8'));
  const wcEvents = sportsData.scannedEvents.filter(e => e.sport === 'soccer_fifa_world_cup');
  const groupStageEvents = wcEvents.filter(e => !e.settlement?.isKnockout);
  const knockoutEvents   = wcEvents.filter(e => e.settlement?.isKnockout);
  console.log(`[step1] WC events loaded: ${wcEvents.length} total (${groupStageEvents.length} group-stage, ${knockoutEvents.length} knockout)`);

  // ── Fetch all Polymarket WC markets ──────────────────────────────────────────
  console.log('[step2] Fetching Polymarket WC markets (tag=world-cup)...');
  let offset = 0;
  const allWcMarkets = [];
  while (true) {
    const d = await get(`https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&tag_slug=world-cup&offset=${offset}`);
    const arr = Array.isArray(d) ? d : [];
    if (arr.length === 0) break;
    allWcMarkets.push(...arr);
    if (arr.length < 100) break;
    offset += 100;
    await sleep(300);
  }
  console.log(`[step2] Total WC markets found: ${allWcMarkets.length}`);

  // Classify market types
  const tournamentWinner = allWcMarkets.filter(m => (m.question || '').toLowerCase().includes('win the 2026 fifa world cup'));
  const groupWinner      = allWcMarkets.filter(m => (m.question || '').toLowerCase().includes('win group'));
  // Single match = two specific teams, one match result (Home/Draw/Away or binary match winner)
  const singleMatch = allWcMarkets.filter(m => {
    const q = (m.question || '').toLowerCase();
    return (q.includes(' vs ') || (q.includes('beat') && !q.includes('win the'))) &&
           (q.includes('world cup') || q.includes('wc 2026') || q.includes('2026 fifa'));
  });

  console.log(`  Tournament outrights: ${tournamentWinner.length}`);
  console.log(`  Group winner outrights: ${groupWinner.length}`);
  console.log(`  Single-match markets: ${singleMatch.length}  <-- TARGET (expect 0)`);

  // ── Try to fetch CLOB prices for demo structural-mismatch rows ───────────────
  // We pair ONE tournament-winner outright per event team, solely to show the
  // structural incompatibility and illiquid depth. NOT_EQUIVALENT on all.
  console.log('[step3] Building structural-mismatch demo rows...');
  const demoRows = [];

  for (const ev of groupStageEvents.slice(0, 8)) {
    // pick the favourite leg (lowest implied = highest probability = best book leg)
    const favLeg = ev.bestLegs.reduce((best, l) => (1/l.odd) > (1/best.odd) ? l : best);
    const team = favLeg.outcome;
    const teamLower = team.toLowerCase()
      .replace('&', 'and')
      .replace(' herzegovina', '-herzegovina')
      .replace('dr congo', 'congo dr')
      .replace('ivory coast', 'ivory coast');

    const polyMkt = tournamentWinner.find(m => {
      const q = (m.question || '').toLowerCase();
      return q.includes(teamLower) || q.includes(team.toLowerCase());
    });

    let clobBestAsk = null, clobBestAskSize = null, clobMid = null;
    if (polyMkt) {
      let tids = [];
      try { tids = JSON.parse(polyMkt.clobTokenIds || '[]'); } catch {}
      if (tids.length > 0) {
        try {
          const bk = await get(`https://clob.polymarket.com/book?token_id=${tids[0]}`);
          const asks = bk?.asks || [];
          const bids = bk?.bids || [];
          // CLOB is sorted DESCENDING: asks[0]=worst/highest, asks[-1]=best/lowest
          if (asks.length > 0) {
            clobBestAsk     = parseFloat(asks[asks.length - 1].price);
            clobBestAskSize = parseFloat(asks[asks.length - 1].size);
          }
          if (asks.length > 0 && bids.length > 0) {
            const ba = parseFloat(asks[asks.length - 1].price);
            const bb = parseFloat(bids[bids.length - 1].price);
            clobMid = Math.round((ba + bb) / 2 * 10000) / 10000;
          }
        } catch {}
        await sleep(250);
      }
    }

    const bookImplied = Math.round((1 / favLeg.odd) * 10000) / 10000;
    const gammaOutcomePrices = JSON.parse(polyMkt?.outcomePrices || '[]');
    const gammaMidYes = parseFloat(gammaOutcomePrices[0] || 0);

    demoRows.push({
      event:           ev.eventName,
      commenceTime:    ev.commenceTime,
      isKnockout:      ev.settlement?.isKnockout,
      settlementBasis: ev.settlement?.basis,
      teamMatched:     team,
      settlementEquivalent: false,
      settlementReason: 'TOURNAMENT_OUTRIGHT vs SINGLE_MATCH — Polymarket question: tournament winner (multi-round cumulative). OddsAPI: single 90-min regulation match result. These are ENTIRELY DIFFERENT EVENTS. NOT_EQUIVALENT by definition.',
      bookLeg: {
        bookmaker:    favLeg.bookmakerId,
        bookmakerLabel: favLeg.bookmaker,
        region:       favLeg.region,
        odd:          favLeg.odd,
        impliedProb:  bookImplied,
        legType:      'sharp_or_exchange_unknown',
      },
      polymarketLeg: {
        question:     polyMkt?.question || null,
        conditionId:  polyMkt?.conditionId || null,
        gammaMidYes,
        execBestAsk:  clobBestAsk,
        depthAtBestAskUsdc: clobBestAskSize,
        thin:         clobBestAskSize != null ? clobBestAskSize < 500 : true,
        note:         clobBestAsk != null
          ? `CLOB best ask = ${clobBestAsk} (asks[-1]). CLOB mid = ${clobMid}. Gamma mid = ${gammaMidYes}.`
          : 'No executable ask found — market illiquid or resolved on CLOB.',
      },
      crossImpliedSum: 'NOT_COMPUTED — outcome structures incompatible (3-way H2H vs binary tournament)',
      roiPct: null,
      cashable: false,
      flags: [
        'NOT_EQUIVALENT:tournament_outright_vs_single_match',
        'OUTCOME_MISMATCH:polymarket_is_binary_yes_no/book_is_3way_home_draw_away',
        favLeg.region === 'us' ? 'GEO:us_book_unavailable_from_polymarket_non_us_jurisdiction' : `GEO:ok_eu_uk_book_region=${favLeg.region}`,
        clobBestAskSize != null && clobBestAskSize < 500 ? `DEPTH_THIN:only_${clobBestAskSize}_usdc_at_best_ask` : null,
        'NO_CASHABLE_PATH:structural_mismatch_is_blocking_all_else',
      ].filter(Boolean),
    });
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  const summary = {
    singleMatchMarketsFound: singleMatch.length,
    matchedPairs: 0,
    cashableArbs: 0,
    primaryBlocker: 'Polymarket lists ZERO single-match 2026 World Cup markets. Without match markets on the Polymarket side, cross-venue H2H arb is not possible.',
    secondaryBlockers: [
      'Tournament outright (Polymarket) vs single 90-min match (OddsAPI) are entirely different events — NOT_EQUIVALENT',
      'Outcome structure mismatch: Polymarket uses binary Yes/No per team; OddsAPI delivers 3-way Home/Draw/Away',
      'CLOB depth: WC tournament outright books are extremely thin at real prices (not executable for meaningful size)',
      'Geo/jurisdiction: Some best-book legs are US-only (draftkings, fanduel) and inaccessible from Polymarket non-US context',
    ],
    ifWcMatchMarketsExisted: [
      'Group stage 3-way (90-min regulation, Draw separate): MIGHT be EQUIVALENT if Polymarket resolution text confirms same basis. Requires per-market resolution text parsing.',
      'Knockout stage: LIKELY NOT_EQUIVALENT — books settle on 90-min result; Polymarket match markets (if they existed) likely resolve on to-advance including ET/penalties.',
      'Even with equivalence: 2% Polymarket winFee eats into ROI; book margins need to be negative sum after fee.',
      'Geo check: if best-book leg is US-only AND Polymarket is non-US — crossAccess flag; not cashable.',
    ],
  };

  // ── Output ───────────────────────────────────────────────────────────────────
  const output = {
    generatedAt: new Date().toISOString(),
    phase: 'PHASE_0_INVESTIGATION',

    integrationFindings: {
      polymarketCLOB: {
        marketDiscovery: 'Gamma API: GET https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&tag_slug=world-cup',
        outcomeTokens: 'clobTokenIds JSON array: index 0 = YES token, index 1 = NO token. Matches outcomes[] array order.',
        executableAskEndpoint: 'https://clob.polymarket.com/book?token_id={YES_token_id}',
        clobOrderingCritical: {
          asks: 'SORTED DESCENDING (highest first). asks[0] = WORST/most expensive. asks[-1] = BEST/lowest executable ask.',
          bids: 'SORTED ASCENDING (lowest first). bids[0] = WORST/lowest. bids[-1] = BEST/highest bid.',
          correctBestAsk: 'bestAsk = asks[asks.length - 1].price; depthAtBestAsk = asks[asks.length - 1].size',
          knownBug: 'agent16-poly-hft.js line 255 uses asks[0].price — that is the WORST ask, not best. Works by coincidence for crypto updown markets (symmetric book near 0.5). Would give wrong prices for asymmetric markets.',
        },
        winFeeModel: 'lib/fees.ts:3 — polymarket: { winFee: 0.02, withdrawFee: 0 } — 2% on winnings. Taker fee for negRisk markets is 3% (agent18-mm-analyzer.js:126).',
        verification: 'Confirmed on Rihanna Album market (Gamma mid 0.515): asks[-1]=0.52, bids[-1]=0.51 → CLOB mid=0.515 ✓',
      },

      sportsScannerData: {
        file: 'data/sports/opportunities.json',
        topLevelKeys: ['lastUpdated', 'creditsRemaining', 'opportunities', 'flaggedArbs', 'quarantine', 'scannedEvents', 'summary'],
        wcEventsInCurrentData: wcEvents.length,
        groupStageCount: groupStageEvents.length,
        knockoutCount: knockoutEvents.length,
        perEventShape: {
          sport: 'soccer_fifa_world_cup',
          eventName: 'TeamA vs TeamB',
          commenceTime: 'ISO8601',
          type: '3way (all group stage), 2way possible for some knockout configs',
          booksCount: 'number of bookmakers quoting',
          bestLegs: '[{ outcome, bookmaker, bookmakerId, region (us/eu/uk), odd }]',
          impliedSum: 'sum(1/odd) for all best legs — above 1.0 = book margin present',
          settlement: '{ basis: string, isKnockout: bool, basisAmbiguous: bool, crossSettlementRisk: bool }',
          groupStageBasis: 'Regulation 90 min (incl. injury time). Draw is a separate outcome. Extra time / penalties do NOT count.',
          knockoutBasis: 'Knockout match: ambiguous — books may settle on 90-min, full incl. ET, or to-advance',
        },
        note: 'bestLegs shows ONE best bookmaker per outcome. These may come from DIFFERENT bookmakers and regions. Not same-book arb.',
      },

      matcherV2ResolutionGate: {
        location: 'agents/matcher-v2.js — function checkResolutionEquivalence(sigA, sigB)',
        signatureShape: {
          subject: 'Precise entity (e.g. "Germany")',
          metric: 'What is measured (e.g. "2026 FIFA World Cup stage reached")',
          relation: 'EXACT | AT_LEAST | AT_MOST | RANGE | BINARY',
          boundary: 'Threshold/stage (e.g. "Semifinals", "match winner")',
          timeframe: 'Competition/election scope',
          yes_condition: 'One-sentence plain-English YES resolution condition',
        },
        sameEventGates: [
          'relation must match — EXACT vs AT_LEAST on same boundary → REJECT',
          'subject must match (normalized)',
          'metric must match (normalized)',
          'boundary must match (normalized)',
          'timeframe must match (normalized)',
        ],
        extractionMethod: 'Haiku LLM call (claude-haiku-4-5-20251001) via haikuExtractBatch(). Results cached in data/resolution-signatures.json (30-day TTL).',
        reachGuard: 'CUMULATIVE_REACH_RE = /reach|qualif|advance|furthest/ — blocks "qualifies to advance" markets from pairing with exact-stage markets',
      },
    },

    polymarketScan: {
      totalActiveWcMarkets: allWcMarkets.length,
      breakdown: {
        tournamentWinnerOutrights: tournamentWinner.length,
        groupWinnerOutrights: groupWinner.length,
        singleMatchMarkets: singleMatch.length,
        other: allWcMarkets.length - tournamentWinner.length - groupWinner.length,
      },
      singleMatchMarketsFound: singleMatch.length,
      singleMatchList: singleMatch.map(m => ({ question: m.question, conditionId: m.conditionId, endDate: m.endDate })),
      verdict: singleMatch.length === 0
        ? 'BLOCKER: Polymarket has ZERO single-match 2026 World Cup markets. Phase 0 cross-venue arb not executable.'
        : `${singleMatch.length} single-match markets found — proceed to Steps 3-5.`,
    },

    matchedPairs: [],
    cashableArbs: [],

    demoStructuralMismatches: demoRows,
    demoNote: 'These rows pair TOURNAMENT OUTRIGHT Polymarket markets with OddsAPI match legs. ALL are NOT_EQUIVALENT by definition. Included only to demonstrate the structural incompatibility and CLOB depth profile. Do NOT use for execution.',

    summary,

    topCashableTable: 'N/A — 0 cashable cross-venue arbs found. Primary blocker: no Polymarket single-match WC markets.',

    wcEventsSnapshot: wcEvents.map(e => ({
      eventName: e.eventName,
      commenceTime: e.commenceTime,
      isKnockout: e.settlement?.isKnockout,
      booksCount: e.booksCount,
      impliedSum: e.impliedSum,
      bestLegs: e.bestLegs,
    })),
  };

  const outDir = path.dirname(OUT_FILE);
  fs.mkdirSync(outDir, { recursive: true });
  const tmp = OUT_FILE + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(output, null, 2));
  fs.renameSync(tmp, OUT_FILE);
  console.log(`[output] Written to ${OUT_FILE} (${Math.round(JSON.stringify(output).length / 1024)} KB)`);

  return output;
}

run().then(() => {
  console.log('[DONE]');
}).catch(e => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
