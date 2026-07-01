#!/usr/bin/env node
'use strict';

/**
 * Agent Monitor — Phase 5
 * Watches the current PM2 fleet via heartbeats + process status.
 * Sends Telegram alert if any agent goes silent >10 min.
 * Writes /tmp/monitor-status.json for /api/health.
 * Runs every 2 minutes.
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// Read every candidate env file — a fresh `pm2 start` does not inherit the
// shell's exported vars, and .env.local exists but doesn't carry TELEGRAM_*
// (see agents/agent26-landing-auditor.js for the same fix + full rationale).
for (const envFile of ['.env.local', '.env']) {
  try {
    const envPath = path.join(__dirname, '..', envFile);
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)="?([^"]*?)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* try next */ }
}

const TG_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT     = process.env.TELEGRAM_CHAT_ID;
const HB_FILE     = '/tmp/agent-heartbeats.json';
const STATUS_OUT  = '/tmp/monitor-status.json';
const INTERVAL_MS = 2 * 60 * 1000;

// Floor so a fast-cycle agent still gets caught reasonably quickly even at
// 2.5x cadence (e.g. a hypothetical 30s-cycle agent wouldn't get a 75s window).
const MIN_STALE_MS = 5 * 60 * 1000;

// pm2Name = the pm2 process name; hbKey = the key that agent actually writes
// into /tmp/agent-heartbeats.json (several agents' hbKey differs from their
// pm2 name — e.g. agent15-funding-writer writes 'agent15-funding'). hbKey:
// null means the agent writes no heartbeat at all — those are checked by
// PM2 status ONLY, never by staleness.
// cadenceMs: the agent's own real scan/poll interval, read from its source
// (setInterval/loop constant) — NOT a guess. Per-agent stale threshold is
// derived as max(2.5 * cadenceMs, MIN_STALE_MS) below, so a slow-cycle agent
// (e.g. agent26's 30-min audit) gets enough slack to not false-alarm between
// its own beats, while a fast-cycle agent (e.g. agent10's 1-min poll) stays
// tightly watched. This replaced a single global 10-min threshold that was
// confirmed to fire real false-positive "down" Telegram alerts for agent20/
// 23/26, whose cadences (30/15/30 min) all exceeded it.
const WATCHED_AGENTS_RAW = [
  { pm2Name: 'agent10-binance',            hbKey: 'agent10-binance',         cadenceMs: 1  * 60_000 }, // agent10-binance.js POLL_INTERVAL
  { pm2Name: 'agent15-funding-writer',     hbKey: 'agent15-funding',         cadenceMs: 1  * 60_000 }, // agent15-funding-writer.js INTERVAL_MS
  { pm2Name: 'agent18-mm-analyzer',        hbKey: null },
  { pm2Name: 'agent19-basis',              hbKey: null },
  { pm2Name: 'agent20-leaderboard',        hbKey: 'agent20-leaderboard',     cadenceMs: 30 * 60_000 }, // agent20-leaderboard.js SCAN_INTERVAL_MS
  { pm2Name: 'agent21-copy-watcher',       hbKey: 'agent21-copy-watcher',    cadenceMs: 5  * 60_000 }, // agent21-copy-watcher.js POLL_INTERVAL_MS
  { pm2Name: 'agent22-funding-alerts',     hbKey: null },
  { pm2Name: 'agent23-prediction-repricer', hbKey: 'repricer',              cadenceMs: 15 * 60_000 }, // agent23-prediction-repricer.js INTERVAL_MS
  { pm2Name: 'agent24-liquidity-rewards',  hbKey: null },
  { pm2Name: 'agent25-kalshi-rewards',     hbKey: null },
  { pm2Name: 'agent26-landing-auditor',    hbKey: 'agent26-landing-auditor', cadenceMs: 30 * 60_000 }, // agent26-landing-auditor.js SCAN_INTERVAL_MS
  { pm2Name: 'dashboard',                  hbKey: null },
];

const WATCHED_AGENTS = WATCHED_AGENTS_RAW.map(a => ({
  ...a,
  staleMs: a.hbKey != null ? Math.max(2.5 * a.cadenceMs, MIN_STALE_MS) : null,
}));

function logThresholdTable() {
  console.log('[monitor] Per-agent heartbeat staleness thresholds:');
  console.log(`  ${'agent'.padEnd(28)}${'cadence'.padEnd(12)}stale threshold`);
  for (const a of WATCHED_AGENTS) {
    const cadenceStr = a.cadenceMs != null ? `${(a.cadenceMs / 60_000).toFixed(1)}min` : 'n/a';
    const staleStr   = a.staleMs   != null ? `${(a.staleMs   / 60_000).toFixed(1)}min` : 'n/a (PM2 status only)';
    console.log(`  ${a.pm2Name.padEnd(28)}${cadenceStr.padEnd(12)}${staleStr}`);
  }
}
logThresholdTable();

