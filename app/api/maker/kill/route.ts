import { NextResponse } from 'next/server';
// The KILL: durably disarm the maker + cancel every resting order, entirely server-side. We import ONLY
// the kill module (which reaches the cancel-only path) — never the placement adapter — so this endpoint
// can STOP orders but structurally cannot start one.
import { killMaker } from '@/lib/maker/kill';
import { buildCancelCredsProviders } from '@/lib/maker/cancel-creds-provider';
import { disarm } from '@/lib/maker/arming';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/maker/kill — the one-tap kill switch for the liquidity-rewards tab.
 *
 * Middleware has already gated this to an authenticated admin session (ADMIN_ACCESS_SECRET). It runs
 * INSIDE the Edgeradar backend — the browser never talks to polymarket.com — so it works even when the
 * operator's ISP blocks polymarket.com and even when agent35 is unresponsive (the durable global kill is
 * set here, and the cancel sweep runs here, not through agent35).
 *
 * Fail-safe: with the maker off and nothing resting this is a safe no-op that still sets the durable kill
 * and runs a real (empty) cancel sweep. Returns venue-reported figures only; a partial failure is 207.
 */
export async function POST() {
  try {
    const credsProviders = await buildCancelCredsProviders();
    const res = await killMaker({
      by: 'operator · liquidity-rewards tab',
      reason: 'manual KILL from the liquidity-rewards tab',
      credsProviders,
      // KILL also withdraws the arming authorization, so a later MAKER_MODE flip cannot resume a stale arm.
      disarmArming: () => { disarm('kill-switch'); },
    });
    const anyFail =
      res.killed === false ||
      (Array.isArray(res.cancel) && res.cancel.some((r: { ok: boolean }) => r.ok === false)) ||
      !!res.cancelError;
    return NextResponse.json({ ok: !anyFail, ...res }, { status: anyFail ? 207 : 200 });
  } catch (e) {
    return NextResponse.json(
      { ok: false, at: new Date().toISOString(), error: (e as Error).message },
      { status: 500 },
    );
  }
}
