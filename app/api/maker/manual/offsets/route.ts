import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { readOffsetConfig, resolveOffsetFor, validateOffset, setMarketOffset, defaultMinMoveCents } from '@/lib/maker/offset-config';
import { resolveMarketRules } from '@/lib/maker/manual-order';
import { readAutoRepriceConfig } from '@/lib/maker/auto-reprice-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/maker/manual/offsets — the TARGET DISTANCE FROM THE MID, per market and per side.
 *
 * GET  → one row per managed market: the resolved target distance for each side, where that value came
 *        from (an explicit setting, a remembered first observation, or the distance seen right now), the
 *        minimum movement that triggers a chase, and the reward band's radius as the HARD CEILING.
 * POST { marketId, book?, targetOffsetCents?, minMoveCents?, reason? } → set one market's values.
 *
 * The band radius is shown but NOT settable here: it is the venue's own max_incentive_spread, read from
 * the live feed. A target beyond it would configure a quote that cannot earn, so it is refused.
 *
 * Admin-gated by middleware (ADMIN_ACCESS_SECRET).
 */
function rowFor(marketId: string) {
  const rules = resolveMarketRules(marketId);
  const band = rules.readable ? rules.bandRadiusCents : null;
  const tick = rules.readable ? rules.tick : null;
  const yes = resolveOffsetFor({ marketId, book: 'yes', tick });
  const no = resolveOffsetFor({ marketId, book: 'no', tick });
  return {
    marketId,
    title: rules.title || null,
    readable: rules.readable,
    mid: rules.mid,
    tick,
    bandRadiusCents: band,
    defaultMinMoveCents: defaultMinMoveCents(tick),
    yes: { targetOffsetCents: yes.targetOffsetCents, source: yes.source },
    no: { targetOffsetCents: no.targetOffsetCents, source: no.source },
    minMoveCents: yes.minMoveCents,
  };
}

export async function GET(req: NextRequest) {
  try {
    const one = req.nextUrl.searchParams.get('marketId');
    const ar = readAutoRepriceConfig();
    const cfg = readOffsetConfig();
    const ids = one ? [one] : Array.from(new Set([...(ar.optedInMarketIds || []), ...Object.keys(cfg.markets || {})]));
    return NextResponse.json({
      at: new Date().toISOString(),
      readable: cfg.readable,
      error: cfg.error,
      rows: ids.map(rowFor),
    });
  } catch (e) {
    return NextResponse.json({ at: new Date().toISOString(), error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: { marketId?: unknown; book?: unknown; targetOffsetCents?: unknown; minMoveCents?: unknown; reason?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }); }

  const marketId = typeof body.marketId === 'string' ? body.marketId.trim() : '';
  if (!marketId) return NextResponse.json({ error: 'marketId obbligatorio' }, { status: 400 });
  const book = body.book === 'yes' || body.book === 'no' ? body.book : null;
  const target = body.targetOffsetCents === undefined || body.targetOffsetCents === null ? undefined : Number(body.targetOffsetCents);
  const minMove = body.minMoveCents === undefined || body.minMoveCents === null ? undefined : Number(body.minMoveCents);
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 300) : null;

  const rules = resolveMarketRules(marketId);
  if (!rules.readable) {
    return NextResponse.json({ error: `regole di venue non leggibili per questo mercato (mancano: ${rules.missing.join(', ')}) — non si configura una distanza contro una banda che non si può leggere` }, { status: 409 });
  }

  const v = validateOffset({
    targetOffsetCents: target === undefined ? null : target,
    minMoveCents: minMove === undefined ? null : minMove,
    bandRadiusCents: rules.bandRadiusCents,
    tick: rules.tick,
  });
  // 422: the request was well formed, the VALUES are not admissible against this market's real rules.
  if (!v.valid) return NextResponse.json({ ok: false, errors: v.errors }, { status: 422 });

  const res = setMarketOffset({
    marketId, book, targetOffsetCents: target, minMoveCents: minMove,
    by: 'operator · pannello ordini manuali', reason,
  });
  if (!res.ok) return NextResponse.json(res, { status: 409 });
  return NextResponse.json({ ...res, row: rowFor(marketId) });
}
