import { NextResponse } from 'next/server';
import fs from 'fs';

const LOG_FILE = '/tmp/master-log.json';
const ARB_FILE = '/tmp/arbitrage-opportunities.json';

export async function GET() {
  let log: any[] = [];
  try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch {}
  if (!Array.isArray(log)) log = [];

  const successLogs = log.filter(e => e.status === 'success');

  // Opportunities per day (last 14 days)
  const dayMap: Record<string, number> = {};
  const roiMap: Record<string, number[]> = {};
  const now = Date.now();
  for (const entry of successLogs) {
    const d = new Date(entry.ts);
    if (now - d.getTime() > 14 * 86_400_000) continue;
    const key = d.toISOString().slice(0, 10);
    dayMap[key] = (dayMap[key] ?? 0) + (entry.opportunities ?? 0);
    if (entry.avg_confidence) {
      if (!roiMap[key]) roiMap[key] = [];
      roiMap[key].push(entry.avg_confidence);
    }
  }

  const labels = Object.keys(dayMap).sort();
  const oppsByDay  = labels.map(k => dayMap[k]);
  const confByDay  = labels.map(k => roiMap[k] ? Math.round(roiMap[k].reduce((a, b) => a + b, 0) / roiMap[k].length) : 0);

  // All-time stats
  const totalScans  = successLogs.length;
  const totalOpps   = successLogs.reduce((s, e) => s + (e.opportunities ?? 0), 0);
  const avgConfAll  = successLogs.length
    ? Math.round(successLogs.reduce((s, e) => s + (e.avg_confidence ?? 0), 0) / successLogs.length)
    : 0;
  const totalAlerts = successLogs.reduce((s, e) => s + (e.alerts_sent ?? 0), 0);
  const bestConf    = successLogs.reduce((best, e) => Math.max(best, e.best?.confidence ?? 0), 0);

  // Current arb data
  let currentBestRoi = 0;
  try {
    const arb = JSON.parse(fs.readFileSync(ARB_FILE, 'utf8'));
    currentBestRoi = arb?.stats?.bestRoi ?? 0;
  } catch {}

  return NextResponse.json({
    charts: { labels, oppsByDay, confByDay },
    stats: {
      totalScans,
      totalOpps,
      avgConfAll,
      totalAlerts,
      bestConf,
      currentBestRoi,
    },
  });
}
