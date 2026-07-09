import { NextResponse } from 'next/server';
import fs from 'fs';
import { getGuardianHealth } from '@/lib/guardian-health';

const MONITOR_FILE  = '/tmp/monitor-status.json';
const HB_FILE       = '/tmp/agent-heartbeats.json';
const STALE_MS      = 10 * 60 * 1000;

interface AgentStatus {
  name:           string;
  healthy:        boolean;
  pm2status:      string;
  pm2uptime:      number | null;
  lastBeat:       number | null;
  beatAgeSeconds: number | null;
}

interface MonitorStatus {
  checkedAt:     string;
  allHealthy:    boolean;
  agentStatuses: AgentStatus[];
}

export async function GET() {
  const now = Date.now();

  let monitor: MonitorStatus | null = null;
  try { monitor = JSON.parse(fs.readFileSync(MONITOR_FILE, 'utf8')); } catch {}

  let heartbeats: Record<string, number> = {};
  try { heartbeats = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}

  // Summarise heartbeats directly (fallback if monitor agent hasn't run yet)
  const hbSummary = Object.entries(heartbeats).map(([name, ts]) => ({
    name,
    lastBeat:       ts,
    beatAgeSeconds: Math.round((now - ts) / 1000),
    stale:          now - ts > STALE_MS,
  }));

  const monitorAge = monitor?.checkedAt ? Math.round((now - new Date(monitor.checkedAt).getTime()) / 1000) : null;

  // Guardian robustness/uptime report (rules 51–74): freshness banner, watchdog view,
  // build integrity, guardian self-checks. Read-only; never throws on the serve path.
  let guardian = null;
  try { guardian = getGuardianHealth(now); } catch { guardian = null; }

  return NextResponse.json({
    ok:             monitor?.allHealthy ?? null,
    monitorAge,
    monitor:        monitor ?? null,
    heartbeats:     hbSummary,
    guardian,
    serverTime:     new Date().toISOString(),
  });
}
