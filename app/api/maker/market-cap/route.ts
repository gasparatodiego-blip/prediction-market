import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import fs from 'fs';
import { getMarketCap, setMarketCap, clearMarketCap, MAX_CAP_USD } from '@/lib/maker/market-caps-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/maker/market-cap?marketId=… — the operator's PER-MARKET collateral ceiling.
 *
 * GET  → the ceiling in force for one market, with its source (per-market | fallback | unset |
 *        unreadable) and the env rail it would fall back to.
 * POST → set it. { marketId, capUsd }. A cap of exactly 0 is legal and means "commit nothing here".
 * DELETE → clear it (back to the env rail fallback).
 *
 * Admin-gated by middleware, like everything under /api/maker.
 *
 * THIS ENDPOINT ARMS NOTHING. Writing a ceiling does not enable placement, does not touch MAKER_MODE or
 * MAKER_FUNDING_APPROVED, and does not create an arming record. It only lowers what the engine would be
 * permitted to commit on one market — the safe direction is always available.
 *
 * The value is read back by agent35 EVERY cycle (lib/maker/market-caps-store.getMarketCap), so a change
 * here binds on the next tick without a restart.
 */

/**
 * The env rail that applies when the operator has set no per-market ceiling.
 *
 * Read from the ENGINE's published state, not from this process's environment: the dashboard runs under
 * a different pm2 env, and the number that matters is the one agent35 will actually enforce (it writes
 * config.rails.perMarketNotionalCapUsd every cycle from its own lib/maker/config). Unreadable ⇒ null,
 * so the client renders "—" instead of a rail we did not read. lib/maker/config is deliberately NOT
 * imported here — it pulls in the CLOB v2 SDK, which has no business in a dashboard route.
 */
function railFallbackUsd(): number | null {
  try {
    const st = JSON.parse(fs.readFileSync('/tmp/maker-state.json', 'utf8'));
    const v = st?.config?.rails?.perMarketNotionalCapUsd;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const marketId = req.nextUrl.searchParams.get('marketId');
  if (!marketId) return NextResponse.json({ error: 'marketId required' }, { status: 400 });
  const fallbackUsd = railFallbackUsd();
  const cap = getMarketCap(marketId, { fallbackUsd });
  return NextResponse.json({
    marketId,
    capUsd: cap.capUsd,
    source: cap.source,
    updatedAt: cap.updatedAt,
    updatedBy: cap.updatedBy,
    error: cap.error,
    fallbackUsd,
    maxCapUsd: MAX_CAP_USD,
    note: cap.source === 'unreadable'
      ? 'archivio dei tetti illeggibile — il motore non impegna nulla (fail closed)'
      : cap.source === 'fallback'
        ? 'nessun tetto impostato per questo mercato: vale il limite di rischio d\'ambiente'
        : null,
  });
}

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 }); }
  const marketId = typeof body?.marketId === 'string' ? body.marketId.trim() : '';
  if (!marketId) return NextResponse.json({ error: 'marketId required' }, { status: 400 });

  const r = setMarketCap(marketId, Number(body?.capUsd), 'operator');
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });

  const fallbackUsd = railFallbackUsd();
  return NextResponse.json({
    ok: true,
    ...getMarketCap(marketId, { fallbackUsd }),
    marketId,
    fallbackUsd,
    armed: false,
    note: 'tetto salvato. Non arma nulla: limita solo quanto il bot potrebbe impegnare su questo mercato. Vale dal prossimo ciclo del motore (nessun riavvio).',
  });
}

export async function DELETE(req: NextRequest) {
  const marketId = req.nextUrl.searchParams.get('marketId');
  if (!marketId) return NextResponse.json({ error: 'marketId required' }, { status: 400 });
  const r = clearMarketCap(marketId);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  const fallbackUsd = railFallbackUsd();
  return NextResponse.json({ ok: true, ...getMarketCap(marketId, { fallbackUsd }), marketId, fallbackUsd });
}
