import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { readManualMode, isManualMarket, setManualMode } from '@/lib/maker/manual-mode';
import { readEngineState } from '@/lib/maker/manual-order';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/maker/manual/mode — the PER-MARKET manual-ownership flag.
 *
 * GET  ?marketId=…  → is this market held by hand, since when, by whom, and has the ENGINE acknowledged
 *                     it (read back from /tmp/maker-state.json, so the answer is the engine's, not ours).
 * POST { marketId, manual:boolean, reason? } → take the market by hand, or hand it back.
 *
 * THIS IS NOT THE KILL SWITCH. It touches no kill state, disarms nothing, and stops the engine nowhere
 * except on the one market named. The global kill remains the control that stops everything.
 *
 * Taking a market MANUAL is the safe direction and always succeeds. Handing it BACK is refused while the
 * ownership file is unreadable — re-enabling the engine on the strength of a state we cannot read is the
 * one move here that could put two writers on one market.
 *
 * The engine re-reads this every cycle (~3s), so a change binds without a restart.
 */
export async function GET(req: NextRequest) {
  const marketId = req.nextUrl.searchParams.get('marketId');
  const engine = readEngineState();
  const all = readManualMode();
  if (!marketId) {
    return NextResponse.json({
      at: new Date().toISOString(),
      readable: all.readable,
      error: all.error,
      manualMarketIds: all.marketIds,
      markets: all.markets,
      engineAcknowledged: engine.fresh ? engine.manualMarketIds : null,
      engineFresh: engine.fresh,
      stateFile: all.stateFile,
    });
  }
  const m = isManualMarket(marketId);
  return NextResponse.json({
    at: new Date().toISOString(),
    marketId,
    manual: m.manual,
    readable: m.readable,
    error: m.error,
    reason: m.reason,
    record: m.record,
    // The ENGINE's own view. null when its state is stale — "we do not know whether the engine has seen
    // this yet" is a different fact from "the engine has not seen it".
    engineAcknowledged: engine.fresh ? engine.manualMarketIds.includes(marketId.toLowerCase()) : null,
    engineFresh: engine.fresh,
    engineAgeSec: engine.ageSec,
  });
}

export async function POST(req: NextRequest) {
  let body: { marketId?: unknown; manual?: unknown; reason?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }); }

  const marketId = typeof body.marketId === 'string' ? body.marketId.trim() : '';
  if (!marketId) return NextResponse.json({ error: 'marketId required' }, { status: 400 });
  if (typeof body.manual !== 'boolean') return NextResponse.json({ error: 'manual must be a boolean' }, { status: 400 });
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : null;

  const res = setManualMode({
    marketId,
    manual: body.manual,
    by: 'operator · manual-orders panel',
    reason,
  });
  // 409, not 400: the request was well formed — the state refused it (ownership unreadable, so handing
  // the market back to the engine would arm it blind). `res` already carries ok:false and the reason.
  if (!res.ok) return NextResponse.json(res, { status: 409 });

  return NextResponse.json({
    ...res,
    // Stated plainly so nobody reads this as an arming action.
    note: body.manual
      ? 'Mercato preso in gestione manuale. agent35 non piazzerà e non cancellerà più nulla QUI dal prossimo ciclo (~3s). Nessun altro mercato è toccato, il kill-switch globale è invariato e questo non arma niente.'
      : 'Mercato restituito al motore automatico. agent35 tornerà a quotarlo secondo le sue normali regole (che restano tutte in vigore: kill-switch, arming, cap, MAKER_MODE).',
    engineBindsWithinSec: 3,
  });
}
