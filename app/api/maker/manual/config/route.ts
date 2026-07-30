import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
// All the policy lives in the CommonJS core so the selfcheck can exhaust it without a server.
import { manualContext } from '@/lib/maker/manual-order';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/maker/manual/config — everything the MANUAL ORDERS panel needs to render itself, with every
 * number read from its real source at request time. READ-ONLY: it places nothing, arms nothing, and
 * changes no state.
 *
 * Admin-gated by middleware (everything under /api/maker rides the ADMIN_ACCESS_SECRET gate, and the
 * whole lane 404s when no admin secret is configured). The panel probes THIS route to decide whether to
 * render at all, so a non-admin visitor sees nothing.
 *
 * What it answers, and where each answer comes from:
 *   kill       → data/safety-kill-switch.json, re-read now (the banner is live state, never a constant)
 *   placement  → MANUAL_ORDER_PLACEMENT, the panel's OWN send switch (default dry-run, independent of
 *                the engine's MAKER_PLACEMENT — neither switch can arm the other by side effect)
 *   caps       → data/safety-risk-limits.json through lib/safety/risk-limits (clamped to the hard
 *                ceilings), plus the adapter's live-min cap; the form shows the MINIMUM of the two
 *   engine     → /tmp/maker-state.json (agent35's own published state) with its age
 *   isolation  → data/maker-manual-mode.json AND the engine's acknowledgement of it
 *   market     → agent34's live book + the normalized board row: tick, scoring mid, band, min size,
 *                both token ids, negRisk. Any missing piece leaves readable:false and the form refuses.
 */
export async function GET(req: NextRequest) {
  const marketId = req.nextUrl.searchParams.get('marketId');
  try {
    return NextResponse.json(manualContext({ marketId: marketId || null }));
  } catch (e) {
    return NextResponse.json(
      { at: new Date().toISOString(), error: (e as Error).message },
      { status: 500 },
    );
  }
}
