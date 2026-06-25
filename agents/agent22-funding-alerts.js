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
const { httpGet: _sharedGet, httpPost: _httpPost } = require('../lib/httpGet');

// ── Config ─────────────────────────────────────────────────────────────────
const TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const API_BASE = `https://api.telegram.org/bot${TOKEN}`;
const SUBS_FILE  = path.join(__dirname, '../data/fund-subscriptions.json');
const UNI_FILE   = '/tmp/unified-opportunities.json';
// Prediction alerts: same post-gate source as /api/prediction
const PRED_REPRICED   = '/tmp/repriced-opportunities.json';
const PRED_DISCOVERY  = '/tmp/arbitrage-opportunities.json';
const PRED_ROI_CEIL   = 15;  // matches dashboard quarantine threshold

const POLL_TIMEOUT   = 25;          // seconds for long-poll
const ALERT_INTERVAL = 60_000;      // ms between alert scans
const THROTTLE_MS    = 3_600_000;   // 1h min between alerts per (chat, asset)
const REF_CAPITAL    = 1_000;       // $ for $/day headline in alerts

// ── Helpers ─────────────────────────────────────────────────────────────────
function log(...a) { console.log('[A22]', ...a); }

// timeoutMs=35_000 matches the old socket-inactivity value and provides a safe
// ceiling for the Telegram long-poll (POLL_TIMEOUT=25 s + 10 s margin).
function httpGet(url) { return _sharedGet(url, { timeoutMs: 35_000 }).then(r => r.data); }

