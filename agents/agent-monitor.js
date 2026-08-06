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
const http  = require('http');
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
// FLEET-FOCUS 2026-07-25 — the liquidity-rewards lane only. The 15 out-of-scope agents this list
// formerly watched (agent2/3/4/5/10/15/18/19/20/21/22/23/30/31/33) were pm2-stopped as part of the
// rewards-only refocus. They are removed here ON PURPOSE: this monitor auto-restarts any watched
// agent it finds stopped/stale (see checkHealth → pm2Restart), so leaving them in would resurrect
// them within one cycle and undo the stop. agent34/35/37 stay watched by their dedicated peers
// (agent38/agent37), not here — the pre-existing design, left unchanged.
//
// ── RIDUZIONE ALL'INSIEME MINIMO — 6 agosto 2026 ────────────────────────────────────────────────
// Tolti da questa lista agent25-kalshi-rewards, agent26-landing-auditor e agent39-net-rerun, perché
// sono stati fermati con `pm2 stop` nella stessa sessione. Lasciarli qui li avrebbe fatti risorgere
// entro un ciclo (2 minuti) — è precisamente ciò che il paragrafo qui sopra dice, e che va onorato
// ogni volta che si ferma qualcosa.
//
// Perché quei tre non servono più (verificato prima di fermarli, non dedotto):
//   · agent25  agent24 chiama writeCombinedSnapshot() a ogni scan e buildCombined() tratta un file
//              kalshi assente come [] senza sollevare: i 112 mercati Polymarket restano tutti, e
//              agent34 sottoscrive solo Polymarket. I premi Kalshi sono US-only, operatore UE.
//   · agent26  scrive landing-auditor-state.json (nessun lettore) e guardian-directives.json, letto
//              solo da /api/health tramite lib/guardian-health, che degrada a null senza sollevare.
//   · agent39  misura la copertura del tape e lancia il replay del netto a 48h. Utile, ma NON
//              operativo: non piazza, non riprezza, non sorveglia nulla che tenga in vita un ordine.
//
// Restano sorvegliati esattamente i produttori e i guardiani che continuano a girare: agent24 (la
// watchlist di agent34 e il normalizzato), agent38 (che a sua volta riavvia agent34 quando i
// giornali smettono di crescere) e la dashboard.
//
// RESTORE: `git revert` di questo commit e di quello sull'ecosystem, poi `pm2 start <nome>` per
// ciascuno e `pm2 restart agent-monitor`. Niente è stato cancellato: solo fermato.
// agent27-news-guard è RIENTRATO il 6 agosto 2026, poche ore dopo essere stato fermato, perché la
// correzione al suo consumatore l'ha reso di nuovo utile: agent35 ora legge /tmp/news-guard.json (il
// file che contiene davvero le severità) invece di /tmp/news-guard-state.json, quindi il rail
// `news-high` di lib/maker/risk-rails.js riceve finalmente un input. Va sorvegliato proprio per questo:
// se agent27 muore, il suo file invecchia, agent35 lo scarta oltre i 30 minuti — correttamente — e il
// freno torna cieco. Un freno che si spegne in silenzio è la cosa che questo monitor esiste per evitare.
const WATCHED_AGENTS_RAW = [
  { pm2Name: 'agent24-liquidity-rewards',  hbKey: null },
  { pm2Name: 'agent27-news-guard',         hbKey: 'agent27-news-guard',      cadenceMs: 11 * 60_000 }, // scan ~10-11 min (54s di lavoro + attesa)
  { pm2Name: 'agent38-tape-watchdog',      hbKey: 'agent38-tape-watchdog',   cadenceMs: 60_000 },      // agent38 CHECK_INTERVAL_MS — the watcher is itself watched (who-watches-the-watchman)
  { pm2Name: 'dashboard',                  hbKey: null },
];

// staleMsOverride lets an entry state a threshold directly when the derived 2.5x rule
// (or the MIN_STALE_MS floor) is not the right shape for that agent, WITHOUT having to
// misstate its cadenceMs — cadence stays the real cycle time, which is what the threshold
// table prints. Entries without the field derive exactly as before, so adding it changes
// no existing agent's threshold.
const WATCHED_AGENTS = WATCHED_AGENTS_RAW.map(a => ({
  ...a,
  staleMs: a.hbKey != null
    ? (a.staleMsOverride ?? Math.max(2.5 * a.cadenceMs, MIN_STALE_MS))
    : null,
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

// ── Rule 58/59: dashboard liveness + build integrity ────────────────────────
// The dashboard is user-facing. PM2 "online" only means the node process is up — a
// hung route or a corrupt build still answers 500 (or hangs) while PM2 reports online.
// So we ACTIVELY probe HTTP: a non-200 (or unreachable) health endpoint means the site
// is not serving. Rule 58 says auto-restart the dashboard on that (guarded by the SAME
// circuit breaker so a genuinely-broken build can't loop). Rule 59: if .next/BUILD_ID is
// missing/corrupt the build is gone — we ALERT (never blindly auto-rebuild from the
// monitor; a rebuild belongs to the guarded build path so a failed build can't take the
// last working one down). This is the "restart processes, never edit code" watchdog.
const DASHBOARD_PROBE_URL = 'http://localhost:3000/api/health';
const PROBE_TIMEOUT_MS    = 8_000;
const BUILD_ID_FILE       = path.join(__dirname, '..', '.next', 'BUILD_ID');

function httpStatus(url, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(t); try { req.destroy(); } catch {} resolve(v); } };
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, (res) => { res.resume(); done({ ok: res.statusCode === 200, status: res.statusCode }); });
    const t = setTimeout(() => done({ ok: false, status: null, error: 'timeout' }), timeoutMs);
    req.on('error', (e) => done({ ok: false, status: null, error: e.message }));
  });
}

