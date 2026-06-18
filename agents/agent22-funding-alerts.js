/**
 * agent22-funding-alerts.js
 * Telegram bot update consumer (ONLY getUpdates consumer in this repo).
 * Handles: /start fund_<ASSET>, /unfollow <ASSET>, /stop
 * Sends throttled status-flip alerts to subscribers.
 * Subscriptions stored in /root/prediction-market/data/fund-subscriptions.json
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');

// ── Config ─────────────────────────────────────────────────────────────────
const TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const API_BASE = `https://api.telegram.org/bot${TOKEN}`;
const SUBS_FILE = path.join(__dirname, '../data/fund-subscriptions.json');
const UNI_FILE  = '/tmp/unified-opportunities.json';

const POLL_TIMEOUT   = 25;          // seconds for long-poll
const ALERT_INTERVAL = 60_000;      // ms between alert scans
const THROTTLE_MS    = 3_600_000;   // 1h min between alerts per (chat, asset)
const REF_CAPITAL    = 1_000;       // $ for $/day headline in alerts

// ── Helpers ─────────────────────────────────────────────────────────────────
function log(...a) { console.log('[A22]', ...a); }

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(35_000, () => { req.destroy(new Error('timeout')); });
  });
}

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const urlObj  = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function sendMessage(chatId, text) {
  try {
    await httpPost(`${API_BASE}/sendMessage`, {
      chat_id:    chatId,
      text,
      parse_mode: 'HTML',
    });
  } catch (e) {
    log('sendMessage error:', e.message);
  }
}

// ── Subscription store ───────────────────────────────────────────────────────
function loadSubs() {
  try {
    if (fs.existsSync(SUBS_FILE)) {
      return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
    }
  } catch (e) { log('loadSubs error:', e.message); }
  return {};
}

function saveSubs(subs) {
  try {
    fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2));
  } catch (e) { log('saveSubs error:', e.message); }
}

function subKey(chatId, asset) {
  return `${chatId}:${asset.toUpperCase()}`;
}

// ── Command handlers ──────────────────────────────────────────────────────────
async function handleUpdate(update, subs) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return;

  const chatId = String(msg.chat.id);
  const text   = msg.text.trim();

  // /start fund_BTC  (deep link from dashboard Follow button)
  const startMatch = text.match(/^\/start\s+fund_([A-Za-z0-9]+)/i);
  if (startMatch) {
    const asset = startMatch[1].toUpperCase();
    const key   = subKey(chatId, asset);
    subs[key] = { chatId, asset, addedAt: Date.now(), lastAlertAt: 0, lastStatus: null };
    saveSubs(subs);
    await sendMessage(chatId,
      `✅ You're following <b>${asset}</b> funding.\n\nI'll alert you when the spread status changes meaningfully — e.g. when it becomes worth harvesting or drops off.\n\nRates are variable and change hourly — alerts are estimates, not promises.\n\n/unfollow ${asset} to stop, or /stop to clear all.`
    );
    log(`Subscribed chatId=${chatId} asset=${asset}`);
    return;
  }

  // /unfollow BTC
  const unfollowMatch = text.match(/^\/unfollow\s+([A-Za-z0-9]+)/i);
  if (unfollowMatch) {
    const asset = unfollowMatch[1].toUpperCase();
    const key   = subKey(chatId, asset);
    if (subs[key]) {
      delete subs[key];
      saveSubs(subs);
      await sendMessage(chatId, `Stopped alerts for <b>${asset}</b>.`);
      log(`Unsubscribed chatId=${chatId} asset=${asset}`);
    } else {
      await sendMessage(chatId, `You weren't following <b>${asset}</b>.`);
    }
    return;
  }

  // /stop — remove all subs for this chat
  if (text.startsWith('/stop')) {
    const keys = Object.keys(subs).filter(k => k.startsWith(`${chatId}:`));
    keys.forEach(k => delete subs[k]);
    saveSubs(subs);
    const count = keys.length;
    await sendMessage(chatId, count
      ? `Stopped all ${count} funding alert(s) for your chat.`
      : `You had no active funding alerts.`
    );
    log(`/stop chatId=${chatId} removed ${count} subs`);
    return;
  }

  // /list — show current subscriptions
  if (text.startsWith('/list')) {
    const keys = Object.keys(subs).filter(k => k.startsWith(`${chatId}:`));
    if (keys.length === 0) {
      await sendMessage(chatId, 'No active funding alerts. Visit the dashboard and tap ✈ Follow on any opportunity.');
    } else {
      const assets = keys.map(k => subs[k].asset).join(', ');
      await sendMessage(chatId, `Currently following: <b>${assets}</b>\n\nSend /unfollow ASSET to stop one, or /stop to clear all.`);
    }
    return;
  }
}

// ── Long-poll loop ────────────────────────────────────────────────────────────
async function pollLoop(subs) {
  let offset = 0;
  log('Starting getUpdates long-poll…');

  while (true) {
    try {
      const url = `${API_BASE}/getUpdates?timeout=${POLL_TIMEOUT}&offset=${offset}&allowed_updates=%5B%22message%22%5D`;
      const res = await httpGet(url);

      if (!res.ok) {
        log('getUpdates error:', JSON.stringify(res));
        await new Promise(r => setTimeout(r, 5_000));
        continue;
      }

      for (const update of res.result || []) {
        offset = update.update_id + 1;
        await handleUpdate(update, subs);
      }
    } catch (e) {
      log('poll error:', e.message);
      await new Promise(r => setTimeout(r, 5_000));
    }
  }
}

// ── Alert scanning ────────────────────────────────────────────────────────────
function loadFundingData() {
  try {
    const raw = JSON.parse(fs.readFileSync(UNI_FILE, 'utf8'));
    return (raw.opportunities || []).filter(o => o.type === 'FUNDING');
  } catch { return []; }
}

function extractCoin(id) {
  // id format: "funding-ETH-dydx-okx"
  const parts = (id || '').split('-');
  return parts.length >= 2 ? parts[1].toUpperCase() : null;
}

function bestPerCoin(opps) {
  const map = {};
  for (const opp of opps) {
    const coin = extractCoin(opp.id);
    if (!coin) continue;
    if (!map[coin] || opp.netROI > map[coin].netROI) {
      map[coin] = { ...opp, coin };
    }
  }
  return map;  // { ETH: opp, BTC: opp, ... }
}

function fmtDayUsd(netRoi) {
  const N      = REF_CAPITAL / 2;
  const dayUsd = (N * netRoi / 100) / 365;
  if (dayUsd < 0.005) return '<$0.01/day';
  return `$${dayUsd.toFixed(2)}/day`;
}

function statusEmoji(status) {
  if (status === 'HARVEST')  return '🟢';
  if (status === 'CAUTION')  return '🟡';
  if (status === 'MARGINAL') return '🔴';
  return '⚪';
}

function buildAlertText(opp, prevStatus) {
  const coin   = opp.coin;
  const short  = (opp.legs[0]?.platform || '').replace(/\s*\(DEX\)/, '');
  const long   = (opp.legs[1]?.platform || '').replace(/\s*\(DEX\)/, '');
  const day    = fmtDayUsd(opp.netROI);
  const status = opp.status;
  const beDays = typeof opp.breakevenDays === 'number' ? opp.breakevenDays.toFixed(1) : '?';

  const changeLabel = prevStatus
    ? `Status: ${prevStatus} → ${status}`
    : `Status: ${status}`;

  return [
    `${statusEmoji(status)} <b>${coin} Funding Alert</b> — ${changeLabel}`,
    '',
    `↓ SHORT ${short} / ↑ LONG ${long}`,
    `≈ ${day} on $${REF_CAPITAL.toLocaleString()} ref capital`,
    `Breakeven: ${beDays} days`,
    '',
    `Net yield: ${opp.netROI.toFixed(1)}%/yr theoretical ceiling`,
    `<i>Rates change hourly — this is a current estimate, not a promise.</i>`,
    '',
    `/unfollow ${coin} to stop these alerts · /list to see all`,
  ].join('\n');
}

async function runAlertScan(subs) {
  const opps       = loadFundingData();
  if (opps.length === 0) return;

  const byAsset = bestPerCoin(opps);
  const now     = Date.now();

  for (const [key, sub] of Object.entries(subs)) {
    const opp = byAsset[sub.asset];
    if (!opp) continue;

    const currentStatus = opp.status;
    const prevStatus    = sub.lastStatus;

    // Alert only on status change
    const changed = prevStatus !== null && prevStatus !== currentStatus;
    if (!changed) continue;

    // Throttle: max 1 alert/hr per (chat, asset)
    if (now - sub.lastAlertAt < THROTTLE_MS) continue;

    const text = buildAlertText(opp, prevStatus);
    await sendMessage(sub.chatId, text);
    log(`Alert sent chatId=${sub.chatId} asset=${sub.asset} ${prevStatus}→${currentStatus}`);

    // Update sub state
    sub.lastAlertAt = now;
    sub.lastStatus  = currentStatus;
  }

  // Always update lastStatus even when no alert sent (so we track baseline)
  let dirty = false;
  for (const [key, sub] of Object.entries(subs)) {
    const opp = byAsset[sub.asset];
    if (!opp) continue;
    if (subs[key].lastStatus !== opp.status) {
      if (subs[key].lastStatus === null) {
        // first scan: just record status, don't alert
        subs[key].lastStatus = opp.status;
        dirty = true;
      }
    }
  }
  if (dirty) saveSubs(subs);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!TOKEN) { console.error('[A22] TELEGRAM_BOT_TOKEN not set'); process.exit(1); }

  log('Starting — subscriptions file:', SUBS_FILE);
  const subs = loadSubs();
  log(`Loaded ${Object.keys(subs).length} existing subscription(s)`);

  // Alert scan loop (independent of poll loop)
  setInterval(() => {
    runAlertScan(subs).catch(e => log('alertScan error:', e.message));
  }, ALERT_INTERVAL);

  // Run first scan immediately
  runAlertScan(subs).catch(e => log('alertScan init error:', e.message));

  // Long-poll loop (blocks forever)
  await pollLoop(subs);
}

main();
