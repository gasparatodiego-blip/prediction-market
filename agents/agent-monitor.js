#!/usr/bin/env node
'use strict';

/**
 * Agent Monitor — Phase 5
 * Watches all 8 PM2 agents via heartbeats + process status.
 * Sends Telegram alert if any agent goes silent >10 min.
 * Writes /tmp/monitor-status.json for /api/health.
 * Runs every 2 minutes.
 */

const fs    = require('fs');
const https = require('https');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const TG_TOKEN    = '8920675182:AAExM7SaLI-t7j3_QgkfGb46MqEJkHRlmJ4';
const TG_CHAT     = '8844610430';
const HB_FILE     = '/tmp/agent-heartbeats.json';
const STATUS_OUT  = '/tmp/monitor-status.json';
const INTERVAL_MS = 2 * 60 * 1000;
const STALE_MS    = 10 * 60 * 1000; // 10 min without heartbeat = stale

const WATCHED_AGENTS = [
  'agent10-binance',
  'agent-kalshi',
  'agent-polymarket',
  'agent-manifold',
  'agent-metaculus',
  'agent-predictit',
  'agent-master',
  'dashboard',
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

  for (const name of WATCHED_AGENTS) {
    const lastBeat = hb[name] ?? null;
    const pm2proc  = pm2map[name];
    const pm2status = pm2proc?.pm2_env?.status ?? 'unknown';
    const pm2uptime = pm2proc?.pm2_env?.pm_uptime ? Math.round((now - pm2proc.pm2_env.pm_uptime) / 1000) : null;

    const beatAge     = lastBeat ? now - lastBeat : null;
    const isStale     = beatAge != null ? beatAge > STALE_MS : true;
    const isDashboard = name === 'dashboard';

    // Dashboard: only check PM2 status, not heartbeat (it doesn't write one)
    const healthy = isDashboard
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
