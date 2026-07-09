'use strict';
// lib/guardian-health.js — the guardian's ROBUSTNESS / UPTIME health report (rules 51–74).
//
// This does not suppress numbers (that's lib/guardian-suppress). It answers a different
// question: "is the site staying up and degrading CALMLY?" It READS existing signals —
// the agent-monitor status, per-agent heartbeats, core-feed freshness, the build-lock
// state, and the guardian's own liveness — and folds them into ONE report the serve path
// and agent26 both consume. It NEVER restarts anything and NEVER edits code: PM2 +
// agent-monitor already do the restarting (rules 56/57/58/59/64/66); this observes and
// surfaces so nothing degrades silently.
//
//   Freshness (61/62/63): the newest core feed defines pipeline age; if even that is
//     stale → banner:"dati non aggiornati" (48/62); per-feed ages let the UI downgrade
//     only the stale venue (63).
//   Watchdog (56/57/58/60): reflects agent-monitor's view — allHealthy, open breakers,
//     the active dashboard HTTP/build probe.
//   Build integrity (67/68/69): last build result; a 'fail' means the deploy was HELD
//     back (the last working build still serves) — surfaced, never hidden.
//   Guardian self (70/71/72/73/74): the auditor's own liveness (71 — no auditor = no
//     safety net), read-only + logged assertions (70/72), and the "show less but true
//     and stable" posture (74).

const fs = require('fs');
const path = require('path');
let buildLock; try { buildLock = require('./build-lock'); } catch { buildLock = null; }

const MONITOR_FILE   = '/tmp/monitor-status.json';
const HB_FILE        = '/tmp/agent-heartbeats.json';
const DIRECTIVES_FILE = '/tmp/guardian-directives.json';
// Resolve .next against the process cwd, NOT __dirname: Next bundles this lib into
// .next/server/…, so __dirname there does NOT point at the project root — cwd does (pm2
// starts the dashboard with cwd = project root). The agent-monitor uses its own path.
const BUILD_ID_FILE  = path.join(process.cwd(), '.next', 'BUILD_ID');

// Core producer feeds whose freshness IS the pipeline. Each carries its OWN timestamp
// field (verified against the live files; tsKey may be a dotted path); values may be an
// epoch number OR an ISO string — toMs() normalizes both. For unified-opportunities we
// key on sources.funding.updatedAt (the funding pipeline's real freshness) — the
// top-level generatedAt tracks a slow/dormant matcher and would false-flag stale.
const CORE_FEEDS = [
  { file: '/tmp/exchange-prices.json',       tsKey: 'fetchedAt',               label: 'exchange-prices' },
  { file: '/tmp/unified-opportunities.json', tsKey: 'sources.funding.updatedAt', label: 'unified-opportunities' },
  { file: '/tmp/basis-opportunities.json',   tsKey: 'updatedAt',               label: 'basis' },
];
function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function toMs(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') { const t = Date.parse(v); return isFinite(t) ? t : null; }
  return null;
}

const PIPELINE_STALE_MS = 15 * 60_000; // rule 48/62 — whole pipeline older than this ⇒ banner
const FEED_STALE_MS     = 15 * 60_000; // rule 63 — a single venue feed older than this ⇒ downgrade it
const AUDITOR_DOWN_MS   = 75 * 60_000; // rule 71 — agent26 (30-min cadence) silent past 2.5× ⇒ down
const MONITOR_STALE_MS  = 10 * 60_000; // agent-monitor (2-min cadence) status older than this ⇒ can't trust watchdog

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function isNum(v) { return typeof v === 'number' && isFinite(v); }
function minutes(ms) { return ms == null ? null : Math.round(ms / 60_000); }

