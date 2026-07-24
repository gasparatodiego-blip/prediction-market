import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { renew } from '@/lib/maker/arming';
import { runPreflight } from '@/lib/maker/preflight';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/maker/renew — the ONLY way to extend an arm, and it RE-RUNS the preflight fresh. If a check has
 * gone red since arming, renew DISARMS instead of extending (the safe direction). Admin-gated (middleware).
 * Body: { ttlSeconds? } (defaults to the record's own TTL, else 4h).
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const preflight = await runPreflight({ prisma, env: process.env });
    const res = renew({ ttlSeconds: body.ttlSeconds != null ? Number(body.ttlSeconds) : undefined }, { preflight });
    return NextResponse.json({ ...res, preflight }, { status: res.ok ? 200 : 409 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