// Rate limit alerts: don't spam same agent within 30 min
const alertCooldown = {};
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;

function readJson(path) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return null; }
}

function writeJson(path, data) {
  try { fs.writeFileSync(path, JSON.stringify(data, null, 2)); } catch {}
}

function sendTelegram(text) {
  const body = JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' });
  const req  = https.request({
    hostname: 'api.telegram.org',
    path:     `/bot${TG_TOKEN}/sendMessage`,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => { try { const r = JSON.parse(d); if (!r.ok) console.error('[monitor] tg fail:', r.description); } catch {} });
  });
  req.on('error', e => console.error('[monitor] tg error:', e.message));
  req.write(body); req.end();
}

async function getPm2List() {
  try {
    const { stdout } = await execFileAsync('pm2', ['jlist'], { timeout: 10000 });
    return JSON.parse(stdout);
  } catch { return null; }
}

async function checkHealth() {
  const ts  = new Date().toISOString();
  const now = Date.now();
  const hb  = readJson(HB_FILE) ?? {};

  const pm2list = await getPm2List();
  const pm2map  = {};
  if (pm2list) {
    for (const p of pm2list) pm2map[p.name] = p;
  }

  const agentStatuses = [];
  const alerted = [];

  for (const { pm2Name: name, hbKey, staleMs } of WATCHED_AGENTS) {
    const heartbeatRequired = hbKey != null;
    const lastBeat = heartbeatRequired ? (hb[hbKey] ?? null) : null;
    const pm2proc  = pm2map[name];
    const pm2status = pm2proc?.pm2_env?.status ?? 'unknown';
    const pm2uptime = pm2proc?.pm2_env?.pm_uptime ? Math.round((now - pm2proc.pm2_env.pm_uptime) / 1000) : null;

    const beatAge = lastBeat ? now - lastBeat : null;
    const isStale = beatAge != null ? beatAge > staleMs : true;
    const isDashboard = !heartbeatRequired;

    // Agents with no heartbeat (incl. dashboard): only check PM2 status.
    const healthy = !heartbeatRequired
      ? pm2status === 'online'
      : (pm2status === 'online' && !isStale);

    const status = {
      name,
      healthy,
      pm2status,
      pm2uptime,
      lastBeat,
      beatAgeSeconds: beatAge != null ? Math.round(beatAge / 1000) : null,
    };
    agentStatuses.push(status);

    if (!healthy) {
      const cooldownKey = name;
      const lastAlert   = alertCooldown[cooldownKey] ?? 0;
      if (now - lastAlert > ALERT_COOLDOWN_MS) {
        alerted.push(name);
        alertCooldown[cooldownKey] = now;
        const reason = isDashboard
          ? `PM2 status: ${pm2status}`
          : `PM2: ${pm2status} | heartbeat: ${beatAge != null ? Math.round(beatAge / 60000) + 'min ago' : 'never'}`;
        console.warn(`[monitor] ALERT: ${name} unhealthy — ${reason}`);
      }
    }
  }

  const allHealthy = agentStatuses.every(a => a.healthy);

  // Write monitor status for /api/health
  writeJson(STATUS_OUT, {
    checkedAt:     ts,
    allHealthy,
    agentStatuses,
  });

  // Send Telegram alerts for unhealthy agents
  if (alerted.length) {
    const lines = alerted.map(name => {
      const s = agentStatuses.find(a => a.name === name);
      return `• <b>${name}</b>: ${s?.pm2status ?? 'unknown'}${s?.beatAgeSeconds ? ` (last beat ${Math.round(s.beatAgeSeconds / 60)}m ago)` : ''}`;
    });
    sendTelegram(`🚨 <b>AGENT MONITOR ALERT</b>\n${alerted.length} agent(s) down:\n${lines.join('\n')}\n\nCheck: <code>pm2 list</code>`);
  }

  const healthStr = agentStatuses.map(a => `${a.name}:${a.healthy ? '✓' : '✗'}`).join(' | ');
  console.log(`[monitor] ${ts} | ${allHealthy ? 'ALL OK' : 'PROBLEMS'} | ${healthStr}`);
}

async function tick() {
  try { await checkHealth(); } catch (e) { console.error('[monitor] crash:', e.message); }
  setTimeout(tick, INTERVAL_MS);
}

tick();
