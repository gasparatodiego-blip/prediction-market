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
const STALE_MS    = 10 * 60 * 1000; // 10 min without heartbeat = stale

// pm2Name = the pm2 process name; hbKey = the key that agent actually writes
// into /tmp/agent-heartbeats.json (several agents' hbKey differs from their
// pm2 name — e.g. agent15-funding-writer writes 'agent15-funding'). hbKey:
// null means the agent writes no heartbeat at all — those are checked by
// pm2 status only, same as dashboard always was.
const WATCHED_AGENTS = [
  { pm2Name: 'agent10-binance',            hbKey: 'agent10-binance' },
  { pm2Name: 'agent15-funding-writer',     hbKey: 'agent15-funding' },
  { pm2Name: 'agent18-mm-analyzer',        hbKey: null },
  { pm2Name: 'agent19-basis',              hbKey: null },
  { pm2Name: 'agent20-leaderboard',        hbKey: 'agent20-leaderboard' },
  { pm2Name: 'agent21-copy-watcher',       hbKey: 'agent21-copy-watcher' },
  { pm2Name: 'agent22-funding-alerts',     hbKey: null },
  { pm2Name: 'agent23-prediction-repricer', hbKey: 'repricer' },
  { pm2Name: 'agent24-liquidity-rewards',  hbKey: null },
  { pm2Name: 'agent25-kalshi-rewards',     hbKey: null },
  { pm2Name: 'agent26-landing-auditor',    hbKey: 'agent26-landing-auditor' },
  { pm2Name: 'dashboard',                  hbKey: null },
];

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

  for (const { pm2Name: name, hbKey } of WATCHED_AGENTS) {
    const heartbeatRequired = hbKey != null;
    const lastBeat = heartbeatRequired ? (hb[hbKey] ?? null) : null;
    const pm2proc  = pm2map[name];
    const pm2status = pm2proc?.pm2_env?.status ?? 'unknown';
    const pm2uptime = pm2proc?.pm2_env?.pm_uptime ? Math.round((now - pm2proc.pm2_env.pm_uptime) / 1000) : null;

    const beatAge = lastBeat ? now - lastBeat : null;
    const isStale = beatAge != null ? beatAge > STALE_MS : true;
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
