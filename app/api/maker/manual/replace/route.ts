import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { replaceManualOrder } from '@/lib/maker/manual-order';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/maker/manual/replace — "modify" a resting order: cancel it and place the replacement, as ONE
 * server-side sequence from ONE client call.
 *
 * THE POLYMARKET CLOB HAS NO ORDER-MODIFY ENDPOINT. Verified against the installed SDK's own endpoint
 * table (@polymarket/clob-client-v2/dist/endpoints.js): POST /order, POST /orders, DELETE /order,
 * DELETE /orders, /cancel-all, /cancel-market-orders — and nothing that amends, edits, replaces or
 * re-prices a resting order. Changing a price or a size on Polymarket MEANS cancel-then-place. No wrapper
 * can invent a primitive the venue does not expose, so this endpoint does not pretend to.
 *
 * WHAT IT GUARANTEES:
 *   • one client call, one server-side sequence — the browser cannot half-finish it, lose the network
 *     between the steps, or double-place by retrying the second half;
 *   • the REPLACEMENT is validated FIRST (shared venue-rules guard). An off-band or under-min
 *     replacement is refused with the OLD ORDER UNTOUCHED — never cancelled for nothing;
 *   • the cancel must be CONFIRMED before the replacement is attempted, so a failed cancel can never
 *     leave two live orders.
 *
 * WHAT IT CANNOT: it is not atomic AT THE VENUE. Between the cancel and the post there is a real
 * out-of-book window with no resting order. If the post is then refused, the response says exactly that —
 * `oldCancelled:true, replaced:false` — rather than hiding it behind the word "modify". agent35 lives
 * with the identical gap and models it explicitly.
 *
 * The replacement runs the FULL placement chain (manual ownership, venue rules, caps, kill switch, and
 * the adapter's own chain ending in validateOrder), and honours MANUAL_ORDER_PLACEMENT — which defaults
 * to dry-run.
 *
 * Admin-gated by middleware (ADMIN_ACCESS_SECRET).
 */

const bodySchema = z.object({
  orderId: z.string().trim().min(1).max(200),
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
    return NextResponse.json({ ok: false, gate: 'invalid-body', detail: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const res = await replaceManualOrder(parsed.data);
    // ok:false with oldCancelled:true is the case the operator MUST see (no resting order right now), so
    // it is a 200 carrying the full story rather than an opaque error status.
    return NextResponse.json(res);
  } catch (e) {
    return NextResponse.json(
      { ok: false, replaced: false, oldCancelled: null, ambiguous: true, error: (e as Error).message, at: new Date().toISOString() },
      { status: 500 },
    );
  }
}
