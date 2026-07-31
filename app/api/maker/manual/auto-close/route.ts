import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  readAutoCloseConfig, isAutoCloseEnabled, setAutoClose, CLOSE_PROFIT_CENTS,
} from '@/lib/maker/auto-close-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/maker/manual/auto-close — the ON/OFF control for AUTOMATIC POSITION CLOSING.
 *
 * GET  ?marketId=… → is it on here, is the master on, and what profit target is configured.
 * POST { scope:'global'|'market', marketId?, enabled:boolean, reason? } → flip a switch.
 *
 * WHAT IT SWITCHES. OFF (the default everywhere) — a filled hand order becomes an open position and stays
 * there until the operator acts, exactly as today. ON — the moment the venue confirms a position with no
 * exit resting against it, a SELL of that same outcome token is placed at entry + the configured profit,
 * snapped up to the market's tick.
 *
 * CLOSING ON POLYMARKET MEANS SELLING THE TOKEN YOU HOLD, not buying the opposite outcome: "you give up an
 * outcome token and receive payment in return". Buying the opposite would build a complete set worth $1 at
 * resolution — a merge construct that ties up MORE capital rather than releasing it.
 *
 * IT ADDS NO AUTHORITY. The close is placed through lib/maker/manual-order.placeManualOrder, the same
 * function and the same gate chain as any hand order: manual ownership, the shared venue-rules guard, the
 * per-order cap, the global kill switch, the adapter's chain, and the exchange's validateOrder().
 * MANUAL_ORDER_PLACEMENT still governs whether anything is actually sent. The size sold is the size the
 * VENUE says is held — never inferred, so a naked short is not expressible on this path.
 *
 * Admin-gated by middleware (ADMIN_ACCESS_SECRET).
 */
export async function GET(req: NextRequest) {
  const marketId = req.nextUrl.searchParams.get('marketId');
  try {
    const cfg = readAutoCloseConfig();
    const market = marketId ? isAutoCloseEnabled(marketId) : null;
    return NextResponse.json({
      at: new Date().toISOString(),
      readable: cfg.readable,
      error: cfg.error,
      globalEnabled: cfg.globalEnabled,
      optedInMarketIds: cfg.optedInMarketIds,
      enabledMarketIds: cfg.enabledMarketIds,
      profitCents: CLOSE_PROFIT_CENTS,
      market: market ? { marketId, ...market } : null,
    });
  } catch (e) {
    return NextResponse.json({ at: new Date().toISOString(), error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: { scope?: unknown; marketId?: unknown; enabled?: unknown; reason?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }); }

  const scope = body.scope === 'global' ? 'global' : 'market';
  const marketId = typeof body.marketId === 'string' ? body.marketId.trim() : '';
  if (scope === 'market' && !marketId) return NextResponse.json({ error: 'marketId required for scope:market' }, { status: 400 });
  if (typeof body.enabled !== 'boolean') return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 });
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : null;

  const res = setAutoClose({
    scope, marketId: scope === 'market' ? marketId : null,
    enabled: body.enabled, by: 'operator · pannello ordini manuali', reason,
  });
  // 409, not 400: the request was well formed — the STATE refused it (enabling over an unreadable config).
  if (!res.ok) return NextResponse.json(res, { status: 409 });

  return NextResponse.json({
    ...res,
    note: body.enabled
      ? (scope === 'global'
        ? 'Interruttore generale della chiusura automatica ACCESO. Da solo non fa nulla: agiscono solo i mercati esplicitamente abilitati.'
        : `Chiusura automatica ACCESA su questo mercato. Quando una posizione risulta aperta e senza uscita a riposo, viene piazzata una VENDITA dello stesso token a carico + ${CLOSE_PROFIT_CENTS}c (arrotondato in su al tick). Passa dagli stessi gate di ogni altro ordine, e la size venduta e quella che il VENUE dice essere posseduta.`)
      : (scope === 'global'
        ? 'Interruttore generale SPENTO: nessuna chiusura automatica su nessun mercato. Le posizioni aperte restano aperte finche non intervieni tu.'
        : 'Chiusura automatica SPENTA su questo mercato: una posizione riempita resta aperta finche non intervieni tu.'),
  });
}
