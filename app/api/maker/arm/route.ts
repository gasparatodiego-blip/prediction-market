import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
// Arming state (durable, fail-closed) + the arming gate. No placement adapter is imported here — arming a
// RECORD cannot itself place an order; placement stays gated by MAKER_MODE + MAKER_FUNDING_APPROVED.
import { arm, readArming } from '@/lib/maker/arming';
import { runPreflight } from '@/lib/maker/preflight';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/maker/arm — current arming status (armed?, expiry countdown). Admin-gated (middleware).
export async function GET() {
  const a = readArming();
  return NextResponse.json({
    armed: a.armed, source: a.source, expiresInSec: a.expiresInSec,
    expiresAt: a.record?.expiresAt ?? null, armedAt: a.record?.armedAt ?? null,
    totalSizeUsd: a.record?.totalSizeUsd ?? null, ttlSeconds: a.record?.ttlSeconds ?? null,
    collateralCapUsd: a.record?.collateralCapUsd ?? null,
    universeMarketIds: a.record?.universeMarketIds ?? [],
  });
}

/**
 * POST /api/maker/arm — arm the maker. Runs the preflight FRESH here (never trusts a UI-cached verdict) and
 * refuses unless it is GO. Two-step: the body must echo the exact size (typedSizeConfirm). Every refusal and
 * every arm is audited. Arms a RECORD only — MAKER_MODE/MAKER_FUNDING_APPROVED still gate real placement.
 * Body: { totalSizeUsd, typedSizeConfirm, ttlSeconds?, collateralCapUsd?, perSideSizeUsd?, universeMarketIds? }
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    // Fresh preflight — real state at arm time, no override.
    const preflight = await runPreflight({ prisma, env: process.env });
    const res = arm(
      {
        totalSizeUsd: Number(body.totalSizeUsd),
        typedSizeConfirm: Number(body.typedSizeConfirm),
        ttlSeconds: body.ttlSeconds != null ? Number(body.ttlSeconds) : undefined,
        collateralCapUsd: body.collateralCapUsd != null ? Number(body.collateralCapUsd) : undefined,
        perSideSizeUsd: body.perSideSizeUsd != null ? Number(body.perSideSizeUsd) : undefined,
        universeMarketIds: Array.isArray(body.universeMarketIds) ? body.universeMarketIds : [],
        by: 'operator · liquidity-rewards tab',
      },
      { preflight },
    );
    return NextResponse.json({ ...res, preflight }, { status: res.ok ? 200 : 409 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