// Returns { healthy, detail, restarted } and mutates the shared ledger/alert state.
async function checkDashboardIntegrity(now, ledgerDirtyRef, alerted) {
  // Rule 59 first — no build, no point probing HTTP.
  let buildOk = true;
  try { buildOk = fs.existsSync(BUILD_ID_FILE) && fs.statSync(BUILD_ID_FILE).size > 0; } catch { buildOk = false; }
  if (!buildOk) {
    const lastAlert = alertCooldown['dashboard-build'] ?? 0;
    if (now - lastAlert > ALERT_COOLDOWN_MS) {
      alertCooldown['dashboard-build'] = now;
      alerted.push('dashboard-build');
      console.error('[monitor] 🚨 .next/BUILD_ID missing/empty — dashboard build is gone or corrupt');
      sendTelegram('🚨 <b>dashboard build corrupt</b> — .next/BUILD_ID missing/empty. NOT auto-rebuilding (a failed build must not replace the last working one). Run the guarded build: <code>scripts/guarded-build.sh</code>.');
    }
    return { healthy: false, detail: '.next/BUILD_ID missing', restarted: false };
  }

  // Rule 58 — HTTP liveness probe.
  const probe = await httpStatus(DASHBOARD_PROBE_URL);
  if (probe.ok) {
    // Recovery bookkeeping for the HTTP breaker mirrors the heartbeat path.
    const entry = ledger['dashboard'];
    if (entry && (entry.attempts.length > 0 || entry.breakerOpen)) {
      if (entry.healthySince == null) { entry.healthySince = now; ledgerDirtyRef.v = true; }
      else if (now - entry.healthySince >= RECOVERY_COOLDOWN_MS) {
        const wasOpen = entry.breakerOpen;
        delete ledger['dashboard']; ledgerDirtyRef.v = true;
        console.log('[monitor] ✅ dashboard HTTP recovered, breaker reset');
        sendTelegram(`✅ <b>dashboard</b> HTTP recovered — 200 for ${Math.round(RECOVERY_COOLDOWN_MS / 60000)} min, auto-restart re-enabled${wasOpen ? ' (breaker was OPEN)' : ''}.`);
      }
    }
    return { healthy: true, detail: 'HTTP 200', restarted: false };
  }

  const detail = `HTTP ${probe.status ?? probe.error ?? 'unreachable'}`;
  const entry = ledgerEntry('dashboard');
  entry.healthySince = null;
  pruneAttempts(entry, now);
  ledgerDirtyRef.v = true;
  if (entry.breakerOpen) {
    return { healthy: false, detail, restarted: false };
  }
  if (entry.attempts.length >= MAX_RESTARTS) {
    entry.breakerOpen = true;
    alerted.push('dashboard-http');
    console.error(`[monitor] 🚨 dashboard HTTP crash-looping (${detail}) — breaker OPEN, auto-restart disabled`);
    sendTelegram(`🚨 <b>dashboard</b> not serving (${detail}) after ${MAX_RESTARTS} restarts in ${Math.round(WINDOW_MS / 60000)} min — auto-restart <b>DISABLED</b>, manual intervention needed.`);
    return { healthy: false, detail, restarted: false };
  }
  entry.attempts.push(now);
  const n = entry.attempts.length;
  try {
    await pm2Restart('dashboard', true);
    console.log(`[monitor] 🔄 dashboard not serving (${detail}) — auto-restarted (attempt ${n}/${MAX_RESTARTS})`);
    sendTelegram(`🔄 <b>dashboard</b> not serving (${detail}) — auto-restarted (attempt ${n}/${MAX_RESTARTS}).`);
  } catch (e) {
    console.error(`[monitor] dashboard restart FAILED (attempt ${n}/${MAX_RESTARTS}): ${e.message}`);
    sendTelegram(`⚠️ dashboard auto-restart FAILED (attempt ${n}/${MAX_RESTARTS})\n<code>${(e.message || '').slice(0, 200)}</code>`);
  }
  return { healthy: false, detail, restarted: true };
}

