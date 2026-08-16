import { NextResponse } from 'next/server';
import { GET as carryGET } from '../route';

export const dynamic = 'force-dynamic';

/**
 * /api/carry/[id] — one basis row, shaped for the position calculator.
 *
 * This route deliberately owns NO math and NO data access. It calls the parent
 * /api/carry handler and picks a row out of its already-assembled response, so the
 * expired-instrument filter, display-sanity net, source-of-truth verifier, guardian
 * suppression AND the free-tier redaction all apply exactly once, in one place. A
 * second pipeline here could disagree with the list the user just tapped — which is
 * precisely the split-brain the honest engine exists to prevent.
 *
 * id format is `<venueKey>-<contract>`, matching the existing detail route: venueKey
 * never contains a dash (BYBIT/OKX/DERIBIT/COINM/USDTM), while the contract keeps its
 * own dashes and underscores (BTC-USD-270326, BTCUSDT-25JUN27, BTCUSD_260925), so the
 * split is on the FIRST dash only.
 */
export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const id = decodeURIComponent(params.id ?? '');
  const dash = id.indexOf('-');
  const venueKey = dash >= 0 ? id.slice(0, dash) : id;
  const contract = dash >= 0 ? id.slice(dash + 1) : '';

  if (!venueKey || !contract) {
    return NextResponse.json({ error: 'bad id — expected <venueKey>-<contract>', id }, { status: 400 });
  }

  const parent = await carryGET();
  const body: any = await parent.json();

  const card = (body.basisCards ?? []).find((c: any) => c.id === `${venueKey}|${contract}`) ?? null;

  if (!card) {
    // A row can legitimately disappear between list and tap: the instrument expired, or
    // the guardian suppressed it. Say which, rather than rendering a blank calculator.
    return NextResponse.json(
      {
        error: 'row not found — it may have expired or been suppressed since the list was rendered',
        id, venueKey, contract,
        updatedAt: body.updatedAt ?? null,
      },
      { status: 404 },
    );
  }

  return NextResponse.json({
    updatedAt:  body.updatedAt ?? null,
    agentStatus: body.agentStatus ?? null,
    isPaid:     body.isPaid ?? false,
    carryMeta:  body.carryMeta ?? null,
    card,
  });
}
