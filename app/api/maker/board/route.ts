import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { buildMarketBoard, buildOrderBoard, buildSummary } from '@/lib/maker/operator-board';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/maker/board — everything the single-page liquidity-rewards console renders, except the
 * positions (which cost a venue round-trip and live at /api/maker/positions) and the pUSD balance
 * (already served, unchanged, by the public /api/rewards/balance).
 *
 * READ-ONLY. It reads two files the agents already write plus the venue's own open-order list through
 * the CANCEL-ONLY adapter. It holds no key, constructs no order, and cannot place, cancel, arm or kill.
 *
 * ONE READ, ONE VERDICT. The header's out-of-band count, the Riepilogo alert, the ladders' order dots and
 * the Regole table are all projections of the SAME `orders` array judged here once, against the SAME
 * shared band guard (lib/maker/venue-rules → lib/rewards-live-band). Two surfaces cannot disagree about
 * whether an order is earning, because there is only one judgement.
 *
 * POLYMARKET ONLY — Kalshi rows are dropped in the aggregation core, at the source.
 *
 * Admin-gated by middleware (everything under /api/maker rides the ADMIN_ACCESS_SECRET gate; the whole
 * lane 404s when no admin secret is configured). The console probes this route to decide whether to
 * render the operator sections at all.
 */
export async function GET() {
  try {
    // prisma is injected: the aggregation core reads the stored bot selection through it but never opens
    // a connection of its own. An unreadable selection leaves inBotUniverse null ("we don't know"), it
    // does NOT mark every market as outside the bot's set.
    const [board, orders] = await Promise.all([buildMarketBoard({ prisma }), buildOrderBoard()]);

    // Committed vs free capital is computed by the CLIENT against /api/rewards/balance, so the balance
    // keeps its single source and its own freshness stamp. Here we only publish what we measured.
    return NextResponse.json({
      at: new Date().toISOString(),
      markets: board.markets,
      marketCount: board.markets.length,
      feed: { generatedAt: board.generatedAt, polyGeneratedAt: board.polyGeneratedAt },
      selection: board.selection,
      selectionReadable: board.selectionReadable,
      orders,
      summary: buildSummary(board.markets, orders),
    });
  } catch (e) {
    return NextResponse.json(
      { at: new Date().toISOString(), error: (e as Error).message, markets: [], orders: null },
      { status: 500 },
    );
  }
}
