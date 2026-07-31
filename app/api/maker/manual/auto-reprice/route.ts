import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  readAutoRepriceConfig, isAutoRepriceEnabled, setAutoReprice,
  readAutoRepriceState, loadAutoRepriceTuning,
} from '@/lib/maker/auto-reprice-config';
import { resolveManualTtlSeconds } from '@/lib/maker/manual-order';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/maker/manual/auto-reprice — the ON/OFF control for AUTOMATIC BAND-EXIT RE-PRICING.
 *
 * GET  ?marketId=…  → is the automatism on here, is the master switch on, what lifetime would a new hand
 *                     order get right now (GTC vs the fixed 180s GTD), when did the watcher last move
 *                     something, and IS THE WATCHER ALIVE.
 * POST { scope:'global'|'market', marketId?, enabled:boolean, reason? } → flip a switch.
 *
 * WHAT IT SWITCHES, stated plainly because this is the only control in the manual lane that makes
 * something happen WITHOUT a human pressing a button:
 *   OFF (the default everywhere) — a hand order carries the fixed ~180s GTD expiry it always did. The
 *   venue kills it on a clock. Nothing moves by itself, ever.
 *   ON — a hand order on this market carries a 15-minute GTD expiry which agent40-manual-reprice RENEWS
 *   proactively with 3 minutes still on it (~5 renewals/hour), and re-prices EARLY whenever the live mid
 *   has travelled far enough to push the order out of the reward band. Time never kills a healthy order;
 *   the expiry exists so that if this host stops, the EXCHANGE retires the order within 15 minutes with
 *   no second supervisor required. Both triggers share one mechanism, so they cannot double-fire.
 *
 * THIS IS NOT AN ARMING CONTROL AND ADDS NO AUTHORITY. The automatism reaches the venue only through
 * lib/maker/manual-order.replaceManualOrder — the SAME function the panel's own "Riprezza" button calls —
 * so the whole gate chain still applies to every automatic move: manual ownership, the shared venue-rules
 * guard, the per-order cap, the global kill switch, the adapter's own chain, and the exchange's
 * validateOrder(). MANUAL_ORDER_PLACEMENT still governs whether anything is actually sent: with it on
 * dry-run, an automatic re-price builds, signs and validates the replacement and sends nothing.
 *
 * BOTH switches must be on. `global` is the master (one flip stops every market); `market` is the
 * per-market opt-in. Turning the automatism ON is refused while the config file is unreadable; turning
 * it OFF is always permitted — the direction that can only reduce activity must never be blocked.
 *
 * Admin-gated by middleware (ADMIN_ACCESS_SECRET).
 */
export async function GET(req: NextRequest) {
  const marketId = req.nextUrl.searchParams.get('marketId');
  try {
    const cfg = readAutoRepriceConfig();
    const state = readAutoRepriceState();
    const tuning = loadAutoRepriceTuning();
    const market = marketId ? isAutoRepriceEnabled(marketId) : null;
    const last = marketId ? (state.markets[marketId.toLowerCase()] || null) : null;

    return NextResponse.json({
      at: new Date().toISOString(),
      readable: cfg.readable,
      error: cfg.error,
      globalEnabled: cfg.globalEnabled,
      optedInMarketIds: cfg.optedInMarketIds || [],
      enabledMarketIds: cfg.enabledMarketIds || [],
      market: market ? {
        marketId,
        enabled: market.enabled,
        marketEnabled: market.marketEnabled,
        globalEnabled: market.globalEnabled,
        readable: market.readable,
        reason: market.reason,
        record: market.record,
        // What a NEW hand order here would get right now — read back from the placement path's own
        // resolver, so this can never drift from what actually gets signed.
        expiry: resolveManualTtlSeconds({ marketId }),
      } : null,
      // The watcher's proof of life. This matters MORE when the automatism is on: GTC orders have no
      // venue expiry, so a dead watcher means an unattended order resting indefinitely. `alive:null`
      // means "never seen it run", which is not the same as "it is fine".
      watcher: {
        readable: state.readable,
        error: state.error,
        heartbeatAt: state.heartbeatAt,
        heartbeatAgeSec: state.heartbeatAgeSec,
        alive: state.heartbeatAgeSec == null ? null : state.heartbeatAgeSec <= 60,
        cycles: state.cycles,
        process: 'agent40-manual-reprice',
      },
      last,
      tuning,
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

  const res = setAutoReprice({
    scope,
    marketId: scope === 'market' ? marketId : null,
    enabled: body.enabled,
    by: 'operator · manual-orders panel',
    reason,
  });
  // 409, not 400: the request was well formed — the STATE refused it (the config is unreadable, so
  // enabling an automatism over it would be arming something blind). `res` carries ok:false + the reason.
  if (!res.ok) return NextResponse.json(res, { status: 409 });

  return NextResponse.json({
    ...res,
    // Stated plainly so nobody reads this as an arming action, and so the GTC trade-off is never silent.
    note: body.enabled
      ? (scope === 'global'
        ? 'Master switch dell\'auto-riprezzo ACCESO. Da solo non fa nulla: agiscono solo i mercati esplicitamente abilitati. Restano in vigore kill-switch, cap, gestione manuale, venue-rules e validateOrder; MANUAL_ORDER_PLACEMENT decide ancora se qualcosa viene davvero inviato.'
        : 'Auto-riprezzo ACCESO su questo mercato. I NUOVI ordini manuali qui porteranno una scadenza GTD di 15 minuti che il watcher rinnova da solo quando ne mancano 3 (~5 rinnovi/ora), e verranno ripiazzati prima se il mid li porta fuori banda. Gli ordini GIÀ a riposo mantengono la scadenza con cui sono stati piazzati finché non vengono rinnovati o ripiazzati. La scadenza È il dead-man\'s switch: se questa macchina si ferma, nessuno rinnova e il venue ritira da solo ogni ordine entro 15 minuti — nessun sistema esterno di sorveglianza serve perché accada.')
      : (scope === 'global'
        ? 'Master switch dell\'auto-riprezzo SPENTO: nessun mercato viene più toccato automaticamente. Le opt-in per mercato restano memorizzate ma inerti. I nuovi ordini manuali tornano alla scadenza fissa GTD di 180s.'
        : 'Auto-riprezzo SPENTO su questo mercato: nessun riprezzo automatico. I nuovi ordini manuali qui tornano alla scadenza fissa GTD di 180s, cioè il comportamento di prima.'),
    bindsWithinSec: Math.round(loadAutoRepriceTuning().pollMs / 1000),
  });
}
