#!/usr/bin/env node
'use strict';

const fs           = require('fs');
const { execSync } = require('child_process');

const STATUS_FILE = '/tmp/agent-status.json';
const HB_FILE     = '/tmp/agent-heartbeats.json';
const INTERVAL    = 30_000;

const MAX_AGE = {
  'fetcher':         150_000,   // 2.5× the 60s fetch interval
  'matcher-politics': 300_000,  // 3.3× the 90s interval
  'matcher-other':    300_000,
  'matcher-crypto':   350_000,  // 3.5× the 100s interval
  'calculator':       120_000,
  'ui-updater':        90_000,
};

const PM2_NAMES = {
  'fetcher':          'agent-fetcher',
  'matcher-politics': 'agent-matcher-politics',
  'matcher-other':    'agent-matcher-other',
  'matcher-crypto':   'agent-matcher-3',
  'calculator':       'agent-calculator',
  'ui-updater':       'agent-ui-updater',
};

function pm2Restart(name) {
  try {
    execSync(`pm2 restart ${name}`, { stdio: 'pipe' });
    console.log(`[orchestrator] restarted ${name}`);
    return true;
  } catch {
    console.error(`[orchestrator] failed to restart ${name}`);
    return false;
  }
}

function run() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}

  const now    = Date.now();
  const status = { updatedAt: now, agents: {} };

  for (const [key, pm2Name] of Object.entries(PM2_NAMES)) {
    const lastBeat = hb[key] || 0;
    const age      = now - lastBeat;
    const maxAge   = MAX_AGE[key];
    const alive    = lastBeat > 0 && age < maxAge;
    const neverRan = lastBeat === 0;

    status.agents[key] = {
      pm2Name,
      lastBeat:  lastBeat || null,
      ageMs:     lastBeat ? age : null,
      status:    neverRan ? 'starting' : alive ? 'alive' : 'stuck',
    };

    if (!alive && !neverRan) {
      console.log(`[orchestrator] ${key} stuck (${Math.round(age / 1000)}s since last beat) — restarting`);
      const restarted = pm2Restart(pm2Name);
      status.agents[key].restartedAt = restarted ? now : null;
    }
  }

  const aliveCount = Object.values(status.agents).filter(a => a.status === 'alive').length;
  const total      = Object.keys(PM2_NAMES).length;
  status.summary   = { aliveAgents: aliveCount, totalAgents: total, healthy: aliveCount === total };

  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  console.log(`[orchestrator] ${aliveCount}/${total} agents alive`);
}

run();
setInterval(run, INTERVAL);
