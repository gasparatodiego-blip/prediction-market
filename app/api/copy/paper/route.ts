import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';

export const dynamic = 'force-dynamic';

const PAPER_FILE = path.join(process.cwd(), 'data/paper-positions.json');
const STALE_MS   = 15 * 60_000;   // agent21 cycles every 5 min

// Live paper-trading positions + PnL for the authed user's copy configs. These are
// SIMULATED (paper) numbers driven by real copied fills — never real orders. Only
// the caller's own configs are returned. No redaction: it's the user's own sim.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = session.user.id;

  let raw: any = null;
  try { raw = JSON.parse(fs.readFileSync(PAPER_FILE, 'utf8')); }
  catch {
    return NextResponse.json({ ok: true, mode: 'paper', liveExecution: false, configs: [], warmingUp: true });
  }

  const age  = Date.now() - new Date(raw.updatedAt ?? 0).getTime();

  // Overlay any PENDING user close-overrides so the UI reflects a queued close
  // immediately (before the engine applies it on its next cycle). Best-effort — a DB
  // hiccup never blocks the read; positions just show without the pending flag.
  const pendingByPos = new Map<string, number>();
  try {
    const pend = await prisma.copyCloseOverride.findMany({ where: { userId, status: 'pending' } });
    for (const o of pend) pendingByPos.set(o.positionId, Math.max(pendingByPos.get(o.positionId) ?? 0, o.closePercent));
  } catch { /* overlay is best-effort */ }

  const mine = Object.values(raw.configs ?? {})
    .filter((c: any) => c.userId === userId)
    .map((c: any) => ({
      walletAddr:     c.walletAddr,
      categories:     c.categories ?? [],
      pctPerOrder:    c.pctPerOrder,
      exitMode:       c.exitMode,
      realizedPnl:    c.realizedPnl ?? 0,
      unrealizedPnl:  c.unrealizedPnl ?? null,   // null = not markable (never guessed)
      openPositions:  c.openPositions ?? Object.keys(c.positions ?? {}).length,
      markedPositions: c.markedPositions ?? 0,
      positions: Object.values(c.positions ?? {}).map((p: any) => {
        // Stable positionId the manual-close override endpoint consumes.
        const id = `${c.userId}|${(c.walletAddr ?? '').toLowerCase()}::${p.cid}|${p.outcome}`;
        const pendingClosePct = pendingByPos.get(id) ?? null;
        return {
          id, cid: p.cid ?? null,
          market: p.market, outcome: p.outcome, category: p.category,
          shares: Math.round((p.shares ?? 0) * 100) / 100,
          entryAvg: p.entryAvg, openedAt: p.openedAt,
          origin: 'copy_auto',                         // engine-owned lane tag (mirror of the manual lane's source)
          pendingClosePct,                             // 1–100 if a manual close is queued, else null
          updatedAt: raw.updatedAt ?? null,            // per-row live-sync timestamp
        };
      }),
      closed: (c.closed ?? []).slice(0, 20),
    }));

  return NextResponse.json({
    ok: true, mode: 'paper', liveExecution: false,
    updatedAt: raw.updatedAt ?? null, stale: age > STALE_MS,
    configs: mine,
  });
}
