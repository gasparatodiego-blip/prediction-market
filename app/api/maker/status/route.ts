import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Read-only status for the kill-switch page: heartbeat age, MAKER_MODE, last-heartbeat open order count,
// and the watchdog's last-trigger timestamp. Everything unknown is null → the client renders "—", never a
// fabricated zero. Middleware gates this to an authenticated admin session.

function readJson(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function GET() {
  const now = Date.now();
  const hb = readJson(path.join(process.cwd(), 'data', 'maker-heartbeat.json'));
  const wd = readJson(path.join(process.cwd(), 'data', 'maker-watchdog-state.json'));

  const hbTs = hb && typeof hb.ts === 'number' ? (hb.ts as number) : null;
  const lastTriggerTs = wd && typeof wd.lastTriggerTs === 'number' ? (wd.lastTriggerTs as number) : null;

  return NextResponse.json({
    at: new Date(now).toISOString(),
    deadmanSeconds: Number(process.env.MAKER_DEADMAN_SECONDS || 120),
    heartbeat: hb
      ? {
          ageSec: hbTs != null ? Math.round((now - hbTs) / 1000) : null,
          cycle: typeof hb.cycle === 'number' ? hb.cycle : null,
          mode: typeof hb.mode === 'string' ? hb.mode : null,
          openOrderCount: typeof hb.openOrderCount === 'number' ? hb.openOrderCount : null,
          lastError: typeof hb.lastError === 'string' ? hb.lastError : null,
        }
      : null,
    watchdog: wd
      ? {
          lastTriggerTs,
          lastTriggerIso: lastTriggerTs != null ? new Date(lastTriggerTs).toISOString() : null,
          lastStalenessSec: typeof wd.lastStalenessSec === 'number' ? wd.lastStalenessSec : null,
          triggeredForEpisode: !!wd.triggeredForEpisode,
        }
      : null,
  });
}
