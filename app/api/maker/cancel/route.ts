import { NextResponse } from 'next/server';
// The cancel-only STOP primitive (address-only signer, structurally cannot place). We import ONLY this —
// never the maker placement adapter — so this endpoint can stop orders but never start one.
import { cancelAllOrders } from '@/lib/maker/cancel-all';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/maker/cancel — the manual kill switch.
 *
 * Middleware has already gated this to an authenticated admin session (ADMIN_ACCESS_SECRET); the whole
 * lane 404s if no admin secret is configured. We call the cancel path DIRECTLY — NOT through agent35 —
 * because the case where the operator needs this most is precisely when agent35 is unresponsive.
 *
 * Returns venue-reported figures only. A venue failure is reported as a failure (never a claimed
 * success), and partial success is reported as partial (HTTP 207). In the disarmed build cancelAllOrders
 * runs against a dry-run cancel adapter (no network, no creds) → honest "0 cancelled (dry-run/disarmed)".
 */
export async function POST() {
  try {
    const results = await cancelAllOrders();
    const anyFail = Array.isArray(results) && results.some((r: { ok: boolean }) => r.ok === false);
    return NextResponse.json(
      { ok: !anyFail, at: new Date().toISOString(), results },
      { status: anyFail ? 207 : 200 },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, at: new Date().toISOString(), error: (e as Error).message, results: [] },
      { status: 500 },
    );
  }
}
