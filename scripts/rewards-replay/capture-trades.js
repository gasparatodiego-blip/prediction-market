#!/usr/bin/env node
'use strict';
// scripts/rewards-replay/capture-trades.js — PHASE 1 verification ONLY. Opens a short-lived, public,
// KEYLESS connection to the Polymarket CLOB market channel, subscribes to a few active reward tokens, and
// prints the raw frames — proving which event type carries executed trades and its exact fields, and
// measuring the real message volume. Read-only: the market channel takes no auth and no orders. Not wired
// into any agent; a diagnostic the task asks to run before writing the persistence code.
//
//   node scripts/rewards-replay/capture-trades.js [seconds] [maxTokens]

const WebSocket = require('ws');
const fs = require('fs');

const URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market'; // docs.polymarket.com/developers/CLOB/websocket
const SECONDS = Number(process.argv[2] || 60);
const MAX_TOKENS = Number(process.argv[3] || 40);

// Active tokens from the live board (agent34's own subscribed set), so we watch markets that actually trade.
function activeTokens() {
  const ids = new Set();
  for (const f of ['/tmp/clob-live-books.json', '/tmp/liquidity-rewards.json']) {
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      const ms = Array.isArray(d.markets) ? d.markets : Object.values(d.markets || {});
      for (const m of ms) { if (m.tokenId) ids.add(String(m.tokenId)); if (m.tokenIdNo) ids.add(String(m.tokenIdNo)); }
    } catch (_) {}
    if (ids.size) break;
  }
  return [...ids].slice(0, MAX_TOKENS);
}

const tokens = activeTokens();
console.log(`subscribing to ${tokens.length} tokens on ${URL} for ${SECONDS}s…`);
const ws = new WebSocket(URL);
const byType = {};
const tradeFrames = [];
let frames = 0;
const t0 = Date.now();

ws.on('open', () => {
  ws.send(JSON.stringify({ assets_ids: tokens, type: 'market' }));
  const ping = setInterval(() => { try { ws.send('PING'); } catch (_) {} }, 10000);
  ws.on('close', () => clearInterval(ping));
});
ws.on('message', (buf) => {
  frames++;
  let data; try { data = JSON.parse(buf.toString()); } catch { return; }
  const events = Array.isArray(data) ? data : [data];
  for (const ev of events) {
    if (!ev || !ev.event_type) continue;
    byType[ev.event_type] = (byType[ev.event_type] || 0) + 1;
    if (ev.event_type === 'last_trade_price' && tradeFrames.length < 5) tradeFrames.push(ev);
  }
});
ws.on('error', (e) => { console.error('ws error:', e.message); });

setTimeout(() => {
  const mins = (Date.now() - t0) / 60000;
  console.log('\n── observed event types (count) ──');
  for (const [k, v] of Object.entries(byType).sort((a, b) => b[1] - a[1])) console.log('  ' + k.padEnd(20) + v);
  console.log('\nframes:', frames, '| message volume:', (frames / mins).toFixed(1) + ' frames/min across', tokens.length, 'tokens');
  const trades = byType['last_trade_price'] || 0;
  console.log('executed trades (last_trade_price):', trades, '=', (trades / mins).toFixed(1) + '/min');
  console.log('\n── RAW last_trade_price FRAMES (verbatim, up to 5) ──');
  for (const f of tradeFrames) console.log(JSON.stringify(f));
  if (!tradeFrames.length) console.log('  (none in this window — try more seconds/tokens or a busier time)');
  ws.close();
  process.exit(0);
}, SECONDS * 1000);
