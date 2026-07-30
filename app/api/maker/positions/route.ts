import { NextResponse } from 'next/server';
import { buildPositions } from '@/lib/maker/operator-board';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/maker/positions — the operator's OPEN positions, grouped by market, with net YES−NO exposure.
 *
 * READ-ONLY FROM THE VENUE. Polymarket's own data-api is the source, walked through the shared helper
 * (lib/open-positions-fetch) that the trader feed uses — `redeemable=false&sizeThreshold=0`, paginated,
 * so small and long-tail holdings are not silently dropped the way a default /positions call drops them.
 * No key is read, nothing is signed, nothing on-chain is written.
 *
 * NET, NOT DOUBLE-COUNTED. A market holding a YES leg and a NO leg is ONE exposure: netShares = YES − NO.
 * Both legs stay visible underneath so the operator can see what nets against what. A leg whose outcome
 * index the venue did not carry is kept and FLAGGED rather than assigned a side — an invented side would
 * flip the sign of the net.
 *
 * FAIL HONEST. An unreachable data-api returns ok:false with the error and an empty list the UI renders
 * as "non lette", never as "nessuna posizione". Those are different facts.
 *
 * Admin-gated by middleware (ADMIN_ACCESS_SECRET).
 */
export async function GET() {
  try {
    const res = await buildPositions();
    return NextResponse.json(res, { status: res.ok ? 200 : 502 });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false, wallet: null, error: (e as Error).message,
        source: 'data-api.polymarket.com', at: new Date().toISOString(), markets: [], totals: null,
      },
      { status: 500 },
    );
  }
}
