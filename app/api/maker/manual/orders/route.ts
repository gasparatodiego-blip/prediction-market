import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { listManualOrders } from '@/lib/maker/manual-order';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/maker/manual/orders?marketId=… — the operator's RESTING orders, read from the VENUE.
 *
 * Venue truth, not local belief: it calls getOpenOrders through the CANCEL-ONLY adapter (address-only
 * signer — it holds no signing key and structurally cannot place), so listing orders never decrypts the
 * signing key and this endpoint can never start one.
 *
 * HONESTY AT THE BOUNDARY. When no Polymarket L2 credential is stored the adapter is dry-run: it returns
 * an empty list flagged `simulated:true`, which means "we did not reach the venue" — NOT "you have no
 * orders". The panel renders that distinction rather than showing an empty table as a fact. A failed read
 * is reported as a failure with its error, never as zero orders.
 *
 * Each row carries `source`, resolved from the append-only audit trail: an order whose id the panel
 * recorded reads 'manual-ui'; anything else reads 'agent35' (or 'unknown' when the panel has never
 * placed anything, so there is no evidence either way).
 */
export async function GET(req: NextRequest) {
  const marketId = req.nextUrl.searchParams.get('marketId');
  try {
    const res = await listManualOrders({ marketId: marketId || null });
    return NextResponse.json(res, { status: res.ok ? 200 : 502 });
  } catch (e) {
    return NextResponse.json(
      { ok: false, at: new Date().toISOString(), error: (e as Error).message, orders: [], count: 0 },
      { status: 500 },
    );
  }
}
