#!/usr/bin/env node
'use strict';

const fs    = require('fs');
const https = require('https');

// ── Config ──────────────────────────────────────
// Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in environment or here.
// To get a token: message @BotFather on Telegram → /newbot
// To get chat ID: message your bot, then visit:
//   https://api.telegram.org/bot<TOKEN>/getUpdates
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';
const MIN_ROI   = parseFloat(process.env.MIN_ROI   || '1');   // default 1%
const INTERVAL  = parseInt(process.env.INTERVAL    || '30000'); // default 30s

const ARB_FILE = '/tmp/arbitrage-opportunities.json';
const HB_FILE  = '/tmp/agent-heartbeats.json';

// Track which opportunities we've already alerted on to avoid spam
const alerted = new Set();

function beat(name) {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb[name] = Date.now();
  fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2));
}

function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log('[telegram] skipped — BOT_TOKEN or CHAT_ID not set');
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${BOT_TOKEN}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', e => { console.error('[telegram] send error:', e.message); resolve(); });
    req.write(body);
    req.end();
  });
}

async function run() {
  if (!fs.existsSync(ARB_FILE)) return beat('telegram');

  let data;
  try {
    data = JSON.parse(fs.readFileSync(ARB_FILE, 'utf8'));
  } catch { return beat('telegram'); }

  const age = Date.now() - (data.updatedAt ?? 0);
  if (age > 300_000) return beat('telegram'); // stale data

  const opportunities = data.opportunities ?? [];

  for (const opp of opportunities) {
    if (opp.roi < MIN_ROI) continue;

    const key = `${opp.lowMarket?.platform}:${opp.highMarket?.platform}:${(opp.question ?? '').slice(0, 40)}`;
    if (alerted.has(key)) continue;
    alerted.add(key);

    const investAmt  = 100;
    const earnAmount = Math.round((opp.roi / 100) * investAmt * 10) / 10;
    const lowPlat    = (opp.lowMarket?.platform  ?? 'unknown').toUpperCase();
    const highPlat   = (opp.highMarket?.platform ?? 'unknown').toUpperCase();
    const lowProb    = opp.lowMarket?.probability  ?? 0;
    const highProb   = opp.highMarket?.probability ?? 0;

    const lowName  = lowPlat.charAt(0) + lowPlat.slice(1).toLowerCase();
    const highName = highPlat.charAt(0) + highPlat.slice(1).toLowerCase();
    const lowUrl   = opp.lowMarket?.url  ?? null;
    const highUrl  = opp.highMarket?.url ?? null;

    const lines = [
      `🚨 <b>ARB ALERT</b>`,
      `Event: ${opp.question ?? 'Unknown'}`,
      `ROI: ${opp.roi.toFixed(1)}%`,
      `Buy ${lowPlat} at ${lowProb}% vs ${highPlat} at ${highProb}%`,
      `Invest $${investAmt} → earn $${earnAmount}`,
    ];

    if (lowUrl || highUrl) {
      lines.push(`🔗 Links:`);
      if (lowUrl)  lines.push(`• ${lowName}: ${lowUrl}`);
      if (highUrl) lines.push(`• ${highName}: ${highUrl}`);
    }

    const msg = lines.join('\n');

    console.log('[telegram] sending alert for:', (opp.question ?? '').slice(0, 60));
    await sendTelegram(msg);
  }

  // Prune old alerted keys to prevent unbounded growth (keep last 500)
  if (alerted.size > 500) {
    const arr = Array.from(alerted);
    arr.slice(0, alerted.size - 500).forEach(k => alerted.delete(k));
  }

  beat('telegram');
}

run().catch(console.error);
setInterval(() => run().catch(console.error), INTERVAL);