async function checkHealth() {
  const ts  = new Date().toISOString();
  const now = Date.now();

  // Fail-safe read of the shared heartbeat file. HB_FILE is a single JSON blob
  // written non-atomically by ~15 agents (truncate-then-write, no lock), so a
  // reader can catch it mid-write and get a partial/empty parse. If we treated
  // that as "every agent's heartbeat is missing", one bad read would mass-restart
  // the whole fleet (the 18:22 incident). So: if the file EXISTS with bytes on
  // disk but does not parse into a non-empty object, this is a transient bad read
  // — skip the cycle and restart NOTHING. A genuinely missing/empty (size 0) file
  // keeps the prior behavior. (Fix (a) only; the atomic-WRITE fix is a later commit.)
  const hbParsed = readJson(HB_FILE);
  const hbValid  = hbParsed !== null && typeof hbParsed === 'object'
                   && !Array.isArray(hbParsed) && Object.keys(hbParsed).length > 0;
  if (!hbValid) {
    let hbSize = 0;
    try { hbSize = fs.statSync(HB_FILE).size; } catch { hbSize = 0; }
    if (hbSize > 0) {
      // File has bytes on disk but parsed empty/unparseable → partial read.
      // Skip staleness evaluation entirely; restart nothing this cycle.
      console.warn(`[monitor] ${ts} | heartbeat file unreadable this cycle (${hbSize}B on disk, parsed empty/invalid) — SKIP, restarting nothing`);
      return;
    }
    // hbSize === 0 (missing or truly empty): fall through with existing behavior.
  }
  const hb = hbValid ? hbParsed : {};

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
    // ── DUE FORME DI BATTITO, UNA SOLA LETTURA ────────────────────────────────────────────────────
    // La maggior parte degli agent scrive un numero (l'epoch ms). Tre — agent27, agent28, agent29 —
    // scrivono invece un OGGETTO `{ ts, …contatori }`. Qui si faceva `now - lastBeat` sul valore
    // grezzo: con l'oggetto il risultato è NaN, e la riga sotto (`beatAge > staleMs`) su NaN è FALSA,
    // quindi quell'agent non sarebbe MAI risultato stantio. Una sorveglianza che non può accorgersi
    // di niente è peggio di nessuna sorveglianza, perché sullo schermo si legge «✓».
    // Trovato il 6 agosto 2026 rimettendo agent27 sotto sorveglianza dopo la correzione del news-guard.
    const beatRaw = heartbeatRequired ? (hb[hbKey] ?? null) : null;
    const lastBeat = typeof beatRaw === 'number' ? beatRaw
      : (beatRaw && typeof beatRaw === 'object' && Number.isFinite(beatRaw.ts) ? beatRaw.ts : null);
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

  // Rule 58/59: active dashboard liveness + build-integrity probe (auto-restart on
  // non-200, guarded by the same breaker; alert-only on a corrupt/missing build).
  const ledgerDirtyRef = { v: ledgerDirty };
  let dashboardHttp = null;
  try {
    dashboardHttp = await checkDashboardIntegrity(now, ledgerDirtyRef, alerted);
  } catch (e) {
    console.error('[monitor] dashboard integrity probe error:', e.message);
  }
  ledgerDirty = ledgerDirtyRef.v;

  if (ledgerDirty) atomicWriteJson(LEDGER_FILE, ledger);

  const allHealthy = agentStatuses.every(a => a.healthy) && (dashboardHttp ? dashboardHttp.healthy : true);

  // Write monitor status for /api/health
  writeJson(STATUS_OUT, {
    checkedAt:     ts,
    allHealthy,
    agentStatuses,
    dashboardHttp,   // rule 58/59 — { healthy, detail, restarted }
  });

  // Send Telegram alerts for unhealthy agents. The dashboard HTTP/build probes
  // (dashboard-http / dashboard-build) already sent their OWN detailed alert inside
  // checkDashboardIntegrity — exclude them here so they don't double-fire.
  const summaryAlerts = alerted.filter(name => agentStatuses.some(a => a.name === name));
  if (summaryAlerts.length) {
    const lines = summaryAlerts.map(name => {
      const s = agentStatuses.find(a => a.name === name);
      return `• <b>${name}</b>: ${s?.pm2status ?? 'unknown'}${s?.beatAgeSeconds ? ` (last beat ${Math.round(s.beatAgeSeconds / 60)}m ago)` : ''}`;
    });
    sendTelegram(`🚨 <b>AGENT MONITOR ALERT</b>\n${summaryAlerts.length} agent(s) down:\n${lines.join('\n')}\n\nCheck: <code>pm2 list</code>`);
  }

  const healthStr = agentStatuses.map(a => `${a.name}:${a.healthy ? '✓' : '✗'}`).join(' | ');
  console.log(`[monitor] ${ts} | ${allHealthy ? 'ALL OK' : 'PROBLEMS'} | ${healthStr}`);
}

async function tick() {
  try { await checkHealth(); } catch (e) { console.error('[monitor] crash:', e.message); }
  setTimeout(tick, INTERVAL_MS);
}

tick();
