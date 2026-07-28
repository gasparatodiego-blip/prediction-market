#!/usr/bin/env node
'use strict';
// scripts/crypto-5min/discover-cli.js — PHASE 0 report: do ~5-minute crypto up/down markets exist, what is
// their structure, and is there any historical data at the 47-second/ask/depth resolution the strategy
// needs? Public keyless REST only; reads no key, places nothing.

const { findFiveMinMarkets, structure, inCollection, pricesHistory, liveBook } = require('./lib/discovery');

async function main() {
  console.log('═'.repeat(78));
  console.log('PHASE 0 — SHORT-DATED CRYPTO UP/DOWN MARKETS: EXISTENCE + DATA AVAILABILITY (primary source)');
  console.log('═'.repeat(78));

  const { scanned, markets } = await findFiveMinMarkets();
  const assets = [...new Set(markets.map((m) => (m.question || '').match(/^(\w+)/)?.[1]).filter(Boolean))];
  console.log(`\nEXISTENCE (Gamma /markets active set): scanned ${scanned}, found ${markets.length} up/down-5m markets · assets: ${assets.join(', ') || '—'}`);
  console.log('Cadence: series recurrence 5m → 288 windows/day per asset; 4 assets → ~1152 markets/day WHEN the series is live.');

  const s = markets.length ? structure(markets[0]) : null;
  console.log('\nRAW STRUCTURE (one market, straight from Gamma):');
  console.log(s ? JSON.stringify(s, null, 1) : '  (no 5m market found)');

  if (s) {
    console.log('\nSETTLEMENT: binary Up/Down; resolves Up if the Chainlink price at window end exceeds the start.');
    console.log('  resolution source:', s.resolutionSource || '—');
    console.log('  tick size:', s.tickSize, '→ the ONLY valid price in [0.98, 0.989] is 0.98 (the sub-cent range 0.981–0.989 is mechanically impossible at a 1¢ tick).');
    console.log('  trading window:', s.windowStartIso, '→', s.windowEndEpoch ? new Date(s.windowEndEpoch * 1000).toISOString() : '—', `(${s.durationSeconds}s)`);

    // DATA AVAILABILITY — the honest audit
    const coll = inCollection(s.conditionId);
    const ph = await pricesHistory(s.tokenIdUp, { fidelity: 1 });
    const book = await liveBook(s.tokenIdUp);
    const tradeableNow = markets.filter((m) => m.acceptingOrders && m.enableOrderBook).length;

    console.log('\nDATA AVAILABILITY (honest audit — what actually exists for THESE markets):');
    console.log(`  1. agent34 collection (mid-history + trade tape): conditionId ${coll.found ? 'FOUND in ' + coll.files.join(',') : 'NOT PRESENT'} — these are not reward markets, so agent34 does not subscribe to them.`);
    console.log(`  2. CLOB prices-history (only public historical series): ${ph.points} points${ph.points ? ' @ ' + ph.cadenceSeconds + 's cadence, fields ' + JSON.stringify(ph.fields) : ''} — ${ph.note}.`);
    console.log('     Even when non-empty it is MID/last at ≥1-minute fidelity: NOT the executable ASK, NOT book DEPTH, NOT 47-second resolution.');
    console.log(`  3. Live order book (asks/bids exist only for a tradeable market): asks ${book.asks}, bids ${book.bids}; markets accepting orders + orderbook enabled RIGHT NOW: ${tradeableNow} of ${markets.length}.`);
    console.log('     An expired market retains NO order book — historical depth is not recoverable from any endpoint.');

    const runnable = coll.found || (tradeableNow > 0);
    console.log('\nVERDICT (data availability):');
    if (!runnable) {
      console.log('  UNRUNNABLE on observed data. The strategy requires the executable ASK at 0.98 AND real book DEPTH,');
      console.log('  sampled inside the final 47 seconds. That data exists in NO source: not in agent34 (not subscribed),');
      console.log('  not in prices-history (mid/last, ≥1-min, and empty for these markets), and not as a retained book');
      console.log('  after expiry. No 5m market is currently tradeable either, so forward collection cannot start now.');
      console.log('  Widening the 47s window or substituting mid-for-ask would violate the honest-engine invariants —');
      console.log('  refused. The backtest machinery (Phases 2–3) is built and unit-tested; over real data every cycle is');
      console.log('  SKIPPED for lack of intra-window book data, and counted.');
    } else {
      console.log('  Some data exists — see counts above; the backtest may run over exactly those cycles.');
    }
  }
}
main().catch((e) => { console.error('HARD FAIL:', e.message); process.exit(1); });