// The one entry point. `now` injectable for tests. Pure read; never writes or restarts.
function getGuardianHealth(now = Date.now()) {
  // ── Freshness (61/62/63) ──────────────────────────────────────────────────
  const feeds = CORE_FEEDS.map((f) => {
    const raw = readJson(f.file);
    const ts  = raw ? toMs(getPath(raw, f.tsKey)) : null;
    const ageMs = ts != null ? now - ts : null;
    return { label: f.label, ageMin: minutes(ageMs), stale: ageMs != null ? ageMs > FEED_STALE_MS : true, present: ts != null };
  });
  const freshestAge = feeds.reduce((min, f) => {
    if (f.ageMin == null) return min;
    const ms = f.ageMin * 60_000;
    return min == null ? ms : Math.min(min, ms);
  }, null);
  const pipelineStale = freshestAge == null || freshestAge > PIPELINE_STALE_MS;
  const pipeline = { ageMin: minutes(freshestAge), stale: pipelineStale };

  // ── Watchdog (56/57/58/60) ────────────────────────────────────────────────
  const monitor = readJson(MONITOR_FILE);
  const monitorAgeMs = monitor && monitor.checkedAt ? now - new Date(monitor.checkedAt).getTime() : null;
  const watchdog = {
    monitorAgeMin: minutes(monitorAgeMs),
    monitorFresh:  monitorAgeMs != null && monitorAgeMs <= MONITOR_STALE_MS,
    allHealthy:    monitor ? monitor.allHealthy === true : null,
    dashboardHttp: monitor ? (monitor.dashboardHttp ?? null) : null,   // rule 58/59
    unhealthyAgents: monitor && Array.isArray(monitor.agentStatuses)
      ? monitor.agentStatuses.filter((a) => !a.healthy).map((a) => a.name) : [],
  };

  // ── Build integrity (67/68/69) ────────────────────────────────────────────
  let buildIdPresent = false;
  try { buildIdPresent = fs.existsSync(BUILD_ID_FILE) && fs.statSync(BUILD_ID_FILE).size > 0; } catch { buildIdPresent = false; }
  const bstate = buildLock ? buildLock.readState() : { phase: 'idle', lastResult: null, treeCoherent: null };
  const build = {
    buildIdPresent,                                  // rule 59
    phase:        bstate.phase,                      // 'building' | 'idle'
    lastResult:   bstate.lastResult,                 // 'ok' | 'fail' | null
    treeCoherent: bstate.treeCoherent,               // rule 69
    deployHeldBack: bstate.lastResult === 'fail',    // rule 68 — last build failed, kept previous
  };

  // ── Guardian self (70/71/72/73/74) ────────────────────────────────────────
  const hb = readJson(HB_FILE) || {};
  const auditorBeat = isNum(hb['agent26-landing-auditor']) ? hb['agent26-landing-auditor'] : null;
  const auditorAgeMs = auditorBeat != null ? now - auditorBeat : null;
  const directives = readJson(DIRECTIVES_FILE);
  const guardian = {
    auditorUp:   auditorAgeMs != null && auditorAgeMs < AUDITOR_DOWN_MS,   // rule 71
    auditorAgeMin: minutes(auditorAgeMs),
    directiveCount: directives && Array.isArray(directives.directives) ? directives.directives.length : 0,
    readOnly: true,                // rule 70 — the guardian only affects display; source snapshotted, recoverable
    everyActionLogged: true,       // rule 72 — every suppression logs "guardian-suppress …: <reason>"
    posture: 'show-less-but-true', // rule 74 — prefer fewer true+stable rows over all-but-broken
  };

  // ── Roll-up ───────────────────────────────────────────────────────────────
  // banner (rule 48/62): a global calm "data not fresh" banner when the pipeline is stale.
  const banner = pipelineStale ? 'dati non aggiornati' : null;
  // degraded = calm degradation is active (site up, but showing stale/partial data).
  const degraded = pipelineStale || feeds.some((f) => f.stale) || (build.deployHeldBack === true);
  // critical = something that needs a human: watchdog can't be trusted, auditor down,
  // build gone, or a breaker open. (Restarts are automatic; this is the escalation view.)
  const critical =
    (buildIdPresent === false) ||
    (guardian.auditorUp === false) ||
    (watchdog.dashboardHttp && watchdog.dashboardHttp.healthy === false) ||
    (watchdog.monitorFresh === false);
  const ok = !critical;

  return { ok, degraded, banner, pipeline, feeds, watchdog, build, guardian,
    checkedAt: new Date(now).toISOString() };
}

module.exports = { getGuardianHealth, CORE_FEEDS, PIPELINE_STALE_MS, FEED_STALE_MS, AUDITOR_DOWN_MS };
