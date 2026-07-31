import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { searchMarkets, rewardLabelFor } from '@/lib/maker/market-search';
import { readAutoRepriceConfig } from '@/lib/maker/auto-reprice-config';
import { readMarketCatalog } from '@/lib/maker/market-catalog';
import { minMinutesToClose } from '@/lib/maker/market-clock';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/maker/markets/search?q=…&limit=… — SEARCH POLYMARKET WITH NO REWARD FILTER.
 *
 * WHY IT EXISTS. Every market list in this project came from the reward board, and the reward board is
 * built with one filter: rewardsDailyRate > 0 (agents/agent24-liquidity-rewards.js). So markets paying no
 * liquidity reward were not merely absent from a dropdown — they were absent from the data, and therefore
 * unquotable. This route asks the venue directly and returns what it answers, reward or no reward.
 *
 * WHAT EVERY ROW CARRIES, so a manual choice is informed rather than blind:
 *   reward_daily_rate  the published $/day pot, or null ⇒ "NESSUN REWARD — solo trading direzionale"
 *   spread             the market's CURRENT book spread, in cents
 *   tick               the venue's minimum price increment (never assumed, null when unread)
 *   plus the close time and minutes-to-close, which decide the order's GTD window and whether the market
 *   is inside the no-new-orders threshold at all (lib/maker/market-clock.js).
 *
 * READ-ONLY AND AUTHORITY-FREE. Two public GETs against Gamma. Nothing is signed, written or enabled here:
 * appearing in this list does not make a market placeable — that needs the deliberate two-step enable
 * (POST /api/maker/markets/enable) plus every gate that already exists.
 *
 * Each row also reports what THIS system currently thinks of the market: `enabled` (on the live-min
 * allowlist) and `catalogued` (its venue metadata has been stored). Both are read locally, never inferred
 * from the venue's answer.
 *
 * Admin-gated by middleware (ADMIN_ACCESS_SECRET).
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q') || '';
  const limitRaw = req.nextUrl.searchParams.get('limit');
  const limit = limitRaw == null || limitRaw === '' ? 25 : Number(limitRaw);
  if (!Number.isFinite(limit) || limit <= 0) {
    return NextResponse.json({ ok: false, error: 'limit deve essere un numero positivo' }, { status: 400 });
  }

  try {
    const res = await searchMarkets({ q, limit });
    const cfg = readAutoRepriceConfig();
    const cat = readMarketCatalog();
    const enabled = new Set((cfg.enabledMarketIds || []).map((m: string) => m.toLowerCase()));
    const optedIn = new Set((cfg.optedInMarketIds || []).map((m: string) => m.toLowerCase()));
    const catalogued = new Set(Object.keys(cat.markets || {}));
    const minMinutes = minMinutesToClose();

    return NextResponse.json({
      ...res,
      at: new Date().toISOString(),
      minMinutesToClose: minMinutes,
      globalAutoRepriceEnabled: cfg.globalEnabled,
      markets: res.markets.map((m) => {
        const id = (m.marketId || '').toLowerCase();
        return {
          ...m,
          enabled: enabled.has(id),
          optedIn: optedIn.has(id),
          catalogued: catalogued.has(id),
          // The two facts that decide whether an order could be placed on this market RIGHT NOW, stated
          // per row so the list itself is the explanation and the operator never has to guess.
          tooCloseToClose: m.minutesToClose != null && m.minutesToClose < minMinutes,
          rewardLabel: rewardLabelFor(m),
        };
      }),
      note: 'Ricerca SENZA filtro sui reward: i mercati senza montepremi sono elencati come tutti gli altri, etichettati come tali. Questa route non abilita e non piazza nulla.',
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message, markets: [], count: 0 }, { status: 500 });
  }
}
