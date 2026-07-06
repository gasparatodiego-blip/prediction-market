#!/usr/bin/env node
'use strict';

/**
 * Agent Monitor — Phase 5
 * Watches the current PM2 fleet via heartbeats + process status.
 * Auto-restarts a down/stale agent, guarded by a per-agent circuit breaker so a
 * genuinely-broken agent can't be thrown into an infinite restart loop
 * (MAX_RESTARTS within WINDOW_MS → breaker opens; RECOVERY_COOLDOWN_MS of
 * continuous health → breaker resets). Sends Telegram alerts on restart /
 * breaker-open / recovery (one alert per state transition, never per cycle).
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
  { pm2Name: 'agent2-fetcher',             hbKey: 'fetcher',                 cadenceMs: 1  * 60_000 }, // agent2-fetcher.js INTERVAL
  { pm2Name: 'agent3-matcher-politics',    hbKey: 'matcher-politics',        cadenceMs: 30 * 60_000 }, // agent3 buildRunner interval (shared-matcher)
  { pm2Name: 'agent4-matcher-other',       hbKey: 'matcher-other',           cadenceMs: 30 * 60_000 }, // agent4 buildRunner interval (shared-matcher)
  { pm2Name: 'agent5-calculator',          hbKey: 'calculator',              cadenceMs: 45_000 },      // agent5-calculator.js INTERVAL (45s)
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

// ── Auto-restart circuit breaker ────────────────────────────────────────────
// When a watched agent is down/stale the monitor restarts it, but a per-agent
// circuit breaker prevents a restart storm on a genuinely-broken agent: allow
// at most MAX_RESTARTS auto-restarts within WINDOW_MS. On exceeding that, the
// breaker OPENS for that agent — auto-restart is disabled and one escalated
// alert is sent — until the agent is continuously healthy for
// RECOVERY_COOLDOWN_MS, which clears the ledger and re-enables auto-restart.
// All values tunable.
const MAX_RESTARTS         = 3;                 // max auto-restarts per agent…
const WINDOW_MS            = 10 * 60 * 1000;    // …within this rolling window
const RECOVERY_COOLDOWN_MS = 15 * 60 * 1000;    // continuous health before breaker reset
const RESTART_TIMEOUT_MS   = 30 * 1000;         // wall-clock bound on each pm2 exec
const LEDGER_FILE    = path.join(__dirname, '..', 'data', 'monitor-restart-ledger.json');
const ECOSYSTEM_FILE = path.join(__dirname, 'ecosystem.config.js');
// Never auto-restart these: the dashboard is user-facing, the monitor is us.
const RESTART_EXCLUDE = new Set(['dashboard', 'agent-monitor']);

// Per-agent restart ledger, persisted so the breaker survives a monitor restart.
// Shape: { [agentName]: { attempts: number[], breakerOpen: boolean, healthySince: number|null } }
let ledger = readJson(LEDGER_FILE);
if (typeof ledger !== 'object' || ledger === null) ledger = {};

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

// Atomic write (tmp + rename) so a mid-write crash can't corrupt the ledger.
function atomicWriteJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) { console.error('[monitor] ledger write failed:', e.message); }
}

function ledgerEntry(name) {
  if (!ledger[name]) ledger[name] = { attempts: [], breakerOpen: false, healthySince: null };
  return ledger[name];
}

// Drop attempt timestamps older than the rolling window so stale strikes don't
// count toward the breaker.
function pruneAttempts(entry, now) {
  entry.attempts = entry.attempts.filter(t => now - t < WINDOW_MS);
}

// Restart one agent by its exact pm2 name (never a broad/pattern kill).
// If present in pm2 (stopped/errored/wedged) → `pm2 restart`; if entirely
// absent → `pm2 start ecosystem --only <name>` then `pm2 save` so a later
// resurrect keeps it (the exact gap that left 3 agents dead for 3 days).
async function pm2Restart(name, presentInPm2) {
  if (presentInPm2) {
    return execFileAsync('pm2', ['restart', name], { timeout: RESTART_TIMEOUT_MS });
  }
  const r = await execFileAsync('pm2', ['start', ECOSYSTEM_FILE, '--only', name], { timeout: RESTART_TIMEOUT_MS });
  try { await execFileAsync('pm2', ['save'], { timeout: RESTART_TIMEOUT_MS }); } catch { /* save is best-effort */ }
  return r;
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
  let ledgerDirty = false;

  for (const { pm2Name: name, hbKey, staleMs } of WATCHED_AGENTS) {
    const heartbeatRequired = hbKey != null;
    const lastBeat = heartbeatRequired ? (hb[hbKey] ?? null) : null;
    const pm2proc  = pm2map[name];
    const pm2status = pm2proc?.pm2_env?.status ?? 'unknown';
    const pm2uptime = pm2proc?.pm2_env?.pm_uptime ? Math.round((now - pm2proc.pm2_env.pm_uptime) / 1000) : null;

    const beatAge = lastBeat ? now - lastBeat : null;
    const isStale = beatAge != null ? beatAge > staleMs : true;

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

    const reason = heartbeatRequired
      ? `PM2: ${pm2status} | heartbeat ${beatAge != null ? Math.round(beatAge / 60000) + 'min ago' : 'never'}`
      : `PM2: ${pm2status}`;

    if (healthy) {
      // Recovery: only agents with prior restart activity carry a ledger entry.
      // Require continuous health for RECOVERY_COOLDOWN_MS before clearing it.
      const entry = ledger[name];
      if (entry && (entry.attempts.length > 0 || entry.breakerOpen)) {
        if (entry.healthySince == null) {
          entry.healthySince = now;
          ledgerDirty = true;
        } else if (now - entry.healthySince >= RECOVERY_COOLDOWN_MS) {
          const wasOpen = entry.breakerOpen;
          delete ledger[name];
          ledgerDirty = true;
          console.log(`[monitor] ✅ ${name} recovered, breaker reset`);
          sendTelegram(`✅ <b>${name}</b> recovered — healthy for ${Math.round(RECOVERY_COOLDOWN_MS / 60000)} min, auto-restart re-enabled${wasOpen ? ' (breaker was OPEN)' : ''}.`);
        }
      }
    } else if (RESTART_EXCLUDE.has(name)) {
      // Non-restartable (dashboard/monitor): keep alert-only, rate-limited.
      const lastAlert = alertCooldown[name] ?? 0;
      if (now - lastAlert > ALERT_COOLDOWN_MS) {
        alerted.push(name);
        alertCooldown[name] = now;
        console.warn(`[monitor] ALERT: ${name} unhealthy (no auto-restart) — ${reason}`);
      }
    } else {
      // Restartable + unhealthy: circuit-breaker supervision.
      const entry = ledgerEntry(name);
      entry.healthySince = null;           // not healthy → reset the recovery timer
      pruneAttempts(entry, now);
      ledgerDirty = true;

      if (entry.breakerOpen) {
        // Breaker already open — stay silent, no restart (alerted once on open).
      } else if (entry.attempts.length >= MAX_RESTARTS) {
        // Budget exhausted within the window → open the breaker, escalate ONCE.
        entry.breakerOpen = true;
        console.error(`[monitor] 🚨 ${name} crash-looping — breaker OPEN, auto-restart disabled`);
        sendTelegram(`🚨 <b>${name}</b> is crash-looping — ${MAX_RESTARTS} restarts in ${Math.round(WINDOW_MS / 60000)} min, auto-restart <b>DISABLED</b>, manual intervention needed.`);
      } else {
        // Restart, counting it as an attempt regardless of success (a failing
        // start still consumes the breaker budget so it can't loop forever).
        entry.attempts.push(now);
        const n = entry.attempts.length;
        try {
          await pm2Restart(name, !!pm2proc);
          console.log(`[monitor] 🔄 auto-restarted ${name} (attempt ${n}/${MAX_RESTARTS}) — ${reason}`);
          sendTelegram(`🔄 auto-restarted <b>${name}</b> (attempt ${n}/${MAX_RESTARTS})\n${reason}`);
        } catch (e) {
          const detail = (e.stderr || e.message || '').toString().slice(0, 300);
          console.error(`[monitor] restart FAILED for ${name} (attempt ${n}/${MAX_RESTARTS}): ${e.message}`);
          sendTelegram(`⚠️ auto-restart FAILED for <b>${name}</b> (attempt ${n}/${MAX_RESTARTS})\n${reason}\n<code>${detail}</code>`);
        }
      }
    }
  }

  if (ledgerDirty) atomicWriteJson(LEDGER_FILE, ledger);

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
