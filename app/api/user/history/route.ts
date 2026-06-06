import { NextResponse } from 'next/server';
import { readFileSync } from 'fs';

const MASTER_LOG  = '/tmp/master-log.json';
const MASTER_OPPS = '/tmp/master-opportunities.json';
const ARB_FILE    = '/tmp/arbitrage-opportunities.json';

function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export async function GET() {
  const log  = readJson(MASTER_LOG) ?? [];
  const opps = readJson(MASTER_OPPS) ?? {};
  const arb  = readJson(ARB_FILE) ?? {};

  const history = Array.isArray(log) ? log.map((entry: any) => ({
    ts:          entry.ts,
    status:      entry.status,
    opps:        entry.opportunities ?? 0,
    avgConf:     entry.avg_confidence ?? null,
    best:        entry.best ?? null,
    alertsSent:  entry.alerts_sent ?? 0,
    fng:         entry.fng ?? null,
    matches:     entry.matches ?? 0,
    accuracy7d:  entry.accuracy_7d ?? null,
    sources:     entry.data_sources ?? [],
  })).slice(-200) : [];

  return NextResponse.json({
    history,
    totalScans:    history.filter((e: any) => e.status === 'success').length,
    totalOpps:     history.reduce((s: number, e: any) => s + (e.opps ?? 0), 0),
    totalAlerts:   history.reduce((s: number, e: any) => s + (e.alertsSent ?? 0), 0),
    lastScan:      history[history.length - 1]?.ts ?? null,
    currentOpps:   opps.opportunities ?? [],
    currentStats:  arb.stats ?? null,
  });
}