// sendMessage / other POSTs — add the wall-clock deadline that was missing.
function httpPost(url, body) { return _httpPost(url, body, { timeoutMs: 15_000 }).then(r => r.data); }

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

  // /start pred_new — subscribe to new prediction-market verified results
  if (/^\/start\s+pred_new/i.test(text)) {
    const key  = `${chatId}:PRED_NEW`;
    const prev = subs[key] || {};
    subs[key]  = {
      chatId,
      type:         'pred_new',
      addedAt:      prev.addedAt    || Date.now(),
      lastAlertAt:  prev.lastAlertAt || 0,
      knownOppIds:  prev.knownOppIds ?? null,  // null = baseline scan pending
    };
    saveSubs(subs);
    await sendMessage(chatId,
      `✅ <b>Prediction alerts active.</b>\n\n` +
      `You'll be notified when a new verified prediction-market result appears.\n\n` +
      `Alerts fire only on results that:\n` +
      `• Passed the AI same-event gate\n` +
      `• Are live-cashable at current bid/ask prices\n\n` +
      `Max 1 alert per new result per hour.\n\n` +
      `/stop to cancel all alerts · /list to see active alerts`
    );
    log(`Pred subscription chatId=${chatId}`);
    return;
  }

  // /start fund_BTC            — status-change alerts only
  // /start fund_BTC_exit_550   — status alerts + exit alert at 5.5%/yr (basis points: value ÷ 100 = %/yr)
  const startMatch = text.match(/^\/start\s+fund_([A-Za-z0-9]+)(?:_exit_(\d+))?/i);
  if (startMatch) {
    const asset         = startMatch[1].toUpperCase();
    const exitThreshold = startMatch[2] != null ? parseInt(startMatch[2], 10) / 100 : null;
    const key           = subKey(chatId, asset);
    const prev          = subs[key] || {};
    subs[key] = {
      chatId,
      asset,
      addedAt:       prev.addedAt || Date.now(),
      lastAlertAt:   prev.lastAlertAt || 0,
      lastStatus:    prev.lastStatus || null,
      exitThreshold: exitThreshold ?? prev.exitThreshold ?? null,
      exitAlertSent: exitThreshold != null ? false : (prev.exitAlertSent || false),
    };
    saveSubs(subs);
    if (exitThreshold != null) {
      await sendMessage(chatId,
        `✅ Following <b>${asset}</b> — exit alert set at <b>${exitThreshold.toFixed(1)}%/yr</b> gross spread.\n\n` +
        `I'll send one message when the ${asset} spread drops below ${exitThreshold.toFixed(1)}%/yr, ` +
        `and also notify you on status changes (HARVEST/CAUTION/MARGINAL).\n\n` +
        `Rates vary hourly — alerts are estimates, not financial advice. ` +
        `No orders are placed.\n\n` +
        `/unfollow ${asset} to cancel · /list to see all alerts`
      );
      log(`Subscribed chatId=${chatId} asset=${asset} exitThreshold=${exitThreshold}`);
    } else {
      await sendMessage(chatId,
        `✅ Following <b>${asset}</b> funding.\n\n` +
        `I'll alert you when the spread status changes meaningfully ` +
        `(e.g. CAUTION → HARVEST or HARVEST → MARGINAL).\n\n` +
        `Rates change hourly — alerts are estimates, not promises.\n\n` +
        `/unfollow ${asset} to stop · /stop to clear all`
      );
      log(`Subscribed chatId=${chatId} asset=${asset}`);
    }
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
      await sendMessage(chatId, 'No active alerts. Visit the dashboard to subscribe.');
    } else {
      const lines = keys.map(k => {
        const s = subs[k];
        if (s.type === 'pred_new') return `• <b>Prediction Markets</b> — new verified results`;
        const thresh = s.exitThreshold != null ? ` · exit alert <${s.exitThreshold.toFixed(1)}%/yr` : '';
        return `• <b>${s.asset}</b> funding${thresh}`;
      });
      await sendMessage(chatId,
        `Active alerts:\n${lines.join('\n')}\n\n/unfollow ASSET to cancel funding alert · /stop to clear all`
      );
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

function buildStatusAlertText(opp, prevStatus) {
  const coin   = opp.coin;
  const short  = (opp.legs[0]?.platform || '').replace(/\s*\(DEX\)/, '');
  const long   = (opp.legs[1]?.platform || '').replace(/\s*\(DEX\)/, '');
  const day    = fmtDayUsd(opp.netROI);
  const status = opp.status;
  const beDays = typeof opp.breakevenDays === 'number' ? opp.breakevenDays.toFixed(1) : '?';

  return [
    `${statusEmoji(status)} <b>${coin} Funding</b> — ${prevStatus} → ${status}`,
    '',
    `↓ SHORT ${short} / ↑ LONG ${long}`,
    `≈ ${day} on $${REF_CAPITAL.toLocaleString()} ref capital · breakeven ${beDays}d`,
    '',
    `Gross spread: ${(opp.annualizedROI || opp.grossROI || 0).toFixed(1)}%/yr`,
    `<i>Rates change hourly — estimate only, not a promise.</i>`,
    '',
    `/unfollow ${coin} · /list`,
  ].join('\n');
}

function buildExitAlertText(opp, threshold) {
  const coin  = opp.coin;
  const gross = (opp.annualizedROI || opp.grossROI || 0).toFixed(1);
  const short = (opp.legs[0]?.platform || '').replace(/\s*\(DEX\)/, '');
  const long  = (opp.legs[1]?.platform || '').replace(/\s*\(DEX\)/, '');

  return [
    `⚠️ <b>${coin} exit alert</b>`,
    '',
    `Gross spread is now <b>${gross}%/yr</b> — below your exit threshold of ${threshold.toFixed(1)}%/yr.`,
    `↓ SHORT ${short} / ↑ LONG ${long}`,
    '',
    `Consider closing both legs simultaneously to avoid leg risk.`,
    `<b>No orders have been placed</b> — this is a notification only.`,
    '',
    `<i>Not financial advice. Verify rates on your exchange before acting.</i>`,
    '',
    `/unfollow ${coin} to stop these alerts · /list`,
  ].join('\n');
}

// ── Prediction alert scanning ─────────────────────────────────────────────────
function loadPredictionData() {
  // Only reads from agent23's live-verified repriced file.
  // If the file is absent, unreadable, or an opportunity has not been repriced
  // yet, this returns [] — no alert fires. Never falls through to raw discovery.
  try {
    const f = JSON.parse(fs.readFileSync(PRED_REPRICED, 'utf8'));
    return (f.opportunities || []).filter(
      o => o.cashable === true && typeof o.roi === 'number' && o.roi > 0 && o.roi <= PRED_ROI_CEIL
    );
  } catch { return []; }
}

function buildPredAlertText(opp) {
  const detectedAt = new Date().toUTCString().replace(/:\d\d GMT$/, ' UTC');
  const q          = (opp.question || opp.title || '').slice(0, 100);
  const low        = opp.lowMarket  || {};
  const high       = opp.highMarket || {};
  const roi        = (opp.roi || 0).toFixed(2);
  const days       = opp.daysToResolution ? `${opp.daysToResolution}d to resolution` : '';
  const yesPrice   = low.yesAsk  ? (low.yesAsk  * 100).toFixed(1) : String(low.probability  || '?');
  const noPrice    = high.yesBid ? ((1 - high.yesBid) * 100).toFixed(1) : String(100 - (high.probability || 0));
  const lowPlat    = low.platform  || '?';
  const highPlat   = high.platform || '?';
  const lowUrl     = low.url  || null;
  const highUrl    = high.url || null;

  const lines = [
    `🔔 <b>Prediction arb detected — ${detectedAt}</b>`,
    `<i>Prices move fast. Verify live before acting.</i>`,
    ``,
    `<b>${q}</b>`,
    ``,
    `At detection: <b>${lowPlat}</b> YES ${yesPrice}¢ / <b>${highPlat}</b> NO ${noPrice}¢ → est. <b>+${roi}%</b> net${days ? `  ·  ${days}` : ''}`,
    `<i>These prices are from the detection moment and may already have moved.</i>`,
    ``,
    `Open both markets and confirm the spread still exists before trading — short-dated and sports markets often close within minutes.`,
  ];

  if (lowUrl || highUrl) {
    lines.push(``);
    if (lowUrl)  lines.push(`• ${lowPlat}: ${lowUrl}`);
    if (highUrl) lines.push(`• ${highPlat}: ${highUrl}`);
  }

  lines.push(``);
  lines.push(`⚠ Verify resolution criteria match on both platforms before trading.`);
  lines.push(`<i>Not financial advice.</i>`);

  return lines.join('\n');
}

async function scanPredictionAlerts(subs) {
  const predKeys = Object.keys(subs).filter(k => k.endsWith(':PRED_NEW'));
  if (predKeys.length === 0) return;

  const opps  = loadPredictionData();
  const now   = Date.now();
  let dirty   = false;

  for (const key of predKeys) {
    const sub = subs[key];

    // First scan ever: record baseline, no alert (avoids firing on existing state at subscribe time)
    if (sub.knownOppIds === null) {
      sub.knownOppIds = opps.map(o => o.id);
      dirty = true;
      log(`Pred baseline chatId=${sub.chatId} count=${opps.length}`);
      continue;
    }

    const prevSet = new Set(sub.knownOppIds || []);
    const newOpps = opps.filter(o => !prevSet.has(o.id));

    if (newOpps.length > 0 && now - sub.lastAlertAt >= THROTTLE_MS) {
      const best = newOpps.sort((a, b) => b.roi - a.roi)[0];
      const text = buildPredAlertText(best);
      await sendMessage(sub.chatId, text);
      log(`Pred alert chatId=${sub.chatId} new=${newOpps.length} opp="${(best.question || best.title || '').slice(0, 40)}"`);
      sub.lastAlertAt = now;
    }

    // Always update known IDs so alerts don't repeat for the same result
    sub.knownOppIds = opps.map(o => o.id);
    dirty = true;
  }

  if (dirty) saveSubs(subs);
}

async function runAlertScan(subs) {
  const opps = loadFundingData();
  if (opps.length === 0) return;

  const byAsset = bestPerCoin(opps);
  const now     = Date.now();
  let   dirty   = false;

  for (const [key, sub] of Object.entries(subs)) {
    const opp = byAsset[sub.asset];
    if (!opp) continue;
    if (!opp.fullyConfirmed) continue;  // suppress: oneLegUnverified, spikeFlag, or otherwise not fully confirmed

    const currentStatus = opp.status;
    const currentGross  = opp.annualizedROI ?? opp.grossROI ?? 0;

    // First scan: record baseline, no alert
    if (sub.lastStatus === null) {
      sub.lastStatus = currentStatus;
      dirty = true;
      continue;
    }

    // ── Status-change alert ───────────────────────────────────────────────────
    if (sub.lastStatus !== currentStatus) {
      if (now - sub.lastAlertAt >= THROTTLE_MS) {
        const text = buildStatusAlertText(opp, sub.lastStatus);
        await sendMessage(sub.chatId, text);
        log(`Status alert chatId=${sub.chatId} asset=${sub.asset} ${sub.lastStatus}→${currentStatus}`);
        sub.lastAlertAt = now;
      }
      sub.lastStatus = currentStatus;
      dirty = true;
    }

    // ── Exit threshold alert ──────────────────────────────────────────────────
    if (sub.exitThreshold != null && !sub.exitAlertSent) {
      if (currentGross < sub.exitThreshold && now - sub.lastAlertAt >= THROTTLE_MS) {
        const text = buildExitAlertText(opp, sub.exitThreshold);
        await sendMessage(sub.chatId, text);
        log(`Exit alert chatId=${sub.chatId} asset=${sub.asset} gross=${currentGross.toFixed(1)} threshold=${sub.exitThreshold}`);
        sub.exitAlertSent = true;
        sub.lastAlertAt   = now;
        dirty = true;
      }
    }
    // Reset exitAlertSent when spread recovers >10% above threshold
    if (sub.exitAlertSent && sub.exitThreshold != null) {
      if (currentGross > sub.exitThreshold * 1.1) {
        sub.exitAlertSent = false;
        dirty = true;
        log(`Exit alert reset chatId=${sub.chatId} asset=${sub.asset} gross=${currentGross.toFixed(1)}`);
      }
    }
  }

  if (dirty) saveSubs(subs);

  // Also scan prediction alerts in the same cycle
  await scanPredictionAlerts(subs);
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
