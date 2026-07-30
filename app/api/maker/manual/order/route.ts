import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { placeManualOrder } from '@/lib/maker/manual-order';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/maker/manual/order — place ONE order BY HAND.
 *
 * This is the only endpoint in the manual lane that can reach POST /order, and it adds no authority of
 * its own. Every gate the automatic engine runs, runs here, in this order — each one names itself, so a
 * refusal is never generic:
 *
 *   1. manual ownership   the market must be in manual mode, i.e. agent35 is provably standing off it
 *   2. venue rules        tick / scoring mid / band / min_incentive_size must be READABLE (fail closed)
 *   3. the shared guard   lib/maker/venue-rules.validateQuote — the identical function the board's band
 *                         warning calls; on-tick, in-band, at or above min size, inside the price range
 *   4. the per-order cap  the MINIMUM of data/safety-risk-limits.json maxOrderNotionalUsd and the
 *                         adapter's live-min cap — never a hardcoded number, never from the request
 *   5. the GLOBAL kill    data/safety-kill-switch.json, re-read now, fail-closed
 *   then the adapter re-runs its own chain independently: venue rules, live-min cap, the single-market
 *   pin, kill, venue allowlist, server-side risk limits, SDK/mode/funding, the CLOB order version, and
 *   finally the exchange's own validateOrder() via eth_call.
 *
 * validateOrder IS NEVER BYPASSED ON A SEND. When an earlier gate refuses, the refusal happens before any
 * key is decrypted — stricter still, not weaker.
 *
 * DEFAULTS CLOSED. `MANUAL_ORDER_PLACEMENT` governs this path and anything other than the exact string
 * 'send' is dry-run: build, sign, ask CTFExchangeV2.validateOrder(), report exactly what would have gone,
 * and drop it. It deliberately does NOT read MAKER_PLACEMENT — the engine's send switch must not arm this
 * panel by side effect, nor the reverse.
 *
 * Admin-gated by middleware (ADMIN_ACCESS_SECRET).
 */

const bodySchema = z.object({
  marketId: z.string().trim().min(1).max(200).optional(),
  book: z.enum(['yes', 'no']),
  price: z.number().finite().gt(0).lt(1),
  size: z.number().finite().gt(0).max(100_000),
  ttlSeconds: z.number().int().min(60).max(86_400).optional(),
  note: z.string().trim().max(280).optional(),
});

export async function POST(req: NextRequest) {
  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 }); }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, gate: 'invalid-body', error: 'invalid body', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const res = await placeManualOrder(parsed.data);
    // A refused order is a 200 with ok:false and its gate — the request was well-formed and the system
    // answered it. Reserve non-2xx for a request or server that failed, so the panel can always render
    // the gate that refused rather than an opaque HTTP error.
    return NextResponse.json(res);
  } catch (e) {
    return NextResponse.json(
      { ok: false, sent: null, ambiguous: true, error: (e as Error).message, at: new Date().toISOString() },
      { status: 500 },
    );
  }
}
