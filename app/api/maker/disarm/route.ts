import { NextResponse } from 'next/server';
import { disarm } from '@/lib/maker/arming';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/maker/disarm — clear the arming record (reason audited). Admin-gated (middleware). This does not
// cancel orders (that is the KILL) — it withdraws the authorization so the next agent35 cycle stops quoting.
export async function POST() {
  const res = disarm('manual · liquidity-rewards tab');
  return NextResponse.json(res);
}
